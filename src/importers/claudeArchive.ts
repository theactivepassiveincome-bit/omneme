// Archival import of non-conversation Claude export categories (projects-000.zip, frames-000.zip, and any
// other category): every entry's exact bytes go into the encrypted blob store as an `export_entry`
// record, then known structures are parsed into `project`, `project_doc`, `artifact` and
// `artifact_version` records. Exported HTML/JS/CSS is treated as inert bytes: never executed or rendered.
//
// Layout (observed in public descriptions of the Nov 2026 export, verified only via synthetic fixtures):
//   projects/<uuid>.json                       {uuid, name, description, is_private, prompt_template, created_at, updated_at, creator, docs[]}
//   artifacts/<id>/artifact.json               {id, kind, visibility, versions[{id,title,description,created_at}], owner_account, updated_at, active_version}
//   artifacts/<id>/versions/<ver>.html         plain artifact version
//   artifacts/<id>/versions/<ver>/…            typed artifact version folder, plus <ver>.files.json
//   artifacts/<id>/versions.md                 human-readable version list
// Detection is by content shape, not only by path. Links are made only to ids present in the source.
import { basename } from 'node:path';
import type { Vault } from '../vault.ts';
import { contentHash, isObj, str, toIso, type BlobRef, type DraftRecord, type Provenance } from '../schema.ts';
import type { ExportSource } from './source.ts';
import { archiveEntries, entryRecord } from './archiveEntries.ts';

export const CLAUDE_ARCHIVE_IMPORTER = { id: 'omneme.claude-archive', version: '0.1.0' };

export interface ArchiveStats {
  entries: number; entriesArchived: number; bytesArchived: number;
  projects: number; projectDocs: number; promptTemplates: number;
  artifacts: number; versionsListed: number; versionsWithFiles: number; filesLinkedToVersion: number; filesUnlinked: number;
}
export interface Issue { entry: string; index: number | null; offset?: number | null; conversationId?: string | null; reason: string }

export const isProject = (v: unknown): v is Record<string, any> => isObj(v) && typeof v.uuid === 'string' && (Array.isArray(v.docs) || 'prompt_template' in v);
export const isArtifact = (v: unknown): v is Record<string, any> => isObj(v) && typeof v.id === 'string' && Array.isArray(v.versions) && 'kind' in v;

function rec(kind: DraftRecord['kind'], prov: Provenance, importedAt: string, raw: unknown, f: Partial<DraftRecord>): DraftRecord {
  return {
    schema: 'omneme.record/1', class: 'original', kind, scope: 'private', provider: 'claude',
    conversationId: null, messageId: null, parentMessageId: null, parentInferred: false, role: null, authorName: null,
    title: null, createdAt: null, updatedAt: null, importedAt, model: null, text: '', parts: [], attachments: [], flags: [],
    relations: [], provenance: prov, contentHash: contentHash(raw), raw, ...f,
  };
}

export async function importClaudeArchive(
  vault: Vault, src: ExportSource, base: Omit<Provenance, 'exportEntry' | 'elementIndex' | 'importer' | 'importerVersion'>, importedAt: string,
  fail: (i: Issue) => void, warn: (i: Issue) => void,
): Promise<{ stats: ArchiveStats; results: ReturnType<Vault['putMany']> }> {
  const st: ArchiveStats = { entries: src.entries.length, entriesArchived: 0, bytesArchived: 0, projects: 0, projectDocs: 0, promptTemplates: 0, artifacts: 0, versionsListed: 0, versionsWithFiles: 0, filesLinkedToVersion: 0, filesUnlinked: 0 };
  const prov = (entry: string, i: number): Provenance => ({ ...base, importer: CLAUDE_ARCHIVE_IMPORTER.id, importerVersion: CLAUDE_ARCHIVE_IMPORTER.version, exportEntry: entry, elementIndex: i });
  const entries = [...src.entries].sort((a, b) => a.name.localeCompare(b.name));

  // Pass 1: archive exact bytes of every entry (shared with other archive importers).
  const pass1 = await archiveEntries(vault, src, fail, warn);
  const archived = pass1.archived;
  st.entriesArchived = pass1.entriesArchived; st.bytesArchived = pass1.bytesArchived;

  // Pass 2: parse known structures.
  const projects: { p: Record<string, any>; a: (typeof archived)[number] }[] = [];
  const artifacts = new Map<string, { m: Record<string, any>; a: (typeof archived)[number] }>();
  for (const a of archived) {
    if (!a.json) continue;
    let v: unknown;
    try { v = JSON.parse(a.json.toString('utf8')); }
    catch {
      if (/^projects\/|(^|\/)artifact\.json$/i.test(a.name)) fail({ entry: a.name, index: a.index, reason: 'Malformed JSON (bytes archived, structure not imported)' });
      else warn({ entry: a.name, index: a.index, reason: 'JSON not parseable (bytes archived)' });
      continue;
    }
    const list = Array.isArray(v) ? v : [v];
    for (const item of list) {
      if (isProject(item)) projects.push({ p: item, a });
      else if (isArtifact(item)) {
        if (artifacts.has(item.id)) warn({ entry: a.name, index: a.index, conversationId: item.id, reason: 'Duplicate artifact manifest id; both archived, first parsed' });
        else artifacts.set(item.id, { m: item, a });
      }
    }
    if (/^projects\/[^/]+\.json$/i.test(a.name) && !list.some(isProject)) fail({ entry: a.name, index: a.index, reason: 'File in projects/ does not contain a recognisable project' });
    if (/(^|\/)artifact\.json$/i.test(a.name) && !list.some(isArtifact)) fail({ entry: a.name, index: a.index, reason: 'artifact.json does not contain a recognisable artifact manifest' });
  }

  const drafts: DraftRecord[] = [];
  for (const { p, a } of projects) {
    const docs: unknown[] = Array.isArray(p.docs) ? p.docs : [];
    const raw = { ...p, docs: docs.map((d, i) => (isObj(d) ? { $omneme_ref: str(d.uuid) ?? `index:${i}` } : d)) };
    const pt = str(p.prompt_template);
    if (pt) st.promptTemplates++;
    st.projects++;
    drafts.push(rec('project', prov(a.name, a.index), importedAt, raw, {
      conversationId: p.uuid, title: str(p.name), createdAt: toIso(p.created_at), updatedAt: toIso(p.updated_at),
      authorName: isObj(p.creator) ? str(p.creator.full_name) ?? str(p.creator.name) : null,
      text: [str(p.name), str(p.description), pt].filter(Boolean).join('\n'),
      parts: [...(str(p.description) ? [{ type: 'description', text: p.description }] : []), ...(pt ? [{ type: 'instructions', text: pt }] : [])],
      flags: [...(p.is_private === true ? ['private'] : []), ...(p.is_starter_project === true ? ['starter'] : [])],
    }));
    docs.forEach((d, i) => {
      if (!isObj(d)) { fail({ entry: a.name, index: a.index, conversationId: p.uuid, reason: `Project doc ${i} is not an object (kept in raw project file)` }); return; }
      st.projectDocs++;
      drafts.push(rec('project_doc', prov(a.name, a.index), importedAt, d, {
        conversationId: p.uuid, messageId: str(d.uuid) ?? `index:${i}`, title: str(d.filename) ?? str(d.name),
        createdAt: toIso(d.created_at), updatedAt: toIso(d.updated_at), text: str(d.content) ?? '',
        parts: [{ type: 'text', text: str(d.content) ?? '' }],
      }));
    });
  }

  // Which archived files belong to which artifact version (only ids present in the source).
  const filesByVersion = new Map<string, number>();
  const entryLinks = new Map<string, { artifact: string; version: string | null }>();
  for (const a of archived) {
    const seg = a.name.split('/');
    if (seg[0] !== 'artifacts' || seg.length < 3 || !artifacts.has(seg[1])) continue;
    const m = artifacts.get(seg[1])!.m;
    const verIds = new Set((m.versions as unknown[]).filter(isObj).map((v) => str(v.id)).filter(Boolean) as string[]);
    let version: string | null = null;
    if (seg[2] === 'versions' && seg[3]) {
      const cand = seg.length > 4 ? seg[3] : seg[3].replace(/\.files\.json$/i, '').replace(/\.[^.]+$/, '');
      if (verIds.has(cand)) version = cand;
      else if (verIds.has(seg[3])) version = seg[3];
      else warn({ entry: a.name, index: a.index, conversationId: seg[1], reason: 'File under versions/ does not match any version id in the manifest' });
    }
    entryLinks.set(a.name, { artifact: seg[1], version });
    if (version) { filesByVersion.set(`${seg[1]}|${version}`, (filesByVersion.get(`${seg[1]}|${version}`) ?? 0) + 1); st.filesLinkedToVersion++; }
  }

  for (const [id, { m, a }] of artifacts) {
    st.artifacts++;
    const versions: unknown[] = m.versions;
    const active = str(m.active_version);
    const vids = versions.filter(isObj).map((v) => str(v.id));
    if (active && !vids.includes(active)) warn({ entry: a.name, index: a.index, conversationId: id, reason: 'active_version is not listed in versions' });
    if (!versions.length) warn({ entry: a.name, index: a.index, conversationId: id, reason: 'Artifact has no versions' });
    const activeV = versions.find((v) => isObj(v) && v.id === active) as Record<string, any> | undefined;
    drafts.push(rec('artifact', prov(a.name, a.index), importedAt, m, {
      conversationId: id, title: str(activeV?.title) ?? str((versions.at(-1) as any)?.title) ?? null,
      updatedAt: toIso(m.updated_at), text: versions.filter(isObj).map((v) => [str(v.title), str(v.description)].filter(Boolean).join(' ')).join('\n'),
      flags: [str(m.kind) ? `kind:${m.kind}` : 'kind:unknown', ...(str(m.visibility) ? [`visibility:${m.visibility}`] : [])],
    }));
    versions.forEach((v, i) => {
      st.versionsListed++;
      if (!isObj(v)) { fail({ entry: a.name, index: a.index, conversationId: id, reason: `Version ${i} is not an object (kept in raw manifest)` }); return; }
      const vid = str(v.id) ?? `index:${i}`;
      const files = filesByVersion.get(`${id}|${vid}`) ?? 0;
      const isPage = archived.some((e) => e.name === `artifacts/${id}/page.md`);
      if (files) st.versionsWithFiles++;
      else warn({ entry: a.name, index: a.index, conversationId: id, reason: isPage
        ? `Page version ${vid}: metadata only. The export provides the page's current content as page.md (+ comments.json), not per-version files`
        : `Version ${vid} has no files in this export` });
      drafts.push(rec('artifact_version', prov(a.name, a.index), importedAt, v, {
        conversationId: id, messageId: vid, title: str(v.title), createdAt: toIso(v.created_at),
        text: [str(v.title), str(v.description)].filter(Boolean).join('\n'),
        flags: [...(vid === active ? ['active'] : []), `files:${files}`],
      }));
    });
  }

  for (const a of archived) {
    const link = entryLinks.get(a.name);
    if (!link) st.filesUnlinked++;
    drafts.push(entryRecord(a, prov(a.name, a.index), importedAt, 'claude', a.name.split('/')[0] || '(root)',
      link ? [{ type: 'artifact', target: link.artifact }, ...(link.version ? [{ type: 'artifact_version', target: link.version }] : [])] : []));
  }
  if (!projects.length && !artifacts.size)
    warn({ entry: src.label, index: null, reason: `No conversations, projects or artifacts recognised: ${st.entriesArchived} file(s) archived byte-exact without structured parsing` });
  const results = vault.putMany(drafts);
  return { stats: st, results };
}
