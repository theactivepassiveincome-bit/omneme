// Google Takeout "My Activity / Gemini Apps / My Activity.html" importer (OMN-024, staged).
//
// The file is an activity LOG, not a chat export. Each `outer-cell` card is preserved verbatim (its exact HTML) as one
// message-kind record under a single Omneme-assigned container (GEMINI_ACTIVITY_CONVERSATION). Observed structure:
//   div.outer-cell > div.mdl-grid > div.header-cell, div.content-cell (6-col body-1: br-delimited segments, typically
//   starting "Prompted"), div.content-cell (6-col text-right), div.content-cell (12-col caption metadata).
// Deliberately NOT inferred (no evidence in the observed structure): role, Gemini conversation id/grouping, branches,
// timestamps (createdAt stays null; date-like text remains a plain segment), which segment is the response, and any
// attachment mapping beyond a relative href/src that resolves to an entry present in the export.
//
// Reuse note: Node has no built-in HTML parser and the project allows zero runtime dependencies, so a small bounded
// tokenizer (~120 lines) is used instead of parse5/htmlparser2 (both MIT; preferred if a dependency is approved).
// It only needs element nesting, text, <br>, links and images; it never executes or renders anything.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import type { Attachment, ContentPart, DraftRecord, Provenance } from '../schema.ts';
import { base, emptyAttachmentStats, type ConvertCtx } from './common.ts';

export const GEMINI_TAKEOUT_IMPORTER = { id: 'omneme.gemini-takeout', version: '0.1.0' };
export const GEMINI_ACTIVITY_CONVERSATION = 'takeout:gemini-apps-activity';
/** Exact Takeout path only (optionally without the leading "Takeout/" when an extracted Takeout folder is imported). */
export const GEMINI_ACTIVITY_PATH = /^(Takeout\/)?My Activity\/Gemini Apps\/My Activity\.html$/;

export interface HtmlLimits { maxBytes: number; maxDepth: number; maxNodes: number; maxCards: number }
export const DEFAULT_HTML_LIMITS: HtmlLimits = { maxBytes: 256 * 2 ** 20, maxDepth: 512, maxNodes: 20_000_000, maxCards: 1_000_000 };

export interface GeminiActivityStats {
  entries: number; cards: number; promptedCards: number; otherCards: number; unrecognizedCards: number;
  duplicateCards: number; externalLinks: number; refsInExport: number; refsMissing: number;
}
export function emptyGeminiStats(): GeminiActivityStats {
  return { entries: 0, cards: 0, promptedCards: 0, otherCards: 0, unrecognizedCards: 0, duplicateCards: 0, externalLinks: 0, refsInExport: 0, refsMissing: 0 };
}

// ---------------------------------------------------------------- tokenizer + light tree
export interface El { tag: string; attrs: Record<string, string>; children: Node[]; start: number; end: number; closed: boolean }
type Node = El | string;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const CLOSES_P = new Set(['div', 'p', 'ul', 'ol', 'table', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']);
const BLOCK = new Set([...CLOSES_P, 'li', 'tr', 'section', 'article', 'header', 'footer']);
/** Elements whose end tag HTML lets an author omit; closing them implicitly is not counted as a mismatch. */
const IMPLIED_END = new Set(['p', 'li', 'dt', 'dd', 'option', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot']);
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ENT: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', emsp: ' ', ensp: ' ', thinsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
};
/** Decode numeric and common named entities; unknown named entities are kept verbatim. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
    }
    return ENT[e] ?? m;
  });
}

export class HtmlLimitError extends Error {}

/** Parse into a light element tree. Tolerant of unclosed/stray tags (counted in `mismatched`), bounded by `limits`. */
export function parseHtml(src: string, limits: HtmlLimits = DEFAULT_HTML_LIMITS): { root: El; mismatched: number } {
  const root: El = { tag: '#root', attrs: {}, children: [], start: 0, end: src.length, closed: true };
  const stack: El[] = [root];
  let i = 0, nodes = 0, mismatched = 0;
  const top = () => stack[stack.length - 1];
  const count = () => { if (++nodes > limits.maxNodes) throw new HtmlLimitError(`HTML node limit exceeded (${limits.maxNodes})`); };
  const text = (t: string) => { if (t) { count(); top().children.push(decodeEntities(t)); } };
  /** Close the nearest open `tag` (ending at `after`); elements above it end implicitly at `at`. */
  const popTo = (tag: string, at: number, after: number) => {
    for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) {
      while (stack.length > k + 1) { const e = stack.pop()!; e.end = at; if (!IMPLIED_END.has(e.tag)) mismatched++; else e.closed = true; }
      const e = stack.pop()!; e.end = after; e.closed = true;
      return true;
    }
    return false;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(src.slice(i)); break; }
    text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    TAG.lastIndex = lt;
    const m = TAG.exec(src);
    if (!m) { text('<'); i = lt + 1; continue; } // a bare '<' is text
    const [whole, close, rawTag, rawAttrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    const after = lt + whole.length;
    if (close) {
      if (tag === 'br') { count(); top().children.push({ tag: 'br', attrs: {}, children: [], start: lt, end: after, closed: true }); } // </br> acts as <br>
      else if (!popTo(tag, lt, after)) mismatched++; // stray end tag: ignored
      i = after; continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(ATTR)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    if (CLOSES_P.has(tag) && stack.some((e) => e.tag === 'p')) popTo('p', lt, lt); // implied </p>
    count();
    const el: El = { tag, attrs, children: [], start: lt, end: after, closed: false };
    top().children.push(el);
    if (VOID.has(tag) || selfClose) { el.closed = true; i = after; continue; }
    if (RAW.has(tag)) {
      const endRe = new RegExp(`</${tag}[\\s/>]`, 'ig'); endRe.lastIndex = after;
      const em = endRe.exec(src);
      const stop = em ? em.index : src.length;
      if (tag === 'title' || tag === 'textarea') el.children.push(decodeEntities(src.slice(after, stop)));
      const gt = em ? src.indexOf('>', em.index) : -1;
      el.end = gt < 0 ? src.length : gt + 1; el.closed = gt >= 0; if (gt < 0) mismatched++;
      i = el.end; continue;
    }
    stack.push(el);
    if (stack.length > limits.maxDepth) throw new HtmlLimitError(`HTML nesting depth limit exceeded (${limits.maxDepth})`);
    i = after;
  }
  while (stack.length > 1) { const e = stack.pop()!; e.end = src.length; mismatched++; }
  return { root, mismatched };
}

const classes = (e: El) => new Set((e.attrs.class ?? '').split(/\s+/).filter(Boolean));
const els = (n: Node[]) => n.filter((c): c is El => typeof c !== 'string');
function walk(e: El, fn: (x: El) => boolean | void): void { for (const c of els(e.children)) if (fn(c) !== false) walk(c, fn); }

/** Rendered-ish text: whitespace collapsed (except in <pre>), <br> and block boundaries become newlines. */
function textOfNodes(nodes: Node[], pre = false): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') out += pre ? n : n.replace(/[ \t\n\r\f]+/g, ' ');
    else if (n.tag === 'br') out += '\n';
    else if (n.tag === 'script' || n.tag === 'style') continue;
    else {
      const t = textOfNodes(n.children, pre || n.tag === 'pre');
      out += BLOCK.has(n.tag) ? `\n${t}\n` : t;
    }
  }
  return out;
}
const tidy = (s: string) => s.split('\n').map((l) => l.replace(/^[ \t]+|[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');

/** Split a cell's top-level children at <br> into segments; nested <br>s stay inside their segment as newlines. */
function segments(cell: El): string[] {
  const segs: Node[][] = [[]];
  for (const c of cell.children) { if (typeof c !== 'string' && c.tag === 'br') segs.push([]); else segs[segs.length - 1].push(c); }
  return segs.map((s) => tidy(textOfNodes(s))).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------- cards -> records
export interface ParsedActivity { title: string | null; cards: { html: string; start: number; byteOffset: number; el: El }[]; strayText: number; nestedCards: number; truncatedCards: number; mismatched: number }

export function findCards(html: string, limits: HtmlLimits = DEFAULT_HTML_LIMITS): ParsedActivity {
  const { root, mismatched } = parseHtml(html, limits);
  let title: string | null = null, strayText = 0, nestedCards = 0, truncatedCards = 0;
  const cards: ParsedActivity['cards'] = [];
  let lastIdx = 0, lastBytes = 0;
  const visit = (e: El, inCard: boolean, inHead: boolean) => {
    for (const c of e.children) {
      if (typeof c === 'string') { if (!inCard && !inHead && c.trim()) strayText++; continue; }
      if (c.tag === 'title' && title === null) title = tidy(textOfNodes(c.children)) || null;
      if (c.tag === 'div' && classes(c).has('outer-cell')) {
        if (inCard) { nestedCards++; continue; } // kept verbatim inside the enclosing card's HTML
        if (cards.length >= limits.maxCards) throw new HtmlLimitError(`Card limit exceeded (${limits.maxCards})`);
        if (!c.closed) truncatedCards++;
        lastBytes += Buffer.byteLength(html.slice(lastIdx, c.start), 'utf8'); lastIdx = c.start;
        cards.push({ html: html.slice(c.start, c.end), start: c.start, byteOffset: lastBytes, el: c });
        visit(c, true, inHead);
        continue;
      }
      visit(c, inCard, inHead || c.tag === 'head' || c.tag === 'script' || c.tag === 'style' || c.tag === 'title');
    }
  };
  visit(root, false, false);
  return { title, cards, strayText, nestedCards, truncatedCards, mismatched };
}

const PROMPTED = /^Prompted[ \t ]+/;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

export interface CardResult { record: DraftRecord; prompted: boolean; recognized: boolean; external: number }

/** Convert one card. `entryDir` resolves relative href/src against the HTML's folder; `entryNames` = all export entries. */
export function convertCard(card: ParsedActivity['cards'][number], messageId: string, entry: string, entryNames: Set<string>, ctx: ConvertCtx): CardResult {
  const grid = els(card.el.children).find((c) => c.tag === 'div' && classes(c).has('mdl-grid'));
  const cells = grid ? els(grid.children).filter((c) => c.tag === 'div') : [];
  const header = cells.find((c) => classes(c).has('header-cell'));
  const content = cells.filter((c) => classes(c).has('content-cell'));
  const body = content.find((c) => classes(c).has('mdl-cell--6-col') && classes(c).has('mdl-typography--body-1') && !classes(c).has('mdl-typography--text-right'));
  const right = content.find((c) => classes(c).has('mdl-typography--text-right'));
  const caption = content.find((c) => classes(c).has('mdl-cell--12-col') && classes(c).has('mdl-typography--caption'));
  const recognized = !!(grid && header && body && card.el.closed);
  const flags = ['activity_entry'];
  if (!recognized) flags.push('unrecognized_structure');
  if (!card.el.closed) flags.push('truncated');

  const parts: ContentPart[] = [];
  const bodySegs = body ? segments(body) : [];
  let prompted = false;
  bodySegs.forEach((s, i) => {
    if (i === 0 && PROMPTED.test(s)) { prompted = true; parts.push({ type: 'text', text: s.replace(PROMPTED, ''), originalType: 'prompted' }); }
    else parts.push({ type: 'text', text: s, originalType: 'segment' });
  });
  if (!body) { const t = tidy(textOfNodes(card.el.children)); if (t) parts.push({ type: 'text', text: t, originalType: 'unrecognized_card_text' }); }
  const meta = (cell: El | undefined, label: string) => { if (cell) for (const s of segments(cell)) parts.push({ type: 'metadata', text: s, originalType: label }); };
  meta(header, 'header'); meta(right, 'aside'); meta(caption, 'caption');

  const attachments: Attachment[] = [];
  let external = 0;
  const dir = posix.dirname(entry);
  const seenRefs = new Set<string>();
  walk(card.el, (e) => {
    const ref = e.tag === 'a' ? e.attrs.href : e.tag === 'img' || e.tag === 'source' ? e.attrs.src : undefined;
    if (!ref || ref.startsWith('#')) return;
    if (EXTERNAL.test(ref) || ref.startsWith('//')) { external++; parts.push({ type: 'link', ref, originalType: e.tag }); return; }
    if (seenRefs.has(ref)) return; seenRefs.add(ref);
    let rel = ref.split(/[?#]/)[0];
    try { rel = decodeURIComponent(rel); } catch { /* keep as written */ }
    const target = posix.normalize(posix.join(dir, rel));
    const inExport = !target.startsWith('..') && entryNames.has(target);
    attachments.push({ id: null, name: posix.basename(rel) || null, mime: null, size: null, ref, exportEntry: inExport ? target : null, availability: inExport ? 'referenced_in_export' : 'missing_from_export' });
  });

  const raw = { format: 'google-takeout/my-activity-card', html: card.html };
  const record = base('gemini', 'message', ctx, raw, {
    conversationId: GEMINI_ACTIVITY_CONVERSATION, messageId, role: null, flags, parts, attachments,
    text: parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n'),
  });
  return { record, prompted, recognized, external };
}

export interface GeminiEntryResult {
  records: DraftRecord[]; stats: GeminiActivityStats; warnings: string[]; errors: string[];
  attachments: ReturnType<typeof emptyAttachmentStats>;
}

/** Stable ids: sha256 of the card's exact HTML; identical cards get an occurrence suffix (#2, #3, ...) in file order. */
export function cardId(html: string, seen: Map<string, number>): string {
  const h = createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 32);
  const n = (seen.get(h) ?? 0) + 1; seen.set(h, n);
  return n === 1 ? `card:${h}` : `card:${h}#${n}`;
}

/** Read an entry as strict UTF-8, refusing anything larger than `maxBytes`. */
export async function readBounded(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    n += b.length;
    if (n > maxBytes) { stream.destroy(); throw new HtmlLimitError(`HTML entry exceeds ${maxBytes} bytes`); }
    chunks.push(b);
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks));
}

export function convertGeminiActivity(html: string, entry: string, entryNames: Set<string>, provenance: Provenance, importedAt: string, limits: HtmlLimits = DEFAULT_HTML_LIMITS): GeminiEntryResult {
  const parsed = findCards(html, limits);
  const stats = emptyGeminiStats(); stats.entries = 1;
  const warnings: string[] = [], errors: string[] = [];
  const att = emptyAttachmentStats();
  const records: DraftRecord[] = [];
  const seen = new Map<string, number>();
  parsed.cards.forEach((card, i) => {
    const id = cardId(card.html, seen);
    if (id.includes('#')) stats.duplicateCards++;
    const ctx: ConvertCtx = { importedAt, files: new Map(), provenance: { ...provenance, elementIndex: i } };
    const r = convertCard(card, id, entry, entryNames, ctx);
    stats.cards++;
    if (r.prompted) stats.promptedCards++; else stats.otherCards++;
    if (!r.recognized) { stats.unrecognizedCards++; warnings.push(`card ${i} at byte ${card.byteOffset}: unrecognized card structure; kept verbatim`); }
    stats.externalLinks += r.external;
    for (const a of r.record.attachments) { att[a.availability]++; if (a.availability === 'referenced_in_export') stats.refsInExport++; else stats.refsMissing++; }
    records.push(r.record);
  });
  if (parsed.truncatedCards) errors.push(`${parsed.truncatedCards} card(s) not closed before end of file (truncated source); kept and flagged`);
  if (parsed.nestedCards) warnings.push(`${parsed.nestedCards} nested outer-cell element(s) kept only inside the enclosing card's HTML`);
  if (parsed.strayText) warnings.push(`${parsed.strayText} text run(s) outside any activity card were not imported as entries`);
  if (parsed.mismatched) warnings.push(`${parsed.mismatched} unclosed or stray HTML tag(s) tolerated`);
  if (!parsed.cards.length) warnings.push('no activity cards (div.outer-cell) found');

  const convRaw = { format: 'google-takeout/my-activity', product: 'Gemini Apps', entry, documentTitle: parsed.title, cards: records.map((r) => ({ $omneme_ref: r.messageId })) };
  records.unshift(base('gemini', 'conversation', { importedAt, files: new Map(), provenance: { ...provenance, elementIndex: -1 } }, convRaw, {
    conversationId: GEMINI_ACTIVITY_CONVERSATION, title: 'Gemini Apps activity (Google Takeout)', flags: ['activity_log', 'not_complete_chats'],
    text: 'Google Takeout My Activity log for Gemini Apps. Entries are activity cards, not complete chats; roles, conversation grouping, branches and times are not inferred.',
  }));
  return { records, stats, warnings, errors, attachments: att };
}
