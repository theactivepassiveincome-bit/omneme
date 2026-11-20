// OMN-024: Google Takeout Gemini Apps activity importer. Synthetic fixtures only (structure modelled on the
// observed card layout; no real export content). Intended location: test/gemini.test.ts in the live tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { geminiActivityEntries, type ExportSource } from '../src/importers/source.ts';
import { DEFAULT_HTML_LIMITS, GEMINI_ACTIVITY_CONVERSATION, decodeEntities, findCards, parseHtml } from '../src/importers/gemini.ts';
import { PASSWORD, TEST_KDF_N, makeZip, tmp } from './helpers.ts';

const M = { prompt: 'gemini-prompt-marker-rho', response: 'gemini-response-marker-phi', odd: 'odd-card-marker-chi', health: 'health-marker-must-not-import', artifact: 'artifact-marker-must-not-import', script: 'script-marker-never-text' };
const GEM = 'Takeout/My Activity/Gemini Apps/My Activity.html';

const card = (body: string, aside = '') =>
  '<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">' +
  '<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>' +
  `<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${body}</div>` +
  `<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right">${aside}</div>` +
  '<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;Gemini Apps<br><b>Why is this here?</b><br>&emsp;Synthetic reason.<br></div>' +
  '</div></div>';
const page = (cards: string[]) =>
  `<html><head><meta charset="utf-8"><title>My Activity</title><style>.x{color:red}</style><script>var s="${M.script}"</script></head>` +
  `<body><div class="mdl-grid">${cards.join('')}</div></body></html>`;

const C1 = card(
  `Prompted&nbsp;Explain ${M.prompt} &amp; more<br>Jan 2, 2026, 10:00:00 AM UTC<br><p>Synthetic <b>response</b> ${M.response}</p><p>Second para</p><script>x="${M.script}"</script>`,
  '<a href="https://gemini.google.com/app/synthetic">Open</a><img src="image-1.png"><a href="missing%20file.pdf">file</a>',
);
const C2 = card('Used&nbsp;Synthetic Gem<br>Jan 3, 2026, 9:00:00 AM UTC<br>');
const C4 = `<div class="outer-cell"><span>odd ${M.odd}</span></div>`;
const CARDS = [C1, C2, C2, C4]; // C2 twice: identical cards must stay distinct entries

function takeoutZip(dir: string, cards = CARDS, name = 'takeout-synthetic.zip', extra: { name: string; data: string | Buffer }[] = []): string {
  const p = join(dir, name);
  writeFileSync(p, makeZip([
    { name: GEM, data: page(cards) },
    { name: 'Takeout/My Activity/Gemini Apps/image-1.png', data: Buffer.from('89504e470d0a1a0a', 'hex'), store: true },
    { name: 'Takeout/My Activity/Gemini Apps/artifact.html', data: `<html><body>${card('Prompted ' + M.artifact)}</body></html>` },
    { name: 'Takeout/My Activity/Health/My Activity.html', data: page([card('Prompted ' + M.health)]) },
    { name: 'Takeout/archive_browser.html', data: '<html><body>index</body></html>' },
    ...extra,
  ]));
  return p;
}
async function freshVault() {
  const d = tmp();
  const { vault } = await Vault.create(join(d, 'v.omneme'), PASSWORD, { kdfN: TEST_KDF_N });
  return { d, vault };
}
const gemini = (vault: Vault) => vault.loadAll().filter((r) => r.provider === 'gemini');

test('Gemini Takeout activity: cards preserved verbatim, nothing inferred, only the exact path parsed', async () => {
  const { d, vault } = await freshVault();
  const r = await importExport(vault, takeoutZip(d));
  assert.equal(r.complete, true, JSON.stringify(r.errors));
  assert.equal(r.category, 'activity');
  assert.deepEqual(r.activity, { entries: 1, cards: 4, promptedCards: 1, otherCards: 3, unrecognizedCards: 1, duplicateCards: 1, externalLinks: 1, refsInExport: 1, refsMissing: 1 });
  assert.equal(r.conversationsSeen, 1); assert.equal(r.elementsSeen, 1);
  assert.equal(r.sourceUnits, 4); assert.equal(r.messagesSeen, 4); assert.equal(r.messagesInserted, 4);
  assert.equal(r.attachments.referenced_in_export, 1); assert.equal(r.attachments.missing_from_export, 1);
  assert.ok(r.warnings.some((w) => /unrecognized card structure/.test(w.reason) && w.entry === GEM));
  assert.equal(r.originalArchived, null); // not archived unless requested

  const recs = gemini(vault);
  const conv = recs.find((x) => x.kind === 'conversation')!;
  assert.equal(conv.conversationId, GEMINI_ACTIVITY_CONVERSATION);
  assert.deepEqual(conv.flags, ['activity_log', 'not_complete_chats']);
  const msgs = recs.filter((x) => x.kind === 'message').sort((a, b) => a.provenance.elementIndex - b.provenance.elementIndex);
  assert.equal(msgs.length, 4);
  for (const m of msgs) {
    assert.equal(m.role, null); assert.equal(m.createdAt, null); assert.equal(m.parentMessageId, null);
    assert.equal(m.conversationId, GEMINI_ACTIVITY_CONVERSATION);
    assert.equal(m.provenance.importer, 'omneme.gemini-takeout'); assert.equal(m.provenance.exportEntry, GEM);
    assert.ok(m.flags.includes('activity_entry'));
    assert.ok(!m.text.includes(M.script), 'script content is never text');
  }
  // Exact card HTML kept as raw.
  assert.deepEqual(msgs[0].raw, { format: 'google-takeout/my-activity-card', html: C1 });
  // Observed text: "Prompted" labelled, not turned into a role; entities decoded; other segments kept in order.
  const p0 = msgs[0].parts.filter((p) => p.type === 'text');
  assert.deepEqual(p0[0], { type: 'text', text: `Explain ${M.prompt} & more`, originalType: 'prompted' });
  assert.deepEqual(p0[1], { type: 'text', text: 'Jan 2, 2026, 10:00:00 AM UTC', originalType: 'segment' });
  assert.match(p0[2].text!, new RegExp(`Synthetic response ${M.response}\\n\\nSecond para`));
  assert.ok(msgs[0].parts.some((p) => p.type === 'metadata' && p.originalType === 'caption' && p.text === 'Products:'));
  assert.ok(msgs[0].parts.some((p) => p.type === 'link' && p.ref === 'https://gemini.google.com/app/synthetic'));
  assert.ok(!msgs[0].text.includes('Products:'), 'metadata cells are not message text');
  const att = Object.fromEntries(msgs[0].attachments.map((a) => [a.ref, a]));
  assert.equal(att['image-1.png'].availability, 'referenced_in_export');
  assert.equal(att['image-1.png'].exportEntry, 'Takeout/My Activity/Gemini Apps/image-1.png');
  assert.equal(att['missing%20file.pdf'].availability, 'missing_from_export');
  assert.equal(att['missing%20file.pdf'].name, 'missing file.pdf');
  // Non-prompted card: no prompted label; identical cards are distinct, stable entries.
  assert.equal(msgs[1].parts[0].originalType, 'segment');
  assert.notEqual(msgs[1].messageId, msgs[2].messageId);
  assert.equal(msgs[2].messageId, msgs[1].messageId + '#2');
  // Unrecognised card kept verbatim and flagged.
  assert.ok(msgs[3].flags.includes('unrecognized_structure'));
  assert.equal((msgs[3].raw as any).html, C4);
  assert.match(msgs[3].text, new RegExp(M.odd));
  // Health and artifact HTML never parsed as chats.
  const all = JSON.stringify(vault.loadAll().map((x) => [x.text, x.parts]));
  assert.ok(!all.includes(M.health)); assert.ok(!all.includes(M.artifact));
  vault.lock();
});

test('Gemini Takeout re-import is idempotent; a newer export adds cards and revises only the container', async () => {
  const { d, vault } = await freshVault();
  const zip = takeoutZip(d);
  await importExport(vault, zip);
  const n = vault.count();
  const r2 = await importExport(vault, zip);
  assert.equal(r2.complete, true);
  assert.equal(r2.messagesInserted, 0); assert.equal(r2.messagesDuplicate, 4); assert.equal(r2.conversationsUnchanged, 1);
  assert.equal(vault.count(), n + 2); // only the two import events
  const C5 = card('Prompted&nbsp;a newer synthetic prompt<br>');
  const r3 = await importExport(vault, takeoutZip(d, [C5, ...CARDS], 'takeout-newer.zip'));
  assert.equal(r3.messagesInserted, 1); assert.equal(r3.messagesDuplicate, 4); assert.equal(r3.conversationsRevised, 1);
  vault.lock();
});

test('Gemini Takeout: truncated, oversized and non-UTF-8 sources are never reported complete', async () => {
  const { d, vault } = await freshVault();
  const trunc = page([C2]).replace('</div></div></div></body></html>', '');
  const rt = await importExport(vault, takeoutZip(d, [], 'empty.zip'));
  assert.equal(rt.complete, true); // an empty activity log is complete but warned
  assert.ok(rt.warnings.some((w) => /no activity cards/.test(w.reason)));

  const p1 = join(d, 'truncated.zip');
  writeFileSync(p1, makeZip([{ name: GEM, data: trunc }]));
  const r1 = await importExport(vault, p1);
  assert.equal(r1.complete, false);
  assert.ok(r1.errors.some((e) => /not closed before end of file/.test(e.reason) && e.entry === GEM && e.conversationId === GEMINI_ACTIVITY_CONVERSATION));
  const t = gemini(vault).find((x) => x.kind === 'message' && x.provenance.importId === r1.importId)!;
  assert.ok(t.flags.includes('truncated') && t.flags.includes('unrecognized_structure'));

  const r2 = await importExport(vault, takeoutZip(d, CARDS, 'big.zip'), { html: { ...DEFAULT_HTML_LIMITS, maxBytes: 100 } });
  assert.equal(r2.complete, false); assert.equal(r2.conversationsFailed, 1); assert.equal(r2.messagesSeen, 0);
  assert.ok(r2.errors.some((e) => /exceeds 100 bytes/.test(e.reason)));

  const p3 = join(d, 'bad-utf8.zip');
  writeFileSync(p3, makeZip([{ name: GEM, data: Buffer.from([0x3c, 0x68, 0x31, 0x3e, 0xff, 0xfe]) }]));
  const r3 = await importExport(vault, p3);
  assert.equal(r3.complete, false);
  assert.ok(r3.errors.some((e) => /not valid UTF-8/.test(e.reason)));
  for (const e of [...r1.errors, ...r2.errors, ...r3.errors]) assert.ok(!e.reason.includes('Synthetic Gem'), 'no content in errors');
  vault.lock();
});

test('only the exact Gemini Apps path is recognised', () => {
  const src = (names: string[]): ExportSource => ({ label: 'x.zip', path: 'x.zip', kind: 'zip', sha256: null, size: 0, entries: names.map((name) => ({ name, size: 0, open: async () => { throw new Error('unused'); } })) });
  const hit = (n: string) => geminiActivityEntries(src([n])).length === 1;
  assert.ok(hit(GEM));
  assert.ok(hit('My Activity/Gemini Apps/My Activity.html'));
  for (const n of ['Takeout/My Activity/Health/My Activity.html', 'Takeout/My Activity/Gemini Apps/artifact.html', 'Takeout/My Activity/Gemini Apps/My Activity.json',
    'x/Takeout/My Activity/Gemini Apps/My Activity.html', 'Takeout/My Activity/gemini apps/My Activity.html', 'Takeout/My Activity/Gemini Apps/sub/My Activity.html']) assert.ok(!hit(n), n);
  assert.equal(geminiActivityEntries({ ...src([GEM]), kind: 'json' }).length, 0);
});

test('HTML tokenizer: entities, implied </p>, stray tags, raw text, nested cards, bounds', () => {
  assert.equal(decodeEntities('&amp;&lt;&#x1F600;&#65;&nbsp;&bogus;&#xD800;'), '&<\u{1F600}A &bogus;�');
  const { root, mismatched } = parseHtml('<div class="a"><p>one<p>two</span></div><br/><img src=x.png alt="a &amp; b">');
  assert.equal(mismatched, 1); // only the stray </span>
  const div = root.children[0] as any;
  assert.deepEqual(div.children.map((c: any) => c.tag), ['p', 'p']);
  assert.equal(div.closed, true);
  assert.equal((root.children[2] as any).attrs.alt, 'a & b');
  const f = findCards(`<body>stray<div class="outer-cell"><div class="outer-cell">in</div></div><script>${'<div class="outer-cell">'}</script></body>`);
  assert.equal(f.cards.length, 1); assert.equal(f.nestedCards, 1); assert.equal(f.strayText, 1);
  assert.equal(f.cards[0].byteOffset, Buffer.byteLength('<body>stray'));
  const deep = '<div>'.repeat(20);
  assert.throws(() => parseHtml(deep, { ...DEFAULT_HTML_LIMITS, maxDepth: 10 }), /depth limit/);
  assert.throws(() => parseHtml('<b>x</b>'.repeat(10), { ...DEFAULT_HTML_LIMITS, maxNodes: 5 }), /node limit/);
  // Byte offsets count UTF-8 bytes, not UTF-16 units.
  const g = findCards('<p>记忆🐼</p><div class="outer-cell">x</div>');
  assert.equal(g.cards[0].byteOffset, Buffer.byteLength('<p>记忆🐼</p>'));
});
