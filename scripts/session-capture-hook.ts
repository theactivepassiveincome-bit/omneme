// Claude Code SessionEnd hook (OMN-007): saves ONE concise summary of a development session to Omneme
// (project "Omneme Session Captures") through the unlocked agent's existing save_memory tool.
// Captures only sessions that edited files; at most once per session ID (local ledger). Never blocks Claude Code.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { callAgent } from '../src/agent.ts';

const LEDGER = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.omneme', 'session-captures.txt');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const redact = (s: string) => s.replace(/(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(password|secret|token|api[_-]?key)\s*[:=]\s*\S+)/gi, '[redacted]');

try {
  const ev = JSON.parse(readFileSync(0, 'utf8'));
  const id = String(ev.session_id ?? '');
  if (!id || !ev.transcript_path || !existsSync(ev.transcript_path)) process.exit(0);
  if (existsSync(LEDGER) && readFileSync(LEDGER, 'utf8').includes(id)) process.exit(0);       // already captured
  const files = new Set<string>(); let last = '';
  for (const line of readFileSync(ev.transcript_path, 'utf8').split('\n')) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content; if (e?.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use' && EDIT_TOOLS.has(c.name)) files.add(basename(String(c.input?.file_path ?? c.input?.notebook_path ?? '?')));
      if (c.type === 'text' && c.text?.trim()) last = c.text.trim();
    }
  }
  if (!files.size) process.exit(0);                                                          // no development work
  const r = await callAgent('save_memory', {
    project: 'Omneme Session Captures', source: 'claude-code',
    status: `Claude Code session ${id.slice(0, 8)} ended (${ev.reason ?? 'end'}) in ${basename(String(ev.cwd ?? ''))}`,
    completed: [`Files edited: ${[...files].slice(0, 10).join(', ')}${files.size > 10 ? ` (+${files.size - 10} more)` : ''}`],
    next: redact(last).slice(0, 600) || '(no closing summary)',
  });
  if (!r.isError) appendFileSync(LEDGER, `${id} ${new Date().toISOString()}\n`);
} catch { /* a capture problem must never affect Claude Code */ }
process.exit(0);
