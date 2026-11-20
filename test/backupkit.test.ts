// Owner backup workflow (Stage 3 phase 1). Synthetic data only. rclone tests use rclone's "local" backend as a stand-in
// cloud; they are skipped when no rclone executable is found (set OMNEME_TEST_RCLONE to its path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, truncateSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { openKit, runBackup, checkBackups, drill, recover, overdueWarnings, childEnv, Rclone, makeDest, type BackupConfig, type Ui } from '../src/backupkit.ts';
import { randomBytes } from 'node:crypto';
import { importLocal } from '../src/importers/localFiles.ts';
import { tmp, writeChatgptZip, writeClaudeZip, TEST_KDF_N } from './helpers.ts';

const PASSWORD = 'synthetic backup password';
const rcloneBin = (() => {
  const c = process.env.OMNEME_TEST_RCLONE ?? 'rclone';
  return spawnSync(c, ['version'], { stdio: 'ignore' }).status === 0 ? c : null;
})();
const withRclone = { skip: rcloneBin ? false : 'no rclone executable found (set OMNEME_TEST_RCLONE)' };

function ui(): Ui & { log: string[] } {
  const log: string[] = [];
  return { log, say: (s) => log.push(s), ask: async () => 'NO', credentials: async () => ({ password: PASSWORD }) };
}

async function setup(opts: { cloud?: boolean; usbConnected?: boolean; cloudBroken?: boolean; margin?: number; bigFileBytes?: number } = {}) {
  const d = tmp();
  const vaultPath = join(d, 'home', '.omneme', 'vault.omneme');
  const { vault: v } = await Vault.create(vaultPath, PASSWORD, { kdfN: TEST_KDF_N });
  await importExport(v, writeChatgptZip(d)); await importExport(v, writeClaudeZip(d));
  if (opts.bigFileBytes) { mkdirSync(join(d, 'files')); writeFileSync(join(d, 'files', 'synthetic.bin'), randomBytes(opts.bigFileBytes)); await importLocal(v, join(d, 'files')); }
  const fingerprint = v.loadAll().map((r) => `${r.recordId}:${r.contentHash}`).sort().join('\n');
  v.lock();
  const usbRoot = join(d, 'E-drive'); if (opts.usbConnected !== false) mkdirSync(usbRoot);
  const cloudRoot = join(d, 'cloud'); mkdirSync(cloudRoot);
  const rcloneConf = join(d, 'rclone-config', 'rclone.conf'); mkdirSync(join(d, 'rclone-config'));
  writeFileSync(rcloneConf, '[omneme-gdrive]\ntype = local\n');
  const cfg: BackupConfig = {
    version: 1, rclone: rcloneBin ?? undefined, rcloneConfig: rcloneConf, fullCheckDays: 30, drillDays: 30, drillDir: join(d, 'drill'),
    minFreeMarginBytes: opts.margin ?? 0,
    destinations: [
      { name: 'usb', kind: 'folder', path: join(usbRoot, 'Omneme-Test', 'Omneme-Backups'), driveRoot: usbRoot, offline: true, overdueDays: 30, label: 'USB drive' },
      ...(opts.cloud === false ? [] : [{ name: 'gdrive', kind: 'rclone' as const, remote: `${opts.cloudBroken ? 'no-such-remote' : 'omneme-gdrive'}:${join(cloudRoot, 'Omneme-Encrypted-Backups')}`, overdueDays: 7, label: 'Google Drive (test stand-in)' }]),
    ],
  };
  mkdirSync(join(d, 'drill'));
  const cfgPath = join(d, 'home', '.omneme', 'backup-config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const u = ui();
  return { d, vaultPath, cfgPath, usbRoot, cloudRoot, u, fingerprint, kit: () => openKit(u, vaultPath, cfgPath),
    usbDir: join(usbRoot, 'Omneme-Test', 'Omneme-Backups'), cloudDir: join(cloudRoot, 'Omneme-Encrypted-Backups') };
}
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

test('backup to USB folder only: written directly, verified, manifest last, drill identical', async () => {
  const s = await setup({ cloud: false });
  const r = await runBackup(s.kit(), { assumeYes: ['usb'] });
  assert.deepEqual(r.results.map((x) => [x.dest, x.status]), [['usb', 'OK']]);
  assert.deepEqual(files(s.usbDir), [r.file!, `${r.file}.json`]);
  const m = JSON.parse(readFileSync(join(s.usbDir, `${r.file}.json`), 'utf8'));
  assert.equal(m.size, statSync(join(s.usbDir, r.file!)).size);
  assert.ok(s.u.log.some((l) => /Restore drill OK: \d+ records and \d+ archived files .* identical to the live vault/.test(l)));
  assert.ok(s.u.log.some((l) => /^Restored vault: \d+ records \(\d+ verified, 0 failed\); \d+ archived files.*\(0 failed\); record set intact/.test(l)));
  const fp = s.u.log.find((l) => l.startsWith('Fingerprint'))!; const fm = fp.match(/restored (\w+)….*live (\w+)…/)!; assert.equal(fm[1], fm[2]);
  const drillLeft = files(join(s.d, 'drill'));
  assert.equal(drillLeft.length, 1, `only the persistent drill guard sidecar may remain: ${drillLeft}`);
  assert.match(drillLeft[0], /^omneme-drill-\d{8}T\d{6}Z\.omneme\.owner$/);
  assert.deepEqual(drillLeft.filter((f) => /\.omneme$|partial|creating|journal|wal|shm|omnbak|json/i.test(f)), [], 'drill vault, partials, backups and settings removed/absent');
  assert.equal(readdirSync(join(s.d, 'home', '.omneme')).filter((f) => /omnbak/.test(f)).length, 0, 'no backup copy on the system drive');
});

test('first use needs owner approval; refusal writes nothing', async () => {
  const s = await setup({ cloud: false });
  const r = await runBackup(s.kit(), {});
  assert.equal(r.file, null);
  assert.equal(r.results[0].status, 'SKIPPED'); assert.match(r.results[0].detail, /not approved/);
  assert.deepEqual(files(s.usbDir), []);
});

test('USB + cloud: both verified; cloud copy checked by full download and provider SHA-256', withRclone, async () => {
  const s = await setup();
  const r = await runBackup(s.kit(), { assumeYes: ['usb', 'gdrive'] });
  assert.deepEqual(r.results.map((x) => [x.dest, x.status]), [['usb', 'OK'], ['gdrive', 'OK']], s.u.log.join('\n'));
  assert.match(r.results[1].detail, /provider SHA-256 matches/);
  assert.deepEqual(files(s.cloudDir), [r.file!, `${r.file}.json`]);
});

test('USB disconnected: cloud backup still runs, streamed with no local temporary copy; USB reported and overdue', withRclone, async () => {
  const s = await setup({ usbConnected: false });
  const r = await runBackup(s.kit(), { assumeYes: ['usb', 'gdrive'], drill: false });
  const by = Object.fromEntries(r.results.map((x) => [x.dest, x]));
  assert.equal(by.usb.status, 'SKIPPED'); assert.match(by.usb.detail, /not connected/);
  assert.equal(by.gdrive.status, 'OK');
  assert.ok(s.u.log.some((l) => /WARNING: usb .* OVERDUE: last verified backup never.*plug in the drive/.test(l)));
  // Nothing written anywhere except the cloud folder.
  assert.ok(!existsSync(s.usbRoot));
  const d = await drill(s.kit()); assert.ok(d.ok);
});

test('unavailable cloud remote: USB still succeeds; cloud clearly FAILED/SKIPPED', withRclone, async () => {
  const s = await setup({ cloudBroken: true });
  const r = await runBackup(s.kit(), { assumeYes: ['usb', 'gdrive'], drill: false });
  const by = Object.fromEntries(r.results.map((x) => [x.dest, x]));
  assert.equal(by.usb.status, 'OK');
  assert.notEqual(by.gdrive.status, 'OK'); assert.match(by.gdrive.detail, /unreachable|failed|not found/i);
});

test('insufficient capacity: refused before anything is written', async () => {
  const s = await setup({ cloud: false, margin: 1e15 });
  const r = await runBackup(s.kit(), { assumeYes: ['usb'] });
  assert.equal(r.file, null); assert.equal(r.results[0].status, 'FAILED'); assert.match(r.results[0].detail, /insufficient space/);
  assert.deepEqual(files(s.usbDir), []);
});

test('USB write failure falls back to the cloud as primary', withRclone, async () => {
  const s = await setup();
  mkdirSync(join(s.usbRoot, 'Omneme-Test')); writeFileSync(s.usbDir, 'a file where the folder should be'); // makes every write to the USB folder fail
  const r = await runBackup(s.kit(), { assumeYes: ['usb', 'gdrive'], drill: false });
  const by = Object.fromEntries(r.results.map((x) => [x.dest, x]));
  assert.equal(by.gdrive.status, 'OK'); assert.equal(by.usb.status, 'FAILED');
});

test('checks detect corrupted, truncated, manifest-less and partial copies; quick check alone cannot see silent USB corruption', withRclone, async () => {
  const s = await setup();
  const r = await runBackup(s.kit(), { assumeYes: ['usb', 'gdrive'], drill: false });
  const f = r.file!;
  // Flip one byte in the middle of the USB copy (same size), and in the cloud copy.
  for (const dir of [s.usbDir, s.cloudDir]) { // flip one bit, so the byte always changes
    const p = join(dir, f); const at = Math.floor(statSync(p).size / 2); const b = readFileSync(p); const fd = openSync(p, 'r+'); writeSync(fd, Buffer.from([b[at] ^ 1]), 0, 1, at); closeSync(fd); }
  const quick = await checkBackups(s.kit());
  const q = Object.fromEntries(quick.items.map((i) => [i.dest, i.status]));
  assert.equal(q.usb, 'OK (quick)', 'size-only quick check cannot see a same-size flip on a plain folder');
  assert.equal(q.gdrive, 'CORRUPT', 'provider SHA-256 catches it on the cloud copy');
  const full = await checkBackups(s.kit(), { full: true });
  assert.ok(full.items.filter((i) => i.file === f).every((i) => i.status === 'CORRUPT'), JSON.stringify(full.items));
  // Truncated copy, an orphan backup without manifest, and an interrupted partial file.
  truncateSync(join(s.usbDir, f), 1000);
  writeFileSync(join(s.usbDir, 'omneme-20200101T000000Z.omnbak'), 'no manifest');
  writeFileSync(join(s.usbDir, 'omneme-20200102T000000Z.omnbak.partial-1-x'), 'interrupted');
  const c = await checkBackups(s.kit(), { full: true });
  const st = (file: string) => c.items.find((i) => i.dest === 'usb' && i.file === file)?.status;
  assert.equal(st(f), 'SIZE-MISMATCH');
  assert.equal(st('omneme-20200101T000000Z.omnbak'), 'NO-MANIFEST');
  assert.equal(st('omneme-20200102T000000Z.omnbak.partial-1-x'), 'INCOMPLETE');
  // Nothing was deleted or repaired by the checker.
  assert.ok(existsSync(join(s.usbDir, 'omneme-20200102T000000Z.omnbak.partial-1-x')));
});

test('interrupted cloud upload (process killed mid-transfer) leaves no manifest and is reported, never counted as a backup', withRclone, async () => {
  const s = await setup({ usbConnected: false, bigFileBytes: 3_000_000 });
  // Slow the upload to 400 KB/s so the kill lands mid-transfer (the backup is ~4 MB, above rclone's in-memory streaming cutoff).
  const child = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, '..', 'bin', 'omneme.mjs'), 'backup-run', '--yes', 'usb,gdrive', '--no-drill', '--vault', s.vaultPath],
    { env: { ...process.env, OMNEME_PASSWORD: PASSWORD, OMNEME_BACKUP_CONFIG: s.cfgPath, RCLONE_BWLIMIT: '400k' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (b) => (out += b));
  await new Promise((r) => setTimeout(r, 4000));
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
  else { child.kill('SIGKILL'); spawnSync('pkill', ['-9', '-f', 'rclone.*omneme-gdrive']); }
  await new Promise((r) => child.on('close', r));
  const c = await checkBackups(s.kit(), { full: true });
  assert.ok(!c.items.some((i) => i.status === 'OK'), `${out}\n${JSON.stringify(c.items)}`);
  assert.ok(/Writing omneme-/.test(out), 'the kill happened after the upload had started');
  if (process.env.OMNEME_TEST_VERBOSE) console.log('interrupted-upload leftovers:', files(s.cloudDir), c.items.map((i) => i.status));
  assert.ok(files(s.cloudDir).every((n) => !n.endsWith('.json')), 'no manifest = not a completed backup');
  // A new run afterwards succeeds and never touches the leftovers.
  const before = files(s.cloudDir);
  const r = await runBackup(s.kit(), { assumeYes: ['gdrive'], drill: false });
  assert.equal(r.results.find((x) => x.dest === 'gdrive')!.status, 'OK');
  for (const b of before) assert.ok(files(s.cloudDir).includes(b));
});

test('immutability: a destination never overwrites an existing name; rclone destructive commands are refused', withRclone, async () => {
  const s = await setup();
  const k = s.kit();
  const usb = k.dests[0], cloud = k.dests[1];
  mkdirSync(s.usbDir, { recursive: true }); mkdirSync(s.cloudDir, { recursive: true });
  writeFileSync(join(s.usbDir, 'x.omnbak'), 'original'); writeFileSync(join(s.cloudDir, 'x.omnbak'), 'original');
  await assert.rejects(cloud.copyFrom(usb, 'x.omnbak'), /already exists; not overwriting/);
  await assert.rejects(usb.copyFrom(cloud, 'x.omnbak'), /already exists; not overwriting/);
  await assert.rejects(usb.putSmall('x.omnbak', 'new'), /EEXIST/);
  await assert.rejects(cloud.putSmall('x.omnbak', 'new'), /already exists/);
  assert.equal(readFileSync(join(s.usbDir, 'x.omnbak'), 'utf8'), 'original');
  assert.equal(readFileSync(join(s.cloudDir, 'x.omnbak'), 'utf8'), 'original');
  const rc = new Rclone(rcloneBin!);
  for (const bad of ['delete', 'deletefile', 'purge', 'sync', 'move', 'moveto', 'rmdir', 'rmdirs', 'cleanup', 'dedupe', 'bisync'])
    await assert.rejects(rc.run(bad, []), /not allowed/);
});

test('clean-environment recovery: new machine, fresh config, only the destinations + password; identical records', withRclone, async () => {
  const s = await setup();
  await runBackup(s.kit(), { assumeYes: ['usb', 'gdrive'], drill: false });
  // New machine: no vault, no state; the owner re-creates the config pointing at the same destinations.
  const nm = tmp(); mkdirSync(join(nm, '.omneme'));
  const cfg = JSON.parse(readFileSync(s.cfgPath, 'utf8')); writeFileSync(join(nm, '.omneme', 'backup-config.json'), JSON.stringify(cfg));
  const target = join(nm, '.omneme', 'vault.omneme');
  for (const which of ['gdrive', 'usb']) {
    const t = join(nm, `restored-${which}.omneme`);
    const r = await recover(openKit(ui(), target, join(nm, '.omneme', 'backup-config.json')), t, { dest: which });
    const v = await Vault.unlock(t, { password: PASSWORD });
    assert.equal(v.loadAll().map((x) => `${x.recordId}:${x.contentHash}`).sort().join('\n'), s.fingerprint, which);
    v.lock(); assert.equal(r.dest, which);
  }
  await assert.rejects(recover(openKit(ui(), target, join(nm, '.omneme', 'backup-config.json')), join(nm, 'restored-usb.omneme')), /never overwrites/);
});

test('no secrets in manifests, state, config, logs or child environments; overdue warning for offline drive', withRclone, async () => {
  const s = await setup();
  process.env.OMNEME_PASSWORD = PASSWORD;
  try {
    const env = childEnv(); assert.equal(env.OMNEME_PASSWORD, undefined);
  } finally { delete process.env.OMNEME_PASSWORD; }
  await runBackup(s.kit(), { assumeYes: ['usb', 'gdrive'] });
  const written = [...files(s.usbDir).map((f) => join(s.usbDir, f)), ...files(s.cloudDir).map((f) => join(s.cloudDir, f)),
    s.cfgPath, join(s.d, 'home', '.omneme', 'backup-state.json')];
  for (const f of written) assert.ok(!readFileSync(f).includes(Buffer.from(PASSWORD)), f);
  assert.ok(!s.u.log.join('\n').includes(PASSWORD));
  for (const m of files(s.usbDir).filter((f) => f.endsWith('.json'))) {
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.usbDir, m), 'utf8'))).sort(), ['chunks', 'createdAt', 'file', 'format', 'omnemeVersion', 'records', 'sha256', 'size', 'verifiedAt']);
  }
  // Make the USB copy look 40 days old in the local state: overdue warning appears.
  const sp = join(s.d, 'home', '.omneme', 'backup-state.json'); const st = JSON.parse(readFileSync(sp, 'utf8'));
  for (const c of Object.values(st.copies) as any[]) if (c.usb) c.usb.at = new Date(Date.now() - 40 * 864e5).toISOString();
  writeFileSync(sp, JSON.stringify(st));
  const w = await overdueWarnings(s.kit());
  assert.ok(w.some((x) => /usb .*OVERDUE: last verified backup 40 days ago/.test(x)), w.join('\n'));
  assert.ok(!w.some((x) => /gdrive/.test(x)));
});

// ---------------- USB-only default (no rclone, no cloud) ----------------
import { previewBackup, RISK_NOTE } from '../src/backupkit.ts';

async function usbOnly() {
  const s = await setup({ cloud: false });
  const cfg = JSON.parse(readFileSync(s.cfgPath, 'utf8')) as BackupConfig;
  delete cfg.rclone; delete cfg.rcloneConfig; cfg.destinations[0].overdueDays = 7;
  writeFileSync(s.cfgPath, JSON.stringify(cfg));
  return s;
}
const tree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? [`${e.name}/`, ...tree(join(dir, e.name)).map((x) => `${e.name}/${x}`)] : [`${e.name}:${statSync(join(dir, e.name)).size}`]).sort() : [];

test('USB-only: works with no rclone configured or installed; shows weekly advice and the single-location limitation', async () => {
  const s = await usbOnly();
  const env = process.env.PATH; process.env.PATH = '';
  try {
    const r = await runBackup(s.kit(), { assumeYes: ['usb'], drill: false });
    assert.deepEqual(r.results.map((x) => x.status), ['OK']);
  } finally { process.env.PATH = env; }
  assert.equal(files(s.usbDir).filter((f) => f.endsWith('.omnbak')).length, 1);
  assert.ok(s.u.log.includes(RISK_NOTE));
  assert.ok(s.u.log.some((l) => /once a week/.test(l)));
  const c = await checkBackups(s.kit(), { full: true });
  assert.ok(c.items.every((i) => i.status === 'OK') && !c.unavailable.length);
});

test('restore test is offered, not forced: declining skips it; accepting runs it', async () => {
  const s = await usbOnly();
  await runBackup(s.kit(), { assumeYes: ['usb'], drill: 'ask' });
  assert.ok(s.u.log.some((l) => /Restore test skipped/.test(l)));
  assert.ok(!s.u.log.some((l) => /Restore drill OK/.test(l)));
  s.u.ask = async (q) => (/restore test/i.test(q) ? 'YES' : 'NO');
  await new Promise((r) => setTimeout(r, 1100)); // backup names have one-second resolution
  await runBackup(s.kit(), { assumeYes: ['usb'], drill: 'ask' });
  assert.ok(s.u.log.some((l) => /Restore drill OK/.test(l)));
  assert.equal(files(s.usbDir).filter((f) => f.endsWith('.omnbak')).length, 2, 'second backup added, first kept');
});

test('USB reminder after 7 days', async () => {
  const s = await usbOnly();
  await runBackup(s.kit(), { assumeYes: ['usb'], drill: false });
  assert.deepEqual(await overdueWarnings(s.kit()), []);
  const sp = join(s.d, 'home', '.omneme', 'backup-state.json');
  const st = JSON.parse(readFileSync(sp, 'utf8'));
  for (const c of Object.values(st.copies) as Record<string, { at: string }>[]) c.usb.at = new Date(Date.now() - 8 * 864e5).toISOString();
  writeFileSync(sp, JSON.stringify(st));
  const w = await overdueWarnings(s.kit());
  assert.equal(w.length, 1); assert.match(w[0], /OVERDUE: last verified backup 8 days ago; due every 7 days/);
});

test('backup-preview is read-only and reports paths, size, space and files to be created', async () => {
  const s = await usbOnly();
  const existing = join(s.d, 'existing-backups'); mkdirSync(existing); writeFileSync(join(existing, 'old.omnbak'), 'x'.repeat(1000));
  const before = tree(s.d); const out: string[] = [];
  const cfgPath = join(s.d, 'no-config-yet', 'backup-config.json');
  const r = previewBackup({ say: (t) => out.push(t), vaultPath: s.vaultPath, cfgPath, usb: s.usbDir, driveRoot: s.usbRoot, existingDir: existing, drillDir: join(s.d, 'drill') });
  assert.deepEqual(tree(s.d), before, 'nothing created or changed');
  assert.ok(r.ok);
  const t = out.join('\n');
  for (const want of [s.vaultPath, s.usbDir, `${r.file}.json`, cfgPath, 'does not exist yet', 'Space check', existing, RISK_NOTE, 'READY']) assert.ok(t.includes(want), want);
  const out2: string[] = [];
  const r2 = previewBackup({ say: (x) => out2.push(x), vaultPath: s.vaultPath, cfgPath, usb: join(s.d, 'Z-drive', 'Omneme-Backups'), driveRoot: join(s.d, 'Z-drive') });
  assert.ok(!r2.ok); assert.ok(out2.join('\n').includes('NOT CONNECTED'));
});
