// Converts one conversation from an official Claude (claude.ai) export into canonical records.
// Claude exports list messages in `chat_messages`. When `parent_message_uuid` is present it is
// used; otherwise the parent is inferred from order and marked `parentInferred: true`.
import { contentHash, isObj, num, str, toIso, type Attachment, type ContentPart, type DraftRecord } from '../schema.ts';
import { base, dedupeAttachments, emptyAttachmentStats, textOf, type ConvertCtx, type Converted } from './common.ts';

export const CLAUDE_IMPORTER = { id: 'omneme.claude', version: '0.1.0' };

export function isClaudeConversation(v: unknown): boolean { return isObj(v) && Array.isArray(v.chat_messages); }

function blockText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(blockText).filter(Boolean).join('\n');
  if (isObj(v)) return typeof v.text === 'string' ? v.text : blockText(v.content);
  return '';
}

export function claudeContent(m: Record<string, any>): { parts: ContentPart[]; attachments: Attachment[] } {
  const parts: ContentPart[] = [];
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (!isObj(b)) continue;
    const t = str(b.type) ?? 'unknown';
    if (t === 'text') parts.push({ type: 'text', text: str(b.text) ?? '' });
    else if (t === 'thinking') parts.push({ type: 'thinking', text: str(b.thinking) ?? '', originalType: t });
    else if (t === 'tool_use') parts.push({ type: 'tool_use', text: b.input === undefined ? '' : JSON.stringify(b.input), originalType: str(b.name) ?? t });
    else if (t === 'tool_result') parts.push({ type: 'tool_result', text: blockText(b.content), originalType: str(b.name) ?? t });
    else parts.push({ type: 'unknown', originalType: t });
  }
  if (!parts.some((p) => p.type === 'text' && p.text) && typeof m.text === 'string' && m.text) parts.unshift({ type: 'text', text: m.text });
  const attachments: Attachment[] = [];
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    if (!isObj(a)) continue;
    const extracted = str(a.extracted_content);
    attachments.push({ id: str(a.id), name: str(a.file_name), mime: str(a.file_type), size: num(a.file_size), ref: null, exportEntry: null, availability: extracted ? 'text_extracted' : 'metadata_only' });
    if (extracted) parts.push({ type: 'attachment_text', text: extracted, originalType: str(a.file_name) ?? 'attachment' });
  }
  for (const f of [...(Array.isArray(m.files) ? m.files : []), ...(Array.isArray(m.files_v2) ? m.files_v2 : [])]) {
    if (!isObj(f)) continue;
    attachments.push({ id: str(f.file_uuid) ?? str(f.uuid), name: str(f.file_name), mime: str(f.file_kind), size: null, ref: null, exportEntry: null, availability: 'missing_from_export' });
  }
  return { parts, attachments: dedupeAttachments(attachments) };
}

export function convertClaude(conv: Record<string, any>, ctx: ConvertCtx): Converted {
  const warnings: string[] = [];
  const stats = emptyAttachmentStats();
  let convId = str(conv.uuid);
  if (!convId) { convId = 'sha256:' + contentHash(conv).slice(0, 32); warnings.push('conversation has no uuid; content-derived id assigned'); }
  const msgs: unknown[] = conv.chat_messages;
  const records: DraftRecord[] = [];
  const parentOf = new Map<string, string | null>();
  let prev: string | null = null;
  let skipped = 0;
  const seenIds = new Set<string>();
  msgs.forEach((m, i) => {
    if (!isObj(m)) { warnings.push(`message ${i} is not an object; skipped`); skipped++; return; }
    let id = str(m.uuid);
    if (!id) { id = `index:${i}:${contentHash(m).slice(0, 16)}`; warnings.push(`message ${i} has no uuid`); }
    if (seenIds.has(id)) warnings.push(`duplicate message uuid ${id} at position ${i}; both kept as versions`);
    seenIds.add(id);
    const explicit = Object.prototype.hasOwnProperty.call(m, 'parent_message_uuid');
    const parent = explicit ? str(m.parent_message_uuid) : prev;
    parentOf.set(id, parent);
    const { parts, attachments } = claudeContent(m);
    for (const a of attachments) stats[a.availability]++;
    const sender = str(m.sender);
    records.push(base('claude', 'message', ctx, m, {
      conversationId: convId, messageId: id, parentMessageId: parent, parentInferred: !explicit && parent !== null,
      role: sender === 'human' ? 'user' : sender, authorName: null,
      createdAt: toIso(m.created_at), updatedAt: toIso(m.updated_at), model: str(m.model) ?? (sender === 'assistant' ? str(conv.model) : null),
      text: textOf(parts), parts, attachments,
    }));
    prev = id;
  });
  const leaf = str(conv.current_leaf_message_uuid);
  if (leaf) {
    const cur = new Set<string>();
    for (let n: string | null | undefined = leaf; n && !cur.has(n); n = parentOf.get(n)) cur.add(n);
    for (const r of records) if (r.messageId && cur.has(r.messageId)) r.flags.push('current_branch');
  }
  const convRaw = { ...conv, chat_messages: msgs.map((m) => (isObj(m) ? { $omneme_ref: str(m.uuid) } : m)) };
  records.unshift(base('claude', 'conversation', ctx, convRaw, {
    conversationId: convId, title: str(conv.name), createdAt: toIso(conv.created_at), updatedAt: toIso(conv.updated_at),
    model: str(conv.model), text: [str(conv.name), str(conv.summary)].filter(Boolean).join('\n'),
  }));
  return { records, messages: records.length - 1, structuralNodes: 0, sourceUnits: msgs.length, skipped, attachments: stats, warnings };
}
