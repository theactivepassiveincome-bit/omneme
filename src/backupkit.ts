// Owner-controlled backup workflow: write a new encrypted backup straight to its destinations, verify every copy by a
// full download and a complete authentication pass, record a manifest, warn about overdue offline copies, run restore
// drills, and recover on a new machine. Destinations are local folders (for example a USB drive) or rclone remotes.
//
// Safety rules enforced here (not just documented):
// - Nothing is ever deleted, moved, overwritten or synced on a destination. rclone is called only with an allowlist of
//   read/copy subcommands, and copies use --immutable; folders use exclusive creation and refuse to rename over a file.
// - No password, recovery key or rclone credential is written to manifests, state, logs or child-process environments.
// - Backups are written directly to a destination: no extra full-size temporary copy on the system drive.
import { spawn } from 'node:child_process';
import { copyFileSync, constants as fsc, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { Vault, type Credentials } from './vault.ts';
import { contentHash } from './schema.ts';

export const MANIFEST_FORMAT = 'omneme.backup-manifest/1';
const SECRET_ENV = /^(OMNEME_PASSWORD|OMNEME_RECOVERY_KEY|OMNEME_.*SECRET.*)$/;

export interface FolderDest { name: string; kind: 'folder'; path: string; offline?: boolean; overdueDays?: number; label?: string;
  /** The removable drive's root; the destination counts as connected only if it exists. Default: the path's drive (Windows). */
  driveRoot?: string }
export interface RcloneDest { name: string; kind: 'rclone'; remote: string; offline?: boolean; overdueDays?: number; label?: string }
export type DestConfig = FolderDest | RcloneDest;
export interface BackupConfig {
  version: 1; destinations: DestConfig[]; rclone?: string; rcloneConfig?: string;
  fullCheckDays?: number; drillDays?: number; drillDir?: string; minFreeMarginBytes?: number;
}
export interface Manifest { format: string; file: string; size: number; sha256: string; records: number; chunks: number; createdAt: string; verifiedAt: string; omnemeVersion: string }
export interface Ui { say(s: string): void; ask(q: string): Promise<string>; credentials(): Promise<Credentials> }
export interface CopyResult { dest: string; status: 'OK' | 'FAILED' | 'SKIPPED'; detail: string; file?: string }

export const defaultConfigPath = () => process.env.OMNEME_BACKUP_CONFIG ?? join(homedir(), '.omneme', 'backup-config.json');
const statePathFor = (cfgPath: string) => join(dirname(cfgPath), 'backup-state.json');
const VERSION = '0.2.0';
const now = () => new Date();
const stamp = (d = now()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261109T071500Z
const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

export function loadConfig(path = defaultConfigPath()): BackupConfig {
  if (!existsSync(path)) throw new Error(`No backup configuration at ${path}. Run "omneme backup-setup" first.`);
  const c = JSON.parse(readFileSync(path, 'utf8')) as BackupConfig;
  if (c.version !== 1 || !Array.isArray(c.destinations) || !c.destinations.length) throw new Error('Backup configuration is not valid');
  const names = new Set<string>();
  for (const d of c.destinations) {
    if (!/^[a-z0-9-]{1,32}$/.test(d.name) || names.has(d.name)) throw new Error(`Invalid or duplicate destination name: ${d.name}`);
    names.add(d.name);
    if (d.kind === 'folder' && !d.path) throw new Error(`Destination ${d.name}: folder path missing`);
    if (d.kind === 'rclone' && !/^[A-Za-z0-9_.-]+:/.test(d.remote)) throw new Error(`Destination ${d.name}: rclone remote must look like name:folder`);
    if (d.kind !== 'folder' && d.kind !== 'rclone') throw new Error(`Destination ${(d as DestConfig).name}: unknown kind`);
  }
  return c;
}

interface State {
  approvals: Record<string, string>;
  copies: Record<string, Record<string, { at: string; size: number; sha256: string; fullVerifiedAt?: string; result: string }>>;
  lastDrill?: { at: string; dest: string; file: string; result: string };
}
function loadState(cfgPath: string): State {
  const p = statePathFor(cfgPath);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { approvals: {}, copies: {} };
}
function saveState(cfgPath: string, s: State) {
  const p = statePathFor(cfgPath), tmp = `${p}.tmp-${process.pid}`;
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 }); renameSync(tmp, p);
}

// ---------------- rclone, restricted ----------------
const RCLONE_ALLOWED = new Set(['version', 'listremotes', 'about', 'lsjson', 'copyto', 'cat', 'rcat', 'hashsum', 'mkdir']);
export function childEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) e[k] = v;
  return e;
}
export class Rclone {
  readonly bin: string; readonly configPath?: string;
  constructor(bin: string, configPath?: string) { this.bin = bin; this.configPath = configPath; }
  private args(sub: string, rest: string[]) {
    if (!RCLONE_ALLOWED.has(sub)) throw new Error(`rclone ${sub} is not allowed by Omneme (destinations are never modified destructively)`);
    return [sub, ...(this.configPath ? ['--config', this.configPath] : []), '--retries', '3', '--low-level-retries', '10', ...rest];
  }
  spawn(sub: string, rest: string[], stdio: ('pipe' | 'ignore')[] = ['ignore', 'pipe', 'pipe']) {
    return spawn(this.bin, this.args(sub, rest), { env: childEnv(), stdio, windowsHide: true });
  }
  run(sub: string, rest: string[], input?: Buffer): Promise<{ code: number; out: string; err: string }> {
    return new Promise((ok, fail) => {
      const p = this.spawn(sub, rest, [input ? 'pipe' : 'ignore', 'pipe', 'pipe']);
      let out = '', err = '';
      p.stdout!.on('data', (b) => (out += b)); p.stderr!.on('data', (b) => (err += b));
      p.on('error', fail); p.on('close', (code) => ok({ code: code ?? 1, out, err: err.trim().split('\n').slice(-3).join(' | ') }));
      if (input) p.stdin!.end(input);
    });
  }
}

// ---------------- destinations ----------------
export interface Dest {
  cfg: DestConfig; describe: string;
  available(): Promise<{ ok: boolean; why?: string; free?: number }>;
  list(): Promise<{ name: string; size: number }[]>;
  exists(name: string): Promise<boolean>;
  /** Write the new backup directly here (primary). */
  writeBackup(name: string, v: Vault): Promise<{ sha256: string; size: number; records: number; chunks: number }>;
  copyFrom(src: Dest, name: string): Promise<void>;
  read(name: string): Readable;
  putSmall(name: string, text: string): Promise<void>;
  remoteSha256(name: string): Promise<string | null>;
}

class FolderDestination implements Dest {
  readonly cfg: FolderDest;
  constructor(cfg: FolderDest) { this.cfg = cfg; }
  get describe() { return `${this.cfg.label ?? 'Folder'} ${this.cfg.path}`; }
  private p(n: string) { return join(this.cfg.path, n); }
  async available() {
    // The folder's drive must be present (USB plugged in). The folder (and missing parents) are created on first approved use.
    const drive = this.cfg.driveRoot ?? (process.platform === 'win32' ? parse(this.cfg.path).root : null);
    if (drive && !existsSync(drive)) return { ok: false, why: `not connected (drive ${drive} not found)` };
    let root = this.cfg.path;
    while (!existsSync(root) && dirname(root) !== root) root = dirname(root);
    if (!existsSync(root)) return { ok: false, why: 'not connected (drive not found)' };
    try { const s = statfsSync(root); return { ok: true, free: Number(s.bavail) * Number(s.bsize) }; } catch (e) { return { ok: false, why: (e as Error).message }; }
  }
  async list() {
    if (!existsSync(this.cfg.path)) return [];
    return readdirSync(this.cfg.path).map((n) => ({ name: n, size: statSync(this.p(n)).size }));
  }
  async exists(n: string) { return existsSync(this.p(n)); }
  async writeBackup(n: string, v: Vault) { mkdirSync(this.cfg.path, { recursive: true }); return v.exportBackup(this.p(n)); }
  async copyFrom(src: Dest, n: string) {
    mkdirSync(this.cfg.path, { recursive: true });
    if (existsSync(this.p(n))) throw new Error('a file with this name already exists; not overwriting');
    const tmp = `${this.p(n)}.partial-${process.pid}-${Date.now().toString(36)}`;
    if (src instanceof FolderDestination) copyFileSync(src.p(n), tmp, fsc.COPYFILE_EXCL);
    else await streamToFile(src.read(n), tmp);
    if (existsSync(this.p(n))) throw new Error('a file with this name appeared; not overwriting');
    renameSync(tmp, this.p(n));
  }
  read(n: string) { return createReadStream(this.p(n)); }
  async putSmall(n: string, text: string) {
    mkdirSync(this.cfg.path, { recursive: true });
    const fd = openSync(this.p(n), 'wx', 0o600); try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  }
  async remoteSha256() { return null; }
}

class RcloneDestination implements Dest {
  readonly cfg: RcloneDest; readonly rc: Rclone;
  constructor(cfg: RcloneDest, rc: Rclone) { this.cfg = cfg; this.rc = rc; }
  get describe() { return `${this.cfg.label ?? 'rclone remote'} ${this.cfg.remote}`; }
  private r(n: string) { return `${this.cfg.remote.replace(/\/$/, '')}/${n}`; }
  async available() {
    const remoteRoot = this.cfg.remote.split(':')[0] + ':';
    const a = await this.rc.run('about', [remoteRoot, '--json']).catch((e) => ({ code: 1, out: '', err: String(e) }));
    if (a.code !== 0) {
      const l = await this.rc.run('lsjson', [remoteRoot, '--max-depth', '1']).catch((e) => ({ code: 1, out: '', err: String(e) }));
      return l.code === 0 ? { ok: true } : { ok: false, why: `unreachable: ${l.err || a.err}` };
    }
    try { const j = JSON.parse(a.out); return { ok: true, free: typeof j.free === 'number' ? j.free : undefined }; } catch { return { ok: true }; }
  }
  async list() {
    const l = await this.rc.run('lsjson', [this.cfg.remote, '--files-only']);
    if (l.code !== 0) { if (/not found|directory not found/i.test(l.err)) return []; throw new Error(`cannot list ${this.cfg.remote}: ${l.err}`); }
    return (JSON.parse(l.out) as { Name: string; Size: number }[]).map((x) => ({ name: x.Name, size: x.Size }));
  }
  async exists(n: string) { return (await this.list()).some((x) => x.name === n); }
  async writeBackup(n: string, v: Vault) {
    if (await this.exists(n)) throw new Error('a file with this name already exists; not overwriting');
    const p = this.rc.spawn('rcat', [this.r(n)], ['pipe', 'ignore', 'pipe']);
    let err = ''; p.stderr!.on('data', (b) => (err += b));
    const done = new Promise<number>((ok) => p.on('close', (c) => ok(c ?? 1)));
    p.on('error', () => {});
    const sum = await v.exportBackupToStream(p.stdin!).catch((e) => { p.kill(); throw e; });
    const code = await done;
    if (code !== 0) throw new Error(`upload failed: ${err.trim().split('\n').slice(-2).join(' | ')}`);
    return sum;
  }
  async copyFrom(src: Dest, n: string) {
    if (await this.exists(n)) throw new Error('a file with this name already exists; not overwriting');
    const from = src instanceof FolderDestination ? join(src.cfg.path, n) : (src as RcloneDestination).r(n);
    const r = await this.rc.run('copyto', ['--immutable', from, this.r(n)]);
    if (r.code !== 0) throw new Error(`upload failed: ${r.err}`);
  }
  read(n: string) {
    const p = this.rc.spawn('cat', [this.r(n)]);
    let err = ''; p.stderr!.on('data', (b) => (err += b));
    p.on('close', (code) => { if (code) p.stdout!.destroy(new Error(`download failed: ${err.trim().split('\n').slice(-2).join(' | ')}`)); });
    return p.stdout!;
  }
  async putSmall(n: string, text: string) {
    if (await this.exists(n)) throw new Error(`${n} already exists; not overwriting`);
    const r = await this.rc.run('rcat', [this.r(n)], Buffer.from(text));
    if (r.code !== 0) throw new Error(`upload failed: ${r.err}`);
  }
  async remoteSha256(n: string) {
    const r = await this.rc.run('hashsum', ['SHA-256', this.r(n)]);
    const h = r.code === 0 ? r.out.trim().split(/\s+/)[0] : '';
    return /^[0-9a-f]{64}$/.test(h) ? h : null;
  }
}

function streamToFile(src: Readable, path: string): Promise<void> {
  return new Promise((ok, fail) => {
    const fd = openSync(path, 'wx', 0o600); let failed = false;
    src.on('data', (b: Buffer) => { try { writeSync(fd, b); } catch (e) { failed = true; src.destroy(e as Error); } });
    src.on('error', (e) => { closeSync(fd); fail(e); });
    src.on('end', () => { if (!failed) { fsyncSync(fd); closeSync(fd); ok(); } });
  });
}

export function makeDest(d: DestConfig, rc: Rclone | null): Dest {
  if (d.kind === 'folder') return new FolderDestination(d);
  if (!rc) throw new Error(`Destination ${d.name} needs rclone, but no rclone executable is configured`);
  return new RcloneDestination(d, rc);
}

// ---------------- workflow ----------------
export interface Kit { cfg: BackupConfig; cfgPath: string; dests: Dest[]; state: State; ui: Ui; vaultPath: string }
export function openKit(ui: Ui, vaultPath: string, cfgPath = defaultConfigPath()): Kit {
  const cfg = loadConfig(cfgPath);
  const rc = cfg.rclone ? new Rclone(cfg.rclone, cfg.rcloneConfig) : null;
  return { cfg, cfgPath, dests: cfg.destinations.map((d) => makeDest(d, rc)), state: loadState(cfgPath), ui, vaultPath };
}

const manifestName = (f: string) => `${f}.json`;
const isBackup = (n: string) => /^omneme-\d{8}T\d{6}Z\.omnbak$/.test(n);

/** Preflight: availability, free space, approval. Returns the destinations to write to. */
export async function preflight(k: Kit, needed: number, assumeYes: string[] = []): Promise<{ ready: Dest[]; results: CopyResult[] }> {
  const margin = k.cfg.minFreeMarginBytes ?? 1e9;
  const ready: Dest[] = [], results: CopyResult[] = [];
  k.ui.say(`Backup size needed: about ${gb(needed)} per destination (plus ${gb(margin)} safety margin).`);
  for (const d of k.dests) {
    const a = await d.available();
    if (!a.ok) { results.push({ dest: d.cfg.name, status: 'SKIPPED', detail: `${d.describe}: ${a.why}` }); k.ui.say(`  - ${d.cfg.name}: ${d.describe} — NOT AVAILABLE (${a.why})`); continue; }
    const freeTxt = a.free === undefined ? 'free space not reported' : `${gb(a.free)} free`;
    k.ui.say(`  - ${d.cfg.name}: ${d.describe} — available, ${freeTxt}`);
    if (a.free !== undefined && a.free < needed + margin) {
      results.push({ dest: d.cfg.name, status: 'FAILED', detail: `insufficient space: ${gb(a.free)} free, ${gb(needed + margin)} needed` }); continue;
    }
    if (!k.state.approvals[d.cfg.name]) {
      const yes = assumeYes.includes(d.cfg.name) ? 'YES' : await k.ui.ask(`First use of "${d.cfg.name}" (${d.describe}). Omneme will only ADD new files there, never change or delete anything. Type YES to allow: `);
      if (yes.trim() !== 'YES') { results.push({ dest: d.cfg.name, status: 'SKIPPED', detail: 'not approved by owner' }); continue; }
      k.state.approvals[d.cfg.name] = now().toISOString(); saveState(k.cfgPath, k.state);
    }
    ready.push(d);
  }
  return { ready, results };
}

/** Full verification of one copy: download/read every byte, authenticate everything, compare with the manifest values. */
export async function verifyCopy(d: Dest, file: string, expect: { sha256: string; size: number }, creds: Credentials) {
  const r = await Vault.verifyBackup(d.read(file), creds);
  if (r.size !== expect.size) throw new Error(`size mismatch (${r.size} bytes, expected ${expect.size})`);
  if (r.sha256 !== expect.sha256) throw new Error('SHA-256 mismatch (corrupted copy)');
  return r;
}

export async function runBackup(k: Kit, opts: { assumeYes?: string[]; drill?: boolean | 'ask' } = {}): Promise<{ file: string | null; results: CopyResult[] }> {
  const ui = k.ui;
  const lastSize = Math.max(0, ...Object.values(k.state.copies).flatMap((c) => Object.values(c).map((x) => x.size)));
  const needed = Math.max(lastSize, existsSync(k.vaultPath) ? Math.ceil(statSync(k.vaultPath).size * 1.4) : 0);
  ui.say('Omneme backup — preflight');
  const { ready, results } = await preflight(k, needed, opts.assumeYes);
  if (!ready.length) { ui.say('No destination is available and approved. Nothing was written.'); report(ui, results); return { file: null, results }; }
  const creds = await ui.credentials();
  const v = await Vault.unlock(k.vaultPath, creds);
  let file: string | null = null, sum: { sha256: string; size: number; records: number; chunks: number } | null = null, primary: Dest | null = null;
  try {
    const vr = v.verify(contentHash);
    if (vr.failed || !vr.recordSetOk || vr.blobsFailed) throw new Error(`vault verification failed (${vr.failed} records, ${vr.blobsFailed} blobs); no backup written`);
    ui.say(`Vault verified: ${vr.total} records intact.`);
    file = `omneme-${stamp()}.omnbak`;
    // Primary: a folder (USB) if one is ready, else the first remote, written directly with no local temporary copy.
    const order = [...ready.filter((d) => d.cfg.kind === 'folder'), ...ready.filter((d) => d.cfg.kind !== 'folder')];
    for (const d of order) {
      try { ui.say(`Writing ${file} to ${d.cfg.name}...`); sum = await d.writeBackup(file, v); primary = d; break; }
      catch (e) { results.push({ dest: d.cfg.name, status: 'FAILED', detail: `write failed: ${(e as Error).message}`, file }); }
    }
  } finally { v.lock(); }
  if (!primary || !sum || !file) { ui.say('The backup could not be written to any destination.'); report(ui, results); return { file: null, results }; }
  const manifest: Manifest = { format: MANIFEST_FORMAT, file, size: sum.size, sha256: sum.sha256, records: sum.records, chunks: sum.chunks,
    createdAt: now().toISOString(), verifiedAt: '', omnemeVersion: VERSION };
  const finish = async (d: Dest) => {
    // Full check of this copy before its manifest (the completion marker) is written.
    ui.say(`Verifying ${d.cfg.name} copy by reading it back completely...`);
    const remote = await d.remoteSha256(file!);
    if (remote && remote !== sum!.sha256) throw new Error('provider-reported SHA-256 differs (corrupted upload)');
    await verifyCopy(d, file!, sum!, creds);
    await d.putSmall(manifestName(file!), JSON.stringify({ ...manifest, verifiedAt: now().toISOString() }, null, 2));
    (k.state.copies[file!] ??= {})[d.cfg.name] = { at: now().toISOString(), size: sum!.size, sha256: sum!.sha256, fullVerifiedAt: now().toISOString(), result: 'OK' };
    saveState(k.cfgPath, k.state);
    results.push({ dest: d.cfg.name, status: 'OK', detail: `written and fully verified (${gb(sum!.size)}, ${sum!.records} records${remote ? ', provider SHA-256 matches' : ''})`, file: file! });
  };
  try { await finish(primary); } catch (e) { results.push({ dest: primary.cfg.name, status: 'FAILED', detail: `verification failed: ${(e as Error).message}`, file }); }
  for (const d of ready) {
    if (d === primary) continue;
    try { ui.say(`Copying to ${d.cfg.name}...`); await d.copyFrom(primary, file); await finish(d); }
    catch (e) { results.push({ dest: d.cfg.name, status: 'FAILED', detail: (e as Error).message, file }); }
  }
  report(ui, results);
  await overdueWarnings(k);
  if (opts.drill !== false && drillDue(k)) {
    const last = k.state.lastDrill ? `last one ${k.state.lastDrill.at.slice(0, 10)}, ${k.state.lastDrill.result.startsWith('OK') ? 'passed' : 'failed'}` : 'none done yet';
    const go = opts.drill === 'ask'
      ? (await ui.ask(`\nA restore test is due (${last}). It restores this backup into a temporary vault in ${k.cfg.drillDir ?? tmpdir()}, checks every record, compares it with your live vault, then removes the temporary vault. It takes a few minutes. Type YES to run it now, or press Enter to skip: `)).trim() === 'YES'
      : true;
    if (go) await drill(k, { creds }).catch((e) => ui.say(`Restore drill could not run: ${(e as Error).message}`));
    else ui.say('Restore test skipped. You can run it at any time with: node bin/omneme.mjs backup-drill');
  }
  advice(k);
  return { file, results };
}

function report(ui: Ui, results: CopyResult[]) {
  ui.say('\nResult by destination:');
  for (const r of results) ui.say(`  [${r.status}] ${r.dest}: ${r.detail}`);
}

// ---------------- checking existing backups ----------------
export interface CheckItem { dest: string; file: string; status: 'OK' | 'OK (quick)' | 'NO-MANIFEST' | 'MISSING' | 'SIZE-MISMATCH' | 'CORRUPT' | 'INCOMPLETE' | 'ERROR'; detail: string }
export async function checkBackups(k: Kit, opts: { full?: boolean } = {}): Promise<{ items: CheckItem[]; unavailable: string[] }> {
  const items: CheckItem[] = [], unavailable: string[] = [];
  const fullDue = (dest: string, file: string) => {
    const c = k.state.copies[file]?.[dest]; const days = k.cfg.fullCheckDays ?? 30;
    return opts.full || !c?.fullVerifiedAt || Date.now() - Date.parse(c.fullVerifiedAt) > days * 864e5;
  };
  let creds: Credentials | null = null;
  for (const d of k.dests) {
    const a = await d.available();
    if (!a.ok) { unavailable.push(`${d.cfg.name} (${a.why})`); continue; }
    let files: { name: string; size: number }[];
    try { files = await d.list(); } catch (e) { items.push({ dest: d.cfg.name, file: '-', status: 'ERROR', detail: (e as Error).message }); continue; }
    const names = new Set(files.map((f) => f.name));
    for (const f of files.filter((x) => /\.omnbak(\.json)?\.(partial|.*\.partial$)/.test(x.name))) items.push({ dest: d.cfg.name, file: f.name, status: 'INCOMPLETE', detail: 'left by an interrupted write; not a usable backup (left untouched)' });
    for (const f of files.filter((x) => x.name.endsWith('.omnbak.json'))) if (!names.has(f.name.slice(0, -5))) items.push({ dest: d.cfg.name, file: f.name.slice(0, -5), status: 'MISSING', detail: 'manifest present but the backup file is missing' });
    for (const f of files.filter((x) => isBackup(x.name))) {
      if (!names.has(manifestName(f.name))) { items.push({ dest: d.cfg.name, file: f.name, status: 'NO-MANIFEST', detail: 'upload or write did not complete (no verified manifest)' }); continue; }
      let m: Manifest;
      try { m = JSON.parse(await readAll(d.read(manifestName(f.name)))); } catch (e) { items.push({ dest: d.cfg.name, file: f.name, status: 'ERROR', detail: `manifest unreadable: ${(e as Error).message}` }); continue; }
      if (m.format !== MANIFEST_FORMAT || m.file !== f.name) { items.push({ dest: d.cfg.name, file: f.name, status: 'ERROR', detail: 'manifest does not describe this file' }); continue; }
      if (f.size !== m.size) { items.push({ dest: d.cfg.name, file: f.name, status: 'SIZE-MISMATCH', detail: `${f.size} bytes, manifest says ${m.size} (truncated or altered)` }); continue; }
      const remote = await d.remoteSha256(f.name);
      if (remote && remote !== m.sha256) { items.push({ dest: d.cfg.name, file: f.name, status: 'CORRUPT', detail: 'provider-reported SHA-256 differs from the manifest' }); continue; }
      if (!fullDue(d.cfg.name, f.name)) { items.push({ dest: d.cfg.name, file: f.name, status: 'OK (quick)', detail: `size${remote ? ' and provider SHA-256' : ''} match; last full check ${k.state.copies[f.name]?.[d.cfg.name]?.fullVerifiedAt}` }); continue; }
      creds ??= await k.ui.credentials();
      try {
        const t = Date.now(); const r = await verifyCopy(d, f.name, m, creds);
        (k.state.copies[f.name] ??= {})[d.cfg.name] = { at: m.createdAt, size: m.size, sha256: m.sha256, fullVerifiedAt: now().toISOString(), result: 'OK' };
        saveState(k.cfgPath, k.state);
        items.push({ dest: d.cfg.name, file: f.name, status: 'OK', detail: `fully read and authenticated: ${r.records} records, ${((Date.now() - t) / 1000).toFixed(1)} s` });
      } catch (e) { items.push({ dest: d.cfg.name, file: f.name, status: 'CORRUPT', detail: (e as Error).message }); }
    }
  }
  k.ui.say('Backup check:');
  for (const u of unavailable) k.ui.say(`  [UNAVAILABLE] ${u}`);
  for (const i of items) k.ui.say(`  [${i.status}] ${i.dest}: ${i.file} — ${i.detail}`);
  if (!items.length && !unavailable.length) k.ui.say('  (no backups found)');
  await overdueWarnings(k);
  return { items, unavailable };
}

function readAll(s: Readable): Promise<string> {
  return new Promise((ok, fail) => { let t = ''; s.on('data', (b) => (t += b)); s.on('end', () => ok(t)); s.on('error', fail); });
}

/** Latest verified backup per destination, from the destinations' own manifests (works on a new machine too). */
export async function latestPerDest(k: Kit): Promise<Record<string, { file: string; createdAt: string } | null | 'unavailable'>> {
  const out: Record<string, { file: string; createdAt: string } | null | 'unavailable'> = {};
  for (const d of k.dests) {
    if (!(await d.available()).ok) { out[d.cfg.name] = 'unavailable'; continue; }
    const ms = (await d.list()).filter((f) => f.name.endsWith('.omnbak.json')).map((f) => f.name).sort();
    out[d.cfg.name] = null;
    for (const m of ms.reverse()) {
      try { const j = JSON.parse(await readAll(d.read(m))) as Manifest; out[d.cfg.name] = { file: j.file, createdAt: j.createdAt }; break; } catch { /* skip */ }
    }
  }
  return out;
}

export async function overdueWarnings(k: Kit): Promise<string[]> {
  const warn: string[] = [];
  for (const d of k.dests) {
    const days = d.cfg.overdueDays ?? 7;
    const fromState = Object.values(k.state.copies).map((c) => c[d.cfg.name]).filter((c) => c?.result === 'OK').map((c) => Date.parse(c!.at));
    const last = fromState.length ? Math.max(...fromState) : 0;
    const age = last ? (Date.now() - last) / 864e5 : Infinity;
    if (age > days) warn.push(`${d.cfg.name} (${d.describe}) is OVERDUE: last verified backup ${last ? `${Math.floor(age)} days ago` : 'never'}; due every ${days} days${d.cfg.offline ? ' — plug in the drive and run: node bin/omneme.mjs backup-run' : ''}`);
  }
  for (const w of warn) k.ui.say(`WARNING: ${w}`);
  return warn;
}

export const SCHEDULE_ADVICE = 'Recommended: back up once a week, and after every significant new import.';
export const RISK_NOTE = 'Limitation: your backups are only on the USB drive. If the computer AND the USB drive are both lost, stolen or destroyed '
  + '(for example in a fire, flood or burglary), your Omneme memory cannot be recovered. Keep the drive unplugged and away from the computer between backups.';
export function advice(k: Pick<Kit, 'ui' | 'cfg'>) {
  k.ui.say(`\n${SCHEDULE_ADVICE}`);
  if (k.cfg.destinations.every((d) => d.kind === 'folder')) k.ui.say(RISK_NOTE);
}

function drillDue(k: Kit) {
  const last = k.state.lastDrill?.result === 'OK' ? Date.parse(k.state.lastDrill.at) : 0;
  return Date.now() - last > (k.cfg.drillDays ?? 30) * 864e5;
}

/**
 * Restore drill: restore the newest verified backup into a NEW temporary vault (from the cloud when the USB drive is
 * absent), open it, verify every record, and compare its record-set commitment with the live vault. Then remove the
 * temporary vault (it is the drill's own file). Refuses to run where there is not enough free space.
 */
export async function drill(k: Kit, opts: { creds?: Credentials; dest?: string } = {}) {
  const latest = await latestPerDest(k);
  const pick = k.dests.find((d) => (!opts.dest || d.cfg.name === opts.dest) && latest[d.cfg.name] && latest[d.cfg.name] !== 'unavailable');
  if (!pick) throw new Error('no available destination holds a verified backup');
  const { file } = latest[pick.cfg.name] as { file: string };
  const m = JSON.parse(await readAll(pick.read(manifestName(file)))) as Manifest;
  const dir = k.cfg.drillDir ?? tmpdir();
  const free = (() => { try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return 0; } })();
  const need = Math.ceil(m.size * 0.85) + (k.cfg.minFreeMarginBytes ?? 1e9);
  if (free < need) throw new Error(`not enough free space for a restore drill in ${dir}: ${gb(free)} free, ${gb(need)} needed (set "drillDir" to the USB drive)`);
  const target = join(dir, `omneme-drill-${stamp()}.omneme`);
  const creds = opts.creds ?? await k.ui.credentials();
  k.ui.say(`Restore drill: ${pick.cfg.name}/${file} -> temporary vault ${target}`);
  const t = Date.now();
  try {
    const r = await Vault.restoreBackup(pick.read(file), target, creds);
    if (r.sha256 !== m.sha256 || r.size !== m.size) throw new Error('restored bytes do not match the manifest');
    const v = await Vault.unlock(target, creds);
    let vr; try { vr = v.verify(contentHash); } finally { v.lock(); }
    k.ui.say(`Restored vault: ${vr.total} records (${vr.ok} verified, ${vr.failed} failed); ${vr.blobs} archived files, ${(vr.blobBytes / 1e9).toFixed(2)} GB (${vr.blobsFailed} failed); record set ${vr.recordSetOk ? 'intact' : 'BROKEN'}`);
    if (vr.failed || !vr.recordSetOk || vr.blobsFailed) throw new Error(`restored vault failed verification (${vr.failed} records, ${vr.blobsFailed} files)`);
    let cmp = 'live vault not compared';
    if (existsSync(k.vaultPath)) {
      const live = await Vault.unlock(k.vaultPath, creds);
      let lv; try { lv = live.verify(contentHash); } finally { live.lock(); }
      k.ui.say(`Live vault (read only): ${lv.total} records (${lv.failed} failed); ${lv.blobs} archived files (${lv.blobsFailed} failed); record set ${lv.recordSetOk ? 'intact' : 'BROKEN'}`);
      k.ui.say(`Fingerprint (all record ids, content hashes and file hashes): restored ${vr.fingerprint.slice(0, 16)}…  live ${lv.fingerprint.slice(0, 16)}…`);
      cmp = lv.fingerprint === vr.fingerprint && lv.total === vr.total && lv.blobs === vr.blobs ? 'identical to the live vault (every record and archived file matches)'
        : `differs from the live vault (live ${lv.total} records, backup ${vr.total}) — expected only if you imported since this backup`;
    }
    const msg = `OK: ${vr.total} records and ${vr.blobs} archived files restored and verified in ${((Date.now() - t) / 1000).toFixed(1)} s; record set ${cmp}`;
    k.state.lastDrill = { at: now().toISOString(), dest: pick.cfg.name, file, result: msg }; saveState(k.cfgPath, k.state);
    k.ui.say(`Restore drill ${msg}`);
    return { ok: true, message: msg, records: r.records };
  } catch (e) {
    k.state.lastDrill = { at: now().toISOString(), dest: pick.cfg.name, file, result: `FAILED: ${(e as Error).message}` }; saveState(k.cfgPath, k.state);
    k.ui.say(`Restore drill FAILED: ${(e as Error).message}`);
    throw e;
  } finally { rmSync(target, { force: true }); rmSync(`${target}.partial`, { force: true }); }
}

/** New-machine recovery: newest verified backup from any available destination, restored into a NEW vault path. */
export async function recover(k: Kit, target: string, opts: { dest?: string } = {}) {
  if (existsSync(target)) throw new Error(`A vault already exists at ${target}; recovery never overwrites. Choose another target.`);
  const latest = await latestPerDest(k);
  const cands = k.dests.filter((d) => (!opts.dest || d.cfg.name === opts.dest) && latest[d.cfg.name] && latest[d.cfg.name] !== 'unavailable')
    .map((d) => ({ d, ...(latest[d.cfg.name] as { file: string; createdAt: string }) })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!cands.length) throw new Error('No available destination holds a verified backup. Plug in the USB drive or check the cloud connection.');
  k.ui.say('Backups found:'); for (const c of cands) k.ui.say(`  ${c.d.cfg.name}: ${c.file} (${c.createdAt})`);
  const creds = await k.ui.credentials();
  for (const c of cands) {
    try {
      const m = JSON.parse(await readAll(c.d.read(manifestName(c.file)))) as Manifest;
      k.ui.say(`Restoring ${c.file} from ${c.d.cfg.name} into ${target} ...`);
      mkdirSync(dirname(target), { recursive: true });
      const r = await Vault.restoreBackup(c.d.read(c.file), target, creds);
      if (r.sha256 !== m.sha256) { rmSync(target, { force: true }); throw new Error('restored bytes do not match the manifest'); }
      const v = await Vault.unlock(target, creds); const vr = v.verify(contentHash); v.lock();
      if (vr.failed || !vr.recordSetOk) throw new Error('restored vault failed verification');
      k.ui.say(`Recovered: ${r.records} records, verified. Vault: ${target}`);
      return { dest: c.d.cfg.name, file: c.file, records: r.records };
    } catch (e) { k.ui.say(`  ${c.d.cfg.name}: ${(e as Error).message} — trying the next copy`); }
  }
  throw new Error('No copy could be recovered.');
}

// ---------------- read-only preview of a backup run ----------------
const fsInfo = (p: string) => { try { const s = statfsSync(p); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; } catch { return null; } };

/**
 * Read-only preview of what a backup run would do: no password, nothing opened for writing, nothing created.
 * Uses the saved configuration if there is one, otherwise the given USB folder.
 */
export function previewBackup(o: { say: (s: string) => void; vaultPath: string; cfgPath?: string; usb?: string; driveRoot?: string; existingDir?: string; drillDir?: string }) {
  const say = o.say, cfgPath = o.cfgPath ?? defaultConfigPath();
  const cfg: BackupConfig | null = existsSync(cfgPath) ? loadConfig(cfgPath) : null;
  const usbPath = o.usb ?? (cfg?.destinations.find((d) => d.kind === 'folder') as FolderDest | undefined)?.path;
  if (!usbPath) throw new Error('backup-preview needs --usb <folder> (no saved backup configuration found)');
  let ok = true;
  const ts = stamp(); const file = `omneme-${ts}.omnbak`;
  say('OMNEME BACKUP PREVIEW (read-only: nothing has been written, created or changed)');
  say(`Prepared: ${now().toISOString()}\n`);
  if (!existsSync(o.vaultPath)) { say(`Live vault: NOT FOUND at ${o.vaultPath}`); return { ok: false }; }
  const vs = statSync(o.vaultPath);
  say('1. Live vault (only read during the backup, never changed)');
  say(`   ${o.vaultPath}`);
  say(`   ${gb(vs.size)}, last changed ${vs.mtime.toISOString()}`);
  let lastBackup = 0, existing: { n: string; size: number }[] = [];
  if (o.existingDir && existsSync(o.existingDir)) {
    existing = readdirSync(o.existingDir).filter((n) => n.endsWith('.omnbak')).map((n) => ({ n, size: statSync(join(o.existingDir!, n)).size }));
    const newest = existing.map((e) => ({ ...e, t: statSync(join(o.existingDir!, e.n)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (newest) lastBackup = newest.size;
  }
  const est = lastBackup ? Math.max(lastBackup, Math.ceil(vs.size * 1.3)) : Math.ceil(vs.size * 1.4);
  const needed = Math.ceil(vs.size * 1.4) + (cfg?.minFreeMarginBytes ?? 1e9);
  say('\n2. Destination: USB drive');
  const root = o.driveRoot ?? (process.platform === 'win32' ? parse(usbPath).root : dirname(usbPath));
  const f = existsSync(root) ? fsInfo(root) : null;
  if (!f) { ok = false; say(`   Drive ${root}: NOT CONNECTED — plug in the USB drive before backing up`); }
  else say(`   Drive ${root}: connected, ${gb(f.free)} free of ${gb(f.total)}`);
  say(`   Folder: ${usbPath}`);
  const inFolder = existsSync(usbPath) ? readdirSync(usbPath) : null;
  say(inFolder === null ? '   The folder does not exist yet; it will be created on the first run.'
    : `   The folder exists and holds ${inFolder.length} item(s); none of them will be changed or removed.`);
  say('\n3. Size and space');
  say(`   Estimated backup size: about ${gb(est)}${lastBackup ? ` (your newest existing backup is ${gb(lastBackup)}; new imports since then add to it)` : ''}`);
  if (f) {
    const enough = f.free >= needed;
    if (!enough) ok = false;
    say(`   Space check: needs ${gb(needed)} free (size allowance plus 1 GB margin) — ${enough ? 'OK' : 'NOT ENOUGH SPACE'}`);
    say(`   Free space on the drive afterwards: about ${gb(f.free - est)} (room for roughly ${Math.floor((f.free - (cfg?.minFreeMarginBytes ?? 1e9)) / est)} more backups of this size)`);
  }
  say('\n4. Files that will be created (new files only; existing files are never overwritten or deleted)');
  say(`   ${join(usbPath, file)}`);
  say('      the encrypted backup (name uses the UTC time of the run, so it will differ slightly). While it is being written it');
  say(`      is called ${file}.partial-<n>, and it is renamed only when complete. An interrupted run leaves that partial file in place.`);
  say(`   ${join(usbPath, file)}.json`);
  say('      the completion record: file name, size, SHA-256 of the encrypted file, record counts, dates, Omneme version.');
  say('      It contains no password, recovery key or conversation content, and is written only after the full read-back check passes.');
  if (!cfg) say(`   ${cfgPath}\n      backup settings (the USB folder, the 7-day reminder, the monthly restore-test offer).`);
  say(`   ${statePathFor(cfgPath)}\n      backup history (dates, sizes, results). No secrets.`);
  const dd = o.drillDir ?? cfg?.drillDir ?? tmpdir(); const df = fsInfo(dd);
  say(`   Only if you accept the restore test: a temporary vault (about ${gb(vs.size)}) in ${dd},`);
  say(`      removed when the test finishes. Free there now: ${df ? gb(df.free) : 'unknown'}.`);
  say('\n5. What happens during the run');
  say('   a) checks the drive is connected and has space; asks you to type YES the first time the USB folder is used;');
  say('   b) asks for your vault password in the window (never stored or logged);');
  say('   c) checks every record in the live vault; stops without writing if anything fails;');
  say('   d) writes the encrypted backup directly to the USB drive (no temporary full-size copy on C:);');
  say('   e) reads the whole backup back from the USB drive and authenticates every part before writing the completion record;');
  say('   f) offers the restore test (monthly);  g) shows the result, the weekly reminder and the limitation below.');
  say('\n6. Not touched');
  say('   - the live vault (read only);');
  if (o.existingDir) say(`   - your existing backups in ${o.existingDir}${existing.length ? ` (${existing.length} file(s), ${gb(existing.reduce((a, e) => a + e.size, 0))})` : ''};`);
  say('   - your recovery key file (never copied next to a backup), original exports, and everything else on the USB drive;');
  say('   - nothing is uploaded; no internet connection, cloud account or rclone is used.');
  say(`\n${SCHEDULE_ADVICE}`);
  say('A reminder is shown when the USB drive has not had a verified backup for more than 7 days.');
  say(RISK_NOTE);
  say(`\nPreview result: ${ok ? 'READY — waiting for your approval. Nothing will be written until you approve and run: node bin/omneme.mjs backup-run' : 'NOT READY — see the items above.'}`);
  return { ok, file, estimate: est, needed, free: f?.free ?? null };
}
