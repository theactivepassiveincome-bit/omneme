// Stage 1.2: Claude projects and artifacts (frames) archival. Synthetic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { MemoryIndex } from '../src/search.ts';
import { contentHash } from '../src/schema.ts';
import {
  ARCHIVE_MARKERS, PASSWORD, TEST_KDF_N, framesFiles, makeZip, projectFixtures, tmp, writeChatgptZip, writeFramesZip, writeProjectsZip,
} from './helpers.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const bytesOf = (v: Vault, ref: any) => Buffer.concat([...v.readBlob(ref)]);
async function fresh() {
  const d = tmp(); const path = join(d, 'v.omneme');
  return { d, path, vault: (await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N })).vault };
}

test('projects-000.zip: projects, instructions, docs, timestamps, creator and exact file bytes are preserved', async () => {
  const { d, vault } = await fresh();
  const zip = writeProjectsZip(d);
  const r = await importExport(vault, zip);
  assert.equal(r.category, 'archive');
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  assert.deepEqual({ p: r.archive!.projects, d: r.archive!.projectDocs, t: r.archive!.promptTemplates, e: r.archive!.entriesArchived }, { p: 2, d: 2, t: 1, e: 2 });
  const ix = new MemoryIndex(vault.loadAll());
  const [one, two] = ix.projects();
  assert.equal(one.project.conversationId, 'p-1');
  assert.equal(one.project.createdAt, '2026-06-01T10:00:00.000Z');
  assert.equal(one.project.authorName, 'Synthetic User');
  assert.ok(one.project.flags.includes('private'));
  assert.equal(one.project.parts.find((p) => p.type === 'instructions')!.text, ARCHIVE_MARKERS.instructions);
  assert.deepEqual(one.docs.map((x) => x.raw), (projectFixtures()['projects/p-1.json'] as any).docs);
  assert.equal(two.docs.length, 0);
  // Exact bytes of every entry and of the original ZIP.
  const files = ix.blobRecords();
  const orig = files.find((f) => f.kind === 'export_file')!;
  assert.equal(bytesOf(vault, orig.blob).equals(readFileSync(zip)), true);
  const entry = files.find((f) => f.messageId === 'projects/p-1.json')!;
  assert.equal(bytesOf(vault, entry.blob).toString(), JSON.stringify(projectFixtures()['projects/p-1.json']));
  vault.lock();
});

test('frames-000.zip: artifacts, full version history, file↔version links and byte-exact files (incl. >4 MiB, binary)', async () => {
  const { d, vault } = await fresh();
  const r = await importExport(vault, writeFramesZip(d));
  const a = r.archive!;
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  assert.equal(a.entries, framesFiles().length);
  assert.equal(a.entriesArchived, a.entries);
  assert.deepEqual({ art: a.artifacts, vl: a.versionsListed, vf: a.versionsWithFiles }, { art: 2, vl: 5, vf: 4 });
  // Tolerated anomalies are surfaced as warnings, never invented links.
  const reasons = r.warnings.map((w) => w.reason).join('\n');
  assert.match(reasons, /active_version is not listed/);
  assert.match(reasons, /Version w3 has no files/);
  assert.match(reasons, /does not match any version id/);
  const ix = new MemoryIndex(vault.loadAll());
  const arts = ix.artifacts();
  const a1 = arts.find((x) => x.artifact.conversationId === 'a-1')!;
  assert.deepEqual(a1.versions.map((v) => [v.messageId, v.flags.includes('active')]), [['v1', false], ['v2', true]]);
  assert.equal(a1.artifact.title, 'Second');
  const a2 = arts.find((x) => x.artifact.conversationId === 'a-2')!;
  assert.equal(a2.versions.length, 3);
  const orphan = a2.files.find((f) => f.messageId!.endsWith('orphan.md'))!;
  assert.deepEqual(orphan.relations, [{ type: 'artifact', target: 'a-2' }]); // artifact from path, no invented version
  const appJs = a2.files.find((f) => f.messageId!.endsWith('w1/app.js'))!;
  assert.deepEqual(appJs.relations, [{ type: 'artifact', target: 'a-2' }, { type: 'artifact_version', target: 'w1' }]);
  for (const f of framesFiles()) {
    const rec = ix.blobRecords().find((x) => x.messageId === f.name)!;
    const want = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    assert.equal(rec.blob!.sha256, sha(want), f.name);
    assert.equal(bytesOf(vault, rec.blob).equals(want), true, f.name);
  }
  const big = ix.blobRecords().find((x) => x.messageId!.endsWith('big.bin'))!;
  assert.equal(big.blob!.chunks.length, 2);
  assert.equal((big.raw as any).zip.crc32 > 0, true);
  vault.lock();
});

test('archive imports are idempotent; changed file bytes become a revision; nothing plaintext on disk', async () => {
  const { d, path, vault } = await fresh();
  const z = writeFramesZip(d);
  await importExport(vault, z);
  await importExport(vault, writeProjectsZip(d));
  const chunkCount = () => (new DatabaseSync(path).prepare('SELECT COUNT(*) n FROM chunks').get() as any).n;
  const before = { records: vault.count(), chunks: chunkCount() };
  const again = await importExport(vault, z);
  assert.equal(again.messagesInserted, 0);
  assert.equal(again.messagesRevised, 0);
  assert.equal(vault.count(), before.records + 2); // only the import's start/finish events
  assert.equal(chunkCount(), before.chunks);
  const files = framesFiles().map((f) => (f.name.endsWith('v1.html') ? { ...f, data: '<html>changed</html>' } : f));
  const d2 = tmp();
  const r3 = await importExport(vault, writeFramesZip(d2, files));
  assert.equal(r3.messagesRevised, 1);
  const ix = new MemoryIndex(vault.loadAll());
  const v1 = ix.blobRecords().filter((x) => x.messageId === 'artifacts/a-1/versions/v1.html');
  assert.equal(v1.length, 1); // latest view
  assert.equal(ix.all.filter((x) => x.messageId === 'artifacts/a-1/versions/v1.html').length, 2); // both kept
  vault.lock();
  const vb = readFileSync(path);
  for (const n of [ARCHIVE_MARKERS.instructions, ARCHIVE_MARKERS.doc, 'window.__omneme_should_never_run', 'example.invalid/exfil', 'Synthetic Project One', 'artifacts/a-1']) {
    assert.equal(vb.includes(Buffer.from(n)), false, `plaintext leaked: ${n}`);
  }
});

test('exported HTML/JS is never executed: importing a frames archive has no side effects', async () => {
  const { d, vault } = await fresh();
  (globalThis as any).__omneme_should_never_run = undefined;
  await importExport(vault, writeFramesZip(d));
  assert.equal((globalThis as any).__omneme_should_never_run, undefined);
  vault.lock();
});

test('verify detects a missing or tampered blob chunk; backup refuses; backup/restore round-trips all bytes', async () => {
  const { d, path, vault } = await fresh();
  await importExport(vault, writeFramesZip(d));
  await importExport(vault, writeProjectsZip(d));
  await importExport(vault, writeChatgptZip(d), { archiveOriginal: true });
  const before = new MemoryIndex(vault.loadAll()).blobRecords().map((r) => [r.recordId, r.blob!.sha256]).sort();
  const bak = join(d, 'b.omnbak');
  vault.exportBackup(bak);
  const ok = vault.verify(contentHash);
  assert.equal(ok.failed, 0); assert.ok(ok.blobs >= framesFiles().length + 3);
  vault.lock();
  // Restore elsewhere: every byte comes back.
  const target = join(tmp(), 'restored.omneme');
  const rr = await Vault.restoreBackup(bak, target, { password: PASSWORD });
  assert.ok(rr.chunks > 0);
  const rv = await Vault.unlock(target, { password: PASSWORD });
  const ix = new MemoryIndex(rv.loadAll());
  assert.deepEqual(ix.blobRecords().map((r) => [r.recordId, r.blob!.sha256]).sort(), before);
  for (const f of framesFiles()) {
    const rec = ix.blobRecords().find((x) => x.messageId === f.name)!;
    assert.equal(bytesOf(rv, rec.blob).equals(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data)), true);
  }
  assert.equal(rv.verify(contentHash).blobsFailed, 0);
  rv.lock();
  // A backup with a chunk line removed is refused.
  const lines = readFileSync(bak, 'utf8').split('\n');
  const noChunk = lines.filter((l, i) => !(l.startsWith('C ') && i === lines.findIndex((x) => x.startsWith('C ')))).join('\n');
  const bad = join(d, 'bad.omnbak'); writeFileSync(bad, noChunk);
  await assert.rejects(Vault.restoreBackup(bad, join(tmp(), 'x.omneme'), { password: PASSWORD }));
  // Delete a chunk in the live vault: verify flags it, backup refuses.
  const db = new DatabaseSync(path); db.exec('DELETE FROM chunks WHERE rowid = (SELECT MIN(rowid) FROM chunks)'); db.close();
  const v2 = await Vault.unlock(path, { password: PASSWORD });
  const chk = v2.verify(contentHash);
  assert.ok(chk.blobsFailed >= 1);
  assert.throws(() => v2.exportBackup(join(d, 'b2.omnbak')), /Backup refused/);
  assert.equal(existsSync(join(d, 'b2.omnbak')), false);
  v2.lock();
});

test('malformed project/manifest JSON and corrupt entries are reported (incomplete) while bytes stay archived', async () => {
  const { d, vault } = await fresh();
  const p = join(d, 'frames-000.zip');
  writeFileSync(p, makeZip([
    { name: 'artifacts/a-9/artifact.json', data: '{"id":"a-9","kind":"artifact","versions":[' },
    { name: 'projects/p-9.json', data: '{"not":"a project"}' },
    { name: 'artifacts/a-9/versions/x.html', data: '<p>x</p>' },
  ]));
  const r = await importExport(vault, p);
  assert.equal(r.complete, false);
  assert.equal(r.archive!.entriesArchived, 3);
  assert.ok(r.errors.some((e) => /Malformed JSON/.test(e.reason) && e.entry === 'artifacts/a-9/artifact.json'));
  assert.ok(r.errors.some((e) => /recognisable project/.test(e.reason)));
  // Corrupt entry (CRC) is not archived and is reported with its location.
  const name = 'artifacts/a-1/versions/v1.html';
  const buf = makeZip([{ name, data: Buffer.alloc(200, 65), store: true }]);
  buf[30 + name.length + 10] ^= 0xff; // flip a byte inside the stored file data
  const q = join(d, 'corrupt.zip'); writeFileSync(q, buf);
  const r2 = await importExport(vault, q);
  assert.equal(r2.complete, false);
  assert.match(r2.errors.find((e) => e.entry === 'artifacts/a-1/versions/v1.html')!.reason, /not archived/);
  vault.lock();
});

test('CLI: projects, artifacts, files and extract (refuses overwrite, verifies bytes)', () => {
  const d = tmp();
  const env = { ...process.env, OMNEME_PASSWORD: PASSWORD, OMNEME_KDF_N: String(TEST_KDF_N), OMNEME_TEST_MODE: '1', OMNEME_VAULT: join(d, 'v.omneme') };
  const cli = (...a: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'omneme.mjs'), ...a], { env, encoding: 'utf8' });
  cli('init');
  const imp = cli('import', writeProjectsZip(d), writeFramesZip(d));
  assert.match(imp.stdout, /2 projects, 2 documents, 1 with instructions/);
  assert.match(imp.stdout, /2 artifacts, 5 versions listed/);
  assert.ok(!imp.stdout.includes(ARCHIVE_MARKERS.instructions));
  assert.match(cli('projects').stdout, /Synthetic Project One/);
  assert.match(cli('artifacts').stdout, /version v2 \(active\)/);
  const line = cli('files', 'big.bin').stdout.trim().split('\n')[0];
  const id = line.split(/\s+/)[0];
  const out = join(d, 'big-out.bin');
  assert.equal(cli('extract', id, '--out', out).status, 0);
  const want = framesFiles().find((f) => f.name.endsWith('big.bin'))!.data as Buffer;
  assert.equal(readFileSync(out).equals(want), true);
  assert.notEqual(cli('extract', id, '--out', out).status, 0); // no overwrite
  assert.match(cli('verify').stdout, /failed: 0, archived blobs: \d+ \(0 failed\), record set: intact/);
});

test('page artifacts: page.md and comments.json archived and linked; versions reported as metadata-only, not as missing files', async () => {
  const { d, vault } = await fresh();
  const manifest = JSON.stringify({ id: 'pg-1', kind: 'page', visibility: 'private', updated_at: '2026-10-01T00:00:00Z', active_version: 'pv2',
    versions: [{ id: 'pv1', title: 'Draft', created_at: '2026-09-01T00:00:00Z' }, { id: 'pv2', title: 'Final', created_at: '2026-09-02T00:00:00Z' }] });
  const p = join(d, 'frames-000.zip');
  writeFileSync(p, makeZip([{ name: 'artifacts/pg-1/artifact.json', data: manifest }, { name: 'artifacts/pg-1/page.md', data: '# Page' }, { name: 'artifacts/pg-1/comments.json', data: '[]' }]));
  const r = await importExport(vault, p);
  assert.equal(r.complete, true);
  assert.equal(r.archive!.entriesArchived, 3);
  const w = r.warnings.map((x) => x.reason);
  assert.equal(w.filter((x) => /Page version pv\d: metadata only/.test(x)).length, 2);
  assert.ok(!w.some((x) => /has no files in this export/.test(x)));
  const ix = new MemoryIndex(vault.loadAll());
  const files = ix.artifacts()[0].files.map((f) => f.messageId).sort();
  assert.deepEqual(files, ['artifacts/pg-1/artifact.json', 'artifacts/pg-1/comments.json', 'artifacts/pg-1/page.md']);
  vault.lock();
});
