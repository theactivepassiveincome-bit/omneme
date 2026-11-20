// Stage 1.4: CodingCat AI Chat Exporter captures. Synthetic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { MemoryIndex } from '../src/search.ts';
import { contentHash } from '../src/schema.ts';
import { CC_MARKERS, PASSWORD, TEST_KDF_N, ccNote, codingcatFiles, makeZip, tmp, writeClaudeZip, writeCodingCatZip } from './helpers.ts';

async function fresh() { const d = tmp(); const path = join(d, 'v.omneme'); return { d, path, vault: (await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N })).vault }; }
const bytes = (v: Vault, ref: any) => Buffer.concat([...v.readBlob(ref)]);

test('CodingCat ZIP: every file and the ZIP archived byte-exact; JSON notes parsed with source attribution', async () => {
  const { d, vault } = await fresh();
  const zip = writeCodingCatZip(d);
  const r = await importExport(vault, zip);
  assert.equal(r.category, 'capture');
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  const c = r.capture!;
  assert.deepEqual({ files: c.entriesArchived, of: c.entries, json: c.notesJson, md: c.notesNotJson, proj: c.projectNotes }, { files: 8, of: 8, json: 2, md: 1, proj: 1 });
  assert.deepEqual(c.platforms, { gemini: 1, grok: 1 });
  assert.equal(r.messagesSeen, 2 + 3 + 3);
  assert.deepEqual(c.reports, ['_reports/export-report-2026-11-06-1000.md']);
  const ix = new MemoryIndex(vault.loadAll());
  // Original ZIP and every entry byte-exact.
  const orig = ix.blobRecords().find((x) => x.kind === 'export_file')!;
  assert.equal(bytes(vault, orig.blob).equals(readFileSync(zip)), true);
  for (const f of codingcatFiles()) {
    const e = ix.blobRecords().find((x) => x.kind === 'export_entry' && x.messageId === f.name)!;
    assert.ok(e, f.name);
    assert.equal(bytes(vault, e.blob).equals(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data)), true, f.name);
    assert.equal(e.provenance.importer, 'omneme.codingcat');
  }
  // Attribution: provider = platform, importer = CodingCat, note path recorded.
  const gem = ix.conversation('codingcat/gemini:gem-1')!;
  assert.equal(gem.conversation!.provider, 'gemini');
  assert.equal(gem.conversation!.provenance.importer, 'omneme.codingcat');
  assert.match(gem.conversation!.provenance.exportEntry, /\(Gemini\)\.json$/);
  assert.equal(gem.conversation!.model, '2.5 Pro');
  const hit = ix.search({ text: CC_MARKERS.gemini });
  assert.equal(hit.length, 1); assert.equal(hit[0].record.provider, 'gemini');
  assert.equal(ix.search({ text: '测试' })[0].record.provider, 'grok');
  vault.lock();
});

test('branches: visible branch and side branches keep fork points; raw message objects preserved', async () => {
  const { d, vault } = await fresh();
  const r = await importExport(vault, writeCodingCatZip(d));
  assert.equal(r.capture!.branches, 2);
  const ix = new MemoryIndex(vault.loadAll());
  const v = ix.conversation('codingcat/grok:grok-1')!;
  const by = Object.fromEntries(v.messages.map((m) => [m.record.messageId, m.record]));
  assert.equal(by.k2.parentMessageId, 'k1'); assert.ok(by.k2.flags.includes('current_branch'));
  assert.equal(by.k3.parentMessageId, 'k2');
  assert.equal(by.k2b.parentMessageId, 'k1'); assert.ok(by.k2b.flags.includes('branch_start'));
  assert.equal(by.k3b.parentMessageId, 'k2b');
  assert.equal(by.k0.parentMessageId, null); // fork at the root
  assert.equal(v.messages.find((m) => m.record.messageId === 'k2b')!.siblings, 2);
  const note = JSON.parse(codingcatFiles()[3].data as string);
  assert.deepEqual(by.k2b.raw, note.conversation.branches[0].messages[0]);
  vault.lock();
});

test('attachments: saved files linked and byte-exact; unavailable and recompressed reported, not hidden', async () => {
  const { d, vault } = await fresh();
  const r = await importExport(vault, writeCodingCatZip(d));
  const c = r.capture!;
  assert.deepEqual({ saved: c.attachmentsSaved, notProvided: c.attachmentsNotProvided, missing: c.attachmentsListedButMissing }, { saved: 2, notProvided: 1, missing: 0 });
  assert.deepEqual(c.attachmentNotes, { unavailable: 1, recompressed: 1 });
  const w = r.warnings.map((x) => x.reason).join('\n');
  assert.match(w, /not byte-exact originals per the platform: 1 recompressed/);
  assert.match(w, /1 attachment\(s\) were not provided/);
  assert.match(w, /1 message block\(s\) were unreadable/);
  assert.match(w, /1 chat note\(s\) are Markdown\/HTML\/DOCX/);
  assert.match(w, /export report archived/);
  const ix = new MemoryIndex(vault.loadAll());
  const g1 = ix.conversation('codingcat/gemini:gem-1')!.messages[0].record;
  assert.deepEqual(g1.attachments.map((a) => [a.name, a.availability]), [['map.png', 'archived_in_vault'], ['old-ticket.pdf', 'missing_from_export']]);
  const mapEntry = ix.blobRecords().find((x) => x.messageId!.endsWith('files/map.png'))!;
  assert.deepEqual(mapEntry.relations, [{ type: 'attachment_of', target: 'gemini:gem-1#g1' }]);
  assert.equal(bytes(vault, mapEntry.blob).toString('hex'), '89504e470d0a1a0a');
  const g2 = ix.conversation('codingcat/gemini:gem-1')!.messages[1].record;
  assert.deepEqual(g2.parts.map((p) => p.type), ['thinking', 'search', 'text', 'unknown', 'image']);
  assert.equal(g2.parts[3].originalType, 'unreadable:future_widget');
  vault.lock();
});

test('a file listed as saved but absent from the ZIP is an error (import incomplete), never silently dropped', async () => {
  const { d, vault } = await fresh();
  const files = codingcatFiles().filter((f) => !f.name.endsWith('files/map.png'));
  const r = await importExport(vault, writeCodingCatZip(d, files));
  assert.equal(r.complete, false);
  assert.match(r.errors[0].reason, /map\.png" is listed as saved at files\/map\.png but is not in the export/);
  assert.equal(r.errors[0].conversationId, 'gem-1');
  assert.equal(r.capture!.attachmentsListedButMissing, 1);
  vault.lock();
});

test('idempotent re-import; a later export with a new message adds only that message; official exports stay separate', async () => {
  const { d, vault } = await fresh();
  const zip = writeCodingCatZip(d);
  await importExport(vault, zip);
  const n = vault.count();
  const again = await importExport(vault, zip);
  assert.deepEqual([again.conversationsNew, again.conversationsRevised, again.messagesInserted, again.messagesRevised], [0, 0, 0, 0]);
  assert.equal(vault.count(), n + 2); // start/finish events only
  // Later export of the same Grok chat with one more message.
  const files = codingcatFiles();
  const gi = files.findIndex((f) => f.name.endsWith('(Grok).json'));
  const note = JSON.parse(files[gi].data as string);
  note.conversation.messages.push({ id: 'k4', role: 'assistant', createdAt: '2026-10-02T10:02:00.000Z', blocks: [{ type: 'text', markdown: 'new reply' }], attachments: [] });
  note.exportedAt = '2026-11-07T00:00:00.000Z';
  files[gi] = { name: files[gi].name, data: JSON.stringify(note, null, 2) };
  const r3 = await importExport(vault, writeCodingCatZip(tmp(), files));
  assert.equal(r3.messagesInserted, 1); assert.equal(r3.conversationsRevised, 1);
  // Official Claude export of a chat with the same id does not merge with or revise the capture.
  await importExport(vault, writeClaudeZip(d));
  const ix = new MemoryIndex(vault.loadAll());
  assert.ok(ix.conversation('claude:cl-1')); assert.ok(ix.conversation('codingcat/grok:grok-1'));
  assert.ok(ix.all.filter((x) => x.provenance.importer === 'omneme.claude').every((x) => !x.relations.some((rel) => rel.type === 'supersedes')));
  vault.lock();
});

test('malformed, unsupported-version and invalid notes are reported with location; bytes still archived', async () => {
  const { d, vault } = await fresh();
  const p = join(d, 'bad.zip');
  writeFileSync(p, makeZip([
    { name: 'A - 2026-01-01 (Claude)/A - 2026-01-01 (Claude).json', data: '{"format":"ai-chat-exporter/conversation@1", "conversation": {' },
    { name: 'B - 2026-01-01 (Claude)/B - 2026-01-01 (Claude).json', data: JSON.stringify({ format: 'ai-chat-exporter/conversation@2', conversation: {} }) },
    { name: 'C - 2026-01-01 (Claude)/C - 2026-01-01 (Claude).json', data: JSON.stringify(ccNote({ id: 'c', platform: 'myspace', messages: [] })) },
    { name: 'D - 2026-01-01 (Claude)/D - 2026-01-01 (Claude).json', data: JSON.stringify(ccNote({ id: 'd', platform: 'claude', title: 't', messages: [{ role: 'user', blocks: [] }], branches: [5] })) },
  ]));
  const r = await importExport(vault, p);
  assert.equal(r.complete, false);
  assert.equal(r.capture!.entriesArchived, 4);
  const reasons = r.errors.map((e) => `${e.entry}: ${e.reason}`).join('\n');
  assert.match(reasons, /A - .*Malformed JSON note/);
  assert.match(reasons, /B - .*Unsupported CodingCat format "ai-chat-exporter\/conversation@2"/);
  assert.match(reasons, /C - .*Not a valid CodingCat conversation/);
  assert.match(reasons, /D - .*Message at messages\[0\] has no id/);
  assert.match(reasons, /D - .*Branch 0 is malformed/);
  vault.lock();
});

test('single .json note and extracted folder are accepted; attachment paths cannot escape the export', async () => {
  const { d, vault } = await fresh();
  const single = join(d, 'One - 2026-10-05 (ChatGPT).json');
  writeFileSync(single, JSON.stringify(ccNote({ id: 'o1', platform: 'chatgpt', title: 'One', createdAt: null, updatedAt: null,
    messages: [{ id: 'm1', role: 'user', createdAt: null, blocks: [{ type: 'text', markdown: 'single note' }], attachments: [{ name: 'x', origin: 'user-upload', path: '../../etc/passwd' }] }], branches: [] })));
  const r = await importExport(vault, single);
  assert.equal(r.category, 'capture');
  assert.equal(r.capture!.attachmentsListedButMissing, 1);
  assert.match(r.errors[0].reason, /listed as saved at \.\.\/\.\.\/etc\/passwd but is not in the export/);
  const folder = join(d, 'extracted');
  for (const f of codingcatFiles()) { mkdirSync(join(folder, f.name, '..'), { recursive: true }); writeFileSync(join(folder, f.name), f.data); }
  const r2 = await importExport(vault, folder);
  assert.equal(r2.category, 'capture'); assert.equal(r2.complete, true, JSON.stringify(r2.errors));
  assert.equal(r2.capture!.attachmentsSaved, 2);
  vault.lock();
});

test('encrypted backup and restore recover captures, files and branches identically', async () => {
  const { d, vault } = await fresh();
  await importExport(vault, writeCodingCatZip(d));
  const before = vault.loadAll().map((x) => `${x.recordId}:${x.contentHash}`).sort();
  const bak = join(d, 'cc.omnbak'); vault.exportBackup(bak); vault.lock();
  const target = join(tmp(), 'r.omneme');
  await Vault.restoreBackup(bak, target, { password: PASSWORD });
  const rv = await Vault.unlock(target, { password: PASSWORD });
  assert.deepEqual(rv.loadAll().map((x) => `${x.recordId}:${x.contentHash}`).sort(), before);
  const chk = rv.verify(contentHash); assert.equal(chk.failed, 0); assert.equal(chk.blobsFailed, 0);
  const ix = new MemoryIndex(rv.loadAll());
  assert.equal(ix.conversation('codingcat/grok:grok-1')!.messages.length, 6);
  const itin = ix.blobRecords().find((x) => x.messageId!.endsWith('itinerary.png'))!;
  assert.equal(bytes(rv, itin.blob).toString('hex'), '89504e47deadbeef');
  rv.lock();
});

test('CLI: import summary, search attribution, show by namespaced id', () => {
  const d = tmp();
  const env = { ...process.env, OMNEME_PASSWORD: PASSWORD, OMNEME_KDF_N: String(TEST_KDF_N), OMNEME_TEST_MODE: '1', OMNEME_VAULT: join(d, 'v.omneme') };
  const cli = (...a: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'omneme.mjs'), ...a], { env, encoding: 'utf8' });
  cli('init');
  const imp = cli('import', writeCodingCatZip(d));
  assert.match(imp.stdout, /capture:\s+CodingCat export · 8\/8 files archived/);
  assert.match(imp.stdout, /2 JSON parsed \(gemini=1 grok=1\), 1 Markdown\/HTML\/DOCX archived only, 1 project notes archived/);
  assert.match(imp.stdout, /official exports remain the authoritative record/);
  assert.ok(!imp.stdout.includes(CC_MARKERS.gemini), 'no content in import output');
  assert.match(cli('search', 'gravity').stdout, /\[grok via CodingCat\]/);
  assert.match(cli('show', 'codingcat/grok:grok-1').stdout, /branch 1\/2[\s\S]*branch 2\/2/);
  assert.match(cli('list').stdout, /codingcat\/gemini:gem-1/);
  assert.match(cli('verify').stdout, /failed: 0, archived blobs: \d+ \(0 failed\), record set: intact/);
});
