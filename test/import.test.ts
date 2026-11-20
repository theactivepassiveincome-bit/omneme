import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { MemoryIndex } from '../src/search.ts';
import {
  MARKERS, PASSWORD, TEST_KDF_N, chatgptConversations, claudeConversations, largeChatgptConversation, makeZip, tmp, writeChatgptZip, writeClaudeZip,
} from './helpers.ts';

async function freshVault() {
  const d = tmp();
  const { vault } = await Vault.create(join(d, 'v.omneme'), PASSWORD, { kdfN: TEST_KDF_N });
  return { d, vault };
}

test('ChatGPT ZIP import preserves conversations, branches, roles, timestamps and provenance', async () => {
  const { d, vault } = await freshVault();
  const zip = writeChatgptZip(d);
  const r = await importExport(vault, zip);
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  assert.equal(r.conversationsSeen, 5);
  assert.equal(r.conversationsNew, 5);
  assert.equal(r.messagesSeen, 2 + 6 + 3 + 2 + 2);
  assert.equal(r.messagesInserted, r.messagesSeen);
  assert.equal(r.structuralNodes, 4);
  const ix = new MemoryIndex(vault.loadAll());
  const v = ix.conversation('cg-branch')!;
  assert.equal(v.messages.length, 6);
  const byId = Object.fromEntries(v.messages.map((m) => [m.record.messageId, m]));
  assert.equal(byId.b2.record.parentMessageId, 'b1');
  assert.equal(byId.b3.record.parentMessageId, 'b1');
  assert.equal(byId.b2.siblings, 2);
  assert.ok(byId.b3.record.flags.includes('current_branch'));
  assert.ok(!byId.b2.record.flags.includes('current_branch'));
  assert.ok(byId.sys.record.flags.includes('hidden'));
  assert.ok(byId.b1.record.flags.includes('branch_point'));
  assert.equal(byId.b1.record.createdAt, new Date((1_700_000_000 + 101) * 1000).toISOString());
  // Conversation record keeps the full mapping skeleton (all node ids, parents, children).
  const conv = v.conversation!;
  assert.deepEqual(Object.keys((conv.raw as any).mapping).sort(), ['b1', 'b2', 'b3', 'b4', 'b5', 'root', 'sys']);
  assert.deepEqual((conv.raw as any).mapping.b1.children, ['b2', 'b3']);
  // Raw message preserved verbatim.
  assert.deepEqual(byId.b2.record.raw, (chatgptConversations()[1] as any).mapping.b2.message);
  const simple = ix.conversation('cg-simple')!.messages.find((m) => m.record.role === 'assistant')!.record;
  assert.equal(simple.model, 'gpt-4o');
  assert.equal(simple.provenance.exportLabel, 'chatgpt-export.zip');
  assert.equal(simple.provenance.exportEntry, 'conversations.json');
  assert.match(simple.provenance.exportSha256!, /^[0-9a-f]{64}$/);
  assert.equal(simple.class, 'original');
  vault.lock();
});

test('attachments and multimodal parts are marked with honest availability', async () => {
  const { d, vault } = await freshVault();
  const r = await importExport(vault, writeChatgptZip(d));
  assert.deepEqual(r.attachments, { text_extracted: 0, referenced_in_export: 1, missing_from_export: 2, metadata_only: 0 });
  const m1 = new MemoryIndex(vault.loadAll()).conversation('cg-media')!.messages[0].record;
  const av = Object.fromEntries(m1.attachments.map((a) => [a.id, a.availability]));
  assert.deepEqual(av, { 'file-IMG001': 'referenced_in_export', 'file-GONE02': 'missing_from_export', 'file-DOC003': 'missing_from_export' });
  assert.equal(m1.attachments.find((a) => a.id === 'file-IMG001')!.exportEntry, 'file-IMG001-pixel.png');
  assert.deepEqual(m1.parts.map((p) => p.type), ['image', 'image', 'text']);
  const ix = new MemoryIndex(vault.loadAll());
  const nulls = ix.conversation('cg-nulls')!.messages.map((m) => m.record);
  assert.equal(nulls.length, 2);
  assert.equal(nulls[0].role, null);
  assert.equal(nulls[0].createdAt, null);
  assert.equal(nulls[1].parts[0].type, 'unknown');
  assert.equal(nulls[1].parts[0].originalType, 'new_future_type');
  vault.lock();
});

test('re-importing the same export is idempotent; a changed message becomes a revision, not an overwrite', async () => {
  const { d, vault } = await freshVault();
  const zip = writeChatgptZip(d);
  await importExport(vault, zip);
  const before = vault.count();
  const r2 = await importExport(vault, zip);
  assert.equal(r2.messagesInserted, 0);
  assert.equal(r2.messagesDuplicate, r2.messagesSeen);
  assert.equal(r2.conversationsUnchanged, 5);
  assert.equal(vault.count(), before + 2); // only the new import's started + finished event records
  const convs = chatgptConversations() as any[];
  convs[0].mapping.n2.message.content.parts = ['Edited synthetic answer'];
  const d2 = tmp();
  const r3 = await importExport(vault, writeChatgptZip(d2, convs));
  assert.equal(r3.messagesRevised, 1);
  const ix = new MemoryIndex(vault.loadAll());
  const shown = ix.conversation('cg-simple')!.messages.find((m) => m.record.messageId === 'n2')!.record;
  assert.equal(shown.text, 'Edited synthetic answer');
  assert.equal(shown.relations[0].type, 'supersedes');
  const original = ix.all.find((r) => r.messageId === 'n2' && r.text === 'Here is a synthetic answer.');
  assert.ok(original, 'original record must be retained');
  assert.equal(ix.revisions.get(shown.recordId), 2);
  vault.lock();
});

test('Claude ZIP import: roles, content blocks, extracted attachment text, explicit and inferred parents', async () => {
  const { d, vault } = await freshVault();
  const r = await importExport(vault, writeClaudeZip(d));
  assert.equal(r.complete, true);
  assert.equal(r.providers.claude, 3);
  assert.equal(r.messagesSeen, 6);
  assert.deepEqual(r.attachments, { text_extracted: 1, referenced_in_export: 0, missing_from_export: 1, metadata_only: 0 });
  assert.ok(r.warnings.some((w) => /no uuid/.test(w.reason)));
  const ix = new MemoryIndex(vault.loadAll());
  const c1 = ix.conversation('cl-1')!.messages.map((m) => m.record);
  assert.equal(c1[0].role, 'user');
  assert.equal(c1[1].parentMessageId, 'c1m1');
  assert.equal(c1[1].parentInferred, true);
  assert.deepEqual(c1[1].parts.map((p) => p.type), ['thinking', 'text', 'tool_use']);
  assert.ok(c1[0].text.includes(MARKERS.attachment));
  const c2 = ix.conversation('cl-2')!;
  const byId = Object.fromEntries(c2.messages.map((m) => [m.record.messageId, m]));
  assert.equal(byId.c2m2.record.parentInferred, false);
  assert.equal(byId.c2m2.siblings, 2);
  assert.ok(byId.c2m3.record.flags.includes('current_branch'));
  assert.ok(!byId.c2m2.record.flags.includes('current_branch'));
  vault.lock();
});

test('large conversation is imported in full (no truncation)', async () => {
  const { d, vault } = await freshVault();
  const p = join(d, 'conversations.json');
  writeFileSync(p, JSON.stringify([largeChatgptConversation(3000)]));
  const r = await importExport(vault, p);
  assert.equal(r.messagesInserted, 3000);
  const v = new MemoryIndex(vault.loadAll()).conversation('cg-large')!;
  assert.equal(v.messages.length, 3000);
  assert.equal(v.messages[2999].record.messageId, 'L2999');
  vault.lock();
});

test('malformed and truncated inputs are reported, valid parts still imported', async () => {
  const { d, vault } = await freshVault();
  const good = JSON.stringify(chatgptConversations()[0]);
  const p1 = join(d, 'conversations.json');
  writeFileSync(p1, `[${good}, {"mapping": {"a": broken}}, {"neither":"format"}]`);
  const r1 = await importExport(vault, p1);
  assert.equal(r1.complete, false);
  assert.equal(r1.conversationsNew, 1);
  assert.deepEqual(r1.errors.map((e) => e.index), [1, 2]);
  const p2 = join(d, 'trunc.json');
  writeFileSync(p2, `[${good}, ${good.slice(0, 50)}`);
  const r2 = await importExport(vault, p2);
  assert.equal(r2.complete, false);
  assert.match(r2.errors[0].reason, /truncated/);
  const p3 = join(d, 'bad.zip');
  writeFileSync(p3, Buffer.from('PK\u0003\u0004 this is not really a zip'));
  await assert.rejects(importExport(vault, p3), /ZIP/);
  const p4 = join(d, 'noconv.zip');
  writeFileSync(p4, makeZip([{ name: 'other.json', data: '[]' }]));
  const r4 = await importExport(vault, p4); // Stage 1.2: unknown categories are archived byte-exact, flagged
  assert.equal(r4.category, 'archive');
  assert.equal(r4.archive!.entriesArchived, 1);
  assert.ok(r4.warnings.some((w) => /No conversations, projects or artifacts recognised/.test(w.reason)));
  vault.lock();
});

test('search: keyword (incl. Chinese), provider/date filters and source provenance', async () => {
  const { d, vault } = await freshVault();
  await importExport(vault, writeChatgptZip(d));
  await importExport(vault, writeClaudeZip(d));
  const ix = new MemoryIndex(vault.loadAll());
  const s = ix.stats();
  assert.equal(s.conversations, 8);
  assert.equal(s.perProvider.chatgpt.messages, 15);
  assert.equal(s.perProvider.claude.messages, 6);
  const h = ix.search({ text: MARKERS.simple.toUpperCase() });
  assert.equal(h.length, 1);
  assert.equal(h[0].record.provider, 'chatgpt');
  assert.equal(h[0].record.conversationId, 'cg-simple');
  assert.equal(h[0].record.messageId, 'n1');
  assert.equal(h[0].conversationTitle, MARKERS.title);
  assert.equal(h[0].record.provenance.exportEntry, 'conversations.json');
  assert.equal(ix.search({ text: '长城 熊猫' }).length, 1);
  assert.equal(ix.search({ text: '测试中文' })[0].record.provider, 'claude');
  assert.equal(ix.search({ text: 'synthetic', provider: 'claude' }).every((x) => x.record.provider === 'claude'), true);
  assert.equal(ix.search({ text: MARKERS.claude, from: '2024-03-01', to: '2024-03-01' }).length, 1);
  assert.equal(ix.search({ text: MARKERS.claude, from: '2024-03-02' }).length, 0);
  assert.equal(ix.search({ text: MARKERS.simple, to: '2023-01-01' }).length, 0);
  assert.equal(ix.search({ text: 'alpha-marker beta-marker' }).length, 0); // AND semantics
  vault.lock();
});

test('Claude attachments with the same filename are distinct files, never merged', async () => {
  const { d, vault } = await freshVault();
  const convs = claudeConversations() as any[];
  convs[0].chat_messages[0].attachments.push({ file_name: 'notes.txt', file_size: 12, file_type: 'text/plain', extracted_content: 'second file, same name' });
  const r = await importExport(vault, writeClaudeZip(d, convs));
  assert.equal(r.attachments.text_extracted, 2);
  const m = new MemoryIndex(vault.loadAll()).conversation('cl-1')!.messages[0].record;
  assert.equal(m.attachments.filter((a) => a.name === 'notes.txt').length, 2);
  vault.lock();
});

test('unified search returns ChatGPT and Claude records together with correct provider attribution', async () => {
  const { d, vault } = await freshVault();
  await importExport(vault, writeChatgptZip(d));
  await importExport(vault, writeClaudeZip(d));
  const hits = new MemoryIndex(vault.loadAll()).search({ text: 'synthetic' });
  const providers = new Set(hits.map((h) => h.record.provider));
  assert.deepEqual([...providers].sort(), ['chatgpt', 'claude']);
  for (const h of hits) assert.equal(h.record.provenance.importer, `omneme.${h.record.provider}`);
  vault.lock();
});
