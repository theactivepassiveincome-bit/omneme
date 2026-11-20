// New-computer recovery from the USB drive: find the backups on any drive, pick the newest valid one, restore it into a
// NEW vault (never overwriting anything), verify every record and archived file, and check that search works.
// Needs only the backup, the vault password (or recovery key) and this program: no configuration, BSV, internet or cloud.
// Prints and reports only counts, file names and hashes, never conversation content or secrets.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, statfsSync, mkdirSync, writeFileSync, createReadStream } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { Vault, type Credentials } from './vault.ts';
import { contentHash } from './schema.ts';
import { MemoryIndex, convKey } from './search.ts';

export const BACKUP_FOLDER = 'Omneme-Backups';

export interface FoundBackup {
  folder: string; file: string; path: string; size: number;
  manifest: { sha256: string; size: number; records: number; createdAt: string } | null;
  status: 'complete' | 'no-manifest' | 'size-mismatch';
}

/** Folders to search: the given one, or <drive>:\Omneme-Backups on every drive letter (Windows), or OMNEME_SEARCH_ROOTS. */
export function backupFolders(from?: string): string[] {
  if (from) return existsSync(from) ? [from] : [];
  const roots = process.env.OMNEME_SEARCH_ROOTS?.split(delimiter).filter(Boolean)
    ?? (process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`) : ['/media', '/mnt', '/Volumes']);
  const out: string[] = [];
  for (const r of roots) {
    try {
      if (!existsSync(r)) continue;
      if (existsSync(join(r, BACKUP_FOLDER))) out.push(join(r, BACKUP_FOLDER));
      else if (process.platform !== 'win32') for (const d of readdirSync(r)) if (existsSync(join(r, d, BACKUP_FOLDER))) out.push(join(r, d, BACKUP_FOLDER));
    } catch { /* drive not ready (e.g. empty card reader) */ }
  }
  return out;
}

/** All backups in the folders, newest complete ones first; backups without a valid manifest come last. */
export function findBackups(folders: string[]): FoundBackup[] {
  const all: FoundBackup[] = [];
  for (const folder of folders) {
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { continue; }
    for (const file of names.filter((n) => /\.omnbak$/.test(n))) {
      const path = join(folder, file); let size = 0;
      try { size = statSync(path).size; } catch { continue; }
      let manifest: FoundBackup['manifest'] = null, status: FoundBackup['status'] = 'no-manifest';
      try {
        const m = JSON.parse(readFileSync(`${path}.json`, 'utf8'));
        manifest = { sha256: m.sha256, size: m.size, records: m.records, createdAt: m.createdAt };
        status = m.size === size ? 'complete' : 'size-mismatch';
      } catch { /* no or unreadable manifest */ }
      all.push({ folder, file, path, size, manifest, status });
    }
  }
  const when = (b: FoundBackup) => b.manifest?.createdAt ?? b.file;
  return all.sort((a, b) => (a.status === 'complete' ? 0 : 1) - (b.status === 'complete' ? 0 : 1) || when(b).localeCompare(when(a)));
}

/** Content-free summary of a vault, used to prove a recovered vault equals the original. */
export function vaultSummary(v: Vault) {
  const vr = v.verify(contentHash);
  const records = v.loadAll();
  const ix = new MemoryIndex(records);
  const s = ix.stats();
  // Search fingerprint: every searchable conversation and its message count (keys are ids, not content).
  const per = new Map<string, number>();
  for (const r of ix.messages) per.set(convKey(r), (per.get(convKey(r)) ?? 0) + 1);
  const searchFingerprint = createHash('sha256').update([...per].map(([k, n]) => `${k}=${n}`).sort().join('\n')).digest('hex');
  // Search probe: 20 messages spread across the whole vault; searching two of their words must find each one.
  const msgs = ix.messages.filter((r) => /\p{L}{5,}.*\p{L}{5,}/su.test(r.text ?? '')).sort((a, b) => a.recordId.localeCompare(b.recordId));
  const step = Math.max(1, Math.floor(msgs.length / 20));
  let probeOk = 0, probes = 0;
  for (let i = 0; i < msgs.length && probes < 20; i += step) {
    const m = msgs[i]; probes++;
    const words = (m.text.match(/\p{L}{5,}/gu) ?? []).slice(0, 2).join(' ');
    if (ix.search({ text: words }).some((h) => h.record.recordId === m.recordId)) probeOk++;
  }
  return {
    records: vr.total, verified: vr.ok, failed: vr.failed, recordSetOk: vr.recordSetOk,
    archivedFiles: vr.blobs, archivedFilesFailed: vr.blobsFailed, archivedBytes: vr.blobBytes, fingerprint: vr.fingerprint,
    conversations: s.conversations, messages: s.messages, projects: s.projects, artifacts: s.artifacts,
    perProvider: Object.fromEntries(Object.entries(s.perProvider).sort(([a], [b]) => a.localeCompare(b)).map(([p, c]) => [p, { conversations: c.conversations, messages: c.messages }])),
    searchFingerprint, searchProbe: `${probeOk}/${probes}`,
  };
}
export type VaultSummary = ReturnType<typeof vaultSummary>;

export function printSummary(say: (s: string) => void, s: VaultSummary) {
  say(`  Records:        ${s.records} (${s.verified} verified, ${s.failed} failed); record set ${s.recordSetOk ? 'intact' : 'BROKEN'}`);
  say(`  Archived files: ${s.archivedFiles} (${(s.archivedBytes / 1e9).toFixed(2)} GB, ${s.archivedFilesFailed} failed)`);
  say(`  Searchable:     ${s.conversations} conversations, ${s.messages} messages; ${s.projects} projects, ${s.artifacts} artifacts`);
  for (const [p, c] of Object.entries(s.perProvider)) say(`                  ${p}: ${c.conversations} conversations, ${c.messages} messages`);
  say(`  Search check:   ${s.searchProbe} sample messages found by search`);
  say(`  Fingerprints:   records ${s.fingerprint.slice(0, 16)}…  search ${s.searchFingerprint.slice(0, 16)}…`);
}

const sha256File = (p: string) => new Promise<string>((res, rej) => {
  const h = createHash('sha256'); createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

export interface RecoverOptions {
  say: (s: string) => void; credentials: () => Promise<Credentials>;
  from?: string; target: string; report?: string; file?: string;
}

/**
 * Restore the newest valid backup into a new vault. Falls back to older backups if one is damaged. Never overwrites a
 * vault, never modifies a backup. Returns the summary of the recovered vault.
 */
export async function recoverFromUsb(o: RecoverOptions) {
  const say = o.say;
  if (existsSync(o.target)) throw new Error(`A vault already exists at ${o.target}. Recovery never overwrites; choose another location.`);
  const folders = backupFolders(o.from);
  if (!folders.length) {
    throw new Error(o.from ? `The folder ${o.from} was not found.`
      : `No "${BACKUP_FOLDER}" folder was found on any drive. Plug in the USB backup drive, wait until Windows shows it in File Explorer, then try again.`);
  }
  say(`Backup folders found: ${folders.join(', ')}`);
  let found = findBackups(folders);
  if (o.file) found = found.filter((b) => b.file === o.file || b.path === o.file);
  if (!found.length) throw new Error('The backup folder contains no Omneme backups (.omnbak files).');
  say('Backups (newest valid first):');
  for (const b of found) say(`  ${b.file}  ${(b.size / 1e9).toFixed(2)} GB  ${b.status === 'complete' ? `verified ${b.manifest!.createdAt.slice(0, 10)}, ${b.manifest!.records} records` : b.status === 'no-manifest' ? 'NO completion record (may be incomplete; tried last)' : 'SIZE DIFFERS from its completion record (damaged; tried last)'}  [${b.folder}]`);

  const dir = dirname(o.target); mkdirSync(dir, { recursive: true });
  const free = (() => { try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; } })();
  const need = Math.ceil(found[0].size * 0.85) + 5e8;
  if (free < need) throw new Error(`Not enough free space in ${dir}: ${(free / 1e9).toFixed(2)} GB free, about ${(need / 1e9).toFixed(2)} GB needed.`);

  const creds = await o.credentials();
  const problems: string[] = [];
  let credentialFailures = 0;
  for (const b of found) {
    say(`\nRestoring ${b.file} into ${o.target} ...`);
    const t = Date.now();
    try {
      const r = await Vault.restoreBackup(b.path, o.target, creds);
      if (b.manifest && (r.sha256 !== b.manifest.sha256 || r.size !== b.manifest.size)) throw new Error('the backup does not match its completion record');
      const v = await Vault.unlock(o.target, creds);
      let s: VaultSummary; try { s = vaultSummary(v); } finally { v.lock(); }
      if (s.failed || !s.recordSetOk || s.archivedFilesFailed) throw new Error(`the restored vault failed verification (${s.failed} records, ${s.archivedFilesFailed} files)`);
      say(`Restored and verified in ${((Date.now() - t) / 1000).toFixed(0)} s:`);
      printSummary(say, s);
      const backupSha = r.sha256;
      if (o.report) writeFileSync(o.report, JSON.stringify({ recoveredAt: new Date().toISOString(), backup: b.file, backupFolder: b.folder, backupSha256: backupSha, backupSize: r.size, target: o.target, problems, summary: s }, null, 2));
      say(`\nRECOVERY SUCCESSFUL. Your vault is at: ${o.target}`);
      return { backup: b, summary: s, problems };
    } catch (e) {
      const msg = (e as Error).message;
      // A wrong password and a damaged key header look the same, so try the other backups before concluding.
      if (/Incorrect password|recovery key/i.test(msg)) credentialFailures++;
      problems.push(`${b.file}: ${msg}`);
      say(`  This backup could not be used: ${msg}`);
      if (existsSync(o.target)) throw new Error(`Stopped: a partial vault was left at ${o.target}; move it aside before retrying.`);
      say('  Trying the next older backup...');
    }
  }
  if (credentialFailures === found.length) throw new Error('The password (or recovery key) is not correct for these backups. Nothing was restored. Run the recovery again and re-type it carefully (check Caps Lock), or use the recovery key.');
  throw new Error(`None of the backups could be restored:\n  ${problems.join('\n  ')}`);
}

export { sha256File };
