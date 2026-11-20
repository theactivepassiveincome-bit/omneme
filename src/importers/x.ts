// X (Twitter) account archive importer, step 1 (OMN-059): POSTS ONLY.
// Imports data/tweets.js (older name tweet.js), data/deleted-tweets.js and data/note-tweet.js, including split parts
// (tweets-part1.js, ...), as non-chat `social_event` records (provider "x"). Everything else in the archive is
// counted and listed as NOT imported (DMs, Grok chats, likes, followers, ...); media files are referenced, never copied.
//
// Safety: the data/*.js members are JavaScript assignments `window.YTD.<name>.part<N> = [ ... ]`. They are never
// executed. The prefix is validated as text against the member's own name and part number, then the remainder is
// parsed with the bounded streaming JSON array reader; anything after the closing `]` is rejected.
//
// Format knowledge (file names, wrapper shape, created_at format, media path convention data/tweets_media/<tweet id>-
// <basename>, and that note-tweet.js documents no join to its tweet) follows the MIT-licensed Archivist project
// (github.com/johnnycube/archivist @8ef61acc41401791c6b88e863b70d9df14752819, providers/twitter/twitter.go,
// Copyright (c) 2026 Johannes Küber); see NOTICE. No code was copied; this is an independent TypeScript implementation.
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { streamJsonArray, DEFAULT_JSON_LIMITS, type JsonLimits } from '../jsonstream.ts';
import { contentHash, isObj, type Attachment, type DraftRecord, type Provenance } from '../schema.ts';
import type { ExportSource, SourceEntry } from './source.ts';

export const X_IMPORTER = { id: 'omneme.x', version: '0.1.0' };
/** Base names (without -partN.js) imported in step 1, with the element wrapper key each one uses. */
const SELECTED: Record<string, { inner: string; kind: 'tweet' | 'deleted' | 'note' }> = {
  'tweet': { inner: 'tweet', kind: 'tweet' }, 'tweets': { inner: 'tweet', kind: 'tweet' },
  'deleted-tweets': { inner: 'tweet', kind: 'deleted' }, 'note-tweet': { inner: 'noteTweet', kind: 'note' },
};
const MEMBER = /^data\/([a-z0-9]+(?:-[a-z0-9]+)*?)(?:-part(\d{1,4}))?\.js$/;
const MAX_PREFIX = 512;

export interface SocialStats {
  platform: 'x';
  scope: 'posts only';
  membersImported: string[];
  postsSeen: number; postsNew: number; postsRevised: number; postsDuplicate: number;
  notes: number; deleted: number; malformed: number;
  mediaReferenced: number; mediaMissing: number;
  /** Other user-data members (data/*.js) present in the archive and NOT imported, with their sizes. */
  notImported: { entry: string; bytes: number }[];
  /** Media files under data/ (not copied; only referenced from imported posts). */
  mediaFiles: { files: number; bytes: number };
  /** Archive viewer files outside data/ (HTML, scripts, fonts, emoji images): not user data. */
  viewerAssets: { files: number; bytes: number };
}
export function emptySocialStats(): SocialStats {
  return { platform: 'x', scope: 'posts only', membersImported: [], postsSeen: 0, postsNew: 0, postsRevised: 0, postsDuplicate: 0,
    notes: 0, deleted: 0, malformed: 0, mediaReferenced: 0, mediaMissing: 0, notImported: [], mediaFiles: { files: 0, bytes: 0 }, viewerAssets: { files: 0, bytes: 0 } };
}

const parsed = (e: SourceEntry) => { const m = MEMBER.exec(e.name); return m ? { base: m[1], part: m[2] === undefined ? 0 : Number(m[2]) } : null; };

/** An official X archive: data/account.js plus at least one data/*.js member, at the archive root. */
export function looksLikeXArchive(src: ExportSource): boolean {
  if (src.kind === 'json') return false;
  return src.entries.some((e) => e.name === 'data/account.js') && src.entries.some((e) => { const p = parsed(e); return !!p && p.base in SELECTED; });
}

export class XFormatError extends Error { constructor(m: string) { super(m); this.name = 'XFormatError'; } }

/** Validate and strip `window.YTD.<name>.part<N> = ` as text; yield the rest (which must be a JSON array). Never executes. */
async function* unwrapYtd(stream: AsyncIterable<Buffer>, name: string, part: number): AsyncGenerator<Buffer> {
  let head = Buffer.alloc(0), done = false;
  for await (const chunk of stream) {
    if (done) { yield chunk; continue; }
    head = Buffer.concat([head, chunk]);
    const at = head.indexOf(0x5b); // '['
    if (at < 0) { if (head.length > MAX_PREFIX) throw new XFormatError('Unsupported wrapper: no JSON array within the first 512 bytes'); continue; }
    if (at > MAX_PREFIX) throw new XFormatError('Unsupported wrapper: prefix longer than 512 bytes');
    const prefix = head.subarray(0, at).toString('utf8').replace(/^﻿/, '');
    const m = /^\s*window\.YTD\.([a-z0-9_]+)\.part(\d+)\s*=\s*$/.exec(prefix);
    if (!m) throw new XFormatError('Unsupported wrapper: expected "window.YTD.<name>.part<N> = [...]"');
    if (m[1] !== name || Number(m[2]) !== part) throw new XFormatError(`Wrapper does not match the member (expected window.YTD.${name}.part${part})`);
    done = true;
    yield head.subarray(at);
  }
  if (!done) throw new XFormatError('Unsupported wrapper: no JSON array found');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Sat Aug 12 16:10:37 +0000 2023" -> ISO UTC, validated (calendar date, weekday, offset); null if invalid. */
export function parseXDate(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(s);
  if (!m) return null;
  const [, dow, mon, dd, hh, mi, ss, sign, oh, om, yyyy] = m;
  const mo = MONTHS.indexOf(mon), d = Number(dd), h = Number(hh), min = Number(mi), sec = Number(ss), y = Number(yyyy);
  if (d < 1 || d > 31 || h > 23 || min > 59 || sec > 59 || Number(oh) > 14 || Number(om) > 59) return null;
  const local = new Date(Date.UTC(y, mo, d, h, min, sec));
  if (local.getUTCMonth() !== mo || local.getUTCDate() !== d || DAYS[local.getUTCDay()] !== dow) return null;
  const off = (Number(oh) * 60 + Number(om)) * (sign === '+' ? 1 : -1);
  return new Date(local.getTime() - off * 60_000).toISOString();
}
/** ISO-8601 timestamp with an explicit zone -> ISO UTC; null if invalid. */
function parseIso(s: unknown): string | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,25}$/.test(v);
const unescapeText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4' };

function mediaOf(t: Record<string, any>, tweetId: string, dir: string, names: Set<string>): Attachment[] {
  const list: unknown[] = Array.isArray(t.extended_entities?.media) ? t.extended_entities.media : Array.isArray(t.entities?.media) ? t.entities.media : [];
  const out: Attachment[] = [];
  for (const m of list) {
    if (!isObj(m)) continue;
    let url = typeof m.media_url_https === 'string' ? m.media_url_https : typeof m.media_url === 'string' ? m.media_url : '';
    const variants = Array.isArray(m.video_info?.variants) ? m.video_info.variants.filter((v: any) => isObj(v) && v.content_type === 'video/mp4' && typeof v.url === 'string') : [];
    if (variants.length) url = variants.sort((a: any, b: any) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0].url;
    const name = basename(url.split('?')[0]);
    if (!name) continue;
    const ref = `${dir}/${tweetId}-${name}`;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    out.push({ id: isId(m.id_str) ? m.id_str : null, name, mime: MIME[ext] ?? null, size: null, ref, exportEntry: names.has(ref) ? ref : null,
      availability: names.has(ref) ? 'referenced_in_export' : 'missing_from_export' });
  }
  return out;
}

function record(f: Pick<DraftRecord, 'conversationId' | 'messageId' | 'title' | 'createdAt' | 'updatedAt' | 'text' | 'attachments' | 'flags' | 'relations' | 'raw'> & { prov: Provenance; importedAt: string }): DraftRecord {
  return {
    schema: 'omneme.record/1', class: 'original', kind: 'social_event', scope: 'private', provider: 'x',
    conversationId: f.conversationId, messageId: f.messageId, parentMessageId: null, parentInferred: false, role: 'author', authorName: null,
    title: f.title, createdAt: f.createdAt, updatedAt: f.updatedAt, importedAt: f.importedAt, model: null, text: f.text,
    parts: f.text ? [{ type: 'text', text: f.text }] : [], attachments: f.attachments, flags: f.flags, relations: f.relations,
    provenance: f.prov, contentHash: contentHash(f.raw), raw: f.raw,
  };
}

/** Convert one tweet object; returns a reason string (content-free) when it cannot be imported. */
function convertTweet(t: unknown, deleted: boolean, ns: string, names: Set<string>, prov: Provenance, importedAt: string): DraftRecord | string {
  if (!isObj(t)) return 'Tweet is not an object';
  const id = isId(t.id_str) ? t.id_str : isId(t.id) ? t.id : null;
  if (!id) return 'Tweet has no valid id';
  const createdAt = parseXDate(t.created_at);
  if (!createdAt) return `Tweet ${id} has an invalid created_at`;
  const full = typeof t.full_text === 'string' ? t.full_text : typeof t.text === 'string' ? t.text : null;
  if (full === null) return `Tweet ${id} has no text field`;
  const text = unescapeText(full);
  const replyTo = isId(t.in_reply_to_status_id_str) ? t.in_reply_to_status_id_str : null;
  const repost = /^RT @\w{1,15}: /.test(full);
  const relations: { type: string; target: string }[] = [];
  if (replyTo) relations.push({ type: 'reply_to', target: `x:tweet:${replyTo}` });
  const initial = t.edit_info?.edit?.initialTweetId;
  if (isId(initial) && initial !== id) relations.push({ type: 'edit_of', target: `x:tweet:${initial}` });
  const flags = [...(deleted ? ['deleted'] : []), ...(repost ? ['repost'] : [])];
  const title = deleted ? 'X deleted post' : repost ? 'X repost' : replyTo ? 'X reply' : 'X post';
  const raw = deleted ? { deleted: true, tweet: t } : { tweet: t };
  return record({ conversationId: ns, messageId: `tweet:${id}`, title, createdAt, updatedAt: null, text,
    attachments: mediaOf(t, id, deleted ? 'data/deleted_tweets_media' : 'data/tweets_media', names), flags, relations, raw, prov, importedAt });
}

/** Long-form text (note-tweet.js) is its own record: the archive documents no join to its tweet, so none is guessed. */
function convertNote(n: unknown, ns: string, prov: Provenance, importedAt: string): DraftRecord | string {
  if (!isObj(n)) return 'Note is not an object';
  const id = isId(n.noteTweetId) ? n.noteTweetId : null;
  if (!id) return 'Note has no valid noteTweetId';
  const createdAt = parseIso(n.createdAt);
  if (!createdAt) return `Note ${id} has an invalid createdAt`;
  const text = typeof n.core?.text === 'string' ? n.core.text : null;
  if (text === null) return `Note ${id} has no core.text`;
  const relations = isId(n.tweetId) ? [{ type: 'note_of', target: `x:tweet:${n.tweetId}` }] : [];
  return record({ conversationId: ns, messageId: `note:${id}`, title: 'X long-form note', createdAt, updatedAt: parseIso(n.updatedAt), text: unescapeText(text),
    attachments: [], flags: [], relations, raw: { noteTweet: n }, prov, importedAt });
}

type Issue = { entry: string; index: number | null; offset?: number | null; reason: string };
async function* elements(entry: SourceEntry, name: string, part: number, inner: string, limits: JsonLimits, fail: (i: Issue) => void) {
  const stream = await entry.open() as Readable;
  for await (const item of streamJsonArray(unwrapYtd(stream as AsyncIterable<Buffer>, name, part), limits)) {
    if ('structuralError' in item) { fail({ entry: entry.name, index: null, offset: item.offset, reason: item.structuralError }); continue; }
    const loc = { entry: entry.name, index: item.index, offset: item.offset };
    if ('error' in item) { fail({ ...loc, reason: item.error }); yield { loc, value: undefined, bad: true }; continue; }
    for (const issue of item.issues ?? []) fail({ ...loc, reason: issue });
    const v = item.value;
    if (!isObj(v) || Object.keys(v).length !== 1 || !(inner in v)) { fail({ ...loc, reason: `Element is not a {"${inner}": ...} wrapper` }); yield { loc, value: undefined, bad: true }; continue; }
    yield { loc, value: (v as Record<string, unknown>)[inner], bad: false };
  }
}

/** The archive's account id (namespace for every record), from data/account.js. Throws XFormatError if absent or ambiguous. */
async function accountId(src: ExportSource, limits: JsonLimits): Promise<string> {
  const e = src.entries.find((x) => x.name === 'data/account.js');
  if (!e) throw new XFormatError('data/account.js is missing; the account cannot be identified');
  const ids = new Set<string>(); const errs: Issue[] = [];
  for await (const el of elements(e, 'account', 0, 'account', limits, (i) => errs.push(i))) {
    if (!el.bad && isObj(el.value) && isId(el.value.accountId)) ids.add(el.value.accountId);
  }
  if (errs.length) throw new XFormatError(`data/account.js could not be read: ${errs[0].reason}`);
  if (ids.size !== 1) throw new XFormatError(ids.size ? 'data/account.js names more than one account' : 'data/account.js has no valid accountId');
  return [...ids][0];
}

export async function importXArchive(
  vault: { putMany(d: DraftRecord[]): ('inserted' | 'duplicate' | 'revision')[] }, src: ExportSource,
  meta: { importId: string; exportLabel: string; exportSha256: string | null }, importedAt: string,
  fail: (i: Issue) => void, warn: (i: Issue) => void, limits: JsonLimits = DEFAULT_JSON_LIMITS,
): Promise<{ stats: SocialStats; attachments: { referenced: number; missing: number } }> {
  const s = emptySocialStats();
  const names = new Set(src.entries.map((e) => e.name));
  // Coverage of everything that is not imported.
  for (const e of src.entries) {
    const p = parsed(e);
    if (p && (p.base in SELECTED || p.base === 'account')) continue;
    if (p) s.notImported.push({ entry: e.name, bytes: e.size });
    else if (e.name.startsWith('data/')) { s.mediaFiles.files++; s.mediaFiles.bytes += e.size; }
    else { s.viewerAssets.files++; s.viewerAssets.bytes += e.size; }
  }
  s.notImported.sort((a, b) => a.entry.localeCompare(b.entry));
  if (s.notImported.length) warn({ entry: meta.exportLabel, index: null, reason: `${s.notImported.length} other X data file(s) not imported (posts only in this version): ${s.notImported.map((n) => basename(n.entry)).join(', ')}` });

  let acct: string;
  try { acct = await accountId(src, limits); } catch (e) { fail({ entry: 'data/account.js', index: null, reason: (e as Error).message }); return { stats: s, attachments: { referenced: 0, missing: 0 } }; }
  const ns = `x-account:${acct}`;
  const order = ['tweet', 'tweets', 'deleted-tweets', 'note-tweet'];
  const members = src.entries.map((e) => ({ e, p: parsed(e) })).filter((x) => x.p && x.p.base in SELECTED)
    .sort((a, b) => order.indexOf(a.p!.base) - order.indexOf(b.p!.base) || a.p!.part - b.p!.part);
  let referenced = 0, missing = 0;
  for (const { e, p } of members) {
    const sel = SELECTED[p!.base];
    s.membersImported.push(e.name);
    const batch: DraftRecord[] = [];
    const flush = () => {
      if (!batch.length) return;
      vault.putMany(batch).forEach((res) => { if (res === 'inserted') s.postsNew++; else if (res === 'revision') s.postsRevised++; else s.postsDuplicate++; });
      batch.length = 0;
    };
    try {
      for await (const el of elements(e, p!.base.replace(/-/g, '_'), p!.part, sel.inner, limits, fail)) {
        if (el.bad) { s.malformed++; continue; }
        const prov: Provenance = { importId: meta.importId, importer: X_IMPORTER.id, importerVersion: X_IMPORTER.version, exportLabel: meta.exportLabel, exportSha256: meta.exportSha256, exportEntry: e.name, elementIndex: el.loc.index };
        const r = sel.kind === 'note' ? convertNote(el.value, ns, prov, importedAt) : convertTweet(el.value, sel.kind === 'deleted', ns, names, prov, importedAt);
        if (typeof r === 'string') { s.malformed++; fail({ ...el.loc, reason: r }); continue; }
        s.postsSeen++;
        if (sel.kind === 'note') s.notes++;
        if (sel.kind === 'deleted') s.deleted++;
        for (const a of r.attachments) { if (a.availability === 'referenced_in_export') { s.mediaReferenced++; referenced++; } else { s.mediaMissing++; missing++; } }
        batch.push(r);
        if (batch.length >= 500) flush();
      }
    } catch (err) {
      const off = (err as { offset?: number }).offset;
      const why = err instanceof XFormatError ? err.message : (err as Error).name === 'JsonStreamError' ? (err as Error).message : 'X member could not be read: ' + (err as Error).name;
      fail({ entry: e.name, index: null, offset: typeof off === 'number' ? off : null, reason: why });
    } finally { flush(); }
  }
  return { stats: s, attachments: { referenced, missing } };
}
