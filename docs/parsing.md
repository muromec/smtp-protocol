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

And on a real one: a message from the mailbox with an 8.83 MB photo in it,
fetched read-only (`BODY.PEEK[]`) and parsed both ways in the same process:

| | |
|---|---|
| postal-mime on the whole message | 24 732 ms |
| `fromFetched`, the walk | 149 ms |
| text, html, attachment name and type | identical |
| attachment bytes | 6 763 595 |

That is 166× faster, and the loop is never held: 149 ms is a single scan's worth
of work rather than twenty-five seconds of it.

A sweep over one message shape at eight sizes, both ways, in this process (the
parser warmed first, so its own setup is not counted):

| payload | message | plain | walk |
|---|---|---|---|
| 8 KB | 0.01 MB | 40 ms | 39 ms |
| 32 KB | 0.04 MB | 122 ms | 123 ms |
| 64 KB | 0.09 MB | 241 ms | 15 ms |
| 128 KB | 0.17 MB | 477 ms | 6 ms |
| 256 KB | 0.34 MB | 953 ms | 8 ms |
| 512 KB | 0.68 MB | 1 949 ms | 11 ms |
| 1 MB | 1.37 MB | 3 988 ms | 47 ms |
| 4 MB | 5.47 MB | 15 794 ms | 89 ms |

The first two rows are the same path: the message is under the limit, so it went
to the parser untouched.  From 64 KB up the walk costs single-digit milliseconds
where the parser costs hundreds — and the walk's own overhead is small enough
that the limit is **not** a performance line.  It is the line below which
ordinary mail is left exactly as it was, which is why it stays at 64 KB: the walk
is our code and the parser is not, and a message small enough to parse in a
quarter of a second does not need to take that risk.

## What it does not do

- It does not change what a message means; the corpus test parses each fixture
  both ways and compares text, html, attachment names, types and bytes.
- No streaming: the message is in memory, as it is today.
- No move off the process.  A copy over a local socket costs about 10 ms for
  6.8 MB, so size is not the objection to it — it makes a transport depend on
  another process being up, and it only pays while the payload fits in memory
  anyway.

## The dependency's own cost, and what a fork would buy

A CPU profile of one 2 MB message (`bun --cpu-prof`) puts three quarters of the
parse in three places, each small enough to name:

| | self time | what it is |
|---|---|---|
| `readLine` (`postal-mime.js:171`) | ~50% | one JS iteration per byte, looking for the line end |
| `decodeBase64` (`decode-strings.js:31`) | ~25% | a hand-written base-64 loop, four characters at a time |
| `/[^a-zA-Z0-9+/]+/g` | ~4% | stripping whitespace before decoding |

Both loops have native replacements: `av.indexOf(0x0a, pos)` for the line, and
`Buffer.from(str, 'base64')` — which skips line breaks itself — for the decode.
A copy of the package with exactly those two changes, parsing the same bytes:

| message | published | two loops made native |
|---|---|---|
| synthetic 2 MB | 7 836 ms | 1 495 ms (5.2×) |
| a real 6.78 MB photo | 26 103 ms | 4 927 ms (5.3×) |

So a fork is a 5× win that still holds the loop for five seconds: the remaining
fifth is the state machine and boundary handling, still per-byte, and would need
a pass of its own.  It is worth doing on its own merits — it makes the parser
faster for everything it reads, the header block this walk still hands it
included — but it is not the fix for a payload.  The walk is, and this is the
number that says so.
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
- The limit (64 KB) is measured rather than guessed (see the sweep above): the
  walk is cheaper from a few KB up, so keeping it where it is is a choice about
  exposure, not about speed.

## Order of work

1. ~~`docs/parsing.md`~~ — written first, as the series' first commit.
2. ~~`src/mime.ts`, tested against postal-mime on a corpus~~ — done.
3. ~~`fromFetched` uses it, the existing suite green~~ — done.
4. ~~Measured on a real message~~ — done: 24 732 ms to 149 ms, same text,
   html, attachment name, type and bytes.
