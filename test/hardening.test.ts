// Stage 1.1 hardening tests: hostile archives, hostile JSON, interruption, record-set integrity,
// KDF parameter abuse, web UI host/origin/throttle checks. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { Vault, IntegrityError } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { MemoryIndex } from '../src/search.ts';
import { contentHash } from '../src/schema.ts';
import { deriveKek, newKdfParams, random, seal } from '../src/crypto.ts';
import { readZipEntries, openZipEntry, ZipError, DEFAULT_ZIP_LIMITS } from '../src/zip.ts';
import { streamJsonArray, DEFAULT_JSON_LIMITS } from '../src/jsonstream.ts';
import { startWeb } from '../src/web.ts';
import {
  PASSWORD, TEST_KDF_N, chatgptConversations, claudeConversations, largeChatgptConversation, makeZip, tmp, writeChatgptZip,
} from './helpers.ts';

const freshVault = async () => {
  const d = tmp();
  const path = join(d, 'v.omneme');
  return { d, path, vault: (await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N })).vault };
};
const drain = async (s: AsyncIterable<unknown>) => { let n = 0; for await (const c of s) n += (c as Buffer).length; return n; };

// Deterministic PRNG so fuzz failures are reproducible.
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); }

// ---------- ZIP ----------

test('ZIP: entry that inflates beyond its declared size is stopped (zip bomb / lying header)', async () => {
  const d = tmp(); const p = join(d, 'lie.zip');
  writeFileSync(p, makeZip([{ name: 'conversations.json', data: 'x'.repeat(100_000), declaredSize: 1000 }]));
  const [e] = await readZipEntries(p);
  await assert.rejects(drain(await openZipEntry(p, e)), /larger than declared/);
});

test('ZIP: high compression ratio, oversize entries and too many entries are refused', async () => {
  const d = tmp(); const p = join(d, 'bomb.zip');
  writeFileSync(p, makeZip([{ name: 'conversations.json', data: Buffer.alloc(4 * 2 ** 20) }, { name: 'b', data: 'x' }]));
  const limits = { ...DEFAULT_ZIP_LIMITS, ratioMinBytes: 2 ** 20, maxRatio: 100 };
  const [e] = await readZipEntries(p, limits);
  await assert.rejects(openZipEntry(p, e, limits), /ratio too high/);
  await assert.rejects(openZipEntry(p, e, { ...limits, maxRatio: 1e9, maxEntryBytes: 2 ** 20 }), /size limit/);
  await assert.rejects(readZipEntries(p, { ...limits, maxEntries: 1 }), /too many entries/);
  // Through the importer, the failure is reported with its location and the import is incomplete.
  const { vault } = await freshVault();
  const r = await importExport(vault, p, { zip: limits });
  assert.equal(r.complete, false);
  assert.match(r.errors[0].reason, /ratio too high/);
  assert.equal(r.errors[0].entry, 'conversations.json');
  vault.lock();
});

test('ZIP: overlapping entries and out-of-bounds offsets are refused', async () => {
  const d = tmp();
  const p = join(d, 'overlap.zip');
  writeFileSync(p, makeZip([{ name: 'a', data: 'hello', store: true }, { name: 'b', data: 'world', store: true, cdOffset: 0 }]));
  await assert.rejects(readZipEntries(p), /overlap/);
  const q = join(d, 'oob.zip');
  writeFileSync(q, makeZip([{ name: 'a', data: 'hello', store: true, cdOffset: 9_999_999 }]));
  await assert.rejects(readZipEntries(q), /out of bounds/);
});

test('ZIP: path-traversal entry names are inert (nothing is ever written to disk)', async () => {
  const d = tmp();
  const p = join(d, 'trav.zip');
  writeFileSync(p, makeZip([
    { name: '../../../../tmp/omneme-evil.json', data: '[]' },
    { name: 'conversations.json', data: JSON.stringify([chatgptConversations()[0]]) },
  ]));
  const before = readdirSync(d).sort();
  const { vault } = await freshVault();
  const r = await importExport(vault, p);
  assert.equal(r.complete, true);
  assert.deepEqual(readdirSync(d).sort(), before);
  assert.equal(existsSync('/tmp/omneme-evil.json'), false);
  vault.lock();
});

test('ZIP fuzz: 400 random corruptions never crash, hang, or import silently-wrong data', async () => {
  const d = tmp();
  const good = makeZip([{ name: 'conversations.json', data: JSON.stringify(chatgptConversations()) }, { name: 'file-IMG001-x.png', data: 'png', store: true }]);
  const rand = rng(42);
  const { vault } = await freshVault();
  let rejected = 0, incomplete = 0, complete = 0;
  for (let i = 0; i < 400; i++) {
    const b = Buffer.from(good);
    const flips = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < flips; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
    const cut = rand() < 0.2 ? Math.floor(rand() * b.length) : b.length;
    const p = join(d, `f${i}.zip`); writeFileSync(p, b.subarray(0, cut));
    try {
      const r = await importExport(vault, p);
      if (r.complete) complete++; else incomplete++;
      assert.equal(r.elementsSeen, r.conversationsSeen + r.conversationsFailed);
    } catch (e) {
      assert.ok(e instanceof ZipError, `unexpected error type ${(e as Error).name}: ${(e as Error).message}`);
      rejected++;
    }
  }
  assert.ok(rejected + incomplete > 300, `most corruptions must be detected (rejected ${rejected}, incomplete ${incomplete}, complete ${complete})`);
  // Whatever was imported is internally consistent.
  const v = vault.verify(contentHash);
  assert.equal(v.failed, 0); assert.equal(v.recordSetOk, true);
  vault.lock();
});

// ---------- JSON ----------

async function items(text: string | Buffer, chunk: number, limits = DEFAULT_JSON_LIMITS) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.subarray(i, i + chunk));
  const out = [];
  for await (const it of streamJsonArray(Readable.from(parts), limits)) out.push(it);
  return out;
}

test('JSON: nesting-depth and element-size limits skip and report only the offending element', async () => {
  const deep = '['.repeat(50) + ']'.repeat(50);
  const text = `[{"a":1}, {"d": ${deep}}, {"big":"${'x'.repeat(5000)}"}, {"z":2}]`;
  for (const chunk of [7, 1000, 100000]) {
    const out = await items(text, chunk, { maxDepth: 20, maxElementBytes: 1000 });
    assert.deepEqual(out.map((o) => ('value' in o ? 'ok' : (o as any).error.split(' ')[0])), ['ok', 'JSON', 'Conversation', 'ok'], `chunk=${chunk}`);
  }
});

test('JSON: element byte offsets are exact even after multi-byte characters', async () => {
  const text = '[{"t":"中文🐼"},{"u":1}]';
  const out = await items(text, 3);
  assert.equal(out[0].offset, 1);
  assert.equal(out[1].offset, Buffer.byteLength('[{"t":"中文🐼"},'));
});

test('JSON: invalid UTF-8 is never silently replaced — it is reported against the element', async () => {
  const pre = Buffer.from('[{"a":"ok"},{"b":"bad ');
  const bad = Buffer.concat([pre, Buffer.from([0xff, 0xfe]), Buffer.from('"}]')]);
  const out = await items(bad, 4);
  assert.equal(out.length, 2);
  assert.ok(!('issues' in out[0]));
  assert.match((out[1] as any).issues[0], /Invalid UTF-8/);
  // Through the importer this makes the import incomplete, with location.
  const { d, vault } = await freshVault();
  const conv = JSON.stringify(chatgptConversations()[0]).replace('Here is a synthetic answer.', 'XX_INVALID_XX');
  const raw = Buffer.from(`[${conv}]`);
  const at = raw.indexOf('XX_INVALID_XX');
  raw[at] = 0xff;
  const p = join(d, 'conversations.json'); writeFileSync(p, raw);
  const r = await importExport(vault, p);
  assert.equal(r.complete, false);
  assert.equal(r.conversationsSeen, 1);
  assert.match(r.errors[0].reason, /Invalid UTF-8/);
  assert.equal(r.errors[0].conversationId, 'cg-simple');
  vault.lock();
});

test('JSON fuzz: random truncation and corruption of conversations.json is always reconciled and reported', async () => {
  const d = tmp();
  const good = Buffer.from(JSON.stringify([...chatgptConversations(), ...claudeConversations()]));
  const rand = rng(7);
  const { vault } = await freshVault();
  for (let i = 0; i < 250; i++) {
    const b = Buffer.from(good);
    for (let k = 0; k < 1 + Math.floor(rand() * 3); k++) b[Math.floor(rand() * b.length)] = '{}[]",:\\x'.charCodeAt(Math.floor(rand() * 10));
    const cut = rand() < 0.5 ? Math.floor(rand() * b.length) : b.length;
    const p = join(d, `c${i}.json`); writeFileSync(p, b.subarray(0, cut));
    const r = await importExport(vault, p);
    assert.equal(r.elementsSeen, r.conversationsSeen + r.conversationsFailed);
    if (cut < b.length) assert.equal(r.complete, false, 'a truncated file must never be complete');
    if (r.complete) assert.equal(r.conversationsSeen, 8);
  }
  assert.equal(vault.verify(contentHash).recordSetOk, true);
  vault.lock();
});

// ---------- Data integrity ----------

test('reconciliation: unreadable mapping nodes are counted, reported and preserved in the raw conversation', async () => {
  const { d, vault } = await freshVault();
  const c = chatgptConversations()[0] as any;
  c.mapping.weird = 'not-an-object';
  const p = join(d, 'conversations.json'); writeFileSync(p, JSON.stringify([c]));
  const r = await importExport(vault, p);
  assert.equal(r.complete, false);
  assert.equal(r.sourceUnits, 4);
  assert.equal(r.messagesSeen + r.structuralNodes + r.skippedUnits, 4);
  assert.match(r.errors[0].reason, /unreadable/);
  const conv = new MemoryIndex(vault.loadAll()).conversation('cg-simple')!.conversation!;
  assert.equal((conv.raw as any).mapping.weird, 'not-an-object');
  vault.lock();
});

test('duplicate message ids inside one conversation are both preserved and flagged', async () => {
  const { d, vault } = await freshVault();
  const c = claudeConversations()[0] as any;
  c.chat_messages.push({ ...c.chat_messages[0], text: 'different content, same uuid', content: [] });
  const p = join(d, 'conversations.json'); writeFileSync(p, JSON.stringify([c]));
  const r = await importExport(vault, p);
  assert.ok(r.warnings.some((w) => /duplicate message uuid c1m1/.test(w.reason)));
  assert.equal(r.messagesInserted + r.messagesRevised, 3);
  const all = new MemoryIndex(vault.loadAll()).all.filter((x) => x.messageId === 'c1m1');
  assert.equal(all.length, 2);
  vault.lock();
});

test('process killed mid-import (SIGKILL inside a transaction): vault stays consistent, import shows interrupted, re-import completes', async () => {
  const { d, path, vault } = await freshVault();
  vault.lock();
  const p = join(d, 'conversations.json');
  const convs = Array.from({ length: 30 }, (_, i) => { const c = largeChatgptConversation(40) as any; c.conversation_id = 'k' + i; return c; });
  writeFileSync(p, JSON.stringify(convs));
  const child = spawnSync(process.execPath, ['--no-warnings', join(import.meta.dirname, 'fixtures', 'crash-child.ts'), path, p, '500'],
    { env: { ...process.env, OMNEME_PASSWORD: PASSWORD }, encoding: 'utf8' });
  // POSIX reports the signal; Windows reports a non-zero exit code instead.
  assert.ok(child.signal === 'SIGKILL' || (child.status !== 0 && !/finished without crash/.test(child.stdout)), child.stderr);
  const v = await Vault.unlock(path, { password: PASSWORD });
  const chk = v.verify(contentHash);
  assert.equal(chk.failed, 0); assert.equal(chk.recordSetOk, true);
  let ix = new MemoryIndex(v.loadAll());
  assert.deepEqual(ix.imports().map((i) => i.status), ['interrupted']);
  assert.ok(ix.stats().conversations < 30);
  // Each committed conversation is complete (atomic per conversation): no half conversations.
  for (const c of ix.listConversations()) assert.equal(ix.conversation(c.conversationId!)!.messages.length, 40);
  const r = await importExport(v, p);
  assert.equal(r.complete, true);
  ix = new MemoryIndex(v.loadAll());
  assert.equal(ix.stats().conversations, 30);
  assert.equal(ix.stats().messages, 1200);
  assert.deepEqual(ix.imports().map((i) => i.status), ['interrupted', 'complete']);
  assert.equal((await importExport(v, p)).messagesInserted, 0);
  v.lock();
});

test('record-set commitment detects deleted rows and tampered state; rows from another vault are rejected', async () => {
  const { d, path, vault } = await freshVault();
  await importExport(vault, writeChatgptZip(d));
  vault.lock();
  const db = new DatabaseSync(path);
  const victim = db.prepare('SELECT id, lineage, blob FROM records LIMIT 1').get() as any;
  db.prepare('DELETE FROM records WHERE id = ?').run(victim.id);
  db.close();
  let v = await Vault.unlock(path, { password: PASSWORD });
  assert.throws(() => v.loadAll(), IntegrityError);
  assert.equal(v.verify(contentHash).recordSetOk, false);
  assert.throws(() => v.exportBackup(join(tmp(), 'b.omnbak')), IntegrityError);
  v.lock();
  // Put it back -> intact again.
  const db2 = new DatabaseSync(path);
  db2.prepare('INSERT INTO records (id, lineage, blob) VALUES (?, ?, ?)').run(victim.id, victim.lineage, victim.blob);
  const st = JSON.parse((db2.prepare("SELECT v FROM meta WHERE k='state'").get() as any).v);
  db2.close();
  v = await Vault.unlock(path, { password: PASSWORD });
  assert.equal(v.verify(contentHash).recordSetOk, true);
  v.lock();
  // Tampering with the state row is caught at unlock.
  const db3 = new DatabaseSync(path);
  db3.prepare("UPDATE meta SET v = ? WHERE k='state'").run(JSON.stringify({ ...st, count: st.count - 1 }));
  db3.close();
  await assert.rejects(Vault.unlock(path, { password: PASSWORD }), /state tampered/);
  // A row transplanted from another vault fails authentication (AAD binds the vault id).
  const other = await freshVault();
  await importExport(other.vault, writeChatgptZip(other.d));
  other.vault.lock();
  const src = new DatabaseSync(other.path);
  const foreign = src.prepare('SELECT id, lineage, blob FROM records LIMIT 1').get() as any;
  src.close();
  const fresh = await freshVault(); fresh.vault.lock();
  const db4 = new DatabaseSync(fresh.path);
  db4.prepare('INSERT INTO records (id, lineage, blob) VALUES (?, ?, ?)').run(foreign.id, foreign.lineage, foreign.blob);
  db4.close();
  const fv = await Vault.unlock(fresh.path, { password: PASSWORD });
  assert.throws(() => fv.loadAll(), /failed integrity/);
  fv.lock();
});

test('restore on a "fresh installation" (only the backup file copied elsewhere) yields deep-identical records', async () => {
  const { d, vault } = await freshVault();
  await importExport(vault, writeChatgptZip(d));
  const original = vault.loadAll().sort((a, b) => a.recordId.localeCompare(b.recordId));
  const bak = join(d, 'b.omnbak');
  writeFileSync(bak + '.partial', 'stale garbage from an interrupted earlier backup');
  vault.exportBackup(bak);
  // An earlier run's partial file is never reused or deleted by the backup itself; the backup checks report it.
  assert.equal(readFileSync(bak + '.partial', 'utf8'), 'stale garbage from an interrupted earlier backup');
  vault.lock();
  const elsewhere = tmp();
  copyFileSync(bak, join(elsewhere, 'copy.omnbak'));
  const target = join(elsewhere, 'new-machine', 'vault.omneme');
  await Vault.restoreBackup(join(elsewhere, 'copy.omnbak'), target, { password: PASSWORD });
  const rv = await Vault.unlock(target, { password: PASSWORD });
  const restored = rv.loadAll().sort((a, b) => a.recordId.localeCompare(b.recordId));
  assert.deepEqual(restored, original);
  rv.lock();
});

// ---------- Crypto parameters ----------

test('KDF parameters from a tampered header cannot exhaust memory or weaken the floor', async () => {
  const p = newKdfParams(TEST_KDF_N);
  const t = Date.now();
  await assert.rejects(deriveKek('pw', { ...p, N: 2 ** 30 }), /out of accepted range/);
  await assert.rejects(deriveKek('pw', { ...p, r: 1000 }), /out of accepted range/);
  await assert.rejects(deriveKek('pw', { ...p, salt: '' }), /out of accepted range/);
  assert.ok(Date.now() - t < 1000);
  assert.equal(newKdfParams().N, 2 ** 17);
  assert.equal(Buffer.from(newKdfParams().salt, 'base64').length, 16);
  assert.notEqual(newKdfParams().salt, newKdfParams().salt);
});

test('AES-GCM nonces are unique across many encryptions under one key', () => {
  const k = random(32), seen = new Set<string>();
  for (let i = 0; i < 20000; i++) seen.add(seal(k, Buffer.from('x'), Buffer.alloc(0)).subarray(0, 12).toString('hex'));
  assert.equal(seen.size, 20000);
});

test('CLI refuses test-strength KDF outside test mode', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'omneme.mjs'), 'init'],
    { env: { ...process.env, OMNEME_PASSWORD: PASSWORD, OMNEME_KDF_N: '16384', OMNEME_TEST_MODE: '', OMNEME_VAULT: join(tmp(), 'v.omneme') }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /only allowed in test mode/);
});

// ---------- Web ----------

function raw(port: number, method: string, path: string, headers: Record<string, string>, body = ''): Promise<{ status: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), ...headers } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('web: DNS rebinding (foreign Host), cross-site POSTs, brute force throttling, failed unlock keeps session', async () => {
  const { path, vault } = await freshVault(); vault.lock();
  const web = await startWeb({ vaultPath: path, port: 0 });
  const port = Number(new URL(web.url).port);
  const host = `127.0.0.1:${port}`;
  try {
    assert.equal((await raw(port, 'GET', '/', { host: `evil.example:${port}` })).status, 421);
    assert.equal((await raw(port, 'POST', '/unlock', { host: `evil.example:${port}`, origin: `http://evil.example:${port}` }, 'password=x')).status, 421);
    assert.equal((await raw(port, 'GET', '/', { host: `localhost:${port}` })).status, 200);
    assert.equal((await raw(port, 'POST', '/unlock', { host, 'sec-fetch-site': 'cross-site' }, 'password=' + PASSWORD)).status, 403);
    assert.equal((await raw(port, 'POST', '/unlock', { host, origin: 'http://localhost:1' }, 'password=' + PASSWORD)).status, 403);
    const ok = await raw(port, 'POST', '/unlock', { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, 'password=' + encodeURIComponent(PASSWORD));
    assert.equal(ok.status, 303);
    const cookie = ok.headers['set-cookie'][0].split(';')[0];
    for (let i = 0; i < 3; i++) assert.equal((await raw(port, 'POST', '/unlock', { host }, 'password=wrong')).status, 401);
    assert.equal((await raw(port, 'POST', '/unlock', { host }, 'password=' + encodeURIComponent(PASSWORD))).status, 429);
    const still = await raw(port, 'GET', '/', { host, cookie });
    assert.match(still.body, /Lock vault/, 'failed attempts must not lock out the existing session');
  } finally { await web.close(); }
});

test('JSON: elements completed before a fatal error in the same chunk are still delivered', async () => {
  const got: unknown[] = [];
  await assert.rejects(async () => {
    for await (const it of streamJsonArray(Readable.from([Buffer.from('[{"a":1},{"b":2}] trailing-garbage')]))) got.push(it);
  }, /after end of JSON array/);
  assert.equal(got.length, 2);
});

// ---------- Stage 1.1 review regressions (independent review findings) ----------

test('JSON: missing, leading, double and trailing commas are detected; such a source is never complete', async () => {
  const cases: Record<string, string> = {
    adjacent: '[{"a":1}{"b":2}]',
    trailing: '[{"a":1},]',
    leading: '[,{"a":1}]',
    double: '[{"a":1},,{"b":2}]',
    primitiveAdjacent: '[{"a":1} 5]',
  };
  for (const [name, text] of Object.entries(cases)) {
    const out = await items(text, 3);
    assert.ok(out.some((o) => 'structuralError' in o), name);
  }
  for (const ok of ['[]', '[ ]', '[{"a":1}]', '[ {"a":1} , {"b":2} ]']) assert.ok(!(await items(ok, 2)).some((o) => 'structuralError' in o), ok);
  // The reviewer's reproduction: two adjacent ChatGPT conversations, no comma.
  const { d, vault } = await freshVault();
  const [c1, c2] = chatgptConversations();
  const p = join(d, 'conversations.json');
  writeFileSync(p, `[${JSON.stringify(c1)}${JSON.stringify(c2)}]`);
  const r = await importExport(vault, p);
  assert.equal(r.complete, false);
  assert.equal(r.status, 'incomplete');
  assert.match(r.errors[0].reason, /Missing comma/);
  assert.equal(typeof r.errors[0].offset, 'number');
  writeFileSync(p, `[${JSON.stringify(c1)},]`);
  assert.equal((await importExport(vault, p)).complete, false);
  vault.lock();
});

test('reviewer reproduction: one record, row deleted directly in SQLite -> verify reports the loss', async () => {
  const { path, vault } = await freshVault();
  vault.put({ schema: 'omneme.record/1', class: 'event', kind: 'import', scope: 'private', provider: null, conversationId: null, messageId: null, parentMessageId: null, parentInferred: false, role: null, authorName: null, title: null, createdAt: null, updatedAt: null, importedAt: '2026-01-01T00:00:00.000Z', model: null, text: '', parts: [], attachments: [], flags: [], relations: [], provenance: { importId: 'x', importer: 't', importerVersion: '0', exportLabel: '', exportSha256: null, exportEntry: '', elementIndex: -1 }, contentHash: contentHash({}), raw: {} } as any);
  vault.lock();
  const db = new DatabaseSync(path); db.exec('DELETE FROM records'); db.close();
  const v = await Vault.unlock(path, { password: PASSWORD });
  const r = v.verify(contentHash);
  assert.equal(r.total, 0); assert.equal(r.expected, 1); assert.equal(r.recordSetOk, false);
  v.lock();
});

test('altered row id or lineage value is detected even when the ciphertext is untouched', async () => {
  const { d, path, vault } = await freshVault();
  await importExport(vault, writeChatgptZip(d));
  vault.lock();
  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT id, lineage FROM records LIMIT 2').all() as any[];
  db.prepare('UPDATE records SET lineage = ? WHERE id = ?').run(rows[1].lineage, rows[0].id); // swap in another row's lineage
  db.close();
  let v = await Vault.unlock(path, { password: PASSWORD });
  assert.throws(() => v.loadAll(), /failed integrity/);
  assert.equal(v.verify(contentHash).failed, 1);
  v.lock();
  const db2 = new DatabaseSync(path);
  db2.prepare('UPDATE records SET lineage = ? WHERE id = ?').run(rows[0].lineage, rows[0].id); // restore
  const id2 = Buffer.from(rows[0].id); id2[0] ^= 1;
  db2.prepare('UPDATE records SET id = ? WHERE id = ?').run(id2, rows[0].id);
  db2.close();
  v = await Vault.unlock(path, { password: PASSWORD });
  const r = v.verify(contentHash);
  assert.equal(r.failed, 1); assert.equal(r.recordSetOk, false);
  v.lock();
});

test('whole-vault rollback to an older valid copy is NOT detectable from inside the vault (documented limitation)', async () => {
  const { d, path, vault } = await freshVault();
  vault.lock();
  const old = join(d, 'old.omneme'); copyFileSync(path, old);
  const v = await Vault.unlock(path, { password: PASSWORD });
  await importExport(v, writeChatgptZip(d)); v.lock();
  copyFileSync(old, path); // attacker/accident restores the older file
  const rv = await Vault.unlock(path, { password: PASSWORD });
  assert.equal(rv.verify(contentHash).recordSetOk, true); // internally consistent: needs an external checkpoint to detect
  rv.lock();
});

test('web: unauthenticated POST /lock does not lock an active session', async () => {
  const { path, vault } = await freshVault(); vault.lock();
  const web = await startWeb({ vaultPath: path, port: 0 });
  const port = Number(new URL(web.url).port), host = `127.0.0.1:${port}`;
  try {
    const ok = await raw(port, 'POST', '/unlock', { host }, 'password=' + encodeURIComponent(PASSWORD));
    const cookie = ok.headers['set-cookie'][0].split(';')[0];
    await raw(port, 'POST', '/lock', { host });
    assert.match((await raw(port, 'GET', '/', { host, cookie })).body, /Lock vault/);
    await raw(port, 'POST', '/lock', { host, cookie });
    assert.match((await raw(port, 'GET', '/', { host, cookie })).body, /vault is locked/);
  } finally { await web.close(); }
});

test('backup is refused (and leaves no file) when any record fails authentication or content integrity', async () => {
  const { d, path, vault } = await freshVault();
  await importExport(vault, writeChatgptZip(d));
  vault.lock();
  const db = new DatabaseSync(path);
  const row = db.prepare('SELECT id, blob FROM records LIMIT 1').get() as any;
  const blob = Buffer.from(row.blob); blob[blob.length - 3] ^= 1;
  db.prepare('UPDATE records SET blob = ? WHERE id = ?').run(blob, row.id);
  db.close();
  const v = await Vault.unlock(path, { password: PASSWORD });
  assert.equal(v.verify(contentHash).failed, 1);
  const out = join(tmp(), 'b.omnbak');
  assert.throws(() => v.exportBackup(out), /Backup refused: 1 record/);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(out + '.partial'), false);
  v.lock();
});

test('KDF: combined N·r memory and N·r·p work are bounded; default parameters still accepted', async () => {
  const p = newKdfParams(TEST_KDF_N);
  await assert.rejects(deriveKek('pw', { ...p, N: 2 ** 20, r: 32 }), /out of accepted range/); // 4 GiB
  await assert.rejects(deriveKek('pw', { ...p, N: 2 ** 18, r: 16 }), /out of accepted range/); // 512 MiB
  await assert.rejects(deriveKek('pw', { ...p, N: 2 ** 17, r: 8, p: 16 }), /out of accepted range/); // work 16x
  await assert.rejects(deriveKek('pw', { ...p, r: 1.5 }), /out of accepted range/);
  assert.equal((await deriveKek('pw', newKdfParams())).length, 32); // default N=2^17, r=8, p=1
});
