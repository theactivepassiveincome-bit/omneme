// Opens an export (ZIP, single JSON file, or extracted directory) as a list of entries.
import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { DEFAULT_ZIP_LIMITS, openZipEntry, readZipEntries, type ZipLimits } from '../zip.ts';

export interface SourceEntry { name: string; size: number; open(): Promise<Readable>; meta?: { crc32: number; compressedSize: number; method: number; mtime: string | null } }
export interface ExportSource { label: string; path: string; kind: 'zip' | 'json' | 'dir'; sha256: string | null; size: number; entries: SourceEntry[] }

async function fileSha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

async function walk(dir: string, root: string, out: SourceEntry[]) {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isSymbolicLink()) continue; // never follow links out of the export
    if (d.isDirectory()) await walk(p, root, out);
    else if (d.isFile()) {
      const s = await stat(p);
      out.push({ name: relative(root, p).split(sep).join('/'), size: s.size, open: async () => createReadStream(p) });
    }
  }
}

export async function openSource(path: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ExportSource> {
  const s = await stat(path);
  if (s.isDirectory()) {
    const entries: SourceEntry[] = [];
    await walk(path, path, entries);
    return { label: basename(path), path, kind: 'dir', sha256: null, size: 0, entries };
  }
  const fh = await open(path, 'r');
  const head = Buffer.alloc(4);
  try { await fh.read(head, 0, 4, 0); } finally { await fh.close(); }
  const sha = await fileSha256(path);
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const zes = await readZipEntries(path, limits);
    return {
      label: basename(path), path, kind: 'zip', sha256: sha, size: s.size,
      entries: zes.filter((e) => !e.name.endsWith('/')).map((e) => ({ name: e.name, size: e.uncompressedSize, open: () => openZipEntry(path, e, limits), meta: { crc32: e.crc32 >>> 0, compressedSize: e.compressedSize, method: e.method, mtime: e.mtime } })),
    };
  }
  return { label: basename(path), path, kind: 'json', sha256: sha, size: s.size, entries: [{ name: basename(path), size: s.size, open: async () => createReadStream(path) }] };
}

/**
 * Google Takeout Gemini Apps activity log: only `My Activity.html` at the exact Takeout path
 * (`Takeout/My Activity/Gemini Apps/My Activity.html`, or without `Takeout/` for an extracted Takeout folder).
 * Other HTML (artifacts, other products such as Health) is never treated as chats.
 */
export function geminiActivityEntries(src: ExportSource): SourceEntry[] {
  if (src.kind === 'json') return [];
  return src.entries.filter((e) => /^(Takeout\/)?My Activity\/Gemini Apps\/My Activity\.html$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Conversation files inside an export: conversations.json, plus split variants such as conversations-000.json. */
export function conversationEntries(src: ExportSource): SourceEntry[] {
  if (src.kind === 'json') return src.entries;
  return src.entries.filter((e) => /(^|\/)conversations(-\d+)?\.json$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
}
