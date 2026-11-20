// Streams the elements of a top-level JSON array one at a time, so a multi-gigabyte
// conversations.json never needs to be held in memory as a whole. Each element is parsed with
// JSON.parse; a malformed element is reported and skipped, not fatal.
// Hardening (Stage 1.1):
//  - nesting-depth cap and per-element size cap (oversized elements are skipped without buffering);
//  - UTF-8 is validated byte by byte (RFC 3629); invalid bytes become U+FFFD *and* are reported
//    against the element containing them, never silently replaced;
//  - every item carries its element index and exact byte offset in the source.

export interface JsonLimits { maxDepth: number; maxElementBytes: number }
export const DEFAULT_JSON_LIMITS: JsonLimits = { maxDepth: 512, maxElementBytes: 256 * 2 ** 20 };

export type ArrayItem =
  | { index: number; offset: number; value: unknown; issues?: string[] }
  | { index: number; offset: number; error: string }
  /** Array-level syntax error between elements (missing/extra comma). Not an element; parsing continues. */
  | { structuralError: string; offset: number };

export class JsonStreamError extends Error {
  offset: number;
  constructor(m: string, offset: number) { super(m); this.name = 'JsonStreamError'; this.offset = offset; }
}

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0xfeff;

/** Split bytes into valid UTF-8 runs and invalid byte positions; an incomplete trailing sequence is returned as `tail`. */
function scanUtf8(d: Buffer): { pieces: ({ s: number; e: number } | { bad: number })[]; tail: number } {
  const pieces: ({ s: number; e: number } | { bad: number })[] = [];
  let i = 0, run = 0;
  while (i < d.length) {
    const b = d[i];
    if (b < 0x80) { i++; continue; }
    const n = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
    let ok = n > 0;
    let incomplete = false;
    for (let k = 1; ok && k <= n; k++) {
      if (i + k >= d.length) { incomplete = true; break; }
      const c = d[i + k];
      let lo = 0x80, hi = 0xbf;
      if (k === 1) { if (b === 0xe0) lo = 0xa0; else if (b === 0xed) hi = 0x9f; else if (b === 0xf0) lo = 0x90; else if (b === 0xf4) hi = 0x8f; }
      if (c < lo || c > hi) ok = false;
    }
    if (ok && incomplete) { if (run < i) pieces.push({ s: run, e: i }); return { pieces, tail: i }; }
    if (ok) { i += n + 1; continue; }
    if (run < i) pieces.push({ s: run, e: i });
    pieces.push({ bad: i });
    i++; run = i;
  }
  if (run < d.length) pieces.push({ s: run, e: d.length });
  return { pieces, tail: d.length };
}

export async function* streamJsonArray(src: AsyncIterable<Buffer | string>, limits: JsonLimits = DEFAULT_JSON_LIMITS): AsyncGenerator<ArrayItem> {
  let started = false, done = false, inStr = false, esc = false, depth = 0, skipping = false;
  // Separator state at array level: 'start' (after '['), 'value' (after an element), 'comma' (after ',').
  let sep: 'start' | 'value' | 'comma' = 'start';
  let oversize = false, tooDeep = false, elementChars = 0, elementStart = 0;
  let issues: string[] = [];
  let pieces: string[] = [];
  let index = 0;
  let carry = Buffer.alloc(0), carryOffset = 0; // incomplete UTF-8 sequence from the previous chunk
  const out: ArrayItem[] = [];

  /** Feed decoded text whose first character starts at absolute byte offset `base`. */
  const feed = (chunk: string, base: number) => {
    let seg = depth > 0 && !oversize ? 0 : -1;
    let byte = base;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      const pos = byte;
      byte += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? 4 : (c >= 0xdc00 && c <= 0xdfff) ? 0 : 3;
      if (!started) {
        if (isWs(c)) continue;
        if (c === 0x5b) { started = true; continue; }
        throw new JsonStreamError(c === 0x7b ? 'Expected a JSON array of conversations but found an object' : 'Not a JSON array', pos);
      }
      if (done) { if (!isWs(c)) throw new JsonStreamError('Unexpected data after end of JSON array', pos); continue; }
      if (inStr) { if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue; }
      if (depth === 0) {
        if (skipping) {
          if (c === 0x22) inStr = true;
          else if (c === 0x2c) { skipping = false; sep = 'comma'; }
          else if (c === 0x5d) { skipping = false; done = true; }
          continue;
        }
        if (isWs(c)) continue;
        if (c === 0x2c) {
          if (sep === 'value') sep = 'comma';
          else out.push({ structuralError: sep === 'start' ? 'Leading comma in JSON array' : 'Double comma in JSON array', offset: pos });
          continue;
        }
        if (c === 0x5d) { if (sep === 'comma') out.push({ structuralError: 'Trailing comma in JSON array', offset: pos }); done = true; continue; }
        if (sep === 'value') out.push({ structuralError: 'Missing comma between array elements', offset: pos });
        sep = 'value';
        if (c === 0x7b || c === 0x5b) { depth = 1; seg = i; pieces = []; elementStart = pos; elementChars = 0; oversize = false; tooDeep = false; issues = []; continue; }
        out.push({ index: index++, offset: pos, error: 'Array element is not an object' });
        skipping = true;
        if (c === 0x22) inStr = true;
        continue;
      }
      if (c === 0x22) inStr = true;
      else if (c === 0x7b || c === 0x5b) { depth++; if (depth > limits.maxDepth) tooDeep = true; }
      else if (c === 0x7d || c === 0x5d) {
        depth--;
        if (depth > 0) continue;
        const at = { index: index++, offset: elementStart };
        if (oversize || elementChars + (i + 1 - seg) > limits.maxElementBytes) {
          out.push({ ...at, error: `Conversation exceeds size limit (${limits.maxElementBytes} characters); skipped` });
        } else if (tooDeep) {
          out.push({ ...at, error: `JSON nesting deeper than ${limits.maxDepth}; skipped` });
        } else {
          pieces.push(chunk.slice(seg, i + 1));
          let value: unknown, okParse = true;
          try { value = JSON.parse(pieces.join('')); } catch { okParse = false; }
          out.push(okParse ? (issues.length ? { ...at, value, issues } : { ...at, value }) : { ...at, error: 'Malformed JSON in array element' });
        }
        pieces = []; seg = -1; oversize = false;
      }
    }
    if (depth > 0 && seg >= 0 && !oversize) {
      const tail = chunk.slice(seg);
      elementChars += tail.length;
      if (elementChars > limits.maxElementBytes) { oversize = true; pieces = []; } else pieces.push(tail);
    }
  };

  const badByte = (offset: number) => {
    const msg = `Invalid UTF-8 at byte ${offset} (replaced with U+FFFD)`;
    if (!started || depth === 0) throw new JsonStreamError(msg, offset);
    issues.push(msg);
    feed('�', offset);
  };

  let consumed = 0;
  for await (const raw of src) {
    const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
    const data = carry.length ? Buffer.concat([carry, buf]) : buf;
    const base = carry.length ? carryOffset : consumed;
    const { pieces: ps, tail } = scanUtf8(data);
    try {
      for (const p of ps) {
        if ('bad' in p) badByte(base + p.bad); else feed(data.toString('utf8', p.s, p.e), base + p.s);
      }
    } catch (e) {
      yield* out.splice(0); // never drop elements completed before a fatal error
      throw e;
    }
    carry = Buffer.from(data.subarray(tail));
    carryOffset = base + tail;
    consumed += buf.length;
    yield* out.splice(0);
  }
  if (carry.length) badByte(carryOffset);
  yield* out.splice(0);
  if (!started) throw new JsonStreamError('Empty input: no JSON array found', consumed);
  if (!done) throw new JsonStreamError(`Unexpected end of input: JSON array is truncated after ${index} complete element(s)`, consumed);
}
