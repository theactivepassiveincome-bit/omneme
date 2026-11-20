// Read-only MCP server (stdio, JSON-RPC 2.0, newline-delimited) exposing Omneme memory search to AI assistants.
// Implements only what MCP clients need for tools: initialize, tools/list, tools/call, ping. No writes, no network.
import { createInterface } from 'node:readline';
import { MemoryIndex, convKey, socialKey, type SearchHit } from './search.ts';
import type { MemoryRecord } from './schema.ts';
import type { Vault } from './vault.ts';
import { normalise, saveHandoff, latestHandoff, formatHandoff } from './handoff.ts';

const STOP = new Set('a an and are about any did do does for from have how i in is it me my of on or our that the this to was we what when where which who why with you your past previous talk talked discuss discussed conversation conversations chat chats remember'.split(' '));

/**
 * Keyword recall ranked per conversation: each query term is weighted by rarity (IDF over conversations, so generic
 * terms like "BSV" count little), and by where it matched (title 2x, user message 1.5x, assistant 1x).
 * Conversations matching only common terms are halved. Grouped by conversation; best excerpts first.
 */
export function recall(ix: MemoryIndex, query: string, opts: { provider?: 'chatgpt' | 'claude' | 'x'; limit?: number } = {}) {
  const words = [...new Set(query.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)))];
  if (!words.length) return [];
  const convTitles = new Map(ix.listConversations(opts.provider).map((c) => [convKey(c), (c.title ?? '').toLowerCase()]));
  const N = Math.max(1, convTitles.size);
  type C = { hits: Map<string, SearchHit>; where: Map<string, number> };
  const convs = new Map<string, C>(); const df = new Map<string, number>();
  const get = (k: string) => { let c = convs.get(k); if (!c) convs.set(k, c = { hits: new Map(), where: new Map() }); return c; };
  for (const w of words) {
    const seen = new Set<string>();
    for (const h of ix.search({ text: w, provider: opts.provider })) {
      // A social record (X post) is its own result, never grouped into a conversation.
      const k = h.record.kind === 'social_event' ? 'social/' + socialKey(h.record) : convKey(h.record); seen.add(k); const c = get(k); c.hits.set(h.record.recordId, h);
      c.where.set(w, Math.max(c.where.get(w) ?? 0, h.record.role === 'user' ? 1.5 : 1));
    }
    for (const [k, t] of convTitles) if (t.includes(w)) { seen.add(k); get(k).where.set(w, 2); }
    df.set(w, seen.size);
  }
  const idf = (w: string) => Math.log(1 + N / Math.max(1, df.get(w)!));
  const common = (w: string) => df.get(w)! > N * 0.1;
  const ranked = [...convs.entries()].map(([k, c]) => {
    let score = 0; for (const [w, b] of c.where) score += idf(w) * b;
    if (words.some((w) => !common(w)) && [...c.where.keys()].every(common)) score *= 0.5;   // only generic terms matched
    score += Math.log(1 + c.hits.size) * 0.1;
    return { k, c, score };
  }).filter((x) => x.c.hits.size).sort((a, b) => b.score - a.score);
  return ranked.slice(0, opts.limit ?? 5).map(({ k, c, score }) => {
    const hits = [...c.hits.values()];
    const termsIn = (h: SearchHit) => words.filter((w) => (h.record.text ?? '').toLowerCase().includes(w)).reduce((a, w) => a + idf(w), 0);
    hits.sort((a, b) => termsIn(b) - termsIn(a) || (a.record.role === 'user' ? -1 : 1));
    const r: MemoryRecord = hits[0].record;
    const social = r.kind === 'social_event';
    return { provider: r.provider, type: social ? 'social_post' : 'conversation', conversationId: social ? socialKey(r) : r.conversationId, title: hits[0].conversationTitle ?? '(untitled)', score: Math.round(score * 10) / 10,
      date: (hits.map((h) => h.record.createdAt).filter(Boolean).sort()[0] ?? '').slice(0, 10),
      lastDate: (hits.map((h) => h.record.createdAt).filter(Boolean).sort().at(-1) ?? '').slice(0, 10), hitCount: hits.length, matchedKeywords: [...c.where.keys()], key: k,
      excerpts: hits.slice(0, 3).map((h) => ({ role: h.record.role, at: h.record.createdAt, text: h.snippet })) };
  });
}

export function formatRecall(query: string, res: ReturnType<typeof recall>): string {
  if (!res.length) return `No archived conversations matched "${query}".`;
  return res.map((c, i) => `${i + 1}. [${c.provider}] ${c.title} (${c.date || 'undated'}${c.lastDate && c.lastDate !== c.date ? ` to ${c.lastDate}` : ''}) score=${c.score} terms=${c.matchedKeywords.join(',')} id=${c.conversationId}\n`
    + c.excerpts.map((e) => `   - ${e.role ?? '?'}: ${e.text}`).join('\n')).join('\n\n');
}

const TOOL = {
  name: 'search_memory',
  description: 'Search the user\'s personal Omneme archive of past AI conversations (ChatGPT, Claude and others) and imported X posts (read-only, local). '
    + 'Pass a few distinctive keywords (names, topics, technical terms). Returns provider, title, date and excerpts; X posts are single social posts, not chats.',
  inputSchema: { type: 'object', properties: {
    query: { type: 'string', description: 'Keywords or a short natural-language question' },
    provider: { type: 'string', enum: ['chatgpt', 'claude', 'x'], description: 'Optional: only this source (x = imported X posts)' },
    limit: { type: 'number', description: 'Max conversations (default 5)' } }, required: ['query'] },
};

const SAVE = { name: 'save_memory', description: 'Save a concise project handoff to the user\'s Omneme memory so another AI (e.g. ChatGPT) can continue the work. Adds a new record; never overwrites.',
  inputSchema: { type: 'object', required: ['project', 'status', 'next'], properties: {
    project: { type: 'string' }, status: { type: 'string' }, decisions: { type: 'array', items: { type: 'string' } },
    completed: { type: 'array', items: { type: 'string' } }, outstanding: { type: 'array', items: { type: 'string' } },
    next: { type: 'string', description: 'Next recommended action' }, source: { type: 'string', description: 'AI platform saving this (default claude)' } } } };
const RESUME = { name: 'resume_memory', description: 'Get the latest saved project handoff for a named project from the user\'s Omneme memory.',
  inputSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string' } } } };

const OPEN = { name: 'get_conversation', description: 'Read one archived conversation, or one imported X post, from the user\'s Omneme memory (read-only), using the id= value returned by search_memory. '
  + 'Returns messages in their original order with role and timestamp, a page at a time; if more remain, call again with the returned offset.',
  inputSchema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', description: 'Conversation id from search_memory (id=...)' },
    offset: { type: 'number', description: 'Index of the first message to return (default 0)' },
    limit: { type: 'number', description: 'Max messages in this page (default 30, max 100)' } } } };
const PAGE_CHARS = 24000, MSG_CHARS = 4000;

/** One page of a conversation, in the archive's tree order (branches marked), capped by message count and characters. */
export function readConversation(ix: MemoryIndex, id: string, offset = 0, limit = 30): ToolResult {
  const v = id ? ix.conversation(id) : null;
  if (!v || !v.messages.length) return { text: `No conversation with id "${id}" was found in Omneme. Use the id= value shown by search_memory.`, isError: true };
  const total = v.messages.length; const start = Math.max(0, Math.floor(offset) || 0);
  if (start >= total) return { text: `This conversation has ${total} messages; offset ${start} is past the end. Use offset 0 to ${total - 1}.`, isError: true };
  const c = v.conversation; const r0 = v.messages[0].record;
  if (!c && r0.kind === 'social_event') { // one social record (X post): shown whole, never as a chat thread
    const t = r0.text ?? ''; const body = t.length > PAGE_CHARS ? `${t.slice(0, PAGE_CHARS)} […truncated, ${t.length - PAGE_CHARS} more characters]` : t;
    const media = r0.attachments.map((a) => `\n[media] ${a.name ?? a.ref ?? 'file'} (${a.availability === 'referenced_in_export' ? 'in the original X archive; not copied into the vault' : 'not in the export'})`).join('');
    const rel = r0.relations.map((x) => `\n[${x.type}] ${x.target}`).join('');
    return { text: `Social post: ${r0.title ?? 'X post'} [${r0.provider}] id=${socialKey(r0)}${r0.flags.length ? ` (${r0.flags.join(', ')})` : ''}\n${r0.createdAt ?? 'no timestamp'}\n\n${body}${media}${rel}`,
      structured: { id: socialKey(r0), type: 'social_post', title: r0.title, provider: r0.provider, createdAt: r0.createdAt, flags: r0.flags } };
  }
  const lines: string[] = []; let chars = 0, i = start;
  const max = Math.min(100, Math.max(1, Math.floor(limit) || 30));
  for (; i < total && i - start < max; i++) {
    const m = v.messages[i]; const t = m.record.text ?? '';
    const body = t.length > MSG_CHARS ? `${t.slice(0, MSG_CHARS)} […message truncated, ${t.length - MSG_CHARS} more characters]` : t;
    const line = `[${i + 1}] ${m.record.role ?? 'unknown'}${m.record.createdAt ? ` ${m.record.createdAt}` : ''}${m.siblings > 1 ? ` (branch ${m.position}/${m.siblings})` : ''}:\n${body}`;
    if (i > start && chars + line.length > PAGE_CHARS) break;
    lines.push(line); chars += line.length;
  }
  const head = `Conversation: ${c?.title ?? '(untitled)'} [${r0.provider}] id=${r0.conversationId}\nMessages ${start + 1}-${i} of ${total}.`;
  const more = i < total ? `\n\nMORE MESSAGES AVAILABLE (${total - i} remaining): call get_conversation with id="${r0.conversationId}" and offset=${i}.` : '\n\nEnd of conversation.';
  return { text: `${head}\n\n${lines.join('\n\n')}${more}`, structured: { id: r0.conversationId, title: c?.title ?? null, provider: r0.provider, total, offset: start, returned: i - start, nextOffset: i < total ? i : null } };
}

export type ToolResult = { text: string; isError?: boolean; structured?: object };
export const TOOLS = [TOOL, OPEN, SAVE, RESUME];

/** Execute one tool against an unlocked store (used by the in-process server and by the unlock agent). */
export function callTool(name: string, args: any, ix: MemoryIndex, store: { vault: Vault; records: MemoryRecord[] }): ToolResult {
  try {
    if (name === TOOL.name) {
      const q = String(args?.query ?? ''); const res = recall(ix, q, { provider: args?.provider, limit: Math.min(20, Number(args?.limit) || 5) });
      return { text: formatRecall(q, res), structured: { results: res } };
    }
    if (name === OPEN.name) return readConversation(ix, String(args?.id ?? ''), Number(args?.offset ?? 0), Number(args?.limit ?? 30));
    if (name === SAVE.name) {
      const h = normalise(args, 'claude'); const r = saveHandoff(store.vault, h);
      store.records.push({ kind: 'handoff', raw: h } as MemoryRecord);
      return { text: `Saved handoff for "${h.project}" at ${h.savedAt} (sha256 ${r.sha256}).` };
    }
    if (name === RESUME.name) {
      const h = latestHandoff(store.records, String(args?.project ?? ''));
      return { text: h ? formatHandoff(h) : `No saved handoff for "${args?.project}".` };
    }
    return { text: `Unknown tool ${name}`, isError: true };
  } catch (e) { return { text: `Error: ${(e as Error).message}`, isError: true }; }
}

/** MCP stdio server. `call` runs a tool (locally, or by forwarding to the unlock agent). */
export function serveMcp(call: (name: string, args: any) => Promise<ToolResult>, info: { version: string }) {
  const out = (m: object) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg: any; try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg; if (id === undefined) return; // notifications need no reply
    const ok = (result: object) => out({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'omneme-memory', version: info.version } });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      const r = await call(params?.name, params?.arguments ?? {});
      return ok({ content: [{ type: 'text', text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}), isError: !!r.isError });
    }
    out({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
  });
}
