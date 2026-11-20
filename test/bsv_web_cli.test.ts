import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  commitmentEnvelope, decodeEnvelope, encodeEnvelope, fromLockingScript, toLockingScript, EnvelopeType,
} from '../src/bsv/envelope.ts';
import { MockLedgerAdapter, anchorCommitment, verifyCommitment } from '../src/bsv/storage.ts';
import { sha256 } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { startWeb } from '../src/web.ts';
import { MARKERS, PASSWORD, TEST_KDF_N, chatgptConversations, tmp, writeChatgptZip, writeClaudeZip } from './helpers.ts';

test('envelope and OP_FALSE OP_RETURN script round-trip, including large pushdata', () => {
  const e = commitmentEnvelope(sha256('x'));
  const s = toLockingScript(e);
  assert.equal(s.subarray(0, 2).toString('hex'), '006a');
  assert.equal(s[2], 6); // push "omneme"
  assert.deepEqual(fromLockingScript(s), { ...e, body: e.body });
  for (const n of [10, 100, 300, 70000]) {
    const big = { version: 1, type: EnvelopeType.ENCRYPTED_PAYLOAD, body: Buffer.alloc(n, 9) } as const;
    assert.equal(fromLockingScript(toLockingScript(big)).body.length, n);
  }
  assert.throws(() => decodeEnvelope(Buffer.from('nope')));
  const enc = encodeEnvelope(e); enc[4] = 9;
  assert.throws(() => decodeEnvelope(enc), /version/);
});

test('mock ledger anchors a commitment and verification detects altered content', async () => {
  const a = new MockLedgerAdapter(join(tmp(), 'ledger'));
  const content = Buffer.from('encrypted backup bytes');
  const r = await anchorCommitment(a, content);
  assert.match(r.txid, /^[0-9a-f]{64}$/);
  assert.equal(r.network, 'mock');
  assert.equal((await verifyCommitment([a], r.txid, content)).ok, true);
  assert.equal((await verifyCommitment([a], r.txid, Buffer.from('other'))).ok, false);
  assert.equal((await verifyCommitment([a], '0'.repeat(64), content)).source, null);
  // A second, independent provider holding the same data can verify too.
  const b = new MockLedgerAdapter(join(tmp(), 'ledger2'));
  await b.publish((await a.fetch(r.txid))!);
  assert.equal((await verifyCommitment([new MockLedgerAdapter(join(tmp(), 'empty')), b], r.txid, content)).source, 'mock-ledger');
});

test('web UI: locked by default, unlocks, escapes untrusted content, rejects cross-origin, locks', async () => {
  const d = tmp();
  const path = join(d, 'v.omneme');
  const { vault } = await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N });
  const convs = chatgptConversations() as any[];
  convs[0].mapping.n2.message.content.parts = ['<script>alert(1)</script> injected-marker'];
  await importExport(vault, writeChatgptZip(d, convs));
  vault.lock();
  const web = await startWeb({ vaultPath: path, port: 0 });
  try {
    let res = await fetch(web.url);
    assert.match(await res.text(), /vault is locked/);
    res = await fetch(web.url + 'unlock', { method: 'POST', body: 'password=wrong', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.equal(res.status, 401);
    res = await fetch(web.url + 'unlock', { method: 'POST', body: 'password=' + encodeURIComponent(PASSWORD), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' }, redirect: 'manual' });
    assert.equal(res.status, 403);
    res = await fetch(web.url + 'unlock', { method: 'POST', body: 'password=' + encodeURIComponent(PASSWORD), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.equal(res.status, 303);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    res = await fetch(web.url + '?q=injected-marker', { headers: { cookie } });
    const html = await res.text();
    assert.match(res.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>alert'));
    assert.match(html, /1 result/);
    res = await fetch(web.url + 'conversation?id=chatgpt%3Acg-branch', { headers: { cookie } });
    assert.match(await res.text(), /branch 2\/2/);
    assert.match(await (await fetch(web.url, {})).text(), /vault is locked/); // no cookie -> locked view
    await fetch(web.url + 'lock', { method: 'POST', headers: { cookie }, redirect: 'manual' });
    assert.match(await (await fetch(web.url, { headers: { cookie } })).text(), /vault is locked/);
  } finally { await web.close(); }
});

test('CLI end-to-end: init, import, stats, search, show, backup, restore, verify, anchor', () => {
  const d = tmp();
  const vault = join(d, 'vault.omneme');
  const env = { ...process.env, OMNEME_PASSWORD: PASSWORD, OMNEME_KDF_N: String(TEST_KDF_N), OMNEME_TEST_MODE: "1", OMNEME_VAULT: vault };
  const cli = (...a: string[]) => execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'omneme.mjs'), ...a], { env, encoding: 'utf8' });
  const init = cli('init');
  const rk = init.match(/([0-9a-f]{4}(-[0-9a-f]{4}){15})/)![1];
  const exp = tmp();
  const imp = cli('import', writeChatgptZip(exp), writeClaudeZip(exp));
  assert.match(imp, /status:\s+complete/);
  assert.ok(!imp.includes(MARKERS.simple), 'import output must not echo content');
  assert.match(cli('stats'), /Conversations: 8\nMessages:      21/);
  const s = JSON.parse(cli('search', '长城', '--json'));
  assert.equal(s.length, 1);
  assert.equal(s[0].conversationId, 'cg-zh');
  assert.match(cli('show', 'cg-branch'), /branch 1\/2[\s\S]*branch 2\/2/);
  assert.match(cli('verify'), /failed: 0/);
  const bak = join(d, 'b.omnbak');
  cli('backup', bak);
  const target = join(d, 'restored.omneme');
  execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'omneme.mjs'), 'restore', bak, '--target', target, '--recovery'],
    { env: { ...env, OMNEME_RECOVERY_KEY: rk }, encoding: 'utf8' });
  assert.match(cli('stats', '--vault', target), /Conversations: 8\nMessages:      21/);
  const ledger = join(d, 'ledger');
  const txid = cli('anchor', bak, '--ledger', ledger).match(/txid:\s+([0-9a-f]{64})/)![1];
  assert.match(cli('verify-anchor', txid, bak, '--ledger', ledger), /^OK/);
  writeFileSync(join(d, 'other'), 'x');
  assert.throws(() => cli('verify-anchor', txid, join(d, 'other'), '--ledger', ledger));
  assert.throws(() => execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'omneme.mjs'), 'stats'], { env: { ...env, OMNEME_PASSWORD: 'wrong-password' }, stdio: 'pipe' }));
});
