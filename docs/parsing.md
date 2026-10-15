# Parsing a fetched message

Status: **built** 2026-10-15 (`src/mime.ts`, `src/message.ts`).  A message at or
below 64 KB takes exactly the path it took before this existed: it goes to
postal-mime as one buffer.  A larger one is walked as octets first, and the
payloads too big to be worth scanning are decoded here and put back afterwards.

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

`Buffer.from(..., 'base64')` skips the line breaks itself and returns bytes
identical to the source, so nothing has to be stripped first.

## As built

`splitForParse(message, limit)` walks the message (`mime.ts`) and returns:

- `forParser` — the same headers and the same structure, with every payload at or
  above the limit replaced by nothing;
- `leaves` — every leaf of the message in the order it appears: `kept` (the
  parser will see it, and `body` says whether it is a text body) or `heavy` (the
  parser will not, and the payload is decoded here — base64 in bulk,
  quoted-printable by hand, 7-bit / 8-bit / binary as they are).

`EmailMessage.fromFetched` then parses `forParser` and stitches: a heavy leaf
that is a body becomes `text`/`html`, a heavy leaf that is not becomes an
attachment, and each kept non-body leaf takes the next attachment the parser
reported.  The rules the parser uses are the ones mirrored here — an
`attachment` disposition wins over the type, and only `text/plain` and
`text/html` are bodies.

Two things send the message to the parser whole instead, with a line on stderr
naming it: a heavy body beside a body the parser did read (the order between them
is not something the stitch can reconstruct), and a walk whose leaf count does
not match what the parser reported.

Measured through the class, a 2 MB attachment:

| | before | after |
|---|---|---|
| parse | > 5 s (the runner's own timeout) | 203 ms |

## What it does not do

- It does not change what a message means; the corpus test parses each fixture
  both ways and compares text, html, attachment names, types and bytes.
- No streaming: the message is in memory, as it is today.
- No move off the process.  A copy over a local socket costs about 10 ms for
  6.8 MB, so size is not the objection to it — it makes a transport depend on
  another process being up, and it only pays while the payload fits in memory
  anyway.

## Open

- **Quoted-printable is the one place the two readings differ.**  Postal-mime
  reads a QP payload as text: it normalises CRLF to LF and appends a newline (a
  1024-byte payload comes back as 1025).  This walker returns the octets the
  sender encoded, one shorter for such a part.  The corpus test states the
  difference rather than hiding it.
- `filename*=UTF-8''...` (RFC 2231) is handled for the single-value form the
  corpus uses; a continuation (`filename*0*`) is not.
- A part that is itself a message (`message/rfc822`) is treated as a leaf, where
  postal-mime would parse it inline.
- The limit (64 KB) is a first estimate: the parser costs about 1.5 ms per KB, so
  it is worth re-measuring the stitch's own cost before moving it.

## Order of work

1. ~~`docs/parsing.md`~~ — written first, as the series' first commit.
2. ~~`src/mime.ts`, tested against postal-mime on a corpus~~ — done.
3. ~~`fromFetched` uses it, the existing suite green~~ — done.
4. Measured on a real message.
