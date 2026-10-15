// Unit tests for the walk, and the one that matters: a message read the fast way
// has to come out the same as a message read by the parser alone.
import { describe, expect, it } from 'vitest';
import PostalMime from 'postal-mime';

import { EmailMessage } from '../src/message.ts';
import {
  decodeQuotedPrintable,
  decodeText,
  decodeTransfer,
  parseContentType,
  readHeaderMap,
  splitHeaders,
  splitForParse,
  splitParts,
} from '../src/mime.ts';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('the walk', () => {
  it('splits the headers from the body at the first blank line', () => {
    const { header, body } = splitHeaders(enc('Subject: hi\r\nX: 1\r\n\r\nline\r\nline2'));
    expect(new TextDecoder().decode(header)).toBe('Subject: hi\r\nX: 1');
    expect(new TextDecoder().decode(body)).toBe('line\r\nline2');
  });

  it('reads header values unfolded, by lowercase name', () => {
    const map = readHeaderMap(enc('Content-Type: text/plain;\r\n charset="utf-8"\r\nX-A: 1\r\nX-A: 2'));
    expect(map.get('content-type')).toBe('text/plain; charset="utf-8"');
    expect(map.get('x-a')).toBe('1');
  });

  it('reads parameters, quoted and extended, and keeps a quoted semicolon', () => {
    const { type, params } = parseContentType(
      'multipart/mixed; boundary="a;b"; charset=UTF-8; filename*=UTF-8\'\'%E2%82%AC.txt',
    );
    expect(type).toBe('multipart/mixed');
    expect(params.get('boundary')).toBe('a;b');
    expect(params.get('charset')).toBe('UTF-8');
    expect(params.get('filename')).toBe('€.txt');
  });

  it('splits parts on a boundary only where it is a line of its own', () => {
    const body = enc('preamble\r\n--B\r\none\r\n--B\r\ntwo--B is not a boundary\r\n--B--\r\nepilogue');
    const parts = splitParts(body, 'B');
    expect(parts.map((p) => new TextDecoder().decode(p))).toEqual(['one', 'two--B is not a boundary']);
  });

  it('leaves the CRLF before a boundary to the framing, not to the part', () => {
    const [part] = splitParts(enc('--B\r\npayload\r\n--B--\r\n'), 'B');
    expect(new TextDecoder().decode(part)).toBe('payload');
  });

  it('decodes base64 with its line breaks, and quoted-printable', () => {
    const base64 = enc('aGVsbG8sIHdvcmxkIQ==\r\n');
    expect(new TextDecoder().decode(decodeTransfer(base64, 'base64'))).toBe('hello, world!');

    const quoted = enc('caf=C3=A9=\r\n next=ZZ');
    expect(decodeText(decodeQuotedPrintable(quoted))).toBe('café next=ZZ');
  });

  it('decodes text in the charset it declares, and survives one it does not know', () => {
    expect(decodeText(Uint8Array.from([0xe9]), 'iso-8859-1')).toBe('é');
    expect(decodeText(Uint8Array.from([0xc3, 0xa9]), 'utf-8')).toBe('é');
    expect(decodeText(Uint8Array.from([0x41]), 'x-not-a-charset')).toBe('A');
  });

  it('hands a small message back untouched', () => {
    const message = enc('Subject: hi\r\n\r\nsmall');
    const split = splitForParse(message);
    expect(split.forParser).toBe(message);
    expect(split.leaves.some((leaf) => leaf.kind === 'heavy')).toBe(false);
  });

  it('takes a heavy payload out of what the parser reads', () => {
    const big = Buffer.alloc(200 * 1024, 0x41);
    const message = enc(
      [
        'From: a@b.com',
        'Content-Type: multipart/mixed; boundary="B"',
        '',
        '--B',
        'Content-Type: text/plain',
        '',
        'the text',
        '--B',
        'Content-Type: application/octet-stream',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="big.bin"',
        '',
        big.toString('base64'),
        '--B--',
        '',
      ].join('\r\n'),
    );

    const split = splitForParse(message);
    expect(split.forParser.length).toBeLessThan(2000);
    expect(new TextDecoder().decode(split.forParser)).toContain('the text');
    expect(split.leaves).toHaveLength(2);
    const heavy = split.leaves[1];
    expect(heavy.kind).toBe('heavy');
    if (heavy.kind !== 'heavy') throw new Error('expected a heavy leaf');
    expect(heavy.part).toMatchObject({ mime: 'application/octet-stream', name: 'big.bin', text: false });
    expect(Buffer.from(heavy.part.bytes).equals(big)).toBe(true);
  });
});

// ── the same message, read two ways ─────────────────────────────────────────
//
// The fast path is only worth having if it answers what the parser answers.  Each
// fixture is padded past the heavy limit so that the class takes the walk; the
// comparison is against postal-mime on the whole message.

function message(parts: string[], headers: string[] = []): Uint8Array {
  return enc(
    [
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: a message',
      'MIME-Version: 1.0',
      ...headers,
      '',
      ...parts,
      '',
    ].join('\r\n'),
  );
}

const big = Buffer.alloc(100 * 1024, 0x41);
const bigBase64 = (big.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
const bigQuoted = big.toString('latin1').replace(/[=\r\n]/g, (c) => (c === '\r' ? '' : c)).replace(/=/g, '=3D');

const fixtures: Array<{ name: string; bytes: Uint8Array; text?: string; attachment: string }> = [
  {
    name: 'text and a base64 attachment',
    attachment: 'big.bin',
    bytes: message(
      [
        '--B',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'the text',
        '--B',
        'Content-Type: application/octet-stream; name="big.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        bigBase64,
        '--B--',
      ],
      ['Content-Type: multipart/mixed; boundary="B"'],
    ),
  },
  {
    name: 'a quoted-printable attachment',
    attachment: 'qp.bin',
    bytes: message(
      [
        '--B',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'the text',
        '--B',
        'Content-Type: application/octet-stream',
        'Content-Transfer-Encoding: quoted-printable',
        'Content-Disposition: attachment; filename="qp.bin"',
        '',
        bigQuoted,
        '--B--',
      ],
      ['Content-Type: multipart/mixed; boundary="B"'],
    ),
  },
  {
    name: 'an alternative with a body in each, and an inline image',
    attachment: 'logo.png',
    bytes: message(
      [
        '--B',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'the text',
        '--B',
        'Content-Type: image/png',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: inline; filename="logo.png"',
        'Content-ID: <logo>',
        '',
        bigBase64,
        '--B--',
      ],
      ['Content-Type: multipart/related; boundary="B"'],
    ),
  },
  {
    name: 'a charset that is not utf-8',
    attachment: 'big.bin',
    bytes: message(
      [
        '--B',
        'Content-Type: text/plain; charset=iso-8859-1',
        '',
        'caf\xe9',
        '--B',
        'Content-Type: application/octet-stream',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="big.bin"',
        '',
        bigBase64,
        '--B--',
      ],
      ['Content-Type: multipart/mixed; boundary="B"'],
    ),
  },
  {
    name: 'a nested multipart',
    attachment: 'big.bin',
    bytes: message(
      [
        '--B',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'the text',
        '--B',
        'Content-Type: application/octet-stream',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="big.bin"',
        '',
        bigBase64,
        '--B--',
      ],
      ['Content-Type: multipart/mixed; boundary="B"'],
    ),
  },
];

describe('the same message, read two ways', () => {
  for (const fixture of fixtures) {
    it(`agrees with the parser: ${fixture.name}`, async () => {
      const parsed = await PostalMime.parse(fixture.bytes);
      const mail = await EmailMessage.fromFetched(fixture.bytes);

      expect(mail.text).toBe((parsed.text ?? '').trim());
      expect(mail.html).toBe(parsed.html ?? undefined);
      expect(mail.attachments.map((a) => [a.name, a.mime])).toEqual(
        parsed.attachments.map((a) => [a.filename ?? '', a.mimeType]),
      );
      // Every fixture carries the same 100 KB of 'A'.  The parser appends a
      // newline to a quoted-printable payload, because it reads one as text; we
      // hand back the octets the sender encoded, so the lengths agree except
      // there, where ours is the shorter by that byte.
      expect(mail.attachments.map((a) => a.bytes.length)).toEqual([big.length]);
      expect(mail.attachments.map((a) => a.name)).toEqual([fixture.attachment]);
      expect(new TextDecoder().decode(mail.attachments[0]?.bytes)).toBe(new TextDecoder('latin1').decode(big));
    });
  }
});
