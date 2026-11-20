// OMN-059: X archive importer, posts only. Synthetic archives only; no real export is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { parseXDate } from '../src/importers/x.ts';
import { MemoryIndex } from '../src/search.ts';
import { callTool } from '../src/mcp.ts';
import { PASSWORD, TEST_KDF_N, makeZip, tmp, writeChatgptZip } from './helpers.ts';

const ytd = (name: string, part: number, items: unknown[], tail = '') => `window.YTD.${name}.part${part} = ${JSON.stringify(items, null, 1)}${tail}`;
const tweet = (id: string, text: string, created = 'Sat Aug 12 16:10:37 +0000 2023', extra: object = {}) =>
  ({ tweet: { id_str: id, id, full_text: text, created_at: created, lang: 'en', favorite_count: '0', retweet_count: '0', ...extra } });
const account = (id: string) => ytd('account', 0, [{ account: { accountId: id, username: 'synthetic_user', createdAt: '2010-01-01T00:00:00.000Z' } }]);
const MEDIA = { extended_entities: { media: [{ id_str: '9001', media_url_https: 'https://pbs.twimg.com/media/Synth01.jpg', type: 'photo' }, { id_str: '9002', media_url_https: 'https://pbs.twimg.com/media/Gone02.png', type: 'photo' }] } };

function xZip(dir: string, name: string, files: Record<string, string | Buffer>) {
  const p = join(dir, name);
  writeFileSync(p, makeZip(Object.entries(files).map(([n, data]) => ({ name: n, data }))));
  return p;
}
function standard(acct = '1111') {
  return {
    'Your archive.html': '<html>viewer</html>', 'assets/js/app.js': 'console.log(1)', 'assets/images/twemoji/1f600.svg': '<svg/>',
    'data/account.js': account(acct),
    'data/tweets.js': ytd('tweets', 0, [tweet('100', 'Hello zeppelin-marker &amp; friends 🚀 日本語', 'Sat Aug 12 16:10:37 +0000 2023', MEDIA),
      tweet('101', 'A reply about quasar-marker', 'Mon Jan 01 09:00:00 +0800 2024', { in_reply_to_status_id_str: '55', in_reply_to_screen_name: 'someone' })]),
    'data/tweets-part1.js': ytd('tweets', 1, [tweet('102', 'RT @someone: reposted nebula-marker')]),
    'data/deleted-tweets.js': ytd('deleted_tweets', 0, [{ tweet: { ...tweet('103', 'Deleted but kept comet-marker').tweet, deleted_at: 'Sun Aug 13 10:00:00 +0000 2023' } }]),
    'data/note-tweet.js': ytd('note_tweet', 0, [{ noteTweet: { noteTweetId: '700', createdAt: '2023-08-12T16:10:30.000Z', updatedAt: '2023-08-12T16:10:30.000Z', core: { text: 'Long form ' + 'x'.repeat(400) + ' orbit-marker', urls: [], mentions: [], hashtags: [] } } }]),
    'data/tweets_media/100-Synth01.jpg': Buffer.alloc(64, 1),
    'data/direct-messages.js': ytd('direct_messages', 0, [{ dmConversation: { conversationId: '1-2', messages: [] } }]),
    'data/grok-chat-item.js': ytd('grok_chat_item', 0, []),
    'data/like.js': ytd('like', 0, [{ like: { tweetId: '5', fullText: 'liked' } }]),
    'data/manifest.js': 'window.__THAR_CONFIG = {}',
  };
}
async function freshVault() {
  const d = tmp();
  const { vault } = await Vault.create(join(d, 'v.omneme'), PASSWORD, { kdfN: TEST_KDF_N });
  return { d, vault };
}
const posts = (v: Vault) => v.loadAll().filter((r) => r.kind === 'social_event');

test('X dates: strict created_at parsing with offset and weekday validation', () => {
  assert.equal(parseXDate('Sat Aug 12 16:10:37 +0000 2023'), '2023-08-12T16:10:37.000Z');
  assert.equal(parseXDate('Mon Jan 01 09:00:00 +0800 2024'), '2024-01-01T01:00:00.000Z');
  for (const bad of ['Fri Aug 12 16:10:37 +0000 2023', 'Sat Feb 30 00:00:00 +0000 2023', '2023-08-12', 'Sat Aug 12 25:00:00 +0000 2023', 12345]) assert.equal(parseXDate(bad), null);
});

test('posts, split parts, deleted posts and notes import as social records; everything else is accounted for', async () => {
  const { d, vault } = await freshVault();
  const r = await importExport(vault, xZip(d, 'x.zip', standard()));
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  assert.equal(r.category, 'social');
  const s = r.social!;
  assert.deepEqual(s.membersImported, ['data/tweets.js', 'data/tweets-part1.js', 'data/deleted-tweets.js', 'data/note-tweet.js']);
  assert.deepEqual([s.postsSeen, s.postsNew, s.notes, s.deleted, s.malformed], [5, 5, 1, 1, 0]);
  assert.deepEqual(s.notImported.map((n) => n.entry), ['data/direct-messages.js', 'data/grok-chat-item.js', 'data/like.js', 'data/manifest.js']);
  assert.deepEqual(s.mediaFiles, { files: 1, bytes: 64 });
  assert.equal(s.viewerAssets.files, 3);
  assert.ok(r.warnings.some((w) => /4 other X data file\(s\) not imported \(posts only/.test(w.reason)));
  // Chat counts are not inflated; no conversations were invented.
  assert.deepEqual([r.conversationsSeen, r.messagesSeen], [0, 0]);
  const all = posts(vault);
  assert.equal(all.length, 5);
  const byId = new Map(all.map((p) => [p.messageId, p]));
  const p100 = byId.get('tweet:100')!;
  assert.equal(p100.provider, 'x'); assert.equal(p100.conversationId, 'x-account:1111'); assert.equal(p100.title, 'X post');
  assert.equal(p100.text, 'Hello zeppelin-marker & friends 🚀 日本語'); // Unicode kept, HTML entity decoded in searchable text only
  assert.equal((p100.raw as any).tweet.full_text, 'Hello zeppelin-marker &amp; friends 🚀 日本語'); // raw provider object verbatim
  assert.equal(p100.createdAt, '2023-08-12T16:10:37.000Z');
  assert.deepEqual(p100.attachments.map((a) => [a.ref, a.availability]), [['data/tweets_media/100-Synth01.jpg', 'referenced_in_export'], ['data/tweets_media/100-Gone02.png', 'missing_from_export']]);
  assert.deepEqual(p100.provenance.exportEntry, 'data/tweets.js'); assert.equal(p100.provenance.importer, 'omneme.x');
  const p101 = byId.get('tweet:101')!;
  assert.equal(p101.title, 'X reply'); assert.equal(p101.createdAt, '2024-01-01T01:00:00.000Z');
  assert.deepEqual(p101.relations, [{ type: 'reply_to', target: 'x:tweet:55' }]); assert.equal(p101.parentMessageId, null);
  assert.deepEqual(byId.get('tweet:102')!.flags, ['repost']);
  const del = byId.get('tweet:103')!;
  assert.deepEqual(del.flags, ['deleted']); assert.equal(del.title, 'X deleted post'); assert.match(del.text, /comet-marker/);
  const note = byId.get('note:700')!;
  assert.equal(note.title, 'X long-form note'); assert.equal(note.text.length, 'Long form '.length + 400 + ' orbit-marker'.length); // never truncated
  assert.deepEqual(note.relations, []); // no documented join: none guessed
  // Media referenced, never copied: no blob records, no original-archive record.
  assert.equal(vault.loadAll().filter((x) => x.blob || x.kind === 'export_file' || x.kind === 'export_entry').length, 0);
  const st = new MemoryIndex(vault.loadAll()).stats();
  assert.deepEqual([st.conversations, st.messages, st.socialEvents], [0, 0, 5]);
});

test('X posts are found by local search and MCP search_memory, and retrievable whole (not as a chat)', async () => {
  const { d, vault } = await freshVault();
  await importExport(vault, writeChatgptZip(d)); // existing chats stay intact alongside posts
  const chatStats = new MemoryIndex(vault.loadAll()).stats();
  await importExport(vault, xZip(d, 'x.zip', standard()));
  const records = vault.loadAll(); const ix = new MemoryIndex(records);
  const st = ix.stats();
  assert.deepEqual([st.conversations, st.messages], [chatStats.conversations, chatStats.messages]);
  const hits = ix.search({ text: 'zeppelin-marker' });
  assert.equal(hits.length, 1); assert.equal(hits[0].record.kind, 'social_event'); assert.equal(hits[0].conversationTitle, 'X post');
  assert.equal(ix.search({ text: 'zeppelin-marker', provider: 'chatgpt' }).length, 0);
  assert.equal(ix.search({ text: 'zeppelin-marker', provider: 'x', from: '2023-08-12', to: '2023-08-12' }).length, 1);
  const store = { vault, records };
  const res = callTool('search_memory', { query: 'zeppelin-marker', provider: 'x' }, ix, store);
  assert.match(res.text, /\[x\] X post \(2023-08-12\).*id=x-account:1111\/tweet:100/);
  assert.equal((res.structured as any).results[0].type, 'social_post');
  const open = callTool('get_conversation', { id: 'x-account:1111/tweet:100' }, ix, store);
  assert.equal(open.isError, undefined);
  assert.match(open.text, /^Social post: X post \[x\] id=x-account:1111\/tweet:100\n2023-08-12T16:10:37.000Z\n\nHello zeppelin-marker & friends/);
  assert.match(open.text, /\[media\] Synth01\.jpg \(in the original X archive; not copied into the vault\)/);
  assert.equal(callTool('get_conversation', { id: 'tweet:100' }, ix, store).isError, undefined); // unique native id also works
  // Existing chat search and reading still work.
  const chat = ix.search({ text: 'synthetic answer' });
  assert.ok(chat.length > 0 && chat.every((h) => h.record.kind === 'message'));
  assert.equal(callTool('get_conversation', { id: 'cg-simple' }, ix, store).isError, undefined);
});

test('re-import is idempotent; split layout changes add nothing; edits become revisions; absence never deletes', async () => {
  const { d, vault } = await freshVault();
  const first = standard();
  await importExport(vault, xZip(d, 'a.zip', first));
  const again = await importExport(vault, xZip(d, 'b.zip', first));
  assert.deepEqual([again.social!.postsNew, again.social!.postsRevised, again.social!.postsDuplicate], [0, 0, 5]);
  // Same posts, different split layout: tweet 102 moves into tweets.js, part1 disappears.
  const relaid: Record<string, string | Buffer> = { ...first };
  delete relaid['data/tweets-part1.js'];
  relaid['data/tweets.js'] = ytd('tweets', 0, [tweet('100', 'Hello zeppelin-marker &amp; friends 🚀 日本語', 'Sat Aug 12 16:10:37 +0000 2023', MEDIA),
    tweet('101', 'A reply about quasar-marker', 'Mon Jan 01 09:00:00 +0800 2024', { in_reply_to_status_id_str: '55', in_reply_to_screen_name: 'someone' }), tweet('102', 'RT @someone: reposted nebula-marker')]);
  const moved = await importExport(vault, xZip(d, 'c.zip', relaid));
  assert.deepEqual([moved.social!.postsNew, moved.social!.postsRevised, moved.social!.postsDuplicate], [0, 0, 5]);
  // A later export: post 100 changed (e.g. counts/text), post 101 missing.
  const later: Record<string, string | Buffer> = { ...first, 'data/tweets.js': ytd('tweets', 0, [tweet('100', 'Hello zeppelin-marker edited', 'Sat Aug 12 16:10:37 +0000 2023', MEDIA)]) };
  const rev = await importExport(vault, xZip(d, 'd.zip', later));
  assert.equal(rev.complete, true);
  assert.deepEqual([rev.social!.postsNew, rev.social!.postsRevised], [0, 1]);
  const versions = posts(vault).filter((p) => p.messageId === 'tweet:100');
  assert.equal(versions.length, 2, 'earlier version kept');
  const ix = new MemoryIndex(vault.loadAll());
  assert.equal(ix.socialRecord('tweet:100')!.text, 'Hello zeppelin-marker edited');
  assert.ok(ix.socialRecord('tweet:101'), 'a post missing from a later export is not deleted');
  assert.equal(ix.social.length, 5);
});

test('different accounts never collide, even with equal native ids', async () => {
  const { d, vault } = await freshVault();
  await importExport(vault, xZip(d, 'a.zip', standard('1111')));
  const r = await importExport(vault, xZip(d, 'b.zip', standard('2222')));
  assert.equal(r.social!.postsNew, 5);
  const ix = new MemoryIndex(vault.loadAll());
  assert.equal(ix.social.length, 10);
  assert.equal(ix.socialRecord('tweet:100'), null, 'an ambiguous native id is not guessed');
  assert.equal(ix.socialRecord('x-account:2222/tweet:100')!.conversationId, 'x-account:2222');
});

test('wrappers are validated as text, never executed; bad members, dates and ids are reported, not skipped silently', async () => {
  const { d, vault } = await freshVault();
  (globalThis as any).__omnemeXPwned = false;
  const bad = {
    ...standard(),
    'data/tweets.js': ytd('tweets', 0, [tweet('100', 'ok one')], '; globalThis.__omnemeXPwned = true'), // malicious suffix
    'data/tweets-part1.js': ytd('tweets', 7, [tweet('102', 'wrong part')]), // wrapper part mismatch
    'data/deleted-tweets.js': 'globalThis.__omnemeXPwned = true; ' + ytd('deleted_tweets', 0, []), // code before the wrapper
    'data/note-tweet.js': ytd('note_tweet', 0, [{ noteTweet: { noteTweetId: 'abc', createdAt: '2023-01-01T00:00:00Z', core: { text: 'x' } } },
      { noteTweet: { noteTweetId: '701', createdAt: 'yesterday', core: { text: 'x' } } }, { tweet: { id_str: '1' } }]),
  };
  const r = await importExport(vault, xZip(d, 'bad.zip', bad));
  assert.equal((globalThis as any).__omnemeXPwned, false);
  assert.equal(r.complete, false); assert.equal(r.status, 'incomplete');
  const reasons = r.errors.map((e) => `${e.entry}: ${e.reason}`);
  assert.ok(reasons.some((x) => /^data\/tweets\.js: Unexpected data after end of JSON array/.test(x)), reasons.join('\n'));
  assert.ok(reasons.some((x) => /^data\/tweets-part1\.js: Wrapper does not match the member \(expected window\.YTD\.tweets\.part1\)/.test(x)));
  assert.ok(reasons.some((x) => /^data\/deleted-tweets\.js: Unsupported wrapper/.test(x)));
  assert.ok(reasons.some((x) => /^data\/note-tweet\.js: Note has no valid noteTweetId/.test(x)));
  assert.ok(reasons.some((x) => /^data\/note-tweet\.js: Note 701 has an invalid createdAt/.test(x)));
  assert.ok(reasons.some((x) => /^data\/note-tweet\.js: Element is not a \{"noteTweet": \.\.\.\} wrapper/.test(x)));
  assert.ok(r.errors.every((e) => !/ok one|wrong part/.test(e.reason)), 'reasons carry no content');
  assert.equal(r.social!.malformed, 3);
  // The readable post before the malicious suffix is kept (everything readable is imported, import marked incomplete).
  assert.deepEqual(posts(vault).map((p) => p.messageId), ['tweet:100']);
  // Bad tweet date / id inside an otherwise valid member.
  const { d: d2, vault: v2 } = await freshVault();
  const r2 = await importExport(v2, xZip(d2, 'dates.zip', { ...standard(), 'data/tweets-part1.js': ytd('tweets', 1, [tweet('102', 'bad date', 'Fri Aug 12 16:10:37 +0000 2023'), tweet('x9', 'bad id')]) }));
  assert.equal(r2.complete, false);
  assert.ok(r2.errors.some((e) => e.entry === 'data/tweets-part1.js' && e.index === 0 && /Tweet 102 has an invalid created_at/.test(e.reason)));
  assert.ok(r2.errors.some((e) => e.entry === 'data/tweets-part1.js' && e.index === 1 && /Tweet has no valid id/.test(e.reason)));
  assert.equal(r2.social!.postsNew, 4);
});

test('missing account, forced provider and oversize elements are reported; nothing is imported without an account', async () => {
  const { d, vault } = await freshVault();
  const noAcct: Record<string, string | Buffer> = { ...standard() };
  noAcct['data/account.js'] = ytd('account', 0, [{ account: { username: 'no id' } }]);
  const r = await importExport(vault, xZip(d, 'noacct.zip', noAcct));
  assert.equal(r.complete, false);
  assert.ok(r.errors.some((e) => e.entry === 'data/account.js' && /no valid accountId/.test(e.reason)));
  assert.equal(posts(vault).length, 0);
  const forced = await importExport(vault, writeChatgptZip(d), { provider: 'x' });
  assert.equal(forced.complete, false); assert.ok(forced.errors.some((e) => /Not an X archive/.test(e.reason)));
  const big = await importExport(vault, xZip(d, 'big.zip', standard('3333')), { json: { maxDepth: 64, maxElementBytes: 300 } });
  assert.equal(big.complete, false);
  assert.ok(big.errors.some((e) => e.entry === 'data/note-tweet.js' && /exceeds size limit/.test(e.reason)));
});
