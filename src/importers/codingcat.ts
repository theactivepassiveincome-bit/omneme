// Stage 1.4: import captures written by the CodingCat AI Chat Exporter (MIT, external Chrome extension;
// format read from github.com/nikolaylosev/ai-chat-exporter @6c8f52f, src/render/json.ts). We read its
// output files only; no extension or scraping code exists in Omneme.
//
// Layout: one ZIP (or folder, or a single .json note) with
//   <Title> - <YYYY-MM-DD> (<Platform>)/<same>.json    note, format "ai-chat-exporter/conversation@1"
//   <same folder>/files/<name>                          saved attachments; note's attachment.path is relative to the note
//   Projects/<Name> (Claude)/<Name> (Claude).md, knowledge/, chats/…   (project notes are always Markdown)
//   _reports/export-report-*.md                         files the extension could not save
// Every file is archived byte-exact first (shared archiver). JSON notes are then parsed into conversation and
// message records in a separate "codingcat" namespace, so they never revise official-export records.
// Markdown/HTML/DOCX notes are archived but not parsed, and are reported.
import { posix } from 'node:path';
import type { Vault } from '../vault.ts';
import { contentHash, isObj, num, str, toIso, type Attachment, type Availability, type ContentPart, type DraftRecord, type Provenance, type Provider } from '../schema.ts';
import type { ExportSource } from './source.ts';
import { archiveEntries, entryRecord, type EntryIssue } from './archiveEntries.ts';
import { textOf } from './common.ts';

export const CODINGCAT_IMPORTER = { id: 'omneme.codingcat', version: '0.1.0' };
export const CC_FORMAT = 'ai-chat-exporter/conversation@1';
const CC_PREFIX = 'ai-chat-exporter/conversation@';
const PLATFORMS = new Set<Provider>(['claude', 'chatgpt', 'gemini', 'grok']);
const NOTE_NAME = /\((Claude|ChatGPT|Gemini|Grok)\)\.(md|html|docx|json)$/i;
const REPORT_NAME = /(^|\/)_reports\/export-report-[^/]+\.md$/;
const PROJECT_NOTE = /(^|\/)Projects\/[^/]+\/[^/]+\.md$/;

export interface CaptureStats {
  entries: number; entriesArchived: number; bytesArchived: number;
  notesJson: number; notesNotJson: number; projectNotes: number; reports: string[];
  platforms: Record<string, number>; conversations: number; messages: number; branches: number; branchMessages: number;
  attachmentsSaved: number; attachmentsNotProvided: number; attachmentsListedButMissing: number;
  attachmentNotes: Record<string, number>; unreadableBlocks: number; partialSelections: number;
}

/** Cheap detection: CodingCat note/report names, or a JSON file that declares the format. */
export async function looksLikeCodingCat(src: ExportSource): Promise<boolean> {
  if (src.entries.some((e) => NOTE_NAME.test(e.name) || REPORT_NAME.test(e.name))) return true;
  for (const e of src.entries.filter((x) => /\.json$/i.test(x.name)).slice(0, 50)) {
    try {
      const s = await e.open();
      let head = Buffer.alloc(0);
      for await (const c of s) { head = Buffer.concat([head, c as Buffer]); if (head.length >= 4096) break; }
      s.destroy();
      if (head.toString('utf8').includes(CC_PREFIX)) return true;
    } catch { /* unreadable: the archiver will report it */ }
  }
  return false;
}

/** Resolve a note-relative path to an archive entry name; null if it escapes the archive or is absolute. */
function resolveRel(noteDir: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  const joined = posix.normalize(posix.join(noteDir === '.' ? '' : noteDir, rel.replace(/\\/g, '/')));
  if (joined.startsWith('..') || joined.startsWith('/')) return null;
  return joined;
}

function blockParts(blocks: unknown[], st: CaptureStats): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const b of blocks) {
    if (!isObj(b)) { st.unreadableBlocks++; parts.push({ type: 'unknown', originalType: 'non-object' }); continue; }
    const t = str(b.type);
    if (t === 'text') parts.push({ type: 'text', text: str(b.markdown) ?? '' });
    else if (t === 'thinking') parts.push({ type: 'thinking', text: str(b.markdown) ?? '' });
    else if (t === 'tool-call') parts.push({ type: 'tool_use', text: [str(b.label), str(b.input), str(b.output)].filter(Boolean).join('\n'), originalType: str(b.name) ?? 'tool-call' });
    else if (t === 'web-search') {
      const results = Array.isArray(b.results) ? b.results.filter(isObj).map((r: any) => `${str(r.title) ?? ''} ${str(r.url) ?? ''}`.trim()) : [];
      parts.push({ type: 'search', text: [str(b.query), ...results].filter(Boolean).join('\n'), originalType: 'web-search' });
    } else {
      // 'unreadable' (the extension could not read it) or a block type newer than this importer: kept in raw, reported.
      st.unreadableBlocks++;
      parts.push({ type: 'unknown', originalType: t === 'unreadable' ? `unreadable:${str(b.kind) ?? '?'}` : (t ?? 'missing-type') });
    }
  }
  return parts;
}

export async function importCodingCat(
  vault: Vault, src: ExportSource, base: Omit<Provenance, 'exportEntry' | 'elementIndex' | 'importer' | 'importerVersion'>, importedAt: string,
  fail: (i: EntryIssue) => void, warn: (i: EntryIssue) => void,
): Promise<{ stats: CaptureStats; results: ReturnType<Vault['putMany']>; drafts: DraftRecord[] }> {
  const prov = (entry: string): Provenance => ({ ...base, importer: CODINGCAT_IMPORTER.id, importerVersion: CODINGCAT_IMPORTER.version, exportEntry: entry, elementIndex: -1 });
  const pass1 = await archiveEntries(vault, src, fail, warn);
  const st: CaptureStats = {
    entries: pass1.entries, entriesArchived: pass1.entriesArchived, bytesArchived: pass1.bytesArchived,
    notesJson: 0, notesNotJson: 0, projectNotes: 0, reports: [], platforms: {}, conversations: 0, messages: 0, branches: 0, branchMessages: 0,
    attachmentsSaved: 0, attachmentsNotProvided: 0, attachmentsListedButMissing: 0, attachmentNotes: {}, unreadableBlocks: 0, partialSelections: 0,
  };
  const names = new Set(pass1.archived.map((a) => a.name));
  const entryLinks = new Map<string, { type: string; target: string }[]>();
  const link = (entry: string, rel: { type: string; target: string }) => entryLinks.set(entry, [...(entryLinks.get(entry) ?? []), rel]);
  const drafts: DraftRecord[] = [];
  const seenConversations = new Map<string, string>();
  const jsonNoteBases = new Set<string>();

  for (const a of pass1.archived) {
    if (!a.json) continue;
    let doc: any;
    try { doc = JSON.parse(a.json.toString('utf8')); }
    catch { if (NOTE_NAME.test(a.name)) fail({ entry: a.name, index: a.index, reason: 'Malformed JSON note (bytes archived, not parsed)' }); continue; }
    if (!isObj(doc) || typeof doc.format !== 'string' || !doc.format.startsWith(CC_PREFIX)) continue;
    jsonNoteBases.add(a.name.replace(/\.json$/i, ''));
    if (doc.format !== CC_FORMAT) { fail({ entry: a.name, index: a.index, reason: `Unsupported CodingCat format "${doc.format}" (bytes archived, not parsed)` }); continue; }
    const c = doc.conversation;
    const platform = str(c?.platform) as Provider | null;
    if (!isObj(c) || !str(c.id) || !platform || !PLATFORMS.has(platform) || !Array.isArray(c.messages)) {
      fail({ entry: a.name, index: a.index, reason: 'Not a valid CodingCat conversation (missing id, platform or messages; bytes archived)' }); continue;
    }
    st.notesJson++; st.conversations++; st.platforms[platform] = (st.platforms[platform] ?? 0) + 1;
    const convId: string = c.id;
    const loc = { entry: a.name, index: a.index, conversationId: convId };
    const key = `${platform}:${convId}`;
    if (seenConversations.has(key)) warn({ ...loc, reason: `Same conversation also exported at ${seenConversations.get(key)}; both kept as versions` });
    seenConversations.set(key, a.name);
    const noteDir = posix.dirname(a.name);
    const branches: unknown[] = Array.isArray(c.branches) ? c.branches : [];
    const flags: string[] = [];
    if (c.archived === true) flags.push('archived_on_platform');
    if (num(c.chosenFrom) !== null) {
      flags.push('partial_selection'); st.partialSelections++;
      warn({ ...loc, reason: `Only ${c.messages.length} of ${c.chosenFrom} messages were chosen when exporting` });
    }
    const ref = (m: unknown) => (isObj(m) ? { $omneme_ref: str(m.id) } : m);
    const raw = { ...c, messages: c.messages.map(ref), branches: branches.map((b) => (isObj(b) ? { ...b, messages: Array.isArray(b.messages) ? b.messages.map(ref) : b.messages } : b)) };
    drafts.push({
      schema: 'omneme.record/1', class: 'original', kind: 'conversation', scope: 'private', provider: platform,
      conversationId: convId, messageId: null, parentMessageId: null, parentInferred: false, role: null, authorName: null,
      title: str(c.title), createdAt: toIso(c.createdAt), updatedAt: toIso(c.updatedAt), importedAt, model: str(c.model),
      text: [str(c.title), str(c.project)].filter(Boolean).join('\n'), parts: [], attachments: [], flags,
      relations: [{ type: 'captured_note', target: a.name }], provenance: prov(a.name), contentHash: contentHash(raw), raw,
    });
    link(a.name, { type: 'conversation_note', target: key });

    const seenMsg = new Set<string>();
    let declared = 0, emitted = 0, skipped = 0;
    const emit = (m: unknown, parent: string | null, mflags: string[], pos: string) => {
      declared++;
      if (!isObj(m) || !str(m.id)) { skipped++; fail({ ...loc, reason: `Message at ${pos} has no id (kept in the archived note only)` }); return null; }
      if (seenMsg.has(m.id)) warn({ ...loc, reason: `Duplicate message id ${m.id}; both kept as versions` });
      seenMsg.add(m.id);
      const parts = blockParts(Array.isArray(m.blocks) ? m.blocks : [], st);
      const attachments: Attachment[] = [];
      for (const att of Array.isArray(m.attachments) ? m.attachments : []) {
        if (!isObj(att)) continue;
        const path = str(att.path), note = str(att.note), origin = str(att.origin) ?? 'unknown';
        if (note) st.attachmentNotes[note] = (st.attachmentNotes[note] ?? 0) + 1;
        let availability: Availability = 'missing_from_export', entry: string | null = null;
        if (path) {
          const resolved = resolveRel(noteDir, path);
          if (resolved && names.has(resolved)) { availability = 'archived_in_vault'; entry = resolved; st.attachmentsSaved++; link(resolved, { type: 'attachment_of', target: `${key}#${m.id}` }); }
          else { st.attachmentsListedButMissing++; fail({ ...loc, reason: `Attachment "${str(att.name) ?? path}" is listed as saved at ${path} but is not in the export` }); }
        } else st.attachmentsNotProvided++; // the platform or download did not provide it; reason (if any) is in raw.error
        attachments.push({ id: null, name: str(att.name), mime: str(att.mime), size: num(att.size), ref: path, exportEntry: entry, availability });
        parts.push({ type: origin === 'image' || (str(att.mime) ?? '').startsWith('image/') ? 'image' : 'file', ref: str(att.name), availability, originalType: [origin, note].filter(Boolean).join(':') });
      }
      const role = str(m.role);
      drafts.push({
        schema: 'omneme.record/1', class: 'original', kind: 'message', scope: 'private', provider: platform,
        conversationId: convId, messageId: m.id, parentMessageId: parent, parentInferred: false, role, authorName: null,
        title: null, createdAt: toIso(m.createdAt), updatedAt: null, importedAt, model: role === 'assistant' ? str(c.model) : null,
        text: textOf(parts), parts, attachments, flags: mflags, relations: [], provenance: prov(a.name), contentHash: contentHash(m), raw: m,
      });
      emitted++;
      return m.id as string;
    };
    // Visible branch: root first, each message follows the previous one. Other branches fork after forkAfterMessageId.
    let prev: string | null = null;
    c.messages.forEach((m: unknown, i: number) => { prev = emit(m, prev, ['current_branch'], `messages[${i}]`) ?? prev; });
    branches.forEach((b, bi) => {
      if (!isObj(b) || !Array.isArray(b.messages)) { fail({ ...loc, reason: `Branch ${bi} is malformed (kept in the archived note only)` }); return; }
      st.branches++;
      let p: string | null = str(b.forkAfterMessageId);
      if (p && !seenMsg.has(p)) warn({ ...loc, reason: `Branch ${bi} forks after unknown message ${p}` });
      b.messages.forEach((m: unknown, i: number) => { st.branchMessages++; p = emit(m, p, i === 0 ? ['branch', 'branch_start'] : ['branch'], `branches[${bi}].messages[${i}]`) ?? p; });
    });
    st.messages += emitted;
    if (declared !== emitted + skipped) fail({ ...loc, reason: `Reconciliation failed: ${declared} messages in note, ${emitted} imported, ${skipped} unreadable` });
  }

  // Everything that was archived but not parsed is reported, never silently ignored.
  const notJson = pass1.archived.filter((a) => NOTE_NAME.test(a.name) && !/\.json$/i.test(a.name) && !jsonNoteBases.has(a.name.replace(/\.(md|html|docx)$/i, '')));
  for (const a of notJson) { if (PROJECT_NOTE.test(a.name) && !/\/chats\//.test(a.name)) st.projectNotes++; else st.notesNotJson++; }
  if (st.notesNotJson) warn({ entry: src.label, index: null, reason: `${st.notesNotJson} chat note(s) are Markdown/HTML/DOCX: archived byte-exact but not parsed. Re-export with the JSON note format for structured import` });
  if (st.projectNotes) warn({ entry: src.label, index: null, reason: `${st.projectNotes} project note(s) archived byte-exact (CodingCat writes project notes as Markdown only)` });
  for (const a of pass1.archived.filter((x) => REPORT_NAME.test(x.name))) { st.reports.push(a.name); warn({ entry: a.name, index: a.index, reason: 'CodingCat export report archived: it lists files the extension could not save' }); }
  const lossy = Object.entries(st.attachmentNotes).filter(([k]) => k !== 'unavailable');
  if (lossy.length) warn({ entry: src.label, index: null, reason: `Attachments that are not byte-exact originals per the platform: ${lossy.map(([k, n]) => `${n} ${k}`).join(', ')}` });
  if (st.attachmentsNotProvided) warn({ entry: src.label, index: null, reason: `${st.attachmentsNotProvided} attachment(s) were not provided by the platform or download (details kept in each message's raw record)` });
  if (st.unreadableBlocks) warn({ entry: src.label, index: null, reason: `${st.unreadableBlocks} message block(s) were unreadable or of an unknown type (kept in raw)` });
  if (!st.notesJson && !st.notesNotJson) warn({ entry: src.label, index: null, reason: 'No CodingCat chat notes found; files archived byte-exact only' });

  for (const a of pass1.archived) drafts.push(entryRecord(a, prov(a.name), importedAt, null, 'codingcat', entryLinks.get(a.name) ?? []));
  const results = vault.putMany(drafts);
  return { stats: st, results, drafts };
}
