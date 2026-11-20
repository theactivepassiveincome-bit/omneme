// New-computer recovery from the USB backup folder (Stage 3 phase 3). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { importLocal } from '../src/importers/localFiles.ts';
import { recoverFromUsb, vaultSummary, findBackups } from '../src/recovery.ts';
import { tmp, writeChatgptZip, writeClaudeZip, TEST_KDF_N } from './helpers.ts';

const PASSWORD = 'synthetic recovery password';
const BIN = join(import.meta.dirname, '..', 'bin', 'omneme.mjs');

async function world() {
  const d = tmp();
  const vaultPath = join(d, 'old-pc', 'vault.omneme');
  const { vault: v, recoveryKey } = await Vault.create(vaultPath, PASSWORD, { kdfN: TEST_KDF_N });
  await importExport(v, writeChatgptZip(d)); await importExport(v, writeClaudeZip(d));
  mkdirSync(join(d, 'files')); writeFileSync(join(d, 'files', 'notes.bin'), randomBytes(300_000)); writeFileSync(join(d, 'files', 'plan.txt'), 'synthetic plan text');
  await importLocal(v, join(d, 'files'));
  const usb = join(d, 'E'); const folder = join(usb, 'Omneme-Backups'); mkdirSync(folder, { recursive: true });
  const backup = (name: string, createdAt: string, manifest = true) => {
    const s = v.exportBackup(join(folder, name));
    if (manifest) writeFileSync(join(folder, `${name}.json`), JSON.stringify({ file: name, size: s.size, sha256: s.sha256, records: s.records, createdAt }));
    return s;
  };
  const original = vaultSummary(v);
  return { d, v, vaultPath, recoveryKey, usb, folder, backup, original, say: [] as string[] };
}
const opts = (w: Awaited<ReturnType<typeof world>>, target: string, creds: any = { password: PASSWORD }) =>
  ({ say: (s: string) => w.say.push(s), credentials: async () => creds, target });

test('recovers the newest verified backup into a new vault; records, files and search identical to the original', async () => {
  const w = await world();
  w.backup('omneme-20261101T000000Z.omnbak', '2026-11-01T00:00:00Z');
  w.backup('omneme-20261108T000000Z.omnbak', '2026-11-08T00:00:00Z');
  w.v.lock();
  process.env.OMNEME_SEARCH_ROOTS = join(w.d, 'no-such-drive') + (process.platform === 'win32' ? ';' : ':') + w.usb;
  try {
    const target = join(w.d, 'new-pc', '.omneme', 'vault.omneme');
    const r = await recoverFromUsb(opts(w, target));
    assert.equal(r.backup.file, 'omneme-20261108T000000Z.omnbak');
    assert.deepEqual(r.summary, w.original, 'recovered vault equals the original (records, files, fingerprints, search)');
    assert.ok(w.original.archivedFiles >= 2 && w.original.messages > 0);
    assert.match(w.original.searchProbe, /^(\d+)\/\1$/, 'every sample message is found by search');
    assert.ok(w.say.some((l) => l.includes('RECOVERY SUCCESSFUL')));
  } finally { delete process.env.OMNEME_SEARCH_ROOTS; }
});

test('damaged newest backup: falls back to the next one and reports the problem; never overwrites a vault', async () => {
  const w = await world();
  w.backup('omneme-20261101T000000Z.omnbak', '2026-11-01T00:00:00Z');
  w.backup('omneme-20261108T000000Z.omnbak', '2026-11-08T00:00:00Z');
  w.v.lock();
  const bad = join(w.folder, 'omneme-20261108T000000Z.omnbak'); const b = readFileSync(bad); b[Math.floor(b.length / 2)] ^= 1; writeFileSync(bad, b);
  const target = join(w.d, 'new', 'vault.omneme');
  const r = await recoverFromUsb({ ...opts(w, target), from: w.folder });
  assert.equal(r.backup.file, 'omneme-20261101T000000Z.omnbak');
  assert.equal(r.problems.length, 1);
  assert.deepEqual(r.summary.fingerprint, w.original.fingerprint);
  await assert.rejects(recoverFromUsb({ ...opts(w, target), from: w.folder }), /never overwrites/);
});

test('newest backup with a damaged key header is skipped (not mistaken for a wrong password)', async () => {
  const w = await world();
  w.backup('omneme-20261101T000000Z.omnbak', '2026-11-01T00:00:00Z');
  w.backup('omneme-20261108T000000Z.omnbak', '2026-11-08T00:00:00Z'); w.v.lock();
  const bad = join(w.folder, 'omneme-20261108T000000Z.omnbak'); const b = readFileSync(bad);
  const i = b.indexOf(Buffer.from('"wrapped":"')) + 20; b[i] = b[i] === 0x41 ? 0x42 : 0x41; writeFileSync(bad, b);
  const r = await recoverFromUsb({ ...opts(w, join(w.d, 'n', 'v.omneme')), from: w.folder });
  assert.equal(r.backup.file, 'omneme-20261101T000000Z.omnbak');
  assert.match(r.problems[0], /Incorrect password or corrupted/);
});

test('backups without a completion record are tried last; a truncated one is refused', async () => {
  const w = await world();
  w.backup('omneme-20261101T000000Z.omnbak', '2026-11-01T00:00:00Z');
  w.backup('omneme-20261109T000000Z.omnbak', '', false);
  w.v.lock();
  const found = findBackups([w.folder]);
  assert.deepEqual(found.map((f) => f.status), ['complete', 'no-manifest']);
  const r = await recoverFromUsb({ ...opts(w, join(w.d, 'n', 'v.omneme')), from: w.folder });
  assert.equal(r.backup.file, 'omneme-20261101T000000Z.omnbak');
});

test('only a manifest-less backup left: it is still fully authenticated and restored', async () => {
  const w = await world();
  w.backup('omneme-20261109T000000Z.omnbak', '', false); w.v.lock();
  const r = await recoverFromUsb({ ...opts(w, join(w.d, 'n', 'v.omneme')), from: w.folder });
  assert.equal(r.summary.fingerprint, w.original.fingerprint);
});

test('wrong password stops at once with a clear message and leaves nothing; recovery key works', async () => {
  const w = await world();
  w.backup('omneme-20261108T000000Z.omnbak', '2026-11-08T00:00:00Z'); w.v.lock();
  const target = join(w.d, 'n', 'v.omneme');
  await assert.rejects(recoverFromUsb({ ...opts(w, target, { password: 'wrong' }), from: w.folder }), /not correct/);
  assert.ok(!existsSync(target));
  const r = await recoverFromUsb({ ...opts(w, target, { recoveryKey: w.recoveryKey }), from: w.folder });
  assert.equal(r.summary.fingerprint, w.original.fingerprint);
});

test('no USB drive or empty folder: clear guidance, nothing created', async () => {
  const w = await world(); w.v.lock();
  process.env.OMNEME_SEARCH_ROOTS = join(w.d, 'nothing-here');
  try { await assert.rejects(recoverFromUsb(opts(w, join(w.d, 'n', 'v.omneme'))), /Plug in the USB backup drive/); }
  finally { delete process.env.OMNEME_SEARCH_ROOTS; }
  await assert.rejects(recoverFromUsb({ ...opts(w, join(w.d, 'n', 'v.omneme')), from: w.folder }), /no Omneme backups/);
});

test('clean computer: CLI recover-usb with an empty profile, no settings, restores into ~/.omneme and writes a content-free report', async () => {
  const w = await world();
  w.backup('omneme-20261108T000000Z.omnbak', '2026-11-08T00:00:00Z'); w.v.lock();
  const home = join(w.d, 'fresh-profile'); mkdirSync(home);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), OMNEME_PASSWORD: PASSWORD, OMNEME_SEARCH_ROOTS: w.usb } as NodeJS.ProcessEnv;
  mkdirSync(env.TEMP!);
  const report = join(home, 'recovery-report.json');
  const p = spawnSync(process.execPath, ['--no-warnings', BIN, 'recover-usb', '--report', report], { env, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.ok(existsSync(join(home, '.omneme', 'vault.omneme')));
  assert.deepEqual(readdirSync(join(home, '.omneme')).sort(), ['vault.omneme', 'vault.omneme.owner'], 'only the recovered vault and its non-secret ownership guard are created');
  const rep = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(rep.summary.fingerprint, w.original.fingerprint);
  const text = readFileSync(report, 'utf8') + p.stdout;
  assert.ok(!text.includes(PASSWORD) && !text.includes('synthetic plan text'), 'no password or content in report/output');
  // A second run never overwrites: it restores beside the existing vault.
  const p2 = spawnSync(process.execPath, ['--no-warnings', BIN, 'recover-usb'], { env, encoding: 'utf8' });
  assert.equal(p2.status, 0, p2.stdout + p2.stderr);
  assert.equal(readdirSync(join(home, '.omneme')).filter((f) => /^vault-recovered-.*\.omneme$/.test(f)).length, 1);
  // vault-summary on the recovered vault matches the original.
  const s = spawnSync(process.execPath, ['--no-warnings', BIN, 'vault-summary', '--json', '--vault', join(home, '.omneme', 'vault.omneme')], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(s.stdout), w.original);
  const c = spawnSync(process.execPath, ['--no-warnings', BIN, 'vault-compare', '--vault', w.vaultPath, '--other', join(home, '.omneme', 'vault.omneme')], { env, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stdout + c.stderr); assert.match(c.stdout, /RESULT: IDENTICAL/);
});
