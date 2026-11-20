// Omneme task worker (OMN-003): run by Windows Task Scheduler every 10 minutes. No AI runs while idle.
// One check per run: if the latest "Omneme Tasks" handoff is an APPROVED task from ChatGPT that has never been
// started before, record its ID (so it can never run twice), then start Claude Code once, headless, to do only that
// task and save one DONE handoff. Needs the Omneme Unlock window open. Pause by creating the PAUSE file.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { callAgent } from '../src/agent.ts';
import { completionSummary, reviewCompletion, saveDecisions } from './completion-review.ts';
import type { ResultMeta } from './completion-review.ts';

const DIR = process.env.OMNEME_WORKER_DIR ?? join(process.env.USERPROFILE ?? '.', 'Omneme', 'Stage3');
const PROJECT_DIR = process.env.OMNEME_PROJECT_DIR ?? join(process.env.USERPROFILE ?? '.', 'Omneme');
const PAUSE = join(DIR, 'omneme-worker.PAUSE'), LOCK = join(DIR, 'omneme-worker.lock');
const GUARD = join(DIR, 'omneme-worker-guard.sqlite');
const REVIEWS = process.env.OMNEME_REVIEW_DIR ?? join(DIR, 'Omneme Reviews');
const RECORD = join(DIR, 'omneme-worker-tasks.txt'), LOG = join(DIR, 'omneme-worker.log');
const log = (m: string) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);
const seen = () => (existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : '').split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean);
const TOOLS = 'mcp__omneme__resume_memory,mcp__omneme__save_memory,mcp__omneme__search_memory,mcp__omneme__get_conversation,Read,Grep,Glob';

function latest() {
  return callAgent('resume_memory', { project: 'Omneme Tasks' }).then((r) => {
    if (r.isError) return { error: r.text.slice(0, 120) };
    const m = /Saved (\S+) by (\S+)[\s\S]*?## Current status\s*\n\s*TASK (\S+)\s*\|\s*APPROVAL:\s*(\w+)/.exec(r.text);
    return m ? { savedAt: m[1], by: m[2], id: m[3], approval: m[4].toUpperCase(), text: r.text } : { error: 'latest handoff is not a task' };
  });
}

// Result lines go to the console only (hidden under the scheduler; shown by "Omneme Run Now").
if (existsSync(PAUSE)) { console.log('Worker is paused - nothing run.'); process.exit(0); } // paused: do nothing, log nothing
// OMN-014: one completion review + notification per DONE task, whether Claude finished it here or interactively.
// The per-task claim file inside reviewCompletion makes repeated scans and overlapping paths no-ops.
function reviewDone(id: string, summary: string, meta?: ResultMeta) {
  if (!/^OMN-\d{3,}$/.test(id) || existsSync(join(REVIEWS, id + '.claim'))) return;
  try {
    const r = reviewCompletion(REVIEWS, id, summary, undefined, meta); // undefined = the real Codex and alert runners
    if (r) { log(`review ${id}: saved, notification ${r.notificationSubmitted ? 'submitted' : 'not submitted'}`); console.log(`Completion review for ${id} saved.`); }
  } catch (e) { log(`review ${id}: ${(e as Error).message}`); }
}
// OMN-018: save each reviewed task's PENDING decision to "Omneme Decisions" once. A failed save is retried on the
// next scan without a new review or notification. Decisions are never read back as tasks or executed here.
async function recordDecisions() {
  try {
    for (const dec of await saveDecisions(REVIEWS, callAgent)) { log(`decision ${dec}: saved as PENDING`); console.log(`Decision ${dec} saved as PENDING.`); }
  } catch (e) { log(`decision: ${(e as Error).message}; will retry`); }
}
// OMN-029/030: the Antigravity queue is REVIEW-ONLY. Its latest terminal result (DONE/BLOCKED/FAILED saved by the exact
// source "antigravity", as verified in the live vault, with a valid task ID) gets the same single review, notification,
// claim and PENDING decision as a Claude result, with its terminal status carried as structured data (ResultMeta).
// Nothing from this queue is ever launched or retried, an APPROVED entry included. A missing, invalid, pending or
// unreachable result is skipped silently (normal idle output unchanged) and never stops the Claude queue below.
const AGY_PROJECT = 'Omneme Antigravity Tasks';
const AGY_SOURCE = 'antigravity';
const section = (text: string, title: string) => (new RegExp(`(?:^|\\n)## ${title}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`).exec(text)?.[1] ?? '').trim();
async function reviewAntigravity() {
  try {
    const r = await callAgent('resume_memory', { project: AGY_PROJECT });
    if (r.isError) return; // unreachable or locked: the Claude check below reports it as before
    const m = /^# Project handoff: (.+)\r?\nSaved (\S+) by (\S+)[\s\S]*?## Current status\s*\n\s*TASK (\S+)\s*\|\s*APPROVAL:\s*(\w+)\s*$/m.exec(r.text);
    if (!m || m[1].trim() !== AGY_PROJECT) return; // missing or not a task result
    const [, , , by, id, approval] = m;
    const status = approval.toUpperCase();
    if (by !== AGY_SOURCE || !/^OMN-\d{3,}$/.test(id) || !(status === 'DONE' || status === 'BLOCKED' || status === 'FAILED')) return;
    const lines = [
      `Completed work: ${section(r.text, 'Completed work') || 'none reported'}`,
      `Outstanding: ${section(r.text, 'Outstanding tasks') || 'none reported'}`,
    ];
    reviewDone(id, lines.join('\n').slice(0, 1500), { implementer: 'Antigravity', status });
    // Idempotent; saves this result's decision even if the Claude check below stops early.
    if (!existsSync(join(REVIEWS, id + '.decision'))) await recordDecisions();
  } catch (e) { log(`antigravity: ${(e as Error).message}`); }
}
// OMN-047: every Claude terminal result gets the same single review, notification, claim and PENDING decision, both
// after a worker run and when found later (e.g. saved interactively). Accepted only for the exact source "claude", a
// valid task ID and an exact status line. DONE keeps the legacy review format; BLOCKED/FAILED carry ResultMeta so the
// review, notification and decision state the worker-recorded status, never "completed". Nothing is retried.
const CLAUDE_RESULT = /^# Project handoff: Omneme Tasks\r?\nSaved \S+ by (\S+) [\s\S]*?\n## Current status\r?\nTASK (OMN-\d{3,}) \| APPROVAL: (DONE|BLOCKED|FAILED)(?:\r?\n|$)/;
function reviewClaude(text: string, expectId?: string) {
  const m = CLAUDE_RESULT.exec(text ?? '');
  if (!m || m[1] !== 'claude' || (expectId !== undefined && m[2] !== expectId)) return;
  const [, , id, status] = m;
  if (status === 'DONE') { reviewDone(id, completionSummary(text)); return; }
  const lines = [
    `Completed work: ${section(text, 'Completed work') || 'none reported'}`,
    `Outstanding: ${section(text, 'Outstanding tasks') || 'none reported'}`,
  ];
  reviewDone(id, lines.join('\n').slice(0, 1500), { implementer: 'Claude', status: status as ResultMeta['status'] });
}
async function run() {
  await reviewAntigravity();
  const t: any = await latest();
  if (t.error) { console.log(/not a task/.test(t.error) ? 'No approved task.' : `Could not check tasks: ${t.error}`); if (!/locked|not a task/.test(t.error)) log(`check: ${t.error}`); return; }
  reviewClaude(t.text); // a Claude DONE/BLOCKED/FAILED result, e.g. saved in an interactive session
  await recordDecisions();
  if (t.by !== 'chatgpt' || t.approval !== 'APPROVED') { console.log(`No approved task (latest: ${t.id} ${t.approval}).`); return; }
  if (seen().includes(t.id)) { console.log(`No new approved task (${t.id} was already processed).`); return; } // never run twice
  appendFileSync(RECORD, `${t.id} started ${new Date().toISOString()}\n`); // recorded BEFORE starting
  log(`start ${t.id} (approved by chatgpt at ${t.savedAt})`);
  console.log(`Task ${t.id} started. This window stays open until Claude Code finishes.`);
  const prompt = `Resume Omneme Tasks with the omneme resume_memory tool. Follow CLAUDE.md "Omneme Tasks handoff". `
    + `Execute ONLY task ${t.id}, and only if it is still APPROVED and from chatgpt, strictly within its stated scope. `
    + `Do not change code, spend money, deploy or publish unless the task explicitly includes it. `
    + `Save exactly one handoff for ${t.id} with omneme save_memory. Use DONE for completed work, BLOCKED for a missing prerequisite or permission, or FAILED for unsuccessful implementation or verification. Include the reason, then stop.`;
  const r = spawnSync('claude', ['-p', '--max-turns', '30', '--allowedTools', TOOLS, '--output-format', 'text'],
    { cwd: PROJECT_DIR, input: prompt, encoding: 'utf8', shell: true, timeout: 2 * 3600_000, windowsHide: true });
  const after: any = await latest();
  const outcome = after.id === t.id && after.by === 'claude'
    && ['DONE', 'BLOCKED', 'FAILED'].includes(after.approval) ? after.approval : undefined;
  const summary = outcome ? `${outcome} handoff saved` : 'no completion handoff found';
  appendFileSync(RECORD, `${t.id} ${outcome?.toLowerCase() ?? 'finished-without-DONE'} ${new Date().toISOString()} exit=${r.status ?? r.error?.message ?? 'n/a'}\n`);
  log(`end ${t.id}: ${summary} (exit ${r.status ?? 'n/a'})`);
  console.log(`Task ${t.id} finished: ${summary}.`);
  if (outcome) { reviewClaude(after.text, t.id); await recordDecisions(); }
  if (process.argv.includes('--show-report')) {
    if (r.stdout?.trim()) console.log(r.stdout.trim());
    if (r.stderr?.trim()) console.error(r.stderr.trim());
    if (r.error) console.error(r.error.message);
  }
}
async function runExclusively() {
  // Keep the transaction open through cleanup so only its owner can replace or remove the marker.
  const guard = new DatabaseSync(GUARD);
  const busyMessage = 'A task is already running - nothing started.';
  try {
    try {
      guard.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5) throw error; // SQLITE_BUSY
      console.log(busyMessage);
      return;
    }
    if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 3 * 3600_000) {
      console.log(busyMessage);
      return;
    }
    writeFileSync(LOCK, String(process.pid));
    try { await run(); } finally { try { rmSync(LOCK); } catch { /* none */ } }
  } finally {
    guard.close();
  }
}

await runExclusively();
