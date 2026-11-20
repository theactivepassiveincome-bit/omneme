// Minimal read-only ZIP reader (central directory + streamed inflate, ZIP64 aware).
// Written because the npm registry was unreachable in the build environment; replaceable by
// `yauzl` (MIT). Hardened for untrusted input (Stage 1.1 review):
//  - nothing is ever extracted to disk, so entry names cannot cause path traversal;
//  - every offset/length is bounds-checked against the file and the central directory;
//  - declared sizes are enforced while streaming (output can never exceed the declared size);
//  - per-entry size cap, compression-ratio cap (zip bombs), entry-count cap, overlapping-entry check;
//  - CRC-32 and exact size are verified at end of stream; encrypted entries are refused.
import { open as fsOpen } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { createInflateRaw, crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** DOS modification time from the central directory, as a local-time string 'YYYY-MM-DDTHH:MM:SS' (no zone), or null. */
  mtime: string | null;
}

function dosTime(time: number, date: number): string | null {
  if (!date) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  const y = 1980 + (date >> 9), mo = (date >> 5) & 15, d = date & 31, h = time >> 11, mi = (time >> 5) & 63, s = (time & 31) * 2;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}`;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number; // max uncompressed size of any single entry we will stream
  maxRatio: number; // max uncompressed/compressed ratio for entries above ratioMinBytes
  ratioMinBytes: number;
}
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 1_000_000, maxEntryBytes: 32 * 2 ** 30, maxRatio: 1000, ratioMinBytes: 16 * 2 ** 20 };

export class ZipError extends Error { constructor(m: string) { super(m); this.name = 'ZipError'; } }

const EOCD = 0x06054b50, ZIP64_EOCD = 0x06064b50, ZIP64_LOC = 0x07064b50, CDH = 0x02014b50, LFH = 0x04034b50;

function need(cond: boolean, msg: string): asserts cond { if (!cond) throw new ZipError(msg); }
/** ZIP64 fields are u64; refuse anything that cannot be represented exactly as a JS number. */
function safeU64(v: bigint, what: string): number {
  need(v <= BigInt(Number.MAX_SAFE_INTEGER), `ZIP64 ${what} too large`);
  return Number(v);
}

export async function readZipEntries(path: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipEntry[]> {
  const fh = await fsOpen(path, 'r');
  try {
    const { size } = await fh.stat();
    need(size >= 22, 'File too small to be a ZIP archive');
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { e = i; break; }
    need(e >= 0, 'ZIP end-of-central-directory not found (truncated or not a ZIP)');
    let total = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOffset = tail.readUInt32LE(e + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      need(e >= 20 && tail.readUInt32LE(e - 20) === ZIP64_LOC, 'ZIP64 locator missing');
      const z64off = safeU64(tail.readBigUInt64LE(e - 20 + 8), 'end-record offset');
      need(z64off + 56 <= size, 'ZIP64 end record out of bounds');
      const z = Buffer.alloc(56);
      await fh.read(z, 0, 56, z64off);
      need(z.readUInt32LE(0) === ZIP64_EOCD, 'ZIP64 end record corrupt');
      total = safeU64(z.readBigUInt64LE(32), 'entry count'); cdSize = safeU64(z.readBigUInt64LE(40), 'directory size'); cdOffset = safeU64(z.readBigUInt64LE(48), 'directory offset');
    }
    need(total <= limits.maxEntries, `ZIP has too many entries (${total})`);
    need(Number.isSafeInteger(cdOffset + cdSize) && cdOffset + cdSize <= size, 'ZIP central directory out of bounds (truncated?)');
    need(total * 46 <= cdSize, 'ZIP central directory too small for its entry count');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < total; i++) {
      need(p + 46 <= cd.length && cd.readUInt32LE(p) === CDH, `ZIP central directory corrupt at entry ${i}`);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nLen = cd.readUInt16LE(p + 28), xLen = cd.readUInt16LE(p + 30), cLen = cd.readUInt16LE(p + 32);
      let off = cd.readUInt32LE(p + 42);
      const end = p + 46 + nLen + xLen + cLen;
      need(end <= cd.length, `ZIP central directory entry ${i} overruns directory`);
      const nameBuf = cd.subarray(p + 46, p + 46 + nLen);
      const name = (flags & 0x800) ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
      let x = p + 46 + nLen; const xEnd = x + xLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        need(x + 4 + len <= xEnd, `ZIP extra field overruns entry ${i}`);
        if (id === 0x0001) {
          let q = x + 4; const qEnd = q + len;
          const u64 = () => { need(q + 8 <= qEnd, `ZIP64 extra field too short in entry ${i}`); const v = safeU64(cd.readBigUInt64LE(q), `field in entry ${i}`); q += 8; return v; };
          if (usize === 0xffffffff) usize = u64();
          if (csize === 0xffffffff) csize = u64();
          if (off === 0xffffffff) off = u64();
        }
        x += 4 + len;
      }
      need(Number.isSafeInteger(off + 30 + csize) && off + 30 + csize <= cdOffset, `ZIP entry ${i} data out of bounds`);
      entries.push({ name, method, flags, crc32: crc, compressedSize: csize, uncompressedSize: usize, localHeaderOffset: off, mtime: dosTime(cd.readUInt16LE(p + 12), cd.readUInt16LE(p + 14)) });
      p = end;
    }
    // Overlapping entries are a zip-bomb technique and never occur in legitimate exports.
    const sorted = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      need(sorted[i].localHeaderOffset >= prev.localHeaderOffset + 30 + prev.compressedSize, 'ZIP entries overlap (possible zip bomb)');
    }
    return entries;
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError('ZIP structure is malformed: ' + (err as Error).name);
  } finally { await fh.close(); }
}

/** Stream an entry's decompressed bytes, verifying size and CRC-32 at the end. */
export async function openZipEntry(path: string, e: ZipEntry, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<Readable> {
  need(!(e.flags & 0x41), `Encrypted ZIP entries are not supported: ${e.name}`);
  need(e.method === 0 || e.method === 8, `Unsupported ZIP compression method ${e.method}`);
  need(e.uncompressedSize <= limits.maxEntryBytes, `ZIP entry exceeds size limit: ${e.name}`);
  need(e.method === 0 ? e.uncompressedSize === e.compressedSize : true, `ZIP stored entry size mismatch: ${e.name}`);
  need(e.uncompressedSize < limits.ratioMinBytes || e.uncompressedSize <= Math.max(1, e.compressedSize) * limits.maxRatio,
    `ZIP entry compression ratio too high (possible zip bomb): ${e.name}`);
  const fh = await fsOpen(path, 'r');
  const h = Buffer.alloc(30);
  try { await fh.read(h, 0, 30, e.localHeaderOffset); } finally { await fh.close(); }
  need(h.readUInt32LE(0) === LFH, 'ZIP local header corrupt');
  const start = e.localHeaderOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const raw = createReadStream(path, e.compressedSize ? { start, end: start + e.compressedSize - 1 } : { start, end: start - 1 });
  let crc = 0, n = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > e.uncompressedSize) return cb(new ZipError(`ZIP entry larger than declared: ${e.name}`));
      crc = crc32(chunk, crc); cb(null, chunk);
    },
    flush(cb) {
      if (n !== e.uncompressedSize || (crc >>> 0) !== (e.crc32 >>> 0)) cb(new ZipError(`ZIP entry corrupt (CRC/size mismatch): ${e.name}`));
      else cb();
    },
  });
  const forward = (s: Readable) => s.on('error', (err) => check.destroy(err instanceof ZipError ? err : new ZipError(`ZIP entry data corrupt: ${e.name}`)));
  forward(raw);
  if (e.method === 8) {
    const inf = createInflateRaw();
    forward(inf);
    raw.pipe(inf).pipe(check);
    check.on('close', () => { raw.destroy(); inf.destroy(); });
  } else {
    raw.pipe(check);
    check.on('close', () => raw.destroy());
  }
  return check;
}
