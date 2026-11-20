import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { MemoryIndex } from '../src/search.ts';
import { contentHash } from '../src/schema.ts';
import { DecryptionError } from '../src/crypto.ts';
import { MARKERS, PASSWORD, TEST_KDF_N, allBytes, tmp, writeChatgptZip, writeClaudeZip } from './helpers.ts';

async function populated() {
  const d = tmp();
  const exp = tmp();
  const path = join(d, 'v.omneme');
  const { vault, recoveryKey } = await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N });
  await importExport(vault, writeChatgptZip(exp));
  await importExport(vault, writeClaudeZip(exp));
  return { d, path, vault, recoveryKey };
}

const fingerprint = (v: Vault) => new MemoryIndex(v.loadAll()).all.map((r) => `${r.recordId}:${r.contentHash}`).sort();

test('wrong password, short password and existing path are rejected', async () => {
  const { path, vault } = await populated();
  vault.lock();
  await assert.rejects(Vault.unlock(path, { password: 'wrong password!' }), DecryptionError);
  await assert.rejects(Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N }), /already exists/);
  await assert.rejects(Vault.create(join(tmp(), 'x'), 'short', { kdfN: TEST_KDF_N }), /at least 8/);
  assert.throws(() => vault.count(), /locked/);
});

test('recovery key unlocks the vault; malformed recovery key is rejected', async () => {
  const { path, vault, recoveryKey } = await populated();
  const fp = fingerprint(vault); vault.lock();
  const v2 = await Vault.unlock(path, { recoveryKey });
  assert.deepEqual(fingerprint(v2), fp); v2.lock();
  await assert.rejects(Vault.unlock(path, { recoveryKey: 'abcd' }), /64 hex/);
  await assert.rejects(Vault.unlock(path, { recoveryKey: '0'.repeat(64) }), DecryptionError);
});

test('no plaintext conversation content, titles or ids persist on disk', async () => {
  const { d, vault } = await populated();
  vault.lock();
  const bytes = allBytes(d);
  const needles = [MARKERS.simple, MARKERS.chinese, MARKERS.claude, MARKERS.attachment, MARKERS.title, 'cg-branch', 'c1m1', 'gpt-4o', '长城', 'chatgpt-export.zip'];
  for (const n of needles) {
    assert.equal(bytes.includes(Buffer.from(n, 'utf8')), false, `plaintext leaked: ${n}`);
    assert.equal(bytes.includes(Buffer.from(n, 'utf16le')), false, `utf16 plaintext leaked: ${n}`);
  }
  assert.equal(existsSync(join(d, 'v.omneme-wal')), false);
  assert.equal(existsSync(join(d, 'v.omneme-journal')), false);
});

test('tampering with a stored record or the header is detected', async () => {
  const { path, vault } = await populated();
  vault.lock();
  const db = new DatabaseSync(path);
  const row = db.prepare('SELECT id, blob FROM records LIMIT 1').get() as { id: Uint8Array; blob: Uint8Array };
  const blob = Buffer.from(row.blob); blob[blob.length - 5] ^= 0x01;
  db.prepare('UPDATE records SET blob = ? WHERE id = ?').run(blob, row.id);
  db.close();
  const v = await Vault.unlock(path, { password: PASSWORD });
  assert.throws(() => v.loadAll(), /failed integrity/);
  const r = v.verify(contentHash);
  assert.equal(r.failed, 1);
  v.lock();
  // Header tampering (e.g. weakening KDF params or swapping slots) breaks unlock.
  const db2 = new DatabaseSync(path);
  const h = JSON.parse((db2.prepare("SELECT v FROM meta WHERE k='header'").get() as { v: string }).v);
  h.createdAt = '1999-01-01T00:00:00.000Z';
  db2.prepare("UPDATE meta SET v = ? WHERE k='header'").run(JSON.stringify(h));
  db2.close();
  await assert.rejects(Vault.unlock(path, { password: PASSWORD }), /integrity/);
});

test('encrypted backup restores into a clean vault with identical records (password and recovery key)', async () => {
  const { path, vault, recoveryKey } = await populated();
  const fp = fingerprint(vault);
  const out = tmp();
  const bak = join(out, 'vault.omnbak');
  const { records } = vault.exportBackup(bak);
  assert.equal(records, vault.count());
  vault.lock();
  // Backup must not contain plaintext either.
  const bb = readFileSync(bak);
  for (const n of [MARKERS.simple, MARKERS.chinese, MARKERS.title]) assert.equal(bb.includes(Buffer.from(n)), false);
  const target = join(tmp(), 'restored.omneme');
  assert.equal((await Vault.restoreBackup(bak, target, { password: PASSWORD })).records, records);
  const rv = await Vault.unlock(target, { password: PASSWORD });
  assert.deepEqual(fingerprint(rv), fp);
  assert.equal(new MemoryIndex(rv.loadAll()).search({ text: MARKERS.chinese }).length, 1);
  assert.equal(rv.verify(contentHash).failed, 0);
  rv.lock();
  const t2 = join(tmp(), 'r2.omneme');
  await Vault.restoreBackup(bak, t2, { recoveryKey });
  const rv2 = await Vault.unlock(t2, { password: PASSWORD });
  assert.deepEqual(fingerprint(rv2), fp); rv2.lock();
  await assert.rejects(Vault.restoreBackup(bak, target, { password: PASSWORD }), /already exists/);
  assert.ok(existsSync(path));
});

test('tampered, truncated or wrong-password backups are refused and leave no partial vault', async () => {
  const { vault } = await populated();
  const bak = join(tmp(), 'b.omnbak');
  vault.exportBackup(bak); vault.lock();
  const lines = readFileSync(bak, 'utf8').split('\n');
  const cases: Record<string, string> = {
    truncated: lines.slice(0, -3).join('\n') + '\n',
    droppedRecord: [lines[0], ...lines.slice(2)].join('\n'),
    flippedByte: (() => { const l = [...lines]; const parts = l[3].split(' '); const b = Buffer.from(parts[3], 'base64'); b[15] ^= 1; parts[3] = b.toString('base64'); l[3] = parts.join(' '); return l.join('\n'); })(),
    reordered: [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n'),
  };
  for (const [name, content] of Object.entries(cases)) {
    const f = join(tmp(), name + '.omnbak'); writeFileSync(f, content);
    const target = join(tmp(), 'r.omneme');
    await assert.rejects(Vault.restoreBackup(f, target, { password: PASSWORD }), undefined, name);
    assert.equal(existsSync(target), false, name);
    assert.equal(existsSync(target + '.partial'), false, name);
  }
  await assert.rejects(Vault.restoreBackup(bak, join(tmp(), 'x.omneme'), { password: 'not the password' }), DecryptionError);
});
