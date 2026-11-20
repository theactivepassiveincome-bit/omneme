// Import orchestration: open export -> stream conversations -> convert -> encrypted vault.
// Never logs message content; reports carry counts, locations (entry, element index, byte offset,
// conversation id) and reasons only.
//
// Completeness guarantees (Stage 1.1):
//  - an `import` event with status "started" is committed BEFORE any data, and superseded by a final
//    event ("complete" | "incomplete") at the end; a crash leaves "started", which the index reports
//    as interrupted, so a partial import can never look complete;
//  - every conversation is committed atomically (all of its records or none);
//  - per conversation, source units (mapping nodes / chat_messages) are reconciled against
//    messages + structural nodes + skipped units, and any mismatch is an error.
import { randomUUID } from 'node:crypto';
import type { Vault } from '../vault.ts';
import { streamJsonArray, DEFAULT_JSON_LIMITS, type JsonLimits } from '../jsonstream.ts';
import { DEFAULT_ZIP_LIMITS, type ZipLimits } from '../zip.ts';
import { contentHash, type Availability, type DraftRecord, type Provider } from '../schema.ts';
import { conversationEntries, geminiActivityEntries, openSource } from './source.ts';
import { DEFAULT_HTML_LIMITS, GEMINI_TAKEOUT_IMPORTER, HtmlLimitError, convertGeminiActivity, emptyGeminiStats, readBounded, type GeminiActivityStats, type HtmlLimits } from './gemini.ts';
import { emptyAttachmentStats, indexExportFiles, type ConvertCtx, type Converted } from './common.ts';
import { CHATGPT_IMPORTER, convertChatGPT, isChatGPTConversation } from './chatgpt.ts';
import { CLAUDE_IMPORTER, convertClaude, isClaudeConversation } from './claude.ts';
import { importClaudeArchive, type ArchiveStats } from './claudeArchive.ts';
import { importCodingCat, looksLikeCodingCat, type CaptureStats } from './codingcat.ts';
import { createReadStream } from 'node:fs';

export const IMPORT_VERSION = '0.1.3';

export interface ImportIssue { entry: string; index: number | null; offset?: number | null; conversationId?: string | null; reason: string }
export type ImportStatus = 'started' | 'complete' | 'incomplete';
export interface ImportReport {
  importId: string;
  status: ImportStatus;
  startedAt: string;
  finishedAt: string | null;
  exportLabel: string;
  exportSha256: string | null;
  providers: Partial<Record<Provider, number>>;
  /** Top-level array elements found in all conversation files (= imported + failed). */
  elementsSeen: number;
  conversationsFailed: number;
  conversationsSeen: number;
  conversationsNew: number;
  conversationsRevised: number;
  conversationsUnchanged: number;
  sourceUnits: number;
  messagesSeen: number;
  messagesInserted: number;
  messagesRevised: number;
  messagesDuplicate: number;
  structuralNodes: number;
  skippedUnits: number;
  attachments: Record<Availability, number>;
  /** 'conversations' or 'archive' (projects / artifacts / other Claude categories); 'activity' = Google Takeout Gemini Apps activity log. */
  category: 'conversations' | 'archive' | 'capture' | 'activity';
  archive: ArchiveStats | null;
  /** Google Takeout Gemini Apps activity statistics (category 'activity'). */
  activity?: GeminiActivityStats | null;
  /** CodingCat capture statistics (category 'capture'). */
  capture: CaptureStats | null;
  /** Exact original export file stored in the encrypted blob store. */
  originalArchived: { sha256: string; size: number } | null;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  complete: boolean;
}

export interface ImportOptions { provider?: 'auto' | Provider; json?: JsonLimits; zip?: ZipLimits; html?: HtmlLimits; /** Also store the exact export file (always on for archive categories). */ archiveOriginal?: boolean }

function importEvent(r: ImportReport): DraftRecord {
  return {
    schema: 'omneme.record/1', class: 'event', kind: 'import', scope: 'private', provider: null,
    conversationId: null, messageId: null, parentMessageId: null, parentInferred: false, role: null, authorName: null,
    title: null, createdAt: r.startedAt, updatedAt: r.finishedAt, importedAt: r.finishedAt ?? r.startedAt, model: null, text: '', parts: [],
    attachments: [], flags: r.status === 'complete' ? [] : [r.status === 'started' ? 'in_progress' : 'incomplete'], relations: [],
    provenance: { importId: r.importId, importer: 'omneme.import', importerVersion: IMPORT_VERSION, exportLabel: r.exportLabel, exportSha256: r.exportSha256, exportEntry: '', elementIndex: -1 },
    contentHash: contentHash(r), raw: structuredClone(r),
  };
}

export async function importExport(vault: Vault, path: string, opts: ImportOptions = {}): Promise<ImportReport> {
  const provider = opts.provider ?? 'auto';
  const src = await openSource(path, opts.zip ?? DEFAULT_ZIP_LIMITS);
  const importId = randomUUID();
  const startedAt = new Date().toISOString();
  const r: ImportReport = {
    importId, status: 'started', startedAt, finishedAt: null, exportLabel: src.label, exportSha256: src.sha256, providers: {},
    elementsSeen: 0, conversationsFailed: 0, conversationsSeen: 0, conversationsNew: 0, conversationsRevised: 0, conversationsUnchanged: 0,
    sourceUnits: 0, messagesSeen: 0, messagesInserted: 0, messagesRevised: 0, messagesDuplicate: 0, structuralNodes: 0, skippedUnits: 0,
    attachments: emptyAttachmentStats(), category: 'conversations', archive: null, activity: null, capture: null, originalArchived: null, errors: [], warnings: [], complete: false,
  };
  vault.putMany([importEvent(r)]); // durable "started" marker before any data

  const fail = (i: ImportIssue) => { r.errors.push(i); };
  // Gemini Takeout activity is recognised only by its exact path, before any other heuristic.
  const activityEntries = provider === 'auto' || provider === 'gemini' ? geminiActivityEntries(src) : [];
  const isActivity = activityEntries.length > 0;
  const isCapture = !isActivity && await looksLikeCodingCat(src);
  const entries = isCapture || isActivity ? [] : conversationEntries(src);
  const isArchive = !isActivity && (isCapture || (!entries.length && src.kind !== 'json'));
  if (isActivity) { r.category = 'activity'; r.activity = emptyGeminiStats(); }
  else if (isCapture) r.category = 'capture'; else if (isArchive) r.category = 'archive';

  // Exact original export file (byte-for-byte), verified against the SHA-256 taken when the source was opened.
  if ((isArchive || opts.archiveOriginal) && src.kind !== 'dir') {
    const blob = await vault.putBlob(createReadStream(src.path) as AsyncIterable<Buffer>);
    if (blob.sha256 !== src.sha256) fail({ entry: src.label, index: null, reason: 'Export file changed while being imported; original not archived' });
    else {
      const raw = { sha256: blob.sha256, size: blob.size, container: src.kind };
      vault.putMany([{
        schema: 'omneme.record/1', class: 'original', kind: 'export_file', scope: 'private', provider: null,
        conversationId: 'export', messageId: blob.sha256, parentMessageId: null, parentInferred: false, role: null, authorName: null,
        title: src.label, createdAt: null, updatedAt: null, importedAt: startedAt, model: null, text: '', parts: [],
        attachments: [], flags: [], relations: [], blob, contentHash: contentHash(raw), raw,
        provenance: { importId, importer: 'omneme.original', importerVersion: IMPORT_VERSION, exportLabel: src.label, exportSha256: src.sha256, exportEntry: '', elementIndex: -1 },
      }]);
      r.originalArchived = { sha256: blob.sha256, size: blob.size };
    }
  }
  if (isCapture) {
    const { stats, results, drafts } = await importCodingCat(vault, src, { importId, exportLabel: src.label, exportSha256: src.sha256 }, startedAt,
      (i) => fail(i), (i) => r.warnings.push(i));
    r.capture = stats;
    for (const [p, n] of Object.entries(stats.platforms)) r.providers[p as Provider] = n;
    if (stats.entriesArchived !== stats.entries) fail({ entry: src.label, index: null, reason: `Reconciliation failed: ${stats.entries} entries in source, ${stats.entriesArchived} archived` });
    r.conversationsSeen = stats.conversations; r.messagesSeen = stats.messages;
    results.forEach((res, i) => {
      const k = drafts[i].kind;
      if (k === 'conversation') { if (res === 'inserted') r.conversationsNew++; else if (res === 'revision') r.conversationsRevised++; else r.conversationsUnchanged++; }
      else if (k === 'message') { if (res === 'inserted') r.messagesInserted++; else if (res === 'revision') r.messagesRevised++; else r.messagesDuplicate++; }
      for (const at of drafts[i].kind === 'message' ? drafts[i].attachments : []) r.attachments[at.availability]++;
    });
    r.elementsSeen = r.conversationsSeen;
  } else if (isArchive) {
    const { stats, results } = await importClaudeArchive(vault, src, { importId, exportLabel: src.label, exportSha256: src.sha256 }, startedAt,
      (i) => fail(i), (i) => r.warnings.push(i));
    r.archive = stats;
    r.providers.claude = stats.projects + stats.artifacts;
    if (stats.entriesArchived !== stats.entries) fail({ entry: src.label, index: null, reason: `Reconciliation failed: ${stats.entries} entries in source, ${stats.entriesArchived} archived` });
    r.messagesInserted = results.filter((x) => x === 'inserted').length; // records, for archive imports
    r.messagesRevised = results.filter((x) => x === 'revision').length;
    r.messagesDuplicate = results.filter((x) => x === 'duplicate').length;
  }
  if (isActivity) {
    // Each activity file is committed atomically: container record + every card, or nothing.
    const allNames = new Set(src.entries.map((e) => e.name));
    const limits = opts.html ?? DEFAULT_HTML_LIMITS;
    for (const entry of activityEntries) {
      r.elementsSeen++;
      try {
        const html = await readBounded(await entry.open(), limits.maxBytes);
        const prov = { importId, importer: GEMINI_TAKEOUT_IMPORTER.id, importerVersion: GEMINI_TAKEOUT_IMPORTER.version, exportLabel: src.label, exportSha256: src.sha256, exportEntry: entry.name, elementIndex: -1 };
        const g = convertGeminiActivity(html, entry.name, allNames, prov, startedAt, limits);
        const convId = g.records[0].conversationId;
        for (const e of g.errors) fail({ entry: entry.name, index: null, conversationId: convId, reason: e });
        for (const w of g.warnings) r.warnings.push({ entry: entry.name, index: null, conversationId: convId, reason: w });
        const cards = g.records.length - 1;
        if (cards !== g.stats.cards) fail({ entry: entry.name, index: null, conversationId: convId, reason: `Reconciliation failed: ${g.stats.cards} cards in source, ${cards} records` });
        const results = vault.putMany(g.records);
        r.conversationsSeen++;
        r.providers.gemini = (r.providers.gemini ?? 0) + 1; // one activity log (cards are in r.activity)
        r.sourceUnits += g.stats.cards; r.messagesSeen += cards;
        for (const k of Object.keys(g.attachments) as Availability[]) r.attachments[k] += g.attachments[k];
        const a = r.activity!;
        for (const k of Object.keys(g.stats) as (keyof GeminiActivityStats)[]) a[k] += g.stats[k];
        results.forEach((res, i) => {
          if (g.records[i].kind === 'conversation') { if (res === 'inserted') r.conversationsNew++; else if (res === 'revision') r.conversationsRevised++; else r.conversationsUnchanged++; }
          else if (res === 'inserted') r.messagesInserted++; else if (res === 'revision') r.messagesRevised++; else r.messagesDuplicate++;
        });
      } catch (e) {
        r.conversationsFailed++;
        // Limit and UTF-8 decoder messages carry no content; anything else is reported by error name only.
        const why = e instanceof HtmlLimitError ? e.message : e instanceof TypeError && /encoded data/i.test(e.message) ? 'entry is not valid UTF-8' : (e as Error).name;
        fail({ entry: entry.name, index: null, reason: 'Gemini activity import failed: ' + why });
      }
    }
  }
  const names = entries.map((e) => e.name);
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) r.warnings.push({ entry: n, index: null, reason: 'Duplicate entry name in archive; all copies imported' });
  const files = indexExportFiles(src.entries.map((e) => e.name));

  for (const entry of entries) {
    try {
      const stream = await entry.open();
      for await (const item of streamJsonArray(stream, opts.json ?? DEFAULT_JSON_LIMITS)) {
        if ('structuralError' in item) { fail({ entry: entry.name, index: null, offset: item.offset, reason: item.structuralError }); continue; }
        r.elementsSeen++;
        const loc = { entry: entry.name, index: item.index, offset: item.offset };
        if ('error' in item) { fail({ ...loc, reason: item.error }); r.conversationsFailed++; continue; }
        const v = item.value as Record<string, any>;
        const kind: Provider | null = provider !== 'auto' ? provider : isChatGPTConversation(v) ? 'chatgpt' : isClaudeConversation(v) ? 'claude' : null;
        const okShape = kind === 'chatgpt' ? isChatGPTConversation(v) : kind === 'claude' ? isClaudeConversation(v) : false;
        if (!kind || !okShape) {
          fail({ ...loc, reason: kind ? `Conversation does not match the ${kind} export shape` : 'Unrecognised conversation format' });
          r.conversationsFailed++; continue;
        }
        const imp = kind === 'chatgpt' ? CHATGPT_IMPORTER : CLAUDE_IMPORTER;
        const ctx: ConvertCtx = {
          importedAt: startedAt, files,
          provenance: { importId, importer: imp.id, importerVersion: imp.version, exportLabel: src.label, exportSha256: src.sha256, exportEntry: entry.name, elementIndex: item.index },
        };
        let conv: Converted;
        try { conv = kind === 'chatgpt' ? convertChatGPT(v, ctx) : convertClaude(v, ctx); }
        catch (e) { fail({ ...loc, reason: 'Conversion failed: ' + (e as Error).name }); r.conversationsFailed++; continue; }
        const convId = conv.records[0]?.conversationId ?? null;
        for (const issue of item.issues ?? []) fail({ ...loc, conversationId: convId, reason: issue });
        for (const w of conv.warnings) r.warnings.push({ ...loc, conversationId: convId, reason: w });
        const accounted = conv.messages + conv.structuralNodes + conv.skipped;
        if (accounted !== conv.sourceUnits) fail({ ...loc, conversationId: convId, reason: `Reconciliation failed: ${conv.sourceUnits} source units, ${accounted} accounted for` });
        if (conv.skipped) fail({ ...loc, conversationId: convId, reason: `${conv.skipped} unreadable message node(s) kept only in the conversation's raw record` });
        const results = vault.putMany(conv.records);
        r.conversationsSeen++;
        r.providers[kind] = (r.providers[kind] ?? 0) + 1;
        r.sourceUnits += conv.sourceUnits;
        r.messagesSeen += conv.messages;
        r.structuralNodes += conv.structuralNodes;
        r.skippedUnits += conv.skipped;
        for (const k of Object.keys(conv.attachments) as Availability[]) r.attachments[k] += conv.attachments[k];
        results.forEach((res, i) => {
          if (conv.records[i].kind === 'conversation') { if (res === 'inserted') r.conversationsNew++; else if (res === 'revision') r.conversationsRevised++; else r.conversationsUnchanged++; }
          else if (res === 'inserted') r.messagesInserted++; else if (res === 'revision') r.messagesRevised++; else r.messagesDuplicate++;
        });
      }
    } catch (e) {
      const off = (e as { offset?: number }).offset;
      fail({ entry: entry.name, index: null, offset: typeof off === 'number' ? off : null, reason: (e as Error).message });
    }
  }
  if (!isArchive && !isActivity && !entries.length) fail({ entry: src.label, index: null, reason: 'No conversations.json found in export' });
  if (r.elementsSeen !== r.conversationsSeen + r.conversationsFailed) fail({ entry: src.label, index: null, reason: 'Internal reconciliation failure (element count)' });
  r.complete = r.errors.length === 0;
  r.status = r.complete ? 'complete' : 'incomplete';
  r.finishedAt = new Date().toISOString();
  vault.putMany([importEvent(r)]); // supersedes the "started" marker
  return r;
}
