// OMN-060: a long X post is readable to its end through get_conversation's textOffset continuation (public callTool API).
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { MemoryIndex } from '../src/search.ts';
import { callTool } from '../src/mcp.ts';
import { PASSWORD, TEST_KDF_N, makeZip, tmp, writeChatgptZip } from './helpers.ts';

const ytd = (n: string, p: number, a: unknown[]) => `window.YTD.${n}.part${p} = ${JSON.stringify(a)}`;
// > 24000 characters, with surrogate pairs (emoji) and CJK placed around likely page boundaries, and an end marker.
const LONG = 'A'.repeat(15999) + '😀' + '日本語'.repeat(1000) + '🚀'.repeat(2000) + 'B'.repeat(3001) + ' END_MARKER';

async function setup() {
  const d = tmp();
  const { vault } = await Vault.create(join(d, 'v.omneme'), PASSWORD, { kdfN: TEST_KDF_N });
  await importExport(vault, writeChatgptZip(d));
  const zip = join(d, 'x.zip');
  writeFileSync(zip, makeZip([
    { name: 'data/account.js', data: ytd('account', 0, [{ account: { accountId: '1111' } }]) },
    { name: 'data/note-tweet.js', data: ytd('note_tweet', 0, [{ noteTweet: { noteTweetId: '700', createdAt: '2023-08-12T16:10:30.000Z', core: { text: LONG } } }]) },
    { name: 'data/tweets.js', data: ytd('tweets', 0, [{ tweet: { id_str: '100', full_text: 'short post', created_at: 'Sat Aug 12 16:10:37 +0000 2023' } }]) },
  ]));
  const r = await importExport(vault, zip);
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  const records = vault.loadAll();
  return { ix: new MemoryIndex(records), store: { vault, records } };
}

test('long social post: following textOffset continuation reconstructs the exact text, in bounded pages', async () => {
  const { ix, store } = await setup();
  assert.ok(LONG.length > 24000);
  const id = 'x-account:1111/note:700';
  let next: number | null = 0, pages = 0; const chunks: string[] = [];
  while (next !== null) {
    const res = callTool('get_conversation', next === 0 ? { id } : { id, textOffset: next }, ix, store);
    assert.equal(res.isError, undefined, res.text);
    const s = res.structured as any;
    assert.equal(s.id, id); assert.equal(s.type, 'social_post'); assert.equal(s.totalChars, LONG.length);
    assert.equal(s.textOffset, next);
    assert.ok(s.text.length > 0 && s.text.length <= 16000, 'bounded page');
    assert.ok(s.text.isWellFormed(), 'no split surrogate pair');
    assert.equal(s.returnedChars, s.text.length);
    assert.ok(res.text.includes(s.text), 'page text is in the text content');
    assert.ok(res.text.length <= 20000, 'whole response bounded');
    if (s.nextTextOffset !== null) {
      assert.ok(s.nextTextOffset > next!, 'progress');
      assert.ok(res.text.includes(`textOffset=${s.nextTextOffset}`), 'continuation instruction');
    } else assert.match(res.text, /End of post\.$/);
    chunks.push(s.text); next = s.nextTextOffset; pages++;
    assert.ok(pages <= 5, 'terminates');
  }
  assert.ok(pages >= 2);
  assert.equal(chunks.join(''), LONG, 'lossless reconstruction including END_MARKER');
  // A short post is still a single, complete page with the default call.
  const short = callTool('get_conversation', { id: 'tweet:100' }, ix, store);
  assert.equal((short.structured as any).nextTextOffset, null);
  assert.match(short.text, /short post/); assert.match(short.text, /End of post\.$/);
});

test('invalid textOffset values are rejected; chat offset/limit are unchanged', async () => {
  const { ix, store } = await setup();
  const id = 'x-account:1111/note:700';
  for (const bad of [-1, 1.5, 'abc', Infinity, LONG.length, LONG.length + 10, 16000]) { // 16000 is inside a surrogate pair
    const res = callTool('get_conversation', { id, textOffset: bad }, ix, store);
    assert.equal(res.isError, true, `textOffset ${String(bad)} must be rejected`);
    assert.match(res.text, /textOffset/);
  }
  assert.equal(callTool('get_conversation', { id, offset: 1 }, ix, store).isError, true);
  // Existing chat paging is unchanged.
  const page = callTool('get_conversation', { id: 'cg-branch', offset: 1, limit: 2 }, ix, store);
  assert.equal(page.isError, undefined);
  assert.match(page.text, /Messages 2-3 of \d+\./);
  assert.equal((page.structured as any).nextOffset, 3);
  assert.equal(callTool('get_conversation', { id: 'cg-branch', textOffset: 5 }, ix, store).isError, true);
});
