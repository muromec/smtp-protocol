# Parsing a fetched message

Status: written 2026-10-15, **not implemented**.  `EmailMessage.fromFetched`
hands the whole message to postal-mime today.  That is correct for ordinary mail
and too slow for a message that carries megabytes of payload.

## The problem, measured

One message, one process, same box.  A 6.8 MB attachment is about 9.3 MB of
message:

| shape | parse | per MB |
|---|---|---|
| 7 MB text body | 11.0 s | 1571 ms |
| 6.8 MB attachment, base64, 76-char lines | 26.7 s | 2873 ms |
| 6.8 MB attachment, base64, one long line | 22.0 s | 2428 ms |
| 6.8 MB attachment, raw 8-bit — nothing to decode | 9.9 s | 1450 ms |

A 10 ms timer fired zero times during each of those runs: the process's loop is
held, not slowed.  A consumer that owes a keepalive every 15 s loses its
connection, and a consumer holding several connections loses all of them in the
same second.

The cost is the scan, not the encoding: a part with nothing to decode still costs
1.45 s/MB, and base64 adds about 1.4 s/MB on top of that.

## What the same bytes cost through native primitives

| operation | time |
|---|---|
| `buf.indexOf('\r\n\r\n')` over 9.3 MB | 0.0 ms |
| three `buf.indexOf(boundary)` over 9.3 MB | 0.7 ms |
| `Buffer.from(wrappedBase64, 'base64')` — 6.8 MB decoded, line breaks left in | 53.9 ms |
| `TextDecoder('utf-8')` over a 7 MB body | 17 ms |
| `Buffer.concat` of two 4.8 MB halves | 4 ms |

`Buffer.from(..., 'base64')` skips the line breaks itself and returns bytes
identical to the source, so nothing has to be stripped first.

## The shape

Split the message on bytes and decode with the platform's own decoders; keep the
parser for the part it is good at, and small.

1. Split the header block from the body at the first `\r\n\r\n` (`indexOf` over
   bytes).
2. The header block goes to postal-mime.  It is a few KB, and encoded words,
   folded headers and address parsing are what it should keep doing.
3. The body is walked as bytes.  A `Content-Type` carrying a `boundary` gives the
   parts (`indexOf`), and each part is split the same way: its headers to
   postal-mime, its payload decoded here — base64 in bulk, quoted-printable with
   a small decoder, 7-bit / 8-bit / binary as they are — and its text through
   `TextDecoder` with the charset its headers declare.
4. The result is the shape the class already builds from: headers, text, html,
   attachments (`name`, `mime`, `bytes`).

## What it does not do

- It does not change what a message *means*: a part is still text, html or an
  attachment by the same rules, and a message whose structure the walker does not
  recognise falls back to postal-mime for the whole message, with a log line
  naming what was not understood.
- No streaming: the message is in memory, as it is today.
- No move off the process.  A copy over a local socket costs about 10 ms for
  6.8 MB, so size is not the objection to it — it makes a transport depend on
  another process being up, and it only pays while the payload fits in memory
  anyway.  If a message ever gets big enough that memory rather than time binds,
  that trade is worth deciding from a number.

## Open

- `filename*=UTF-8''...` (RFC 2231) in a part's `Content-Disposition`.  Postal-mime
  handles it; a walker that reads the parameter itself has to handle it too.
- A part that is itself a message (`message/rfc822`).
- Whether the fallback is one log line per occurrence or a counter.

## Order of work

1. `src/mime.ts` — the walker, with tests that compare it against postal-mime on
   a corpus (plain, html, alternative, mixed, base64, quoted-printable, a charset
   that is not UTF-8, nested multipart, and a body whose declared boundary never
   appears), plus one coarse time bound that names the regression it guards.
2. `fromFetched` uses it, and the existing suite stays green.
3. Measured on a real message.
