// Shared by archive-style importers (Claude projects/frames, CodingCat captures): stream every entry of an
// export into the encrypted blob store as exact bytes, keeping small JSON files in memory for parsing,
// and build the `export_entry` record that points at those bytes.
import { basename } from 'node:path';
import type { Vault } from '../vault.ts';
import { contentHash, type BlobRef, type DraftRecord, type Provenance, type Provider } from '../schema.ts';
import type { ExportSource } from './source.ts';

export const MAX_JSON_PARSE_BYTES = 64 * 2 ** 20;
export interface ArchivedEntry { name: string; index: number; blob: BlobRef; meta: unknown; json?: Buffer }
export interface EntryIssue { entry: string; index: number | null; offset?: number | null; conversationId?: string | null; reason: string }

/** Archive every entry (sorted by name). Unreadable/corrupt entries are reported via `fail`, never silently skipped. */
export async function archiveEntries(vault: Vault, src: ExportSource, fail: (i: EntryIssue) => void, warn: (i: EntryIssue) => void)
  : Promise<{ archived: ArchivedEntry[]; entries: number; entriesArchived: number; bytesArchived: number }> {
  const entries = [...src.entries].sort((a, b) => a.name.localeCompare(b.name));
  const archived: ArchivedEntry[] = [];
  let bytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const wantJson = /\.json$/i.test(e.name) && e.size <= MAX_JSON_PARSE_BYTES;
    const kept: Buffer[] = [];
    try {
      const stream = await e.open();
      const tap = async function* () { for await (const c of stream) { if (wantJson) kept.push(c as Buffer); yield c as Buffer; } };
      const blob = await vault.putBlob(tap());
      archived.push({ name: e.name, index: i, blob, meta: e.meta ?? null, json: wantJson ? Buffer.concat(kept) : undefined });
      bytes += blob.size;
      if (/\.json$/i.test(e.name) && !wantJson) warn({ entry: e.name, index: i, reason: 'JSON file larger than 64 MiB archived but not parsed' });
    } catch (err) {
      fail({ entry: e.name, index: i, reason: `Entry could not be read; not archived: ${(err as Error).message}` });
    }
  }
  return { archived, entries: entries.length, entriesArchived: archived.length, bytesArchived: bytes };
}

/** The `export_entry` record for one archived file (exact bytes in `blob`). */
export function entryRecord(a: ArchivedEntry, prov: Provenance, importedAt: string, provider: Provider | null, conversationId: string,
  relations: { type: string; target: string }[]): DraftRecord {
  const raw = { path: a.name, size: a.blob.size, sha256: a.blob.sha256, zip: a.meta };
  return {
    schema: 'omneme.record/1', class: 'original', kind: 'export_entry', scope: 'private', provider,
    conversationId, messageId: a.name, parentMessageId: null, parentInferred: false, role: null, authorName: null,
    title: basename(a.name), createdAt: null, updatedAt: null, importedAt, model: null, text: '', parts: [],
    attachments: [{ id: null, name: basename(a.name), mime: null, size: a.blob.size, ref: a.name, exportEntry: a.name, availability: 'archived_in_vault' }],
    flags: [], relations, provenance: prov, contentHash: contentHash(raw), raw, blob: a.blob,
  };
}
