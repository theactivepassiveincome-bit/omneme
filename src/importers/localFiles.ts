// Stage 1.3: import ordinary local files and folders into the existing encrypted blob store.
// No format-specific parsing: every regular file is stored as exact bytes (streamed, 4 MiB chunks,
// deduplicated). Metadata: relative path (+ raw name bytes if not valid UTF-8), size, SHA-256, mtime,
// birthtime, ctime, permission bits.
// Safety: symlinks are recorded (target text) but never followed; FIFOs, sockets and devices are never
// opened (reading a FIFO would block); files are opened with O_NOFOLLOW where the OS supports it; a
// file that changes while being read is rejected; the vault's own files are excluded. Nothing is executed.
import { constants, createReadStream } from 'node:fs';
import { lstat, open, opendir, readlink } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { Vault } from '../vault.ts';
import { canonicalPath, guardFileFor } from '../ownership.ts';
import { contentHash, type DraftRecord, type Provenance } from '../schema.ts';

export const LOCAL_IMPORTER = { id: 'omneme.local-files', version: '0.1.0' };
const BATCH_FILES = 200, BATCH_BYTES = 256 * 2 ** 20;

export interface LocalIssue { entry: string; index: null; reason: string }
export interface LocalReport {
  importId: string; status: 'started' | 'complete' | 'incomplete'; category: 'local';
  startedAt: string; finishedAt: string | null; exportLabel: string; sourcePath: string; exportSha256: null;
  filesSeen: number; filesNew: number; filesRevised: number; filesUnchanged: number; bytesSeen: number;
  newChunks: number; reusedChunks: number; newBytes: number;
  dirs: number; symlinks: number; skippedSpecial: number; skippedVaultFiles: number;
  errors: LocalIssue[]; warnings: LocalIssue[]; complete: boolean;
}

const iso = (ms: number) => (ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
/** Decode a name; report whether the UTF-8 decoding is exact (otherwise raw bytes are kept). */
function decodeName(b: Buffer): { s: string; exact: boolean } { const s = b.toString('utf8'); return { s, exact: Buffer.from(s, 'utf8').equals(b) }; }

function event(r: LocalReport): DraftRecord {
  return {
    schema: 'omneme.record/1', class: 'event', kind: 'import', scope: 'private', provider: null, conversationId: null, messageId: null,
    parentMessageId: null, parentInferred: false, role: null, authorName: null, title: null, createdAt: r.startedAt, updatedAt: r.finishedAt,
    importedAt: r.finishedAt ?? r.startedAt, model: null, text: '', parts: [], attachments: [], relations: [],
    flags: r.status === 'complete' ? [] : [r.status === 'started' ? 'in_progress' : 'incomplete'],
    provenance: { importId: r.importId, importer: LOCAL_IMPORTER.id, importerVersion: LOCAL_IMPORTER.version, exportLabel: r.sourcePath, exportSha256: null, exportEntry: '', elementIndex: -1 },
    contentHash: contentHash(r), raw: structuredClone(r),
  };
}

export async function importLocal(vault: Vault, path: string, opts: { label?: string } = {}): Promise<LocalReport> {
  const root = resolve(path);
  const label = opts.label ?? (basename(root) || root);
  const startedAt = new Date().toISOString();
  const r: LocalReport = {
    importId: randomUUID(), status: 'started', category: 'local', startedAt, finishedAt: null, exportLabel: label, sourcePath: root, exportSha256: null,
    filesSeen: 0, filesNew: 0, filesRevised: 0, filesUnchanged: 0, bytesSeen: 0, newChunks: 0, reusedChunks: 0, newBytes: 0,
    dirs: 0, symlinks: 0, skippedSpecial: 0, skippedVaultFiles: 0, errors: [], warnings: [], complete: false,
  };
  vault.putMany([event(r)]);
  const vaultBase = resolve(vault.path), vaultCanon = canonicalPath(vault.path);
  const guardBase = vaultBase + '.owner', guardCanon = guardFileFor(vault.path);
  const vaultFiles = new Set([
    vaultBase, vaultBase + '-journal', vaultBase + '-wal', vaultBase + '-shm', vaultBase + '.partial', vaultBase + '.creating',
    vaultCanon, vaultCanon + '-journal', vaultCanon + '-wal', vaultCanon + '-shm', vaultCanon + '.partial', vaultCanon + '.creating',
    guardBase, guardBase + '-journal', guardBase + '-wal', guardBase + '-shm',
    guardCanon, guardCanon + '-journal', guardCanon + '-wal', guardCanon + '-shm',
  ]);
  const isVaultFile = (abs: Buffer, nonUtf8: boolean, st: Stats): boolean => {
    if (nonUtf8 || st.isSymbolicLink()) return false;
    const p = abs.toString();
    return vaultFiles.has(p) || vaultFiles.has(canonicalPath(p));
  };
  const prov = (rel: string): Provenance => ({ importId: r.importId, importer: LOCAL_IMPORTER.id, importerVersion: LOCAL_IMPORTER.version, exportLabel: root, exportSha256: null, exportEntry: rel, elementIndex: -1 });
  const base = (kind: DraftRecord['kind'], rel: string, raw: Record<string, unknown>, f: Partial<DraftRecord>): DraftRecord => ({
    schema: 'omneme.record/1', class: 'original', kind, scope: 'private', provider: null, conversationId: label, messageId: rel,
    parentMessageId: null, parentInferred: false, role: null, authorName: null, title: rel.split('/').pop() ?? rel, createdAt: null, updatedAt: null,
    importedAt: startedAt, model: null, text: '', parts: [], attachments: [], flags: [], relations: [], provenance: prov(rel),
    contentHash: contentHash(raw), raw, ...f,
  });
  const tally = (res: string) => { if (res === 'inserted') r.filesNew++; else if (res === 'revision') r.filesRevised++; else r.filesUnchanged++; };
  const fail = (rel: string, reason: string) => r.errors.push({ entry: rel || label, index: null, reason });
  const warn = (rel: string, reason: string) => r.warnings.push({ entry: rel || label, index: null, reason });

  // Batching: up to 200 files / 256 MiB share one transaction (chunks + records + state commit together).
  let pending: DraftRecord[] = [];
  let batchFiles = 0, batchBytes = 0;
  const queue: { rel: string; abs: Buffer; st: Stats; nameBytes: string | null }[] = [];
  const flush = async () => {
    if (!queue.length && !pending.length) return;
    const items = queue.splice(0);
    const recs = pending.splice(0);
    await vault.batch(async () => {
      for (const it of items) {
        const rec = await readOne(it);
        if (rec) recs.push(rec);
      }
      const results = vault.putMany(recs);
      results.forEach((res, i) => { if (recs[i].kind === 'local_file') tally(res); });
    });
    batchFiles = 0; batchBytes = 0;
  };

  const readOne = async (it: { rel: string; abs: Buffer; st: Stats; nameBytes: string | null }): Promise<DraftRecord | null> => {
    let fh;
    try { fh = await open(it.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (e) { fail(it.rel, `Cannot open: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); return null; }
    try {
      const pre = await fh.stat();
      if (!pre.isFile()) { warn(it.rel, 'No longer a regular file; skipped'); return null; }
      const blob = await vault.putBlob(createReadStream('', { fd: fh.fd, autoClose: false, start: 0 }) as AsyncIterable<Buffer>, r);
      const post = await fh.stat();
      if (blob.size !== pre.size || post.size !== pre.size || post.mtimeMs !== pre.mtimeMs) { fail(it.rel, 'File changed while being read; not imported (re-run the import)'); return null; }
      r.bytesSeen += blob.size;
      const raw = {
        relativePath: it.rel, ...(it.nameBytes ? { relativePathBytes: it.nameBytes } : {}), size: blob.size, sha256: blob.sha256,
        mtime: iso(pre.mtimeMs), birthtime: iso(pre.birthtimeMs), ctime: iso(pre.ctimeMs), mode: pre.mode & 0o7777,
      };
      return base('local_file', it.rel, raw, {
        blob, createdAt: iso(pre.birthtimeMs), updatedAt: iso(pre.mtimeMs),
        attachments: [{ id: null, name: it.rel.split('/').pop() ?? it.rel, mime: null, size: blob.size, ref: it.rel, exportEntry: it.rel, availability: 'archived_in_vault' }],
        flags: [...(it.nameBytes ? ['non_utf8_name'] : []), ...(blob.size === 0 ? ['empty'] : [])],
      });
    } catch (e) { fail(it.rel, `Read failed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); return null; }
    finally { await fh.close(); }
  };

  // Iterative walk with Buffer paths, so names that are not valid UTF-8 are read and stored exactly.
  const stack: { abs: Buffer; rel: string; relBytes: Buffer[]; nonUtf8: boolean }[] = [];
  const rootBuf = Buffer.from(root);
  let rootSt: Stats;
  try { rootSt = await lstat(rootBuf); } catch (e) { fail('', `Cannot access source: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); rootSt = null as any; }
  const visit = async (abs: Buffer, rel: string, relBytes: Buffer[], nonUtf8: boolean, st: Stats) => {
    if (isVaultFile(abs, nonUtf8, st)) { r.skippedVaultFiles++; return; }
    const nameBytes = nonUtf8 ? relBytes.map((b) => b.toString('base64url')).join('/') : null;
    if (st.isSymbolicLink()) {
      r.symlinks++;
      let target: string | null = null;
      try { target = (await readlink(abs)).toString(); } catch { /* unreadable link */ }
      pending.push(base('local_symlink', rel, { relativePath: rel, ...(nameBytes ? { relativePathBytes: nameBytes } : {}), target, mtime: iso(st.mtimeMs) }, { flags: ['not_followed'] }));
      warn(rel, 'Symbolic link recorded but not followed');
    } else if (st.isDirectory()) {
      r.dirs++;
      if (rel) pending.push(base('local_dir', rel, { relativePath: rel, ...(nameBytes ? { relativePathBytes: nameBytes } : {}), mode: st.mode & 0o7777 }, {}));
      stack.push({ abs, rel, relBytes, nonUtf8 });
    } else if (st.isFile()) {
      r.filesSeen++;
      queue.push({ rel, abs, st, nameBytes });
      batchFiles++; batchBytes += st.size;
      if (batchFiles >= BATCH_FILES || batchBytes >= BATCH_BYTES) await flush();
    } else {
      r.skippedSpecial++;
      warn(rel, 'Special file (FIFO, socket or device) skipped; never opened');
    }
  };
  if (rootSt) {
    if (rootSt.isFile()) await visit(rootBuf, basename(root), [Buffer.from(basename(root))], false, rootSt);
    else await visit(rootBuf, '', [], false, rootSt);
  }
  while (stack.length) {
    const d = stack.pop()!;
    let dir;
    try { dir = await opendir(d.abs, { encoding: 'buffer' as any }); }
    catch (e) { fail(d.rel, `Cannot read folder: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); continue; }
    const names: Buffer[] = [];
    for await (const ent of dir) names.push(ent.name as unknown as Buffer);
    names.sort(Buffer.compare);
    for (const nb of names) {
      const abs = Buffer.concat([d.abs, Buffer.from(sep), nb]);
      const { s, exact } = decodeName(nb);
      const rel = d.rel ? `${d.rel}/${s}` : s;
      let st: Stats;
      try { st = await lstat(abs); } catch (e) { fail(rel, `Cannot stat: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); continue; }
      await visit(abs, rel, [...d.relBytes, nb], d.nonUtf8 || !exact, st);
    }
  }
  await flush();
  r.complete = r.errors.length === 0;
  r.status = r.complete ? 'complete' : 'incomplete';
  r.finishedAt = new Date().toISOString();
  vault.putMany([event(r)]);
  return r;
}
