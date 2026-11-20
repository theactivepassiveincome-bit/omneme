// Stage 1.3: local files and folders on the existing blob engine. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Vault } from '../src/vault.ts';
import { importLocal } from '../src/importers/localFiles.ts';
import { checkRelPath, restoreLocalFiles } from '../src/restoreFiles.ts';
import { MemoryIndex } from '../src/search.ts';
import { contentHash } from '../src/schema.ts';
import { PASSWORD, TEST_KDF_N, tmp } from './helpers.ts';

const POSIX = process.platform !== 'win32';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const prng = (n: number, seed: number) => { const b = Buffer.alloc(n); let x = seed >>> 0; for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; b[i] = x >>> 24; } return b; };
async function fresh() { const d = tmp(); const path = join(d, 'v.omneme'); return { d, path, vault: (await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N })).vault }; }
const chunkCount = (path: string) => { const db = new DatabaseSync(path); const n = (db.prepare('SELECT COUNT(*) n FROM chunks').get() as any).n; db.close(); return n; };

/** A synthetic personal folder: documents, photos, video-like binary, nested and empty folders, odd names. */
function makeTree(root: string) {
  const files: Record<string, Buffer> = {
    'Documents/report.pdf': Buffer.concat([Buffer.from('%PDF-1.7\n'), prng(30_000, 1)]),
    'Documents/letter.docx': Buffer.concat([Buffer.from('PK\x03\x04'), prng(20_000, 2)]),
    'Documents/budget.xlsx': Buffer.concat([Buffer.from('PK\x03\x04'), prng(15_000, 3)]),
    'Photos/2024/海滩 beach.jpg': Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), prng(50_000, 4)]),
    'Photos/2024/icon.png': Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), prng(5_000, 5)]),
    'Videos/clip.mp4': Buffer.concat([Buffer.from('\0\0\0\x18ftypmp42', 'latin1'), prng(6 * 2 ** 20, 6)]), // > 4 MiB: 2 chunks
    'empty.bin': Buffer.alloc(0),
    'name with spaces & émoji 🎉.txt': Buffer.from('odd name'),
    'script.sh': Buffer.from(`#!/bin/sh\ntouch "${join(root, 'EXECUTED')}"\n`),
    'app.js': Buffer.from(`require('fs').writeFileSync(${JSON.stringify(join(root, 'EXECUTED'))}, 'x')`),
  };
  for (const [rel, data] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), data); }
  mkdirSync(join(root, 'Empty Folder'), { recursive: true });
  utimesSync(join(root, 'Documents/report.pdf'), new Date('2020-01-02T03:04:05Z'), new Date('2020-01-02T03:04:05Z'));
  return files;
}

test('folder import: exact bytes, paths, timestamps, empty files/folders, odd names; nothing executed', async () => {
  const { d, vault } = await fresh();
  const root = join(d, 'MyFiles'); const files = makeTree(root);
  const r = await importLocal(vault, root);
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  assert.equal(r.filesSeen, Object.keys(files).length);
  assert.equal(r.filesNew, r.filesSeen);
  assert.equal(r.bytesSeen, Object.values(files).reduce((n, b) => n + b.length, 0));
  const ix = new MemoryIndex(vault.loadAll());
  const recs = ix.localRecords('MyFiles');
  for (const [rel, data] of Object.entries(files)) {
    const rec = recs.find((x) => x.kind === 'local_file' && x.messageId === rel)!;
    assert.ok(rec, rel);
    assert.equal(rec.blob!.sha256, sha(data));
    assert.equal(Buffer.concat([...vault.readBlob(rec.blob!)]).equals(data), true, rel);
    assert.equal(rec.provenance.importer, 'omneme.local-files');
    assert.equal(rec.provenance.exportLabel, root);
  }
  const pdf = recs.find((x) => x.messageId === 'Documents/report.pdf')!;
  assert.equal((pdf.raw as any).mtime, '2020-01-02T03:04:05.000Z');
  assert.equal(pdf.updatedAt, '2020-01-02T03:04:05.000Z');
  assert.ok(recs.some((x) => x.kind === 'local_dir' && x.messageId === 'Empty Folder'));
  assert.ok(recs.find((x) => x.messageId === 'empty.bin')!.flags.includes('empty'));
  assert.equal(recs.find((x) => x.messageId === 'Videos/clip.mp4')!.blob!.chunks.length, 2);
  assert.equal(existsSync(join(root, 'EXECUTED')), false, 'imported scripts must never run');
  vault.lock();
});

test('symlinks are recorded but never followed; FIFOs are skipped without blocking; non-UTF-8 names kept exactly', { skip: !POSIX }, async () => {
  const { d, vault } = await fresh();
  const root = join(d, 'src'); mkdirSync(root);
  const secret = join(d, 'outside-secret.txt'); writeFileSync(secret, 'OUTSIDE-SECRET-NEVER-IMPORT');
  writeFileSync(join(root, 'a.txt'), 'a');
  symlinkSync(secret, join(root, 'link-to-outside'));
  symlinkSync(d, join(root, 'link-to-parent-dir')); // would loop / escape if followed
  const fifo = spawnSync('mkfifo', [join(root, 'pipe')]).status === 0;
  const raw = Buffer.concat([Buffer.from(root + '/'), Buffer.from([0x66, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74])]); // "f\xff\xfe.txt"
  writeFileSync(raw, 'latin bytes');
  const r = await importLocal(vault, root);
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  assert.equal(r.symlinks, 2);
  assert.equal(r.skippedSpecial, fifo ? 1 : 0);
  assert.equal(r.filesSeen, 2);
  const ix = new MemoryIndex(vault.loadAll());
  const recs = ix.localRecords('src');
  const link = recs.find((x) => x.messageId === 'link-to-outside')!;
  assert.equal(link.kind, 'local_symlink'); assert.equal((link.raw as any).target, secret); assert.equal(link.blob, undefined);
  for (const b of ix.blobRecords()) assert.ok(!Buffer.concat([...vault.readBlob(b.blob!)]).includes('OUTSIDE-SECRET'));
  const odd = recs.find((x) => x.flags.includes('non_utf8_name'))!;
  assert.ok(odd);
  // Restore recreates the exact original name bytes.
  const out = join(d, 'restored');
  const rep = restoreLocalFiles(vault, recs, out);
  assert.equal(rep.failed.length, 0);
  assert.deepEqual(rep.symlinksListed.length, 2);
  const names = readdirSync(Buffer.from(out), { encoding: 'buffer' }).map((b) => b.toString('hex'));
  assert.ok(names.includes(Buffer.from([0x66, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]).toString('hex')));
  assert.equal(existsSync(join(out, 'link-to-outside')), false); // never recreated
  vault.lock();
});

test('deduplication: identical content stored once; re-adding the same folder adds no data', async () => {
  const { d, path, vault } = await fresh();
  const root = join(d, 'dups'); mkdirSync(root);
  const big = prng(9 * 2 ** 20, 9); // 3 chunks
  writeFileSync(join(root, 'one.bin'), big); writeFileSync(join(root, 'copy-of-one.bin'), big);
  const r = await importLocal(vault, root);
  assert.equal(r.newChunks, 3); assert.equal(r.reusedChunks, 3);
  assert.equal(chunkCount(path), 3);
  const before = { records: vault.count(), chunks: chunkCount(path) };
  const again = await importLocal(vault, root);
  assert.equal(again.filesUnchanged, 2); assert.equal(again.filesNew + again.filesRevised, 0);
  assert.equal(again.newChunks, 0);
  assert.equal(vault.count(), before.records + 2); // start/finish events only
  assert.equal(chunkCount(path), before.chunks);
  vault.lock();
});

test('changed files keep every earlier version; any version can be extracted', async () => {
  const { d, vault } = await fresh();
  const root = join(d, 'notes'); mkdirSync(root);
  const f = join(root, 'diary.md');
  writeFileSync(f, 'version one'); utimesSync(f, new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));
  await importLocal(vault, root);
  writeFileSync(f, 'version two, longer'); utimesSync(f, new Date('2022-01-01T00:00:00Z'), new Date('2022-01-01T00:00:00Z'));
  const r2 = await importLocal(vault, root);
  assert.equal(r2.filesRevised, 1);
  const ix = new MemoryIndex(vault.loadAll());
  const h = ix.history('notes', 'diary.md');
  assert.deepEqual(h.map((x) => Buffer.concat([...vault.readBlob(x.blob!)]).toString()), ['version one', 'version two, longer']);
  assert.deepEqual(h[1].relations, [{ type: 'supersedes', target: h[0].recordId }]);
  assert.equal(ix.localRecords('notes').find((x) => x.kind === 'local_file')!.recordId, h[1].recordId); // latest shown by default
  vault.lock();
});

test('a file modified while being read is rejected and reported, never stored half-changed', async () => {
  const { d, vault } = await fresh();
  const root = join(d, 'live'); mkdirSync(root);
  const f = join(root, 'growing.log'); writeFileSync(f, prng(5 * 2 ** 20, 11));
  let fired = false;
  Vault.testHooks.afterChunk = () => { if (!fired) { fired = true; appendFileSync(f, 'appended during import'); } };
  try {
    const r = await importLocal(vault, root);
    assert.equal(r.complete, false);
    assert.match(r.errors[0].reason, /changed while being read/);
    assert.equal(new MemoryIndex(vault.loadAll()).localRecords('live').filter((x) => x.kind === 'local_file').length, 0);
  } finally { Vault.testHooks.afterChunk = undefined; }
  const r2 = await importLocal(vault, root); // re-run succeeds
  assert.equal(r2.complete, true); assert.equal(r2.filesNew, 1);
  vault.lock();
});

test('the vault itself is never imported when it lives inside the folder being added', async (t) => {
  const d = tmp();
  const root = join(d, 'home'); mkdirSync(root);
  const keep: Record<string, Buffer> = {
    'doc.txt': Buffer.from('hello'),
    'notes.owner': Buffer.from('legitimate user .owner file'),
    'other.omneme.owner': Buffer.from('another vault guard or unrelated owner file'),
    'app.sqlite': Buffer.concat([Buffer.from('SQLite format 3\0'), prng(4096, 31)]),
    'bin.dat': prng(8192, 32),
  };
  for (const [k, v] of Object.entries(keep)) writeFileSync(join(root, k), v);
  const vaultPath = join(root, 'vault.omneme');
  const { vault } = await Vault.create(vaultPath, PASSWORD, { kdfN: TEST_KDF_N });
  // Simulate optional SQLite WAL/SHM companions for the active vault and its ownership guard.
  for (const sfx of ['-wal', '-shm', '.owner-wal', '.owner-shm']) writeFileSync(vaultPath + sfx, 'active-companion');
  const r = await importLocal(vault, join(root, '.', '..', 'home')); // non-canonical lexical parent spelling
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  assert.equal(r.filesSeen, Object.keys(keep).length);
  assert.ok(r.skippedVaultFiles >= 6, `expected active vault + guard + companions skipped, got ${r.skippedVaultFiles}`);
  const linkParent = join(tmp(), 'linked-parent');
  let linked = true;
  try { symlinkSync(d, linkParent, process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
  if (linked) {
    const rAlias = await importLocal(vault, join(linkParent, 'home'));
    assert.equal(rAlias.complete, true);
    assert.equal(rAlias.filesSeen, Object.keys(keep).length);
    assert.equal(rAlias.filesUnchanged, Object.keys(keep).length);
    assert.ok(rAlias.skippedVaultFiles >= 6);
  } else t.diagnostic('symlink/junction not permitted here; canonical-parent alias not exercised');
  const recs = new MemoryIndex(vault.loadAll()).localRecords('home').filter((x) => x.kind === 'local_file');
  assert.deepEqual(recs.map((x) => x.messageId).sort(), Object.keys(keep).sort());
  assert.equal(vault.verify(contentHash).failed, 0);
  const bak = join(d, 'home.omnbak'), restoredVault = join(d, 'restored.omneme'), out = join(d, 'restored-files');
  vault.exportBackup(bak);
  vault.lock();
  await Vault.restoreBackup(bak, restoredVault, { password: PASSWORD });
  const rv = await Vault.unlock(restoredVault, { password: PASSWORD });
  assert.equal(rv.verify(contentHash).failed, 0);
  const rep = restoreLocalFiles(rv, new MemoryIndex(rv.loadAll()).localRecords('home'), out);
  assert.equal(rep.failed.length + rep.skipped.length, 0);
  assert.deepEqual(readdirSync(out).sort(), Object.keys(keep).sort());
  for (const [k, v] of Object.entries(keep)) assert.equal(readFileSync(join(out, k)).equals(v), true, k);
  rv.lock();
});

test('corrupt or missing chunk: verify flags it, restore-files reports and leaves no partial file, backup refuses', async () => {
  const { d, path, vault } = await fresh();
  const root = join(d, 'c'); mkdirSync(root);
  writeFileSync(join(root, 'a.bin'), prng(100_000, 21)); writeFileSync(join(root, 'b.txt'), 'fine');
  await importLocal(vault, root);
  vault.lock();
  const db = new DatabaseSync(path);
  const row = db.prepare('SELECT id, blob FROM chunks ORDER BY length(blob) DESC LIMIT 1').get() as any;
  const bad = Buffer.from(row.blob); bad[bad.length - 2] ^= 1;
  db.prepare('UPDATE chunks SET blob = ? WHERE id = ?').run(bad, row.id); db.close();
  const v = await Vault.unlock(path, { password: PASSWORD });
  assert.equal(v.verify(contentHash).blobsFailed, 1);
  const out = join(d, 'out');
  const rep = restoreLocalFiles(v, new MemoryIndex(v.loadAll()).localRecords('c'), out);
  assert.equal(rep.files, 1); assert.equal(rep.failed.length, 1); assert.equal(rep.failed[0].path, 'a.bin');
  assert.deepEqual(readdirSync(out).sort(), ['b.txt']); // no partial or corrupt a.bin left behind
  assert.throws(() => v.exportBackup(join(d, 'b.omnbak')), /Backup refused/);
  v.lock();
});

test('backup and independent restore include all local files, byte-exact with timestamps', async () => {
  const { d, vault } = await fresh();
  const root = join(d, 'Archive'); const files = makeTree(root);
  await importLocal(vault, root);
  const bak = join(d, 'all.omnbak');
  vault.exportBackup(bak); vault.lock();
  const elsewhere = tmp();
  const target = join(elsewhere, 'new-machine.omneme');
  await Vault.restoreBackup(bak, target, { password: PASSWORD });
  const rv = await Vault.unlock(target, { password: PASSWORD });
  assert.equal(rv.verify(contentHash).failed, 0);
  const out = join(elsewhere, 'Recovered');
  const rep = restoreLocalFiles(rv, new MemoryIndex(rv.loadAll()).localRecords('Archive'), out);
  assert.equal(rep.failed.length + rep.skipped.length, 0);
  for (const [rel, data] of Object.entries(files)) assert.equal(readFileSync(join(out, rel)).equals(data), true, rel);
  assert.equal(statSync(join(out, 'Documents/report.pdf')).mtime.toISOString(), '2020-01-02T03:04:05.000Z');
  assert.ok(existsSync(join(out, 'Empty Folder')));
  assert.throws(() => restoreLocalFiles(rv, [], out), /new or empty/);
  rv.lock();
});

test('restore path validation rejects traversal, absolute and malformed paths', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', 'C:x', '\\\\server\\share', 'a//b', './a', 'a/./b', '', 'a\0b'])
    assert.equal(checkRelPath(bad).ok, false, JSON.stringify(bad));
  for (const good of ['a', 'a/b.txt', 'Photos/2024/海滩 beach.jpg', '.hidden', 'a..b']) assert.equal(checkRelPath(good).ok, true, good);
});

// Streaming-memory test. Process RSS is not a reliable streaming measure across platforms: it includes garbage
// that the runtime has not collected yet. On Windows 11 / Node 24 the RSS growth for this test was 136-144 MB versus
// ~16-30 MB on Linux, while live memory was identical. So the precise assertions use V8's own accounting of
// *live* buffer memory (process.memoryUsage().arrayBuffers after a forced GC at every 4 MiB chunk), which is
// platform-independent, plus a size-scaling check. RSS is still asserted, but only against the file size: buffering a
// whole file would exceed it on any platform. Evidence: docs/PROGRESS.md (2026-11-06, Windows memory investigation).
test('large file streams with bounded memory: live buffers stay under a fixed bound independent of file size (child process)', () => {
  const d = tmp();
  const script = join(d, 'measure.mjs');
  const url = (p: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', p)).href); // file URLs: Windows-safe ESM imports
  writeFileSync(script, `
    import { createWriteStream } from 'node:fs';
    import { join } from 'node:path';
    const { Vault, CHUNK_SIZE } = await import(${url('vault.ts')});
    const { importLocal } = await import(${url('importers/localFiles.ts')});
    const { MemoryIndex } = await import(${url('search.ts')});
    const dir = ${JSON.stringify(d)};
    const gen = (f, MB, seed) => new Promise((res) => { const ws = createWriteStream(f); let x = seed, i = 0;
      const go = () => { while (i < MB) { const b = Buffer.alloc(2 ** 20); for (let j = 0; j < b.length; j += 4) { x = (x * 1664525 + 1013904223) >>> 0; b.writeUInt32LE(x, j); } i++; if (!ws.write(b)) return ws.once('drain', go); } ws.end(res); }; go(); });
    const ab = () => process.memoryUsage().arrayBuffers;
    // A) RSS growth for 256 MiB, with normal (lazy) garbage collection.
    await gen(join(dir, 'a.bin'), 256, 7);
    const va = (await Vault.create(join(dir, 'a.omneme'), 'password-123', { kdfN: 16384 })).vault;
    global.gc(); const rss0 = process.resourceUsage().maxRSS;
    const ra = await importLocal(va, join(dir, 'a.bin'));
    let n = 0; for (const c of va.readBlob(new MemoryIndex(va.loadAll()).blobRecords()[0].blob)) n += c.length;
    const rssGrowthMB = Math.round((process.resourceUsage().maxRSS - rss0) / 1024);
    // B) Live buffer memory (forced GC at every chunk) for 64 and 256 MiB.
    const live = async (MB, seed) => {
      const f = join(dir, 'b' + MB + '.bin'); await gen(f, MB, seed);
      const v = (await Vault.create(join(dir, 'b' + MB + '.omneme'), 'password-123', { kdfN: 16384 })).vault;
      global.gc(); const base = ab(); let peak = 0;
      Vault.testHooks.afterChunk = () => { global.gc(); peak = Math.max(peak, ab() - base); };
      await importLocal(v, f);
      Vault.testHooks.afterChunk = undefined;
      for (const c of v.readBlob(new MemoryIndex(v.loadAll()).blobRecords()[0].blob)) { global.gc(); peak = Math.max(peak, ab() - base); }
      global.gc(); return { peak, retained: ab() - base };
    };
    const l64 = await live(64, 11), l256 = await live(256, 13);
    console.log(JSON.stringify({ ok: ra.complete, size: ra.bytesSeen, readBack: n, chunk: CHUNK_SIZE, rssGrowthMB, live64: l64.peak, live256: l256.peak, retained256: l256.retained }));
  `);
  const out = spawnSync(process.execPath, ['--no-warnings', '--expose-gc', script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const m = JSON.parse(out.stdout.trim().split('\n').pop()!);
  assert.equal(m.ok, true); assert.equal(m.size, 256 * 2 ** 20); assert.equal(m.readBack, m.size);
  // Live memory is bounded by a few chunks (measured ≈28 MiB for both 64 and 256 MiB files, in either order) and does
  // not grow with file size. Node frees large buffers on a background thread, so instantaneous readings swing between
  // ~4 and ~28 MiB; hence a fixed bound for both sizes rather than an exact difference.
  for (const [label, v] of [['64 MiB', m.live64], ['256 MiB', m.live256]] as const)
    assert.ok(v < 8 * m.chunk, `live buffer peak for ${label} file: ${v} B, must stay below 8 chunks (32 MiB)`);
  assert.ok(m.retained256 < 2 * m.chunk, `buffers retained after streaming: ${m.retained256} B`);
  // RSS guard: buffering the whole 256 MiB file would exceed this on any platform.
  assert.ok(m.rssGrowthMB < 256, `RSS grew ${m.rssGrowthMB} MB for a 256 MiB file`);
});

test('CLI: add, sources, history, files, restore-files, verify; local files distinct from Claude exports', () => {
  const d = tmp();
  const env = { ...process.env, OMNEME_PASSWORD: PASSWORD, OMNEME_KDF_N: String(TEST_KDF_N), OMNEME_TEST_MODE: '1', OMNEME_VAULT: join(d, 'v.omneme') };
  const cli = (...a: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'omneme.mjs'), ...a], { env, encoding: 'utf8' });
  cli('init');
  const root = join(d, 'Stuff'); makeTree(root);
  const add = cli('add', root, '--label', 'laptop-stuff');
  assert.match(add.stdout, /files:\s+10 seen, 10 new/); assert.match(add.stdout, /status:\s+complete/);
  assert.match(cli('sources').stdout, /laptop-stuff\s+10 files/);
  assert.match(cli('files', 'clip.mp4').stdout, /local_file .* laptop-stuff\/Videos\/clip\.mp4/);
  assert.match(cli('history', 'laptop-stuff', 'Documents/report.pdf').stdout, /mtime 2020-01-02T03:04:05.000Z/);
  const to = join(d, 'restored');
  const rf = cli('restore-files', 'laptop-stuff', '--to', to, '--prefix', 'Photos');
  assert.equal(rf.status, 0, rf.stdout + rf.stderr);
  assert.deepEqual(readdirSync(to), ['Photos']);
  assert.match(cli('verify').stdout, /failed: 0, archived blobs: 10 \(0 failed\), record set: intact/);
  assert.match(cli('imports').stdout, /COMPLETE\s+local files "laptop-stuff": 10 files/);
});
