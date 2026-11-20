// In-memory index built from decrypted records after unlock. Nothing here touches disk.
import { sourceTag, type MemoryRecord, type Provider } from './schema.ts';

/** View key of a conversation: `provider:id`, or `codingcat/provider:id` for captures. */
export const convKey = (r: MemoryRecord) => `${sourceTag(r) ? sourceTag(r) + '/' : ''}${r.provider}:${r.conversationId}`;

/** Stable id of one social record (e.g. an X post): `<account namespace>/<native id>`. Social records are never chats. */
export const socialKey = (r: MemoryRecord) => `${r.conversationId}/${r.messageId}`;

export interface SearchQuery { text: string; provider?: Provider; from?: string; to?: string; limit?: number }
export interface SearchHit {
  record: MemoryRecord;
  conversationTitle: string | null;
  snippet: string;
}
export interface ConversationView { conversation: MemoryRecord | null; messages: { record: MemoryRecord; depth: number; siblings: number; position: number }[] }

const norm = (s: string) => s.normalize('NFKC').toLowerCase();

function latestByLineage(records: MemoryRecord[]): { latest: MemoryRecord[]; revisions: Map<string, number> } {
  const by = new Map<string, MemoryRecord[]>();
  for (const r of records) {
    const k = [sourceTag(r), r.provider, r.kind, r.conversationId, r.messageId, r.kind === 'import' ? r.provenance.importId : ''].join('|');
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  const latest: MemoryRecord[] = [];
  const revisions = new Map<string, number>();
  for (const list of by.values()) {
    list.sort((a, b) => a.importedAt.localeCompare(b.importedAt));
    const top = list[list.length - 1];
    latest.push(top);
    if (list.length > 1) revisions.set(top.recordId, list.length);
  }
  return { latest, revisions };
}

function dayBound(s: string, end: boolean): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z') : new Date(s).toISOString();
}

export class MemoryIndex {
  readonly all: MemoryRecord[];
  readonly messages: MemoryRecord[];
  /** Latest social records (OMN-059: X posts). Searchable, but not conversations or messages. */
  readonly social: MemoryRecord[];
  readonly conversations = new Map<string, MemoryRecord>(); // key provider:conversationId
  readonly revisions: Map<string, number>;
  private byConv = new Map<string, MemoryRecord[]>();
  private normText = new Map<string, string>();
  private latestImports = new Map<string, MemoryRecord>();
  private latestOf = (kind: string) => this.latest.filter((r) => r.kind === kind);
  private latest: MemoryRecord[] = [];

  constructor(records: MemoryRecord[]) {
    this.all = records;
    const { latest, revisions } = latestByLineage(records);
    this.revisions = revisions;
    this.latest = latest;
    this.messages = latest.filter((r) => r.kind === 'message');
    this.social = latest.filter((r) => r.kind === 'social_event');
    for (const r of this.social) this.normText.set(r.recordId, norm(r.text));
    for (const r of records) {
      if (r.kind !== 'import') continue;
      const prev = this.latestImports.get(r.provenance.importId);
      if (!prev || (prev.raw as any)?.status === 'started') this.latestImports.set(r.provenance.importId, r);
    }
    for (const r of latest) {
      const key = convKey(r);
      if (r.kind === 'conversation') this.conversations.set(key, r);
      if (r.kind === 'message') {
        (this.byConv.get(key) ?? this.byConv.set(key, []).get(key)!).push(r);
        this.normText.set(r.recordId, norm(r.text));
      }
    }
  }

  stats() {
    type P = { conversations: number; messages: number; undated: number; earliest: string | null; latest: string | null };
    const per: Record<string, P> = {};
    const get = (p: string | null) => (per[p ?? 'unknown'] ??= { conversations: 0, messages: 0, undated: 0, earliest: null, latest: null });
    for (const c of this.conversations.values()) get(c.provider).conversations++;
    for (const m of this.messages) {
      const p = get(m.provider); p.messages++;
      if (!m.createdAt) { p.undated++; continue; }
      if (!p.earliest || m.createdAt < p.earliest) p.earliest = m.createdAt;
      if (!p.latest || m.createdAt > p.latest) p.latest = m.createdAt;
    }
    const imports = this.imports();
    const files = this.latestOf('export_entry');
    return {
      projects: this.latestOf('project').length, projectDocs: this.latestOf('project_doc').length,
      artifacts: this.latestOf('artifact').length, artifactVersions: this.latestOf('artifact_version').length,
      archivedFiles: files.length, archivedBytes: files.reduce((n, f) => n + (f.blob?.size ?? 0), 0),
      originalExports: this.latestOf('export_file').length,
      localFiles: this.latestOf('local_file').length, localBytes: this.latestOf('local_file').reduce((n, f) => n + (f.blob?.size ?? 0), 0),
      localSources: new Set(this.latestOf('local_file').map((f) => f.conversationId)).size,
      conversations: this.conversations.size, messages: this.messages.length, records: this.all.length,
      imports: imports.length, importsNotComplete: imports.filter((i) => i.status !== 'complete').length,
      revisedRecords: this.revisions.size, perProvider: per,
      socialEvents: this.social.length,
    };
  }

  /** Import history (latest event per import). A lone "started" event means the import was interrupted. */
  imports(): { importId: string; status: 'complete' | 'incomplete' | 'interrupted'; startedAt: string; exportLabel: string; exportSha256: string | null; report: any }[] {
    return [...this.latestImports.values()].map((r) => {
      const rep = r.raw as any;
      const status = rep?.status === 'complete' ? 'complete' : rep?.status === 'incomplete' ? 'incomplete' : 'interrupted';
      return { importId: r.provenance.importId, status, startedAt: rep?.startedAt ?? r.createdAt ?? r.importedAt, exportLabel: r.provenance.exportLabel, exportSha256: r.provenance.exportSha256, report: rep };
    }).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  projects(): { project: MemoryRecord; docs: MemoryRecord[] }[] {
    const docs = this.latestOf('project_doc');
    return this.latestOf('project').sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
      .map((p) => ({ project: p, docs: docs.filter((d) => d.conversationId === p.conversationId) }));
  }

  artifacts(): { artifact: MemoryRecord; versions: MemoryRecord[]; files: MemoryRecord[] }[] {
    const versions = this.latestOf('artifact_version'), files = this.latestOf('export_entry');
    return this.latestOf('artifact').map((a) => ({
      artifact: a,
      versions: versions.filter((v) => v.conversationId === a.conversationId).sort((x, y) => (x.createdAt ?? '').localeCompare(y.createdAt ?? '')),
      files: files.filter((f) => f.relations.some((r) => r.type === 'artifact' && r.target === a.conversationId)),
    }));
  }

  /** Local file sources (labels) with counts; latest version of each path. */
  localSources(): { label: string; files: number; bytes: number; dirs: number; symlinks: number }[] {
    const m = new Map<string, { label: string; files: number; bytes: number; dirs: number; symlinks: number }>();
    for (const r of this.latest) {
      if (!r.kind.startsWith('local_')) continue;
      const e = m.get(r.conversationId!) ?? m.set(r.conversationId!, { label: r.conversationId!, files: 0, bytes: 0, dirs: 0, symlinks: 0 }).get(r.conversationId!)!;
      if (r.kind === 'local_file') { e.files++; e.bytes += r.blob?.size ?? 0; } else if (r.kind === 'local_dir') e.dirs++; else e.symlinks++;
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
  /** Latest local records of one source (for restore). */
  localRecords(label: string): MemoryRecord[] { return this.latest.filter((r) => r.kind.startsWith('local_') && r.conversationId === label); }
  /** Every stored version of one path, oldest first. */
  history(label: string, relPath: string): MemoryRecord[] {
    return this.all.filter((r) => r.kind === 'local_file' && r.conversationId === label && r.messageId === relPath).sort((a, b) => a.importedAt.localeCompare(b.importedAt));
  }

  /** Records holding exact bytes (archived export entries and original export files). */
  blobRecords(): MemoryRecord[] { return this.latest.filter((r) => r.blob); }

  /** Pick n random conversations (for spot checks). */
  randomConversations(n: number): MemoryRecord[] {
    const all = [...this.conversations.values()];
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    return all.slice(0, n);
  }

  search(q: SearchQuery): SearchHit[] {
    const terms = norm(q.text).split(/\s+/).filter(Boolean);
    const from = q.from ? dayBound(q.from, false) : null;
    const to = q.to ? dayBound(q.to, true) : null;
    const hits: SearchHit[] = [];
    for (const m of [...this.messages, ...this.social]) {
      if (q.provider && m.provider !== q.provider) continue;
      if (from && (!m.createdAt || m.createdAt < from)) continue;
      if (to && (!m.createdAt || m.createdAt > to)) continue;
      const t = this.normText.get(m.recordId)!;
      if (!terms.every((term) => t.includes(term))) continue;
      const at = terms.length ? t.indexOf(terms[0]) : 0;
      const s = Math.max(0, at - 60);
      const snippet = (s > 0 ? '…' : '') + m.text.slice(s, s + 200).replace(/\s+/g, ' ') + (m.text.length > s + 200 ? '…' : '');
      hits.push({ record: m, conversationTitle: m.kind === 'social_event' ? m.title : this.conversations.get(convKey(m))?.title ?? null, snippet });
    }
    hits.sort((a, b) => (b.record.createdAt ?? '').localeCompare(a.record.createdAt ?? ''));
    return q.limit ? hits.slice(0, q.limit) : hits;
  }

  listConversations(provider?: Provider): MemoryRecord[] {
    return [...this.conversations.values()].filter((c) => !provider || c.provider === provider)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  /** Resolve by conversation id, `provider:conversationId`, or a message recordId. */
  findConversationKey(id: string): string | null {
    if (this.byConv.has(id) || this.conversations.has(id)) return id;
    for (const k of this.conversations.keys()) if (k.endsWith(':' + id)) return k;
    const m = this.messages.find((r) => r.recordId === id || r.messageId === id);
    return m ? convKey(m) : null;
  }

  /** One social record by record id, `<namespace>/<native id>` or a unique native id (e.g. `tweet:123`). */
  socialRecord(id: string): MemoryRecord | null {
    if (!id) return null;
    const exact = this.social.find((r) => r.recordId === id || socialKey(r) === id);
    if (exact) return exact;
    const byNative = this.social.filter((r) => r.messageId === id);
    return byNative.length === 1 ? byNative[0] : null;
  }

  /** Messages in tree order (depth-first, siblings by time), preserving every branch. A social record id returns that
   *  single record with no conversation (social posts are never grouped into an invented chat thread). */
  conversation(id: string): ConversationView | null {
    const key = this.findConversationKey(id);
    if (!key) {
      const s = this.socialRecord(id);
      return s ? { conversation: null, messages: [{ record: s, depth: 0, siblings: 1, position: 1 }] } : null;
    }
    const msgs = this.byConv.get(key) ?? [];
    const ids = new Set(msgs.map((m) => m.messageId));
    const kids = new Map<string | null, MemoryRecord[]>();
    for (const m of msgs) {
      const p = m.parentMessageId && ids.has(m.parentMessageId) ? m.parentMessageId : null;
      (kids.get(p) ?? kids.set(p, []).get(p)!).push(m);
    }
    const order = (a: MemoryRecord, b: MemoryRecord) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || (a.messageId ?? '').localeCompare(b.messageId ?? '');
    for (const l of kids.values()) l.sort(order);
    const out: ConversationView['messages'] = [];
    const seen = new Set<string>();
    const stack: { r: MemoryRecord; depth: number; siblings: number; position: number }[] = [];
    const pushKids = (p: string | null, depth: number) => {
      const l = kids.get(p) ?? [];
      for (let i = l.length - 1; i >= 0; i--) stack.push({ r: l[i], depth, siblings: l.length, position: i + 1 });
    };
    pushKids(null, 0);
    while (stack.length) {
      const { r, depth, siblings, position } = stack.pop()!;
      if (seen.has(r.recordId)) continue;
      seen.add(r.recordId);
      out.push({ record: r, depth, siblings, position });
      pushKids(r.messageId, siblings > 1 ? depth + 1 : depth);
    }
    // Anything unreachable (cycles) is still shown, never dropped.
    for (const m of msgs) if (!seen.has(m.recordId)) out.push({ record: m, depth: 0, siblings: 1, position: 1 });
    return { conversation: this.conversations.get(key) ?? null, messages: out };
  }
}
