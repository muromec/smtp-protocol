// ── what the parser has to read, and what it does not ──────────────────────
//
// A general-purpose MIME parser reads every byte of a message, payload included,
// at about 1.5 s per megabyte and up (docs/parsing.md): eight megabytes of
// attachment holds the caller's event loop for tens of seconds, which is how a
// consumer that owes a keepalive loses its connection.
//
// The bytes do not have to pass through it.  This module walks the structure of
// a message as octets — the header/body split, a Content-Type with a boundary,
// the parts between boundaries — and hands back the same message with the heavy
// payloads taken out of it, plus those payloads decoded here in bulk.  What the
// parser then reads is the structure and the text: the part it is good at, and
// the part that is small.

import { decodeWords } from 'postal-mime';

/** A leaf payload taken out of what the parser reads. */
export interface HeavyPart {
  /** The MIME type the part declared. */
  mime: string;
  /** The name the part declared, decoded; empty when it declared none. */
  name: string;
  /** True for a body rather than an attachment: text/plain or text/html that
   *  does not say `Content-Disposition: attachment`. */
  text: boolean;
  /** The charset a text part declared, lowercased; empty when it declared none. */
  charset: string;
  /** The payload, decoded from its transfer encoding. */
  bytes: Uint8Array;
}

/** One leaf of a message, in the order the parts appear in it. */
export type LeafPlan =
  | { kind: 'kept'; body: boolean }
  | { kind: 'heavy'; part: HeavyPart };

export interface SplitMessage {
  /** The message to parse: the same headers and structure, less the payloads. */
  forParser: Uint8Array;
  /** Every leaf of the message in order: which the parser will see, and which
   *  it will not. */
  leaves: LeafPlan[];
}

/**
 * A payload at or above this many octets is taken out of the parse.  The parser
 * costs about 1.5 ms per KB, so this is roughly where reading a payload starts
 * to cost more than walking around it.
 */
export const HEAVY_LIMIT = 64 * 1024;

/**
 * The message the parser should read, and the payloads it should not.
 *
 * A message at or below the limit is returned untouched: ordinary mail keeps
 * exactly the path it took before this module existed.
 */
export function splitForParse(message: Uint8Array, limit = HEAVY_LIMIT): SplitMessage {
  if (message.length <= limit) return { forParser: message, leaves: [{ kind: 'kept', body: true }] };

  const leaves: LeafPlan[] = [];
  const root = readNode(message, 0);
  const kept = rebuild(root, limit, leaves);
  // The root itself can be the payload (a single-part message): its headers
  // still have to reach the parser, so the body is left empty rather than the
  // whole message dropped.
  const forParser = kept ?? Buffer.concat([root.headerBytes, CRLF, CRLF]);

  return { forParser, leaves };
}

// ── the walk ────────────────────────────────────────────────────────────────

interface Node {
  readonly header: Map<string, string>;
  readonly headerBytes: Uint8Array;
  readonly type: string;
  readonly params: Map<string, string>;
  readonly encoding: string;
  readonly disposition: string;
  readonly payload: Uint8Array;
  readonly children: Node[];
}

const MAX_DEPTH = 10;

function readNode(bytes: Uint8Array, depth: number): Node {
  const { header, body } = splitHeaders(bytes);
  const map = readHeaderMap(header);
  const { type, params } = parseContentType(map.get('content-type'), 'text/plain');
  const encoding = (map.get('content-transfer-encoding') ?? '').trim().toLowerCase();
  const disposition = (map.get('content-disposition') ?? '').trim().toLowerCase();
  const boundary = params.get('boundary');

  const children: Node[] = [];
  let payload = body;
  if (depth < MAX_DEPTH && type.startsWith('multipart/') && boundary) {
    payload = new Uint8Array(0);
    for (const raw of splitParts(body, boundary)) children.push(readNode(raw, depth + 1));
  }

  return { header: map, headerBytes: header, type, params, encoding, disposition, payload, children };
}

/**
 * The message with every payload at or above the limit replaced by nothing.  A
 * null return means this node *was* a payload, and it is in `heavy` now.
 */
/**
 * The message with every payload at or above the limit replaced by nothing, and
 * the leaves of the message in order.  A null return means this node *was* a
 * payload: the parser will not see it.
 */
function rebuild(node: Node, limit: number, leaves: LeafPlan[]): Uint8Array | null {
  if (node.children.length === 0) {
    if (node.payload.length < limit) {
      leaves.push({ kind: 'kept', body: isBody(node) });
      return Buffer.concat([node.headerBytes, CRLF, CRLF, node.payload]);
    }
    leaves.push({ kind: 'heavy', part: heavyPartOf(node) });
    return null;
  }

  const parts: Uint8Array[] = [];
  for (const child of node.children) {
    const kept = rebuild(child, limit, leaves);
    if (kept) parts.push(kept);
  }

  const boundary = node.params.get('boundary') ?? '';
  const pieces: Uint8Array[] = [node.headerBytes, CRLF, CRLF];
  for (const part of parts) {
    pieces.push(bytes(`--${boundary}\r\n`), part, CRLF);
  }
  pieces.push(bytes(`--${boundary}--\r\n`));

  return Buffer.concat(pieces);
}

function heavyPartOf(node: Node): HeavyPart {
  return {
    mime: node.type || 'application/octet-stream',
    name: partName(node),
    text: isBody(node),
    charset: (node.params.get('charset') ?? '').toLowerCase(),
    bytes: decodeTransfer(node.payload, node.encoding),
  };
}

/** The parser's own rule: an attachment disposition wins over the type, and only
 *  text/plain and text/html are bodies. */
function isBody(node: Node): boolean {
  if (node.disposition.startsWith('attachment')) return false;
  return node.type === 'text/plain' || node.type === 'text/html';
}

/** The name a part declares: `filename` first, then `name`, decoded. */
function partName(node: Node): string {
  const disposition = parseContentType(node.header.get('content-disposition'), '');
  const raw = disposition.params.get('filename') ?? node.params.get('name') ?? '';
  return raw ? decodeWords(raw) : '';
}

// ── headers and parts ───────────────────────────────────────────────────────

/** The header block and the body, split at the first blank line. */
export function splitHeaders(bytes: Uint8Array): { header: Uint8Array; body: Uint8Array } {
  const at = buffer(bytes);
  const crlf = at.indexOf('\r\n\r\n');
  const lf = at.indexOf('\n\n');

  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    return { header: bytes.subarray(0, crlf), body: bytes.subarray(crlf + 4) };
  }
  if (lf >= 0) {
    const end = at[lf - 1] === 0x0d ? lf - 1 : lf;
    return { header: bytes.subarray(0, end), body: bytes.subarray(lf + 2) };
  }
  return { header: bytes, body: new Uint8Array(0) };
}

/** Header values by lowercase name, unfolded.  The first occurrence wins. */
export function readHeaderMap(headerBytes: Uint8Array): Map<string, string> {
  const map = new Map<string, string>();
  let key: string | null = null;

  for (const rawLine of buffer(headerBytes).toString('latin1').split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    if (/^[ \t]/.test(line)) {
      if (key) map.set(key, `${map.get(key) ?? ''} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    key = line.slice(0, colon).trim().toLowerCase();
    if (!map.has(key)) map.set(key, line.slice(colon + 1).trim());
  }

  return map;
}

/** `type/subtype` lowercased with its parameters; an empty value gives `fallback`. */
export function parseContentType(
  value: string | undefined,
  fallback = '',
): { type: string; params: Map<string, string> } {
  const params = new Map<string, string>();
  if (!value) return { type: fallback, params };

  const [head, ...rest] = splitParameters(value);
  const type = head.trim().toLowerCase() || fallback;

  for (const piece of rest) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim().toLowerCase();
    if (!name) continue;

    let raw = piece.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\(.)/g, '$1');
    }

    const extended = name.endsWith('*'); // filename*=UTF-8''%E2%82%AC
    const key = extended ? name.slice(0, -1) : name;
    if (params.has(key)) continue;
    params.set(key, extended ? decodeExtendedParameter(raw) : raw);
  }

  return { type, params };
}

/** Split on ';' outside a quoted string, so a boundary containing one survives. */
function splitParameters(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '"') quoted = !quoted;
    if (c === '\\' && quoted && i + 1 < value.length) {
      current += c + value[++i];
      continue;
    }
    if (c === ';' && !quoted) {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }

  out.push(current);
  return out;
}

/** `UTF-8''%E2%82%AC` gives `€`; a value not in that form is left alone. */
function decodeExtendedParameter(raw: string): string {
  const match = /^([\w-]+)'([\w-]*)'(.*)$/.exec(raw);
  if (!match) return raw;
  return decodeText(percentToBytes(match[3] ?? ''), match[1] ?? 'utf-8');
}

/** `%E2%82%AC` is octets, not characters: the escapes become bytes first, and
 *  the charset then says what the bytes mean. */
function percentToBytes(value: string): Uint8Array {
  const out = Buffer.allocUnsafe(value.length);
  let n = 0;

  for (let i = 0; i < value.length; i++) {
    const hex = value.slice(i + 1, i + 3);
    if (value[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      out[n++] = Number.parseInt(hex, 16);
      i += 2;
      continue;
    }
    out[n++] = value.charCodeAt(i) & 0xff;
  }

  return buffer(out.subarray(0, n));
}

/**
 * The parts between `--boundary` lines, payloads only: the delimiter, the line
 * it sits on and the CRLF before the next one are framing, not part of a part.
 */
export function splitParts(body: Uint8Array, boundary: string): Uint8Array[] {
  const at = buffer(body);
  const delimiter = buffer(bytes(`--${boundary}`));
  const parts: Uint8Array[] = [];
  let from = 0;

  while (from < body.length) {
    const found = nextDelimiter(at, delimiter, from);
    if (found < 0) break;

    let start = found + delimiter.length;
    if (at[start] === 0x2d && at[start + 1] === 0x2d) break; // --boundary--
    while (start < body.length && at[start] !== 0x0a) start++;
    start++;

    const next = nextDelimiter(at, delimiter, start);
    let end = next < 0 ? body.length : next;
    if (end >= 2 && at[end - 2] === 0x0d && at[end - 1] === 0x0a) end -= 2;
    else if (end >= 1 && at[end - 1] === 0x0a) end -= 1;

    parts.push(body.subarray(start, Math.max(start, end)));
    if (next < 0) break;
    from = next;
  }

  return parts;
}

function nextDelimiter(body: Buffer, delimiter: Buffer, from: number): number {
  let at = body.indexOf(delimiter, from);
  while (at >= 0) {
    if (isDelimiterAt(body, at, delimiter.length)) return at;
    at = body.indexOf(delimiter, at + 1);
  }
  return -1;
}

/** A delimiter is a whole line: one starts at it, and it ends the line. */
function isDelimiterAt(body: Buffer, at: number, length: number): boolean {
  if (at !== 0 && body[at - 1] !== 0x0a) return false;
  const after = body[at + length];
  if (after === 0x0d && body[at + length + 1] === 0x0a) return true;
  if (after === 0x0a) return true;
  return after === 0x2d && body[at + length + 1] === 0x2d;
}

// ── decoding ────────────────────────────────────────────────────────────────

/** The payload as bytes: base64 and quoted-printable undo their encoding, and
 *  every other encoding is already what it says it is. */
export function decodeTransfer(payload: Uint8Array, encoding: string): Uint8Array {
  switch (encoding) {
    case 'base64':
      // The decoder skips line breaks itself, and a line break is all that
      // wrapping a base64 payload adds.
      return buffer(Buffer.from(buffer(payload).toString('latin1'), 'base64'));
    case 'quoted-printable':
      return decodeQuotedPrintable(payload);
    default:
      return payload;
  }
}

/** `=E2=82=AC` is a byte, `=\r\n` is nothing, and a lone `=` stays. */
export function decodeQuotedPrintable(payload: Uint8Array): Uint8Array {
  const text = buffer(payload).toString('latin1');
  const out = Buffer.allocUnsafe(text.length);
  let n = 0;

  for (let i = 0; i < text.length; i++) {
    const byte = text.charCodeAt(i);
    if (byte !== 0x3d) {
      out[n++] = byte;
      continue;
    }
    if (text[i + 1] === '\r' && text[i + 2] === '\n') {
      i += 2;
      continue;
    }
    if (text[i + 1] === '\n') {
      i += 1;
      continue;
    }
    const hex = text.slice(i + 1, i + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out[n++] = Number.parseInt(hex, 16);
      i += 2;
      continue;
    }
    out[n++] = byte;
  }

  return buffer(out.subarray(0, n));
}

/** Bytes as text in the charset they declare.  An unknown label falls back to
 *  UTF-8 rather than refusing the message. */
export function decodeText(input: Uint8Array, charset = ''): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(input);
  } catch {
    return new TextDecoder('utf-8').decode(input);
  }
}

/** The text a body part holds, with the line endings a reader expects. */
export function textOf(part: HeavyPart): string {
  return decodeText(part.bytes, part.charset).replace(/\r\n/g, '\n');
}

// ── octets ──────────────────────────────────────────────────────────────────

/** Latin-1 bytes, which is what a header, a boundary and base64 are. */
function bytes(text: string): Uint8Array {
  return buffer(Buffer.from(text, 'latin1'));
}

/** A view over the same memory as a Buffer, so the native searches apply.  A
 *  Buffer already is one. */
function buffer(input: Uint8Array): Buffer {
  if (Buffer.isBuffer(input)) return input;
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

const CRLF = bytes('\r\n');
