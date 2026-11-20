// Cross-platform project handoffs (Stage 4.2): an AI saves a concise project state; any AI can resume from it.
// Stored as ordinary encrypted records (kind "handoff"), one new record per save; earlier handoffs are never changed.
import { randomUUID, createHash } from 'node:crypto';
import { contentHash, type DraftRecord, type MemoryRecord, type Provider } from './schema.ts';
import type { Vault } from './vault.ts';

export interface Handoff {
  project: string; status: string; decisions: string[]; completed: string[]; outstanding: string[]; next: string;
  source: string; savedAt: string;
}

const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
export function normalise(input: any, source: string): Handoff {
  if (!input?.project || !String(input.project).trim()) throw new Error('handoff needs a project name');
  return { project: String(input.project).trim(), status: String(input.status ?? ''), decisions: list(input.decisions), completed: list(input.completed),
    outstanding: list(input.outstanding), next: String(input.next ?? ''), source: String(input.source ?? source), savedAt: new Date().toISOString() };
}

export function formatHandoff(h: Handoff): string {
  const sec = (t: string, xs: string[]) => (xs.length ? `\n## ${t}\n${xs.map((x) => `- ${x}`).join('\n')}\n` : '');
  return `# Project handoff: ${h.project}\nSaved ${h.savedAt} by ${h.source} (from my Omneme memory). Please continue from here.\n`
    + `\n## Current status\n${h.status}\n` + sec('Important decisions', h.decisions) + sec('Completed work', h.completed)
    + sec('Outstanding tasks', h.outstanding) + `\n## Next recommended action\n${h.next}\n`;
}
export const textHash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function saveHandoff(v: Vault, h: Handoff): { result: string; sha256: string } {
  const text = formatHandoff(h);
  const provider = (['chatgpt', 'claude', 'gemini', 'grok'].includes(h.source.toLowerCase()) ? h.source.toLowerCase() : null) as Provider | null;
  const d: DraftRecord = {
    schema: 'omneme.record/1', class: 'derived', kind: 'handoff', scope: 'shared-project', provider,
    conversationId: `handoff:${h.project.toLowerCase()}`, messageId: randomUUID(), parentMessageId: null, parentInferred: false,
    role: 'assistant', authorName: h.source, title: h.project, createdAt: h.savedAt, updatedAt: h.savedAt, importedAt: h.savedAt, model: null,
    text, parts: [{ type: 'text', text }], attachments: [], flags: [], relations: [],
    provenance: { importId: randomUUID(), importer: 'omneme.handoff', importerVersion: '1', exportLabel: '', exportSha256: null, exportEntry: '', elementIndex: -1 },
    contentHash: contentHash(h), raw: structuredClone(h),
  };
  const result = v.put(d);
  if (result !== 'inserted') throw new Error(`handoff not stored (${result})`);
  return { result, sha256: textHash(text) };
}

/** Latest handoff for a project (case-insensitive), or null. */
export function latestHandoff(records: MemoryRecord[], project: string): Handoff | null {
  const p = project.trim().toLowerCase();
  const hs = records.filter((r) => r.kind === 'handoff' && String((r.raw as Handoff)?.project ?? '').toLowerCase() === p)
    .map((r) => r.raw as Handoff).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return hs[0] ?? null;
}
