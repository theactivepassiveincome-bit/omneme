// Query Omneme through the unlocked agent (no password). Writes only titles, providers, dates and hit counts.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [bin, out, ...q] = process.argv.slice(2);
const env = { ...process.env }; delete env.OMNEME_PASSWORD;
const p = spawn(process.execPath, ['--no-warnings', bin, 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; p.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i < 0) return; const j = JSON.parse(buf.slice(0, i)); buf = '';
  if (j.id !== 2) return;
  const r = j.result.structuredContent?.results ?? []; const text = j.result.content[0].text;
  const lines = r.length ? r.map((c: any, k: number) => `${k + 1}. [${c.provider}] ${c.title} | first ${c.date} | last ${c.lastDate} | ${c.hitCount} matching messages`) : [text];
  writeFileSync(out, lines.join('\n') + '\n'); console.log(text); p.kill(); });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_memory', arguments: { query: q.join(' '), limit: 10 } } }) + '\n');
