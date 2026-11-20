// Synthetic fixtures only. No real user data is used anywhere in the test suite.
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export const TEST_KDF_N = 2 ** 14;
export const PASSWORD = 'correct horse battery staple';

// Every scratch folder is removed when the test process exits (set OMNEME_KEEP_TEST_TMP=1 to keep them for debugging).
const created: string[] = [];
process.on('exit', () => {
  if (process.env.OMNEME_KEEP_TEST_TMP) return;
  for (const d of created) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } }
});
export function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'omneme-test-')); created.push(d); return d; }

/** Minimal ZIP writer for building synthetic export archives. */
export function makeZip(files: { name: string; data: string | Buffer; store?: boolean; declaredSize?: number; cdOffset?: number }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const cdOff = f.cdOffset ?? off;
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = f.store ? data : deflateRawSync(data);
    const method = f.store ? 0 : 8;
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.declaredSize ?? data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(cdOff, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const node = (id: string, parent: string | null, children: string[], message: unknown) => ({ id, parent, children, message });
const msg = (id: string, role: string, text: string | null, t: number | null, extra: Record<string, unknown> = {}) => ({
  id, author: { role, name: null, metadata: {} }, create_time: t, update_time: null,
  content: text === null ? { content_type: 'text', parts: null } : { content_type: 'text', parts: [text] },
  status: 'finished_successfully', end_turn: true, weight: 1, metadata: {}, recipient: 'all', ...extra,
});

export const MARKERS = {
  simple: 'zebra-quokka-marker-7731',
  branchA: 'first regenerated answer alpha-marker',
  branchB: 'second regenerated answer beta-marker',
  chinese: '记忆是我们的身份 长城 熊猫',
  claude: 'claude-synthetic-marker-4242',
  attachment: 'extracted attachment text omega-marker',
  title: 'Synthetic Title Delta-9',
};

export function chatgptConversations(): unknown[] {
  const base = 1_700_000_000;
  return [
    {
      title: MARKERS.title, create_time: base, update_time: base + 60, conversation_id: 'cg-simple', id: 'cg-simple',
      current_node: 'n2', default_model_slug: 'gpt-4o',
      mapping: {
        root: node('root', null, ['n1'], null),
        n1: node('n1', 'root', ['n2'], msg('n1', 'user', `Tell me about ${MARKERS.simple}`, base + 1)),
        n2: node('n2', 'n1', [], msg('n2', 'assistant', 'Here is a synthetic answer.', base + 2, { metadata: { model_slug: 'gpt-4o' } })),
      },
    },
    {
      title: 'Branching', create_time: base + 100, update_time: base + 200, conversation_id: 'cg-branch', current_node: 'b5',
      mapping: {
        root: node('root', null, ['sys'], null),
        sys: node('sys', 'root', ['b1'], msg('sys', 'system', '', base + 100, { metadata: { is_visually_hidden_from_conversation: true } })),
        b1: node('b1', 'sys', ['b2', 'b3'], msg('b1', 'user', 'Question with two answers', base + 101)),
        b2: node('b2', 'b1', [], msg('b2', 'assistant', MARKERS.branchA, base + 102)),
        b3: node('b3', 'b1', ['b4'], msg('b3', 'assistant', MARKERS.branchB, base + 103)),
        b4: node('b4', 'b3', ['b5'], msg('b4', 'user', 'Follow-up on second branch', base + 104)),
        b5: node('b5', 'b4', [], msg('b5', 'assistant', 'Final answer on current branch', base + 105)),
      },
    },
    {
      title: 'Multimodal', create_time: base + 300, conversation_id: 'cg-media', current_node: 'm2',
      mapping: {
        root: node('root', null, ['m1'], null),
        m1: node('m1', 'root', ['m2'], {
          ...msg('m1', 'user', null, base + 301),
          content: { content_type: 'multimodal_text', parts: [
            { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-IMG001', size_bytes: 12, width: 1, height: 1 },
            { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-GONE02', size_bytes: 99 },
            'What is in these images?',
          ] },
          metadata: { attachments: [{ id: 'file-DOC003', name: 'notes.pdf', size: 1234, mime_type: 'application/pdf' }] },
        }),
        m2: node('m2', 'm1', ['m3'], { ...msg('m2', 'assistant', null, base + 302), content: { content_type: 'code', language: 'python', text: 'print("hi")' } }),
        m3: node('m3', 'm2', [], { ...msg('m3', 'tool', null, base + 303), content: { content_type: 'execution_output', text: 'hi' } }),
      },
    },
    {
      title: '中文对话', create_time: base + 400, conversation_id: 'cg-zh', current_node: 'z2',
      mapping: {
        root: node('root', null, ['z1'], null),
        z1: node('z1', 'root', ['z2'], msg('z1', 'user', `请告诉我：${MARKERS.chinese} 🐼`, base + 401)),
        z2: node('z2', 'z1', [], msg('z2', 'assistant', '好的 — Unicode ✓ émoji 🎉', base + 402)),
      },
    },
    {
      // Missing / null metadata everywhere.
      conversation_id: 'cg-nulls', title: null, create_time: null, update_time: null, current_node: null,
      mapping: {
        x1: { id: 'x1', parent: null, children: ['x2'], message: { id: 'x1', author: null, content: null, create_time: null, metadata: null } },
        x2: { id: 'x2', parent: 'x1', children: [], message: { id: 'x2', author: { role: 'assistant' }, content: { content_type: 'new_future_type', blob: 1 } } },
      },
    },
  ];
}

export function largeChatgptConversation(n: number): unknown {
  const mapping: Record<string, unknown> = { root: node('root', null, ['L0'], null) };
  for (let i = 0; i < n; i++) {
    mapping['L' + i] = node('L' + i, i === 0 ? 'root' : 'L' + (i - 1), i + 1 < n ? ['L' + (i + 1)] : [],
      msg('L' + i, i % 2 ? 'assistant' : 'user', `Large message ${i} ` + 'lorem ipsum '.repeat(20), 1_710_000_000 + i));
  }
  return { title: 'Large', create_time: 1_710_000_000, conversation_id: 'cg-large', current_node: 'L' + (n - 1), mapping };
}

export function claudeConversations(): unknown[] {
  return [
    {
      uuid: 'cl-1', name: 'Claude synthetic', created_at: '2024-03-01T10:00:00.000Z', updated_at: '2024-03-01T10:05:00.000Z',
      account: { uuid: 'acct-synthetic' },
      chat_messages: [
        { uuid: 'c1m1', text: `Hello ${MARKERS.claude}`, content: [{ type: 'text', text: `Hello ${MARKERS.claude}` }], sender: 'human', created_at: '2024-03-01T10:00:00.000Z', updated_at: '2024-03-01T10:00:00.000Z',
          attachments: [{ file_name: 'notes.txt', file_size: 40, file_type: 'text/plain', extracted_content: MARKERS.attachment }], files: [{ file_name: 'photo.png' }] },
        { uuid: 'c1m2', text: '', content: [{ type: 'thinking', thinking: 'synthetic reasoning' }, { type: 'text', text: 'Synthetic reply' }, { type: 'tool_use', name: 'web_search', input: { q: 'x' } }], sender: 'assistant', created_at: '2024-03-01T10:00:05.000Z', attachments: [], files: [] },
      ],
    },
    {
      uuid: 'cl-2', name: '', created_at: '2024-04-02T08:00:00Z',
      current_leaf_message_uuid: 'c2m3',
      chat_messages: [
        { uuid: 'c2m1', parent_message_uuid: '00000000-0000-4000-8000-000000000000', text: '你好 Claude，测试中文', sender: 'human', created_at: '2024-04-02T08:00:00Z', content: [] },
        { uuid: 'c2m2', parent_message_uuid: 'c2m1', text: 'Answer v1', sender: 'assistant', created_at: '2024-04-02T08:00:01Z' },
        { uuid: 'c2m3', parent_message_uuid: 'c2m1', text: 'Answer v2 (retry)', sender: 'assistant', created_at: '2024-04-02T08:00:02Z' },
      ],
    },
    { uuid: 'cl-3', name: null, created_at: null, chat_messages: [{ sender: 'human', text: null }] },
  ];
}

export function writeChatgptZip(dir: string, convs = chatgptConversations()): string {
  const p = join(dir, 'chatgpt-export.zip');
  writeFileSync(p, makeZip([
    { name: 'conversations.json', data: JSON.stringify(convs) },
    { name: 'user.json', data: '{"id":"user-synthetic"}' },
    { name: 'file-IMG001-pixel.png', data: Buffer.from('89504e470d0a1a0a0000', 'hex'), store: true },
    { name: 'chat.html', data: '<html></html>' },
  ]));
  return p;
}

export function writeClaudeZip(dir: string, convs = claudeConversations()): string {
  const p = join(dir, 'claude-export.zip');
  writeFileSync(p, makeZip([
    { name: 'conversations.json', data: JSON.stringify(convs) },
    { name: 'users.json', data: '[{"uuid":"acct-synthetic"}]' },
    { name: 'projects.json', data: '[]' },
  ]));
  return p;
}

/** Read every file in a directory tree as bytes, for plaintext-leak scanning. */
export function allBytes(dir: string): Buffer {
  const out: Buffer[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (f.isFile()) out.push(readFileSync(join(f.parentPath, f.name)));
  }
  return Buffer.concat(out);
}

// ---------- Stage 1.2 synthetic Claude projects / artifacts (frames) exports ----------
export const ARCHIVE_MARKERS = { instructions: 'synthetic-project-instructions-kappa', doc: 'synthetic project doc lambda 文档', html: '<script>window.__omneme_should_never_run=1</script>' };

export function projectFixtures(): Record<string, unknown> {
  return {
    'projects/p-1.json': {
      uuid: 'p-1', name: 'Synthetic Project One', description: 'desc one', is_private: true, is_starter_project: false,
      prompt_template: ARCHIVE_MARKERS.instructions, created_at: '2026-06-01T10:00:00Z', updated_at: '2026-06-02T10:00:00Z',
      creator: { uuid: 'u-1', full_name: 'Synthetic User' },
      docs: [
        { uuid: 'd-1', filename: 'notes.md', content: ARCHIVE_MARKERS.doc, created_at: '2026-06-01T11:00:00Z' },
        { uuid: 'd-2', filename: 'spec.txt', content: 'second doc', created_at: '2026-06-01T12:00:00Z' },
      ],
    },
    'projects/p-2.json': { uuid: 'p-2', name: 'No docs', description: '', is_private: false, prompt_template: '', created_at: '2026-07-01T00:00:00Z', updated_at: null, creator: null, docs: [] },
  };
}

export function framesFiles(): { name: string; data: string | Buffer }[] {
  const manifest = (id: string, kind: string, versions: { id: string; title: string }[], active: string) => JSON.stringify({
    id, kind, visibility: 'private', owner_account: { uuid: 'u-1' }, updated_at: '2026-10-01T00:00:00Z', active_version: active,
    versions: versions.map((v, i) => ({ ...v, description: `d${i}`, created_at: `2026-09-0${i + 1}T00:00:00Z` })),
  });
  return [
    { name: 'artifacts/a-1/artifact.json', data: manifest('a-1', 'artifact', [{ id: 'v1', title: 'First' }, { id: 'v2', title: 'Second' }], 'v2') },
    { name: 'artifacts/a-1/versions.md', data: '# Versions\n- v1\n- v2 (active)\n' },
    { name: 'artifacts/a-1/versions/v1.html', data: `<html><body>v1 ${ARCHIVE_MARKERS.html}</body></html>` },
    { name: 'artifacts/a-1/versions/v2.html', data: `<html><body>v2 ${ARCHIVE_MARKERS.html}</body></html>` },
    // typed artifact: a folder per version plus <ver>.files.json; binary file and a >4 MiB file to exercise chunking
    { name: 'artifacts/a-2/artifact.json', data: manifest('a-2', 'page', [{ id: 'w1', title: 'Deck' }, { id: 'w2', title: 'Deck v2' }, { id: 'w3', title: 'Listed only' }], 'w9') },
    { name: 'artifacts/a-2/versions/w1.files.json', data: '["index.html","app.js","style.css"]' },
    { name: 'artifacts/a-2/versions/w1/index.html', data: '<div>deck</div>' },
    { name: 'artifacts/a-2/versions/w1/app.js', data: 'fetch("https://example.invalid/exfil")' },
    { name: 'artifacts/a-2/versions/w1/style.css', data: 'body{}' },
    { name: 'artifacts/a-2/versions/w2/index.html', data: '<div>deck v2</div>' },
    { name: 'artifacts/a-2/versions/w2/big.bin', data: Buffer.from(Array.from({ length: 5 * 2 ** 20 + 123 }, (_, i) => (i * 7919) % 256)) },
    { name: 'artifacts/a-2/versions/wX/orphan.md', data: 'file under a version id not in the manifest' },
  ];
}

export function writeProjectsZip(dir: string, projects = projectFixtures()): string {
  const p = join(dir, 'projects-000.zip');
  writeFileSync(p, makeZip(Object.entries(projects).map(([name, v]) => ({ name, data: JSON.stringify(v) }))));
  return p;
}
export function writeFramesZip(dir: string, files = framesFiles()): string {
  const p = join(dir, 'frames-000.zip');
  writeFileSync(p, makeZip(files));
  return p;
}

// ---------- Stage 1.4 synthetic CodingCat AI Chat Exporter output (format ai-chat-exporter/conversation@1) ----------
export const CC_MARKERS = { gemini: 'gemini-capture-marker-sigma', grok: 'grok capture marker 测试', branch: 'alternative branch answer tau' };
const ccMsg = (id: string, role: 'user' | 'assistant', text: string, at: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, role, createdAt: at, blocks: [{ type: 'text', markdown: text }], attachments: [], ...extra });

export function ccNote(conversation: Record<string, unknown>) {
  return { format: 'ai-chat-exporter/conversation@1', exportedAt: '2026-11-06T02:00:00.000Z', conversation };
}

/** A CodingCat ZIP: Gemini chat with saved + unavailable + recompressed files, Grok chat with branches, a Markdown-only note, a report. */
export function codingcatFiles(): { name: string; data: string | Buffer }[] {
  const gem = 'Holiday plans - 2026-10-01 (Gemini)';
  const grok = 'Physics question - 2026-10-02 (Grok)';
  const gemini = ccNote({
    id: 'gem-1', platform: 'gemini', title: 'Holiday plans', url: 'https://gemini.google.com/app/gem-1',
    createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z', model: '2.5 Pro',
    messages: [
      ccMsg('g1', 'user', `Plan a trip ${CC_MARKERS.gemini}`, '2026-10-01T08:00:00.000Z', {
        attachments: [
          { name: 'map.png', mime: 'image/png', size: 8, origin: 'user-upload', path: 'files/map.png' },
          { name: 'old-ticket.pdf', origin: 'user-upload', note: 'unavailable', error: 'The platform no longer provides this file' },
        ],
      }),
      { id: 'g2', role: 'assistant', createdAt: '2026-10-01T08:00:05.000Z', blocks: [
        { type: 'thinking', markdown: 'synthetic thinking' },
        { type: 'web-search', query: 'beaches', results: [{ title: 'Beach A', url: 'https://example.invalid/a' }] },
        { type: 'text', markdown: 'Here is a plan.' },
        { type: 'unreadable', kind: 'future_widget' },
      ], attachments: [{ name: 'itinerary.png', mime: 'image/png', origin: 'model-generated', note: 'recompressed', path: 'files/itinerary.png' }] },
    ],
    branches: [],
  });
  const grokNote = ccNote({
    id: 'grok-1', platform: 'grok', title: 'Physics question', url: 'https://grok.com/c/grok-1',
    createdAt: '2026-10-02T10:00:00.000Z', updatedAt: null,
    messages: [
      ccMsg('k1', 'user', `Explain gravity ${CC_MARKERS.grok}`, '2026-10-02T10:00:00.000Z'),
      ccMsg('k2', 'assistant', 'Gravity answer, current branch', '2026-10-02T10:00:10.000Z'),
      ccMsg('k3', 'user', 'Follow-up', '2026-10-02T10:01:00.000Z'),
    ],
    branches: [
      { forkAfterMessageId: 'k1', messages: [ccMsg('k2b', 'assistant', CC_MARKERS.branch, '2026-10-02T10:00:20.000Z'), ccMsg('k3b', 'user', 'branch follow-up', null)] },
      { forkAfterMessageId: null, messages: [ccMsg('k0', 'user', 'edited first prompt', '2026-10-02T09:59:00.000Z')] },
    ],
  });
  return [
    { name: `${gem}/${gem}.json`, data: JSON.stringify(gemini, null, 2) + '\n' },
    { name: `${gem}/files/map.png`, data: Buffer.from('89504e470d0a1a0a', 'hex') },
    { name: `${gem}/files/itinerary.png`, data: Buffer.from('89504e47deadbeef', 'hex') },
    { name: `${grok}/${grok}.json`, data: JSON.stringify(grokNote, null, 2) + '\n' },
    { name: 'Recipe - 2026-10-03 (ChatGPT)/Recipe - 2026-10-03 (ChatGPT).md', data: '---\ntitle: Recipe\n---\n# Recipe\nmarkdown only note\n' },
    { name: 'Projects/Garden (Claude)/Garden (Claude).md', data: '# Garden project\ninstructions…\n' },
    { name: 'Projects/Garden (Claude)/knowledge/soil.txt', data: 'soil notes' },
    { name: '_reports/export-report-2026-11-06-1000.md', data: '# Export report\n- 1 file could not be saved\n' },
  ];
}
export function writeCodingCatZip(dir: string, files = codingcatFiles(), name = 'AI Chats.zip'): string {
  const p = join(dir, name); writeFileSync(p, makeZip(files)); return p;
}
