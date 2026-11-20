// Safe restoration of imported local files into a NEW, empty folder. Every path is validated
// (no absolute paths, no '..', no NUL; on Windows also reserved names and illegal characters) and must
// resolve inside the target. Files are written via .partial + rename, never overwriting anything,
// with bytes verified chunk-by-chunk and by whole-file SHA-256. Symlinks are listed but not recreated.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, utimesSync, writeSync, chmodSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Vault } from './vault.ts';
import type { MemoryRecord } from './schema.ts';

const WIN = process.platform === 'win32';
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Validate one relative path; returns its segments, or a reason it is unsafe. */
export function checkRelPath(rel: string): { ok: true; parts: string[] } | { ok: false; reason: string } {
  if (!rel || rel.includes('\0')) return { ok: false, reason: 'empty or contains NUL' };
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) return { ok: false, reason: 'absolute path' };
  const parts = rel.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') return { ok: false, reason: 'empty, "." or ".." segment' };
    if (WIN) {
      if (/[<>:"|?*\\\x00-\x1f]/.test(p)) return { ok: false, reason: 'character not allowed on Windows' };
      if (WIN_RESERVED.test(p)) return { ok: false, reason: 'reserved Windows name' };
      if (/[. ]$/.test(p)) return { ok: false, reason: 'trailing dot/space not allowed on Windows' };
    }
  }
  return { ok: true, parts };
}

export interface RestoreFilesReport { files: number; bytes: number; dirs: number; symlinksListed: string[]; skipped: { path: string; reason: string }[]; failed: { path: string; reason: string }[] }

export function restoreLocalFiles(vault: Vault, records: MemoryRecord[], targetDir: string, prefix = ''): RestoreFilesReport {
  const target = resolve(targetDir);
  if (existsSync(target) && readdirSync(target).length) throw new Error('Target folder must be new or empty');
  mkdirSync(target, { recursive: true });
  const rep: RestoreFilesReport = { files: 0, bytes: 0, dirs: 0, symlinksListed: [], skipped: [], failed: [] };
  const sel = records.filter((r) => r.messageId && (!prefix || r.messageId === prefix || r.messageId.startsWith(prefix.replace(/\/$/, '') + '/')));
  const place = (rel: string, rawBytes?: string): string | Buffer | null => {
    const c = checkRelPath(rel);
    if (!c.ok) { rep.skipped.push({ path: rel, reason: c.reason }); return null; }
    const out = resolve(target, ...c.parts);
    if (!(out + sep).startsWith(target + sep)) { rep.skipped.push({ path: rel, reason: 'escapes target folder' }); return null; }
    // On POSIX, recreate names that were not valid UTF-8 from their original bytes.
    if (rawBytes && !WIN) {
      const segs = rawBytes.split('/').map((b) => Buffer.from(b, 'base64url'));
      if (segs.some((b) => b.length === 0 || b.includes(0) || b.includes(0x2f) || b.equals(Buffer.from('..')) || b.equals(Buffer.from('.')))) { rep.skipped.push({ path: rel, reason: 'unsafe raw name bytes' }); return null; }
      return Buffer.concat([Buffer.from(target), ...segs.flatMap((b) => [Buffer.from(sep), b])]);
    }
    return out;
  };
  const parentOf = (p: string | Buffer) => {
    if (typeof p === 'string') return p.slice(0, p.lastIndexOf(sep));
    return p.subarray(0, p.lastIndexOf(sep.charCodeAt(0)));
  };
  for (const r of sel.filter((x) => x.kind === 'local_dir')) {
    const p = place(r.messageId!, (r.raw as any)?.relativePathBytes);
    if (p) { mkdirSync(p, { recursive: true }); rep.dirs++; }
  }
  for (const r of sel.filter((x) => x.kind === 'local_symlink')) rep.symlinksListed.push(`${r.messageId} -> ${(r.raw as any)?.target ?? '?'}`);
  for (const r of sel.filter((x) => x.kind === 'local_file' && x.blob)) {
    const raw = r.raw as any;
    const p = place(r.messageId!, raw?.relativePathBytes);
    if (!p) continue;
    mkdirSync(parentOf(p), { recursive: true });
    const tmp = typeof p === 'string' ? p + '.omneme-partial' : Buffer.concat([p, Buffer.from('.omneme-partial')]);
    let fd: number | null = null;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      for (const b of vault.readBlob(r.blob!)) writeSync(fd, b);
      closeSync(fd); fd = null;
      if (existsSync(p)) throw new Error('target path already exists');
      renameSync(tmp, p);
      if (!WIN && typeof raw?.mode === 'number') chmodSync(p, raw.mode & 0o777); // never restore setuid/setgid/sticky bits
      const m = raw?.mtime ? new Date(raw.mtime) : null;
      if (m) utimesSync(p, m, m);
      rep.files++; rep.bytes += r.blob!.size;
    } catch (e) {
      if (fd !== null) closeSync(fd);
      rmSync(tmp, { force: true });
      rep.failed.push({ path: r.messageId!, reason: (e as Error).message });
    }
  }
  return rep;
}

export { join };
