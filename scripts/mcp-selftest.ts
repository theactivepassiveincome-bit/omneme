// Acts as an MCP client (like Claude Desktop): starts `omneme mcp` with NO password, which forwards to the unlock agent.
// Runs one search and one handoff save + resume. Writes only a summary (titles, counts, hashes) — no excerpts.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from 'node:crypto';
const [bin, out, handoffFile] = process.argv.slice(2);
const env = { ...process.env }; delete env.OMNEME_PASSWORD; delete env.OMNEME_RECOVERY_KEY;
const p = spawn(process.execPath, ['--no-warnings', bin, 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map<number, (r: any) => void>(); let buf = '';
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const j = JSON.parse(l); pending.get(j.id)?.(j.result); } });
let n = 0; const rpc = (method: string, params: object = {}) => new Promise<any>((ok) => { const id = ++n; pending.set(id, ok); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name: string, args: object) => { const t0 = performance.now(); const r = await rpc('tools/call', { name, arguments: args }); return { text: r.content[0].text as string, isError: r.isError, ms: Math.round(performance.now() - t0) }; };
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'omneme-selftest', version: '1' } });
const tools = (await rpc('tools/list')).tools.map((t: any) => t.name);
const s = await tool('search_memory', { query: 'BSV AI agent payments' });
const h = JSON.parse(readFileSync(handoffFile, "utf8"));
const sv = await tool('save_memory', h);
const rs = await tool('resume_memory', { project: h.project });
const savedSha = /sha256 ([0-9a-f]{64})/.exec(sv.text)?.[1];
const summary = { tools, search: { isError: s.isError, ms: s.ms, conversations: s.text.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/ score=.*/, '')) },
  save: { isError: sv.isError, ms: sv.ms, sha256: savedSha }, resume: { isError: rs.isError, ms: rs.ms, sha256: createHash('sha256').update(rs.text, 'utf8').digest('hex') } };
(summary as any).roundTripIdentical = summary.save.sha256 === summary.resume.sha256;
writeFileSync(out, JSON.stringify(summary, null, 1)); console.log(JSON.stringify(summary, null, 1)); p.kill();
