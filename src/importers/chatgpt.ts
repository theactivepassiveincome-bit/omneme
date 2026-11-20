// Converts one conversation object from an official ChatGPT export (conversations.json)
// into canonical records. The full `mapping` tree is preserved: every message keeps its
// parent node id, and the conversation record keeps the complete node skeleton.
import { contentHash, isObj, num, str, toIso, type Attachment, type ContentPart, type DraftRecord } from '../schema.ts';
import { base, dedupeAttachments, emptyAttachmentStats, textOf, type ConvertCtx, type Converted } from './common.ts';

export const CHATGPT_IMPORTER = { id: 'omneme.chatgpt', version: '0.1.0' };

export function isChatGPTConversation(v: unknown): boolean { return isObj(v) && isObj(v.mapping); }

function assetId(ptr: string): string { return ptr.replace(/^[a-z-]+:\/\//i, ''); }

function fileAttachment(id: string | null, name: string | null, mime: string | null, size: number | null, ref: string | null, ctx: ConvertCtx): Attachment {
  const entry = (id && ctx.files.get(id)) || (name && ctx.files.get(name)) || null;
  return { id, name, mime, size, ref, exportEntry: entry, availability: entry ? 'referenced_in_export' : (id || ref ? 'missing_from_export' : 'metadata_only') };
}

function genericText(c: Record<string, any>): string[] {
  const out: string[] = [];
  for (const k of ['text', 'result', 'content']) if (typeof c[k] === 'string') out.push(c[k]);
  if (Array.isArray(c.parts)) for (const p of c.parts) if (typeof p === 'string') out.push(p);
  return out;
}

export function chatgptContent(content: unknown, ctx: ConvertCtx): { parts: ContentPart[]; attachments: Attachment[] } {
  const parts: ContentPart[] = [];
  const attachments: Attachment[] = [];
  if (!isObj(content)) return { parts: [{ type: 'unknown', originalType: 'missing_content' }], attachments };
  const ct = str(content.content_type) ?? 'unknown';
  const strParts = () => (Array.isArray(content.parts) ? content.parts : []);
  switch (ct) {
    case 'text':
      for (const p of strParts()) if (typeof p === 'string') parts.push({ type: 'text', text: p });
      break;
    case 'multimodal_text':
      for (const p of strParts()) {
        if (typeof p === 'string') { parts.push({ type: 'text', text: p }); continue; }
        if (!isObj(p)) continue;
        const pct = str(p.content_type) ?? 'unknown';
        if (pct.endsWith('asset_pointer') && typeof p.asset_pointer === 'string') {
          const kind = pct.includes('image') ? 'image' : pct.includes('audio') ? 'audio' : pct.includes('video') ? 'video' : 'file';
          const a = fileAttachment(assetId(p.asset_pointer), null, str(p.mime_type) ?? null, num(p.size_bytes), p.asset_pointer, ctx);
          attachments.push(a);
          parts.push({ type: kind, ref: p.asset_pointer, availability: a.availability, originalType: pct });
        } else if (typeof p.text === 'string') parts.push({ type: 'text', text: p.text, originalType: pct });
        else parts.push({ type: 'unknown', originalType: pct });
      }
      break;
    case 'code': parts.push({ type: 'code', text: str(content.text) ?? '', originalType: str(content.language) ?? 'code' }); break;
    case 'execution_output': parts.push({ type: 'tool_result', text: str(content.text) ?? '', originalType: ct }); break;
    case 'thoughts':
      for (const t of Array.isArray(content.thoughts) ? content.thoughts : [])
        if (isObj(t)) parts.push({ type: 'thinking', text: [str(t.summary), str(t.content)].filter(Boolean).join('\n'), originalType: ct });
      break;
    case 'reasoning_recap': parts.push({ type: 'thinking', text: str(content.content) ?? '', originalType: ct }); break;
    case 'user_editable_context':
      parts.push({ type: 'context', text: [str(content.user_profile), str(content.user_instructions)].filter(Boolean).join('\n'), originalType: ct });
      break;
    default: {
      const t = genericText(content);
      if (t.length) for (const x of t) parts.push({ type: 'text', text: x, originalType: ct });
      else parts.push({ type: 'unknown', originalType: ct });
    }
  }
  return { parts, attachments };
}

export function convertChatGPT(conv: Record<string, any>, ctx: ConvertCtx): Converted {
  const warnings: string[] = [];
  const stats = emptyAttachmentStats();
  let convId = str(conv.conversation_id) ?? str(conv.id);
  if (!convId) { convId = 'sha256:' + contentHash(conv).slice(0, 32); warnings.push('conversation has no id; content-derived id assigned'); }
  const mapping = conv.mapping as Record<string, any>;
  // Current branch: walk from current_node to the root.
  const current = new Set<string>();
  for (let n = str(conv.current_node), guard = 0; n && mapping[n] && guard < 1e6; guard++) {
    if (current.has(n)) { warnings.push('cycle in mapping parent chain'); break; }
    current.add(n); n = str(mapping[n]?.parent);
  }
  const skeleton: Record<string, unknown> = {};
  const records: DraftRecord[] = [];
  let structural = 0, skipped = 0;
  const seenIds = new Set<string>();
  const defaultModel = str(conv.default_model_slug);
  for (const [key, node] of Object.entries(mapping)) {
    if (!isObj(node)) { warnings.push(`mapping node ${key} is not an object; skipped`); skipped++; skeleton[key] = node; continue; }
    const nodeId = str(node.id) ?? key;
    if (str(node.id) && node.id !== key) warnings.push(`mapping key ${key} differs from node id ${node.id}`);
    if (seenIds.has(nodeId)) warnings.push(`duplicate node id ${nodeId}; both kept as versions`);
    seenIds.add(nodeId);
    const msg = node.message;
    skeleton[key] = { ...node, message: isObj(msg) ? { $omneme_ref: str(msg.id) ?? nodeId } : null };
    if (!isObj(msg)) { structural++; continue; }
    const { parts, attachments: inline } = chatgptContent(msg.content, ctx);
    const meta = isObj(msg.metadata) ? msg.metadata : {};
    const metaAtt = Array.isArray(meta.attachments) ? meta.attachments : [];
    const attachments = dedupeAttachments([
      ...inline,
      ...metaAtt.filter(isObj).map((a: any) => fileAttachment(str(a.id), str(a.name), str(a.mime_type) ?? str(a.mimeType), num(a.size), null, ctx)),
    ]);
    for (const a of attachments) stats[a.availability]++;
    const flags: string[] = [];
    if (current.has(key)) flags.push('current_branch');
    if (meta.is_visually_hidden_from_conversation) flags.push('hidden');
    if (Array.isArray(node.children) && node.children.length > 1) flags.push('branch_point');
    const author = isObj(msg.author) ? msg.author : {};
    records.push(base('chatgpt', 'message', ctx, msg, {
      conversationId: convId, messageId: nodeId, parentMessageId: str(node.parent),
      role: str(author.role), authorName: str(author.name),
      createdAt: toIso(msg.create_time), updatedAt: toIso(msg.update_time),
      model: str(meta.model_slug) ?? (author.role === 'assistant' ? defaultModel : null),
      text: textOf(parts), parts, attachments, flags,
    }));
  }
  const { mapping: _omit, ...convMeta } = conv;
  const convRaw = { ...convMeta, mapping: skeleton };
  records.unshift(base('chatgpt', 'conversation', ctx, convRaw, {
    conversationId: convId, title: str(conv.title), createdAt: toIso(conv.create_time), updatedAt: toIso(conv.update_time),
    model: defaultModel, text: str(conv.title) ?? '',
  }));
  return { records, messages: records.length - 1, structuralNodes: structural, sourceUnits: Object.keys(mapping).length, skipped, attachments: stats, warnings };
}
