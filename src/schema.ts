// Canonical, provider-independent memory record format. See docs/MEMORY_SCHEMA.md.
import { sha256hex } from './crypto.ts';

export const SCHEMA_VERSION = 'omneme.record/1';

/** AI chat providers, plus 'x' for X (Twitter) archive posts (social records, not chats). */
export type Provider = 'chatgpt' | 'claude' | 'gemini' | 'grok' | 'x';
/** original = imported verbatim; derived = AI/tool generated later; event = corrections, imports, supersessions. */
export type RecordClass = 'original' | 'derived' | 'event';
export type RecordKind = 'conversation' | 'message' | 'import' | 'correction'
  | 'export_file'   // an original export file (e.g. frames-000.zip), exact bytes in the blob store
  | 'export_entry'  // one file inside an export archive, exact bytes in the blob store
  | 'project' | 'project_doc' | 'artifact' | 'artifact_version'
  | 'local_file' | 'local_dir' | 'local_symlink' // personal files and folders (Stage 1.3)
  | 'handoff'       // cross-platform project handoff saved by an AI (Stage 4.2)
  | 'social_event'; // one item from a social-media archive, e.g. an X post (OMN-059); never a chat message
export type Scope = 'private' | 'business' | 'shared-project' | 'agent' | 'restricted';

/**
 * text_extracted       – the provider supplied extracted text; it is stored in the record.
 * referenced_in_export – the file exists in the export archive but bytes are NOT copied into the vault (Stage 1).
 * missing_from_export  – referenced by the conversation but absent from the export.
 * metadata_only        – only name/size/type metadata was supplied.
 */
export type Availability = 'text_extracted' | 'referenced_in_export' | 'missing_from_export' | 'metadata_only' | 'archived_in_vault';

/** Reference to exact bytes in the vault's encrypted blob store. */
export interface BlobRef { sha256: string; size: number; chunks: string[] }

export interface ContentPart {
  type: string; // text | code | thinking | image | audio | file | tool_use | tool_result | attachment_text | unknown
  text?: string;
  ref?: string | null;
  mime?: string | null;
  availability?: Availability;
  originalType?: string;
}

export interface Attachment {
  id: string | null;
  name: string | null;
  mime: string | null;
  size: number | null;
  ref: string | null;
  exportEntry: string | null;
  availability: Availability;
}

export interface Provenance {
  importId: string;
  importer: string; // e.g. omneme.chatgpt
  importerVersion: string;
  exportLabel: string; // file name of the export (no directory)
  exportSha256: string | null;
  exportEntry: string; // file inside the export
  elementIndex: number; // index of the conversation in that file
}

export interface MemoryRecord {
  schema: typeof SCHEMA_VERSION;
  recordId: string; // assigned by the vault (keyed hash, stable across backup/restore)
  class: RecordClass;
  kind: RecordKind;
  scope: Scope;
  provider: Provider | null;
  conversationId: string | null;
  messageId: string | null;
  parentMessageId: string | null;
  parentInferred: boolean; // true when the parent was inferred from order, not supplied
  role: string | null; // user | assistant | system | tool | other provider value
  authorName: string | null;
  title: string | null;
  createdAt: string | null; // ISO-8601 UTC, null if not supplied
  updatedAt: string | null;
  importedAt: string;
  model: string | null;
  text: string; // searchable plain text derived from parts
  parts: ContentPart[];
  attachments: Attachment[];
  flags: string[]; // hidden, current_branch, ...
  relations: { type: string; target: string }[]; // e.g. supersedes, corrects, derived_from
  provenance: Provenance;
  contentHash: string; // sha256 of canonical JSON of `raw`
  raw: unknown; // the original provider object, verbatim
  blob?: BlobRef; // exact original bytes (export_file / export_entry)
}

export type DraftRecord = Omit<MemoryRecord, 'recordId'>;

/** Deterministic JSON with sorted object keys (for hashing). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

export function contentHash(raw: unknown): string { return sha256hex(canonicalJson(raw)); }

/** Non-empty for records from a capture tool rather than an official export. */
export function sourceTag(r: { provenance?: { importer?: string } }): string {
  return r.provenance?.importer === 'omneme.codingcat' ? 'codingcat' : '';
}

/** Lineage = identity of a record independent of content version. */
export function lineageKey(r: Pick<DraftRecord, 'provider' | 'kind' | 'conversationId' | 'messageId' | 'provenance'>): string {
  if (r.kind === 'import') return `import|${r.provenance.importId}`;
  const key = [r.provider ?? '', r.kind, r.conversationId ?? '', r.messageId ?? ''].join('|');
  // Captures (e.g. CodingCat) live in their own namespace, so they never revise official-export records of the same chat.
  return sourceTag(r) ? `${sourceTag(r)}|${key}` : key;
}

/** Normalise a provider timestamp (epoch seconds/ms or ISO string) to ISO, or null. */
export function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  let d: Date;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    d = new Date(v > 1e12 ? v : v * 1000);
  } else if (typeof v === 'string') {
    d = /^\d+(\.\d+)?$/.test(v) ? new Date(Number(v) * 1000) : new Date(v);
  } else return null;
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function isObj(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
