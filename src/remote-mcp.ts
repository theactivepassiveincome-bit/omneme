// OMN-036: remote MCP adapter for Muse. A small, stateless MCP "Streamable HTTP" endpoint (POST /mcp, JSON responses
// only, no sessions, no SSE) bound to 127.0.0.1. It never opens the vault and never asks for a password: every tool call
// is forwarded through the injected `call` function (in production `callAgent`, i.e. the running Omneme Unlock agent),
// so there is never a second vault writer.
// Security: a separate random bearer secret read from a token file (never printed, never accepted in the URL), compared
// in constant time; explicit Host and Origin allow-lists (localhost defaults); authentication on every method.
// Only search_memory, resume_memory and save_memory exist here. Remote saves are always stored with source "muse" and may
// not target the owner's approval projects (Omneme Tasks, Omneme Antigravity Tasks, Omneme Decisions and their
// subprojects) nor carry an approval-style status, so a remote client can never issue or impersonate an owner approval.
// Reuse note: the official MCP TypeScript SDK (MIT) has a Streamable HTTP transport, but it brings runtime dependencies
// that break Omneme's zero-dependency core; the stateless JSON-only subset needed here is small, so it uses node:http.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TOOLS, type ToolResult } from './mcp.ts';

export const PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26'];
const LATEST_VERSION = '2025-06-18';
/** Streamable HTTP: a request without MCP-Protocol-Version is treated as 2025-03-26. */
const HEADER_DEFAULT_VERSION = '2025-03-26';
export const REMOTE_SOURCE = 'muse';
/** Canonical (lower-case) names of projects a remote client may not write to, including all of their subprojects. */
export const PROTECTED_PROJECTS: readonly string[] = ['omneme tasks', 'omneme antigravity tasks', 'omneme decisions'];
export const REMOTE_TOOL_NAMES: readonly string[] = ['search_memory', 'resume_memory', 'save_memory'];
export const MAX_BODY_BYTES = 256 * 1024;
export const MIN_TOKEN_CHARS = 43; // 32 random bytes in base64url; 64 hex characters also qualify
const MAX_TOKEN_CHARS = 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export type CallFn = (name: string, args: any) => Promise<ToolResult>;

// ---------- tool schemas: the existing TOOLS, restricted and bounded ----------
type Schema = {
  type: string; description?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; enum?: string[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; maxItems?: number;
};
const listBound: Partial<Schema> = { maxItems: 50, items: { type: 'string', maxLength: 1000 } };
const BOUNDS: Record<string, Record<string, Partial<Schema>>> = {
  search_memory: { query: { minLength: 1, maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
  resume_memory: { project: { minLength: 1, maxLength: 200 } },
  save_memory: {
    project: { minLength: 1, maxLength: 200 }, status: { minLength: 1, maxLength: 300 }, next: { minLength: 1, maxLength: 2000 },
    decisions: listBound, completed: listBound, outstanding: listBound,
  },
};

export const REMOTE_TOOLS = REMOTE_TOOL_NAMES.map((name) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`Omneme tool ${name} is missing`);
  const s = structuredClone(t.inputSchema) as Schema;
  s.additionalProperties = false;
  if (name === 'save_memory') delete s.properties!.source; // fixed to "muse" remotely
  for (const [k, b] of Object.entries(BOUNDS[name])) s.properties![k] = { ...s.properties![k], ...structuredClone(b) } as Schema;
  const description = name === 'save_memory'
    ? `${t.description} Over this remote connection the handoff is always saved with source "muse"; the Omneme Tasks, Omneme Antigravity Tasks and Omneme Decisions projects are read-only here.`
    : t.description;
  return { name, description, inputSchema: s };
});
const SCHEMAS = new Map(REMOTE_TOOLS.map((t) => [t.name, t.inputSchema]));

const argName = (k: string) => k.replace(/[^\w.\[\]-]/g, '?').slice(0, 40);
function check(s: Schema, v: unknown, path: string): string | null {
  switch (s.type) {
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 'arguments must be an object';
      const o = v as Record<string, unknown>;
      for (const k of s.required ?? []) if (o[k] === undefined || o[k] === null) return `missing required argument "${k}"`;
      for (const [k, x] of Object.entries(o)) {
        const ps = s.properties?.[k];
        if (!ps) { if (s.additionalProperties === false) return `unknown argument "${argName(k)}"`; continue; }
        if (x === undefined) continue;
        const e = check(ps, x, k); if (e) return e;
      }
      return null;
    }
    case 'string': {
      if (typeof v !== 'string') return `"${path}" must be a string`;
      if (s.enum && !s.enum.includes(v)) return `"${path}" must be one of: ${s.enum.join(', ')}`;
      if (s.minLength !== undefined && v.trim().length < s.minLength) return `"${path}" must not be empty`;
      if (s.maxLength !== undefined && v.length > s.maxLength) return `"${path}" is longer than ${s.maxLength} characters`;
      return null;
    }
    case 'integer': case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) return `"${path}" must be ${s.type === 'integer' ? 'an integer' : 'a number'}`;
      if ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum)) return `"${path}" must be between ${s.minimum} and ${s.maximum}`;
      return null;
    }
    case 'array': {
      if (!Array.isArray(v)) return `"${path}" must be an array`;
      if (s.maxItems !== undefined && v.length > s.maxItems) return `"${path}" has more than ${s.maxItems} items`;
      for (let i = 0; i < v.length; i++) { const e = check(s.items!, v[i], `${path}[${i}]`); if (e) return e; }
      return null;
    }
  }
  return `"${path}" has an unsupported schema`;
}
/** Validate tool arguments against the advertised (bounded) schema. Returns an error message or null. */
export const validateToolArgs = (name: string, args: unknown): string | null => {
  const s = SCHEMAS.get(name); return s ? check(s, args, 'arguments') : 'unknown tool';
};

// ---------- save policy: isolate the owner's approval authority ----------
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
const canon = (s: string) => s.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().toLowerCase();
/** True for the protected approval projects and any of their subprojects (case-insensitive, after trimming). */
export const isProtectedProject = (project: string) => { const c = canon(project); return PROTECTED_PROJECTS.some((p) => c.startsWith(p)); };
const APPROVAL_LIKE = /\bapproval\s*[:=]|\btask\s+[a-z][a-z0-9]*-\d+\s*\|/i;
/** Content-free reason why a remote save is refused, or null if it may be forwarded. */
export function saveRefusal(args: Record<string, unknown>): string | null {
  if (args.source !== undefined && (typeof args.source !== 'string' || canon(args.source) !== REMOTE_SOURCE))
    return `Remote saves are always stored with source "${REMOTE_SOURCE}"; omit "source".`;
  const project = String(args.project);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(project)) return 'The project name contains control characters.';
  if (isProtectedProject(project))
    return 'This project is reserved for the owner\'s task approvals and decisions and is read-only over the remote connection. Save to a normal project instead.';
  if (APPROVAL_LIKE.test(canon(String(args.status))) || APPROVAL_LIKE.test(canon(String(args.next ?? ''))))
    return 'Approval-style statuses (for example "TASK … | APPROVAL: …") can only be set by the owner. Describe the state in plain words instead.';
  return null;
}

// ---------- bearer token ----------
/** Checks a bearer secret; error messages never contain the secret. */
export function validateToken(token: string): string {
  if (typeof token !== 'string' || !token) throw new Error('The token file is empty.');
  if (/\s/.test(token)) throw new Error('The token file must hold the token on one line, without spaces.');
  if (token.length < MIN_TOKEN_CHARS) throw new Error(`The token is too short: use at least 32 random bytes (${MIN_TOKEN_CHARS}+ base64url or 64 hex characters).`);
  if (token.length > MAX_TOKEN_CHARS) throw new Error(`The token is longer than ${MAX_TOKEN_CHARS} characters.`);
  if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new Error('The token may only contain letters, digits and - . _ ~ + / =');
  if (new Set(token).size < 12) throw new Error('The token does not look random; generate 32 random bytes.');
  return token;
}
/** Reads the bearer secret from a file (one line; a BOM and one trailing newline are tolerated). */
export function loadTokenFile(file: string): string {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { throw new Error('Cannot read the file given with --token-file.'); }
  if (raw.length > 4096) throw new Error('The token file is too large.');
  return validateToken(raw.replace(/^﻿/, '').replace(/\r?\n$/, ''));
}
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const authorized = (header: unknown, want: Buffer) => {
  const m = /^Bearer ([^\s]+)$/i.exec(typeof header === 'string' ? header : '');
  return timingSafeEqual(digest(m ? m[1] : ''), want) && !!m; // fixed-length digests: constant time, no length leak
};

// ---------- options ----------
const HOST_RE = /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;
export function normaliseHost(h: string): string {
  const v = String(h).trim().toLowerCase();
  if (!HOST_RE.test(v)) throw new Error('--allow-host must be a host name with an optional port, e.g. memory.example.com (no wildcards, schemes or paths).');
  return v;
}
export function normaliseOrigin(o: string): string {
  const v = String(o).trim().replace(/\/$/, '').toLowerCase();
  let u: URL | null = null; try { u = new URL(v); } catch { /* invalid */ }
  if (!u || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.origin !== v)
    throw new Error('--allow-origin must be an origin like https://memory.example.com (scheme, host and optional port only; no wildcards).');
  return u.origin;
}
export function parsePort(p: string | undefined): number {
  if (!p || !/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) throw new Error('--port must be a number from 1 to 65535.');
  return Number(p);
}
export interface RemoteConfig { port: number; token: string; allowHosts: string[]; allowOrigins: string[] }
/** Strict validation of the CLI options; there is no anonymous or unrestricted fallback. */
export function parseRemoteOptions(raw: { port?: string; tokenFile?: string; allowHost?: string[]; allowOrigin?: string[] }): RemoteConfig {
  const port = parsePort(raw.port);
  if (!raw.tokenFile) throw new Error('--token-file is required: the remote MCP server never runs without a bearer token.');
  return { port, token: loadTokenFile(raw.tokenFile), allowHosts: (raw.allowHost ?? []).map(normaliseHost), allowOrigins: (raw.allowOrigin ?? []).map(normaliseOrigin) };
}

// ---------- JSON-RPC ----------
type Id = string | number;
const validId = (id: unknown): id is Id => typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
const rpcError = (id: Id | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const ok = (id: Id, result: object) => ({ jsonrpc: '2.0', id, result });

/** Removes things that look like file paths or bearer tokens from upstream error texts. */
const scrub = (t: string) => t
  .replace(/[A-Za-z]:[\\/][^\s"'<>|)]*/g, '[path]').replace(/\\\\[^\s"'<>|)]+/g, '[path]')
  .replace(/\/(?:home|Users|tmp|var|root|private|etc|mnt)\/[^\s"'<>|)]*/g, '[path]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 2000);

interface Ctx { call: CallFn; timeoutMs: number; version: string; serverVersion: string }

async function runTool(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const isSave = name === 'save_memory';
  let fwd = args;
  if (isSave) {
    const refusal = saveRefusal(args); if (refusal) return { text: refusal, isError: true };
    fwd = { ...args, source: REMOTE_SOURCE };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), ctx.timeoutMs); });
  try {
    const r = await Promise.race([Promise.resolve().then(() => ctx.call(name, fwd)), timeout]); // one attempt only; never retried
    if (r === 'timeout') return { text: isSave
      ? 'Omneme did not confirm the save in time. It may or may not have been stored and it was not retried; check with resume_memory before saving again.'
      : 'Omneme did not answer in time. Ask the owner to check, on their own computer, that the terminal running the Omneme agent (node bin/omneme.mjs agent --vault "YOUR-VAULT-FILE", from the Omneme source folder containing package.json) is still open, then try again.', isError: true };
    if (!r || typeof r !== 'object' || typeof r.text !== 'string') return { text: 'Omneme returned an unexpected answer.', isError: true };
    if (r.isError) return { text: scrub(r.text), isError: true };
    return { text: r.text, ...(r.structured ? { structured: r.structured } : {}) };
  } catch {
    return { text: isSave
      ? 'Omneme could not complete the save. It may or may not have been stored and it was not retried; check with resume_memory before saving again.'
      : 'Omneme could not be reached. Ask the owner to start the Omneme agent on their own computer: in a terminal opened in the Omneme source folder (the one containing package.json), run node bin/omneme.mjs agent --vault "YOUR-VAULT-FILE" with YOUR-VAULT-FILE replaced by the intended vault path, enter the vault password only in that terminal and leave it open. Then try again.', isError: true };
  } finally { clearTimeout(timer); }
}

/** Handles one JSON-RPC message. Returns the response object, or null for an accepted notification/response. */
async function handleMessage(m: unknown, ctx: Ctx, inBatch: boolean, note: (s: string) => void): Promise<object | null> {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  const r = m as Record<string, unknown>;
  const hasId = 'id' in r;
  if (hasId && !validId(r.id)) return rpcError(null, -32600, 'Invalid Request: id must be a string or an integer');
  const id = hasId ? (r.id as Id) : null;
  if (r.jsonrpc !== '2.0') return rpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  if (r.method === undefined) {
    if (hasId && ('result' in r || 'error' in r)) return null; // a response from the client; this server sends no requests
    return rpcError(id, -32600, 'Invalid Request: missing method');
  }
  if (typeof r.method !== 'string') return rpcError(id, -32600, 'Invalid Request: method must be a string');
  if (r.params !== undefined && (!r.params || typeof r.params !== 'object' || Array.isArray(r.params)))
    return hasId ? rpcError(id, -32602, 'Invalid params: params must be an object') : rpcError(null, -32600, 'Invalid notification params');
  if (!hasId) { note('notification'); return null; } // notifications (e.g. notifications/initialized) need no answer
  const p = (r.params ?? {}) as Record<string, any>;
  switch (r.method) {
    case 'initialize': {
      note('initialize');
      if (inBatch) return rpcError(id, -32600, 'Invalid Request: initialize must not be part of a batch');
      if (typeof p.protocolVersion !== 'string') return rpcError(id, -32602, 'Invalid params: initialize needs protocolVersion');
      const v = PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : LATEST_VERSION;
      return ok(id!, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'omneme-memory-remote', version: ctx.serverVersion },
        instructions: 'Omneme memory: search_memory and resume_memory read the owner\'s archive; save_memory adds a project handoff (source "muse").' });
    }
    case 'ping': note('ping'); return ok(id!, {});
    case 'tools/list': note('tools/list'); return ok(id!, { tools: REMOTE_TOOLS });
    case 'tools/call': {
      const name = p.name;
      if (typeof name !== 'string' || !SCHEMAS.has(name)) { note('tools/call unknown'); return rpcError(id, -32602, 'Unknown tool: available tools are search_memory, resume_memory and save_memory'); }
      note(`tools/call ${name}`);
      const args = p.arguments ?? {};
      const err = validateToolArgs(name, args);
      if (err) return rpcError(id, -32602, `Invalid arguments for ${name}: ${err}`);
      const t = await runTool(name, args, ctx);
      return ok(id!, { content: [{ type: 'text', text: t.text }], ...(ctx.version === '2025-06-18' && t.structured ? { structuredContent: t.structured } : {}), isError: !!t.isError });
    }
    default: note('unknown method'); return rpcError(id, -32601, 'Method not found');
  }
}

// ---------- HTTP ----------
export interface RemoteOptions {
  port: number; token: string; call: CallFn; allowHosts?: string[]; allowOrigins?: string[];
  log?: (line: string) => void; timeoutMs?: number; version?: string; maxBodyBytes?: number;
}
export interface RemoteServer { port: number; url: string; hosts: string[]; origins: string[]; close(): Promise<void> }

const mediaTypes = (h: unknown) => String(h ?? '').split(',').map((x) => x.split(';')[0].trim().toLowerCase()).filter(Boolean);

export async function startRemoteMcp(opts: RemoteOptions): Promise<RemoteServer> {
  const want = digest(validateToken(opts.token)); // refuses to start without a valid secret
  if (typeof opts.call !== 'function') throw new Error('remote MCP needs a call function');
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('invalid port');
  const log = opts.log ?? (() => {}); const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const extraHosts = (opts.allowHosts ?? []).map(normaliseHost); const extraOrigins = (opts.allowOrigins ?? []).map(normaliseOrigin);
  const hosts = new Set<string>(); const origins = new Set<string>();
  const stamp = () => new Date().toLocaleTimeString();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const method = /^[A-Z]{1,10}$/.test(req.method ?? '') ? req.method! : 'OTHER';
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const reject = (status: number, reason: string, message: string, headers: Record<string, string> = {}) => {
      log(`${stamp()} ${method} rejected ${status} ${reason}`);
      send(status, rpcError(null, -32600, message), headers);
    };
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return reject(403, 'host', 'Host not allowed');
    const url = req.url ?? ''; const q = url.indexOf('?');
    if ((q < 0 ? url : url.slice(0, q)) !== '/mcp') return reject(404, 'path', 'Not found');
    if (q >= 0) return reject(400, 'query', 'Query parameters are not accepted; send the token only in the Authorization header');
    if (req.headers.origin !== undefined && !origins.has(String(req.headers.origin).toLowerCase())) return reject(403, 'origin', 'Origin not allowed');
    if (!authorized(req.headers.authorization, want)) return reject(401, 'auth', 'Unauthorized', { 'www-authenticate': 'Bearer' });
    if (method !== 'POST') return reject(405, 'method', 'Only POST is supported (stateless server)', { allow: 'POST' });
    const pv = req.headers['mcp-protocol-version'];
    if (pv !== undefined && !PROTOCOL_VERSIONS.includes(String(pv))) return reject(400, 'protocol-version', `Unsupported MCP-Protocol-Version; supported: ${PROTOCOL_VERSIONS.join(', ')}`);
    const version = pv === undefined ? HEADER_DEFAULT_VERSION : String(pv);
    if (mediaTypes(req.headers['content-type'])[0] !== 'application/json') return reject(415, 'content-type', 'Content-Type must be application/json');
    const acc = mediaTypes(req.headers.accept);
    if (!acc.some((a) => a === 'application/json' || a === 'application/*' || a === '*/*')) return reject(406, 'accept', 'Accept must include application/json');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBody) { res.setHeader('connection', 'close'); return reject(413, 'size', 'Request body too large'); }

    const chunks: Buffer[] = []; let size = 0; let tooBig = false;
    await new Promise<void>((done, fail) => {
      req.on('data', (c: Buffer) => { if (tooBig) return; size += c.length; if (size > maxBody) { tooBig = true; return; } chunks.push(c); });
      req.on('end', () => done()); req.on('error', fail);
    });
    if (tooBig) { res.setHeader('connection', 'close'); return reject(413, 'size', 'Request body too large'); }
    let msg: unknown;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      log(`${stamp()} POST rejected 400 parse`); return send(400, rpcError(null, -32700, 'Parse error'));
    }
    const notes: string[] = []; const note = (s: string) => { notes.push(s); };
    const ctx: Ctx = { call: opts.call, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, version, serverVersion: opts.version ?? '0.3' };
    let status: number; let body: unknown;
    if (Array.isArray(msg)) {
      if (version !== '2025-03-26' || !msg.length) { status = 400; body = rpcError(null, -32600, msg.length ? 'Batching is not supported in protocol 2025-06-18' : 'Invalid Request: empty batch'); }
      else {
        const out = (await Promise.all(msg.map((m) => handleMessage(m, ctx, true, note)))).filter((x): x is object => x !== null);
        if (out.length) { status = 200; body = out; } else { status = 202; body = undefined; }
      }
    } else {
      const r = await handleMessage(msg, ctx, false, note) as { id?: unknown; error?: unknown } | null;
      if (r === null) { status = 202; body = undefined; }
      else { status = r.error && r.id === null ? 400 : 200; body = r; }
    }
    log(`${stamp()} POST ${notes.join(', ') || 'message'} -> ${status}`);
    send(status, body);
  };

  const srv = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
    handle(req, res).catch(() => {
      log(`${stamp()} internal error`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify(rpcError(null, -32603, 'Internal error')));
      else res.destroy();
    });
  });
  await new Promise<void>((done, fail) => { srv.once('error', fail); srv.listen(opts.port, '127.0.0.1', () => { srv.off('error', fail); done(); }); });
  const port = (srv.address() as { port: number }).port;
  for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, ...extraHosts]) hosts.add(h);
  for (const o of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins]) origins.add(o);
  return {
    port, url: `http://127.0.0.1:${port}/mcp`, hosts: [...hosts], origins: [...origins],
    close: () => new Promise<void>((done) => { srv.close(() => done()); srv.closeAllConnections?.(); }),
  };
}

/** Startup text for the console. Never contains the token or the token file path. */
export function remoteUsage(s: { url: string; hosts: string[]; origins: string[] }): string[] {
  return [
    `Omneme remote MCP listening on ${s.url} (loopback only; stateless Streamable HTTP, POST only).`,
    'Tools: search_memory, resume_memory, save_memory. Saves are stored with source "muse"; Omneme Tasks, Omneme Antigravity Tasks and Omneme Decisions are read-only here.',
    `Allowed Host headers: ${s.hosts.join(', ')}`,
    `Allowed Origins: ${s.origins.join(', ')} (requests without an Origin header are also accepted)`,
    'Clients must send "Authorization: Bearer <token from the token file>". The token is never printed and never accepted in the URL.',
    'Tool calls are forwarded to the unlock agent (node bin/omneme.mjs agent), which must be running; this process never opens the vault. Ctrl-C to stop.',
    'Token file: one line holding at least 32 random bytes, e.g. node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  ];
}
