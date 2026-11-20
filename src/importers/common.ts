import { basename } from 'node:path';
import {
  contentHash, type Attachment, type Availability, type ContentPart, type DraftRecord, type Provenance, type Provider,
} from '../schema.ts';

export interface ConvertCtx {
  provenance: Provenance;
  importedAt: string;
  /** Lookup of file ids (e.g. file-abc123) to entry names present in the export archive. */
  files: Map<string, string>;
}

export interface Converted {
  records: DraftRecord[];
  messages: number;
  structuralNodes: number;
  /** Units the source declares (ChatGPT mapping nodes / Claude chat_messages) and units skipped as unreadable. */
  sourceUnits: number;
  skipped: number;
  attachments: Record<Availability, number>;
  warnings: string[];
}

export function emptyAttachmentStats(): Record<Availability, number> {
  return { text_extracted: 0, referenced_in_export: 0, missing_from_export: 0, metadata_only: 0 };
}

/** Index export entries by any file-id-like token in their basename (file-XXXX / file_XXXX). */
export function indexExportFiles(names: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of names) {
    const b = basename(n);
    const hit = b.match(/^(file[-_][A-Za-z0-9]+)/);
    if (hit && !m.has(hit[1])) m.set(hit[1], n);
    if (!m.has(b)) m.set(b, n);
  }
  return m;
}

export function textOf(parts: ContentPart[]): string {
  return parts.map((p) => p.text).filter((t): t is string => typeof t === 'string' && t.length > 0).join('\n');
}

export function base(
  provider: Provider, kind: 'conversation' | 'message', ctx: ConvertCtx, raw: unknown, f: Partial<DraftRecord>,
): DraftRecord {
  return {
    schema: 'omneme.record/1', class: 'original', kind, scope: 'private', provider,
    conversationId: null, messageId: null, parentMessageId: null, parentInferred: false,
    role: null, authorName: null, title: null, createdAt: null, updatedAt: null, importedAt: ctx.importedAt,
    model: null, text: '', parts: [], attachments: [], flags: [], relations: [],
    provenance: ctx.provenance, contentHash: contentHash(raw), raw,
    ...f,
  };
}

/**
 * Merge entries that describe the same file (same id or same reference), e.g. a ChatGPT inline image pointer and its
 * metadata.attachments entry. Entries with neither id nor ref are distinct files even if their names match
 * (two different uploads can share a filename), so they are never merged.
 */
export function dedupeAttachments(list: Attachment[]): Attachment[] {
  const seen = new Map<string, Attachment>();
  let anon = 0;
  for (const a of list) {
    const k = a.id ?? a.ref ?? `anon:${anon++}`;
    const prev = seen.get(k);
    if (!prev) seen.set(k, a);
    else seen.set(k, { ...a, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== null)) } as Attachment);
  }
  return [...seen.values()];
}
