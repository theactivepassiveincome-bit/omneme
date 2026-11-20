// OMN-025: recovery-key authenticated password reset. Synthetic vaults in temporary folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Vault, type VaultHeader } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { contentHash } from '../src/schema.ts';
import { DecryptionError } from '../src/crypto.ts';
import { PASSWORD, TEST_KDF_N, tmp, writeChatgptZip } from './helpers.ts';

const NEW_PW = 'a brand new synthetic password';

async function populated() {
  const d = tmp();
  const path = join(d, 'v.omneme');
  const { vault, recoveryKey } = await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N });
  await importExport(vault, writeChatgptZip(tmp()));
  const ref = await vault.putBlob((async function* () { yield Buffer.from('synthetic archived bytes '.repeat(1000)); })());
  assert.ok(ref.chunks.length >= 1);
  vault.lock();
  return { path, recoveryKey };
}

/** Raw bytes of every stored row (records, chunks, meta), read without keys. */
function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = (sql: string) => (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => Object.values(r).map((x) => (x instanceof Uint8Array ? Buffer.from(x).toString('hex') : String(x))).join('|'));
    const meta = Object.fromEntries((db.prepare('SELECT k, v FROM meta').all() as { k: string; v: string }[]).map((r) => [r.k, r.v]));
    return { records: rows('SELECT id, lineage, blob FROM records ORDER BY id'), chunks: rows('SELECT id, blob FROM chunks ORDER BY id'), meta };
  } finally { db.close(); }
}

function setMeta(path: string, k: string, v: string) {
  const db = new DatabaseSync(path);
  try { db.prepare('UPDATE meta SET v = ? WHERE k = ?').run(v, k); } finally { db.close(); }
}

const reset = (path: string, recoveryKey: string, extra: Partial<{ newPassword: string; confirmPassword: string }> = {}) =>
  Vault.resetPassword(path, { recoveryKey, newPassword: NEW_PW, confirmPassword: NEW_PW, kdfN: TEST_KDF_N, ...extra });

test('reset: new password and the same recovery key unlock; old password is rejected; data untouched', async () => {
  const { path, recoveryKey } = await populated();
  const before = snapshot(path);
  const hb = JSON.parse(before.meta.header) as VaultHeader;
  await reset(path, recoveryKey);
  const after = snapshot(path);

  // Only the header row changed; records, chunks and the record-set state are byte-identical.
  assert.deepEqual(after.records, before.records);
  assert.deepEqual(after.chunks, before.chunks);
  assert.equal(after.meta.state, before.meta.state);
  assert.deepEqual(Object.keys(after.meta).sort(), Object.keys(before.meta).sort());
  const ha = JSON.parse(after.meta.header) as VaultHeader;
  assert.equal(ha.vaultId, hb.vaultId); assert.equal(ha.createdAt, hb.createdAt); assert.equal(ha.format, hb.format);
  assert.deepEqual(ha.slots.map((s) => s.type), hb.slots.map((s) => s.type));
  assert.deepEqual(ha.slots.find((s) => s.type === 'recovery'), hb.slots.find((s) => s.type === 'recovery'));
  const pa = ha.slots.find((s) => s.type === 'password')!, pb = hb.slots.find((s) => s.type === 'password')!;
  assert.notEqual(pa.wrapped, pb.wrapped);
  assert.notEqual(pa.kdf!.salt, pb.kdf!.salt); // fresh KDF parameters
  assert.notEqual(ha.mac, hb.mac);

  await assert.rejects(Vault.unlock(path, { password: PASSWORD }), DecryptionError);
  const v = await Vault.unlock(path, { password: NEW_PW });
  const r = v.verify(contentHash);
  assert.equal(r.failed, 0); assert.ok(r.recordSetOk); assert.equal(r.total, before.records.length);
  // Backup format unchanged: a backup taken now restores with the new password and with the recovery key.
  const bak = join(tmp(), 'b.omnbak');
  v.exportBackup(bak); v.lock();
  await Vault.restoreBackup(bak, join(tmp(), 'r1.omneme'), { password: NEW_PW });
  await Vault.restoreBackup(bak, join(tmp(), 'r2.omneme'), { recoveryKey });
  const vr = await Vault.unlock(path, { recoveryKey });
  assert.equal(vr.verify(contentHash).failed, 0); vr.lock();
});

test('wrong or malformed recovery key, mismatch and short password leave the header unchanged', async () => {
  const { path, recoveryKey } = await populated();
  const before = snapshot(path);
  await assert.rejects(reset(path, '0'.repeat(64)), DecryptionError);
  await assert.rejects(reset(path, 'abcd'), /64 hex/);
  await assert.rejects(reset(path, recoveryKey, { confirmPassword: NEW_PW + 'x' }), /do not match/);
  await assert.rejects(reset(path, recoveryKey, { newPassword: 'short', confirmPassword: 'short' }), /at least 8/);
  assert.deepEqual(snapshot(path), before);
  const v = await Vault.unlock(path, { password: PASSWORD }); v.lock();
});

test('tampered header MAC or record-set state is refused before any write', async () => {
  const { path, recoveryKey } = await populated();
  const orig = snapshot(path);
  const h = JSON.parse(orig.meta.header) as VaultHeader;
  setMeta(path, 'header', JSON.stringify({ ...h, createdAt: '2000-01-01T00:00:00.000Z' }));
  const tampered = snapshot(path);
  await assert.rejects(reset(path, recoveryKey), /header integrity/);
  assert.deepEqual(snapshot(path), tampered);

  setMeta(path, 'header', orig.meta.header);
  const st = JSON.parse(orig.meta.state); st.count += 1;
  setMeta(path, 'state', JSON.stringify(st));
  const tampered2 = snapshot(path);
  await assert.rejects(reset(path, recoveryKey), /state tampered/);
  assert.deepEqual(snapshot(path), tampered2);
});

test('failure inside the commit rolls back: header unchanged, old password still works', async () => {
  const { path, recoveryKey } = await populated();
  const before = snapshot(path);
  Vault.testHooks.afterHeaderUpdate = () => { throw new Error('simulated failure'); };
  try { await assert.rejects(reset(path, recoveryKey), /simulated failure/); } finally { delete Vault.testHooks.afterHeaderUpdate; }
  assert.deepEqual(snapshot(path), before);
  const v = await Vault.unlock(path, { password: PASSWORD }); v.lock();
  await assert.rejects(Vault.unlock(path, { password: NEW_PW }), DecryptionError);
});

test('a concurrent header change is detected (compare-before-write) and not overwritten', async () => {
  const { path, recoveryKey } = await populated();
  const h = JSON.parse(snapshot(path).meta.header) as VaultHeader;
  const concurrent = JSON.stringify({ ...h, createdAt: '1999-12-31T00:00:00.000Z' });
  Vault.testHooks.beforeHeaderCommit = () => setMeta(path, 'header', concurrent);
  try { await assert.rejects(reset(path, recoveryKey), /changed during the reset/); } finally { delete Vault.testHooks.beforeHeaderCommit; }
  assert.equal(snapshot(path).meta.header, concurrent);
});
