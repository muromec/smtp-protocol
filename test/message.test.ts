// Unit tests for EmailMessage — parsing, composing, and serialization.

import { describe, it, expect } from 'vitest';
import { EmailMessage } from '../src/message.ts';

// ── helpers ────────────────────────────────────────────────────────────────

function rawMsg(headers: string[], body: string): string {
  return [...headers, '', body].join('\r\n');
}

// ── parsing (inbound) ──────────────────────────────────────────────────────

describe('EmailMessage parsing', () => {
  it('parses From address', async () => {
    const msg = await EmailMessage.fromFetched(
      rawMsg(
        [
          'From: Alice <alice@example.com>',
          'To: bob@example.com',
          'Subject: Hello',
          'Message-ID: <abc123@example.com>',
          'Date: Mon, 01 Jan 2025 12:00:00 +0000',
        ],
        'test body',
      ),
    );

    expect(msg.from).toBe('alice@example.com');
    expect(msg.headers.from).toEqual({
      address: 'alice@example.com',
      name: 'Alice',
    });
  });

  it('parses subject', async () => {
    const msg = await EmailMessage.fromFetched(
      rawMsg(['From: a@b.com', 'Subject: =?UTF-8?Q?Caf=C3=A9?='], ''),
    );
    expect(msg.headers.subject).toBe('Café');
  });

  it('parses In-Reply-To and References', async () => {
    const msg = await EmailMessage.fromFetched(
      rawMsg(
        [
          'From: a@b.com',
          'In-Reply-To: <reply@example.com>',
          'References: <root@example.com> <parent@example.com>',
          'Message-ID: <child@example.com>',
        ],
        'body',
      ),
    );

    expect(msg.headers.inReplyTo).toBe('<reply@example.com>');
    expect(msg.headers.references).toEqual(['<root@example.com>', '<parent@example.com>']);
    expect(msg.headers.messageId).toBe('<child@example.com>');
  });

  it('parses text body', async () => {
    const msg = await EmailMessage.fromFetched(rawMsg(['From: a@b.com'], '  hello world  \n\n'));
    expect(msg.text).toBe('hello world');
  });

  it('handles empty headers gracefully', async () => {
    const msg = await EmailMessage.fromFetched(rawMsg(['From: a@b.com'], ''));
    expect(msg.headers.inReplyTo).toBeUndefined();
    expect(msg.headers.references).toEqual([]);
    expect(msg.headers.messageId).toBeUndefined();
    expect(msg.text).toBe('');
  });

  it('parses Content-Type', async () => {
    const msg = await EmailMessage.fromFetched(
      rawMsg(['From: a@b.com', 'Content-Type: text/html; charset=UTF-8'], '<html></html>'),
    );
    expect(msg.headers.contentType).toBe('text/html; charset=UTF-8');
  });

  it('parses Date', async () => {
    const msg = await EmailMessage.fromFetched(
      rawMsg(['From: a@b.com', 'Date: Tue, 15 Jan 2025 10:30:00 +0100'], ''),
    );
    expect(msg.headers.date).toBeInstanceOf(Date);
    expect(msg.headers.date!.getUTCHours()).toBe(9); // +0100 → 09:30 UTC
  });
});

// ── composing (outbound) ───────────────────────────────────────────────────

describe('EmailMessage composing', () => {
  it('builds headers from OutgoingEmail fields', () => {
    const msg = EmailMessage.compose({
      from: 'bot@example.com',
      to: 'alice@example.com',
      subject: 'Re: Hello',
      text: 'response body',
      inReplyTo: '<inbound@example.com>',
      references: ['<root@example.com>', '<inbound@example.com>'],
    });

    expect(msg.uid).toBe(0);
    expect(msg.outbound).toBe(true);
    expect(msg.from).toBe('bot@example.com');
    expect(msg.headers.to).toEqual([{ address: 'alice@example.com', name: '' }]);
    expect(msg.headers.subject).toBe('Re: Hello');
    expect(msg.text).toBe('response body');
    expect(msg.headers.inReplyTo).toBe('<inbound@example.com>');
    expect(msg.headers.references).toEqual(['<root@example.com>', '<inbound@example.com>']);
    expect(msg.headers.messageId).toMatch(/^<[^>]+@example\.com>$/);
    expect(msg.headers.date).toBeInstanceOf(Date);
  });

  it('serializes to valid RFC822', () => {
    const msg = EmailMessage.compose({
      from: 'bot@example.com',
      to: 'alice@example.com',
      subject: 'Test',
      text: 'hello',
    });

    const rfc = msg.toRfc822();
    expect(rfc).toContain('From: bot@example.com');
    expect(rfc).toContain('To: alice@example.com');
    expect(rfc).toContain('Subject: Test');
    expect(rfc).toMatch(/Message-ID: <[^>]+@example\.com>/);
    expect(rfc).toContain('MIME-Version: 1.0');
    expect(rfc).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(rfc).toContain('\r\n\r\nhello');
  });

  it('includes In-Reply-To and References when provided', () => {
    const msg = EmailMessage.compose({
      from: 'bot@example.com',
      to: 'alice@example.com',
      subject: 'Re: Test',
      text: 'reply',
      inReplyTo: '<orig@example.com>',
      references: ['<root@example.com>', '<orig@example.com>'],
    });

    const rfc = msg.toRfc822();
    expect(rfc).toContain('In-Reply-To: <orig@example.com>');
    expect(rfc).toContain('References: <root@example.com> <orig@example.com>');
  });

  it('omits optional fields when not provided', () => {
    const msg = EmailMessage.compose({
      from: 'bot@example.com',
      to: 'alice@example.com',
      subject: 'No reply headers',
      text: 'body',
    });

    const rfc = msg.toRfc822();
    expect(rfc).not.toContain('In-Reply-To:');
    expect(rfc).toContain('References: ');
  });

  it('toString returns serialized RFC822 for outbound', () => {
    const msg = EmailMessage.compose({
      from: 'bot@example.com',
      to: 'alice@example.com',
      subject: 'Test',
      text: 'hello',
    });
    expect(msg.toString()).toBe(msg.toRfc822());
  });
});

// ── logString ──────────────────────────────────────────────────────────────

describe('EmailMessage.logString', () => {
  it('includes key headers and body, omits transport noise', async () => {
    const noisy = [
      'From: Alice <alice@example.com>',
      'To: bob@example.com',
      'Subject: Important',
      'Message-ID: <mid@example.com>',
      'In-Reply-To: <parent@example.com>',
      'References: <root@example.com> <parent@example.com>',
      'Date: Mon, 01 Jan 2025 12:00:00 +0000',
      'Content-Type: text/plain; charset=UTF-8',
      'Received: from mx1.example.com by mx2.example.com with ESMTP id 12345',
      'ARC-Seal: i=1; a=rsa-sha256; d=example.com; s=arc01; b=abc123...',
      'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=2025; b=xyz789...',
      'X-KPN-SpamVerdict: e1=0;White',
      'X-CMAE-Analysis: v=2.4 cv=Abc123 c=1 sm=1',
    ];
    const msg = await EmailMessage.fromFetched(rawMsg(noisy, 'body text'));

    const log = msg.logString;
    expect(log).toContain('From: Alice <alice@example.com>');
    expect(log).toContain('Subject: Important');
    expect(log).toContain('Message-ID: <mid@example.com>');
    expect(log).toContain('In-Reply-To: <parent@example.com>');
    expect(log).toContain('body text');

    // Transport noise omitted.
    expect(log).not.toContain('Received:');
    expect(log).not.toContain('ARC-Seal:');
    expect(log).not.toContain('DKIM-Signature:');
    expect(log).not.toContain('X-KPN-');
    expect(log).not.toContain('X-CMAE-');
  });

  it('handles missing optional headers', async () => {
    const msg = await EmailMessage.fromFetched(rawMsg(['From: a@b.com'], 'just body'));
    const log = msg.logString;

    expect(log).toContain('From: a@b.com');
    expect(log).toContain('just body');
    expect(log).not.toContain('Subject:');
    expect(log).not.toContain('In-Reply-To:');
  });

  it('works for outbound messages', () => {
    const msg = EmailMessage.compose({
      from: 'bot@example.com',
      to: 'alice@example.com',
      subject: 'Re: Test',
      text: 'outbound body',
    });

    const log = msg.logString;
    expect(log).toContain('From: bot@example.com');
    expect(log).toContain('Subject: Re: Test');
    expect(log).toContain('outbound body');
    expect(log).not.toContain('Received:');
  });
});

// ── toString ────────────────────────────────────────────────────────────────

describe('EmailMessage.toString', () => {
  it('returns raw RFC822 for inbound messages', async () => {
    const raw = rawMsg(['From: a@b.com', 'Subject: S'], 'body');
    const msg = await EmailMessage.fromFetched(raw);
    expect(msg.toString()).toBe(raw);
  });

  it('returns serialized RFC822 for outbound messages', () => {
    const msg = EmailMessage.compose({
      from: 'bot@example.com',
      to: 'alice@example.com',
      subject: 'Test',
      text: 'hello',
    });
    expect(msg.toString()).toBe(msg.toRfc822());
  });
});

// ── attachments ─────────────────────────────────────────────────────────────

describe('EmailMessage attachments', () => {
  const mixed = [
    'From: Alice <alice@example.com>',
    'To: bob@example.com',
    'Subject: Report',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIXED"',
    '',
    '--MIXED',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'please take a look',
    '--MIXED',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--MIXED--',
    '',
  ].join('\r\n');

  it('hands over an attached file with its name, type and bytes', async () => {
    const msg = await EmailMessage.fromFetched(mixed);

    expect(msg.text).toBe('please take a look');
    expect(msg.attachments).toHaveLength(1);

    const [file] = msg.attachments;
    expect(file.name).toBe('report.pdf');
    expect(file.mime).toBe('application/pdf');
    expect(new TextDecoder().decode(file.bytes)).toBe('%PDF-1.4\n');
  });

  it('keeps a part the body points at', async () => {
    // An image the html refers to by cid is still a part of the message; which
    // parts count as files is the caller's question, not this one's.
    const related = [
      'From: Alice <alice@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="REL"',
      '',
      '--REL',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>hi</p>',
      '--REL',
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: inline; filename="logo.png"',
      'Content-ID: <logo@example.com>',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--REL--',
      '',
    ].join('\r\n');

    const msg = await EmailMessage.fromFetched(related);
    expect(msg.attachments.map((file) => file.name)).toEqual(['logo.png']);

    const [file] = msg.attachments;
    expect(file.mime).toBe('image/png');
    expect(file.bytes.length).toBe(8);
    expect(file.bytes[0]).toBe(0x89);
  });

  it('has nothing to hand over when the message is one text body', async () => {
    const msg = await EmailMessage.fromFetched(rawMsg(['From: a@b.com'], 'hello'));
    expect(msg.attachments).toEqual([]);
  });

  it('has nothing to hand over on an outbound message', () => {
    const msg = EmailMessage.compose({
      from: 'bot@example.com',
      to: 'alice@example.com',
      subject: 'Test',
      text: 'hello',
    });
    expect(msg.attachments).toEqual([]);
  });
});

// ── a fetched body is bytes ────────────────────────────────────────────────
//
// IMAP hands a message over as octets.  A string that has already been decoded
// has lost whatever was not valid UTF-8, and the parser wants the octets so it
// can read the charset the message itself declares.

describe('a fetched body given as octets', () => {
  it('parses it the same as the text form', async () => {
    const raw = rawMsg(['From: a@b.com', 'Subject: S'], 'body');
    const fromText = await EmailMessage.fromFetched(raw);
    const fromOctets = await EmailMessage.fromFetched(new TextEncoder().encode(raw));

    expect(fromOctets.headers.subject).toBe(fromText.headers.subject);
    expect(fromOctets.text).toBe(fromText.text);
  });

  it('keeps the octets as given, and prints them as text', async () => {
    const octets = new TextEncoder().encode(rawMsg(['From: a@b.com', 'Subject: S'], 'body'));
    const msg = await EmailMessage.fromFetched(octets);

    expect(msg.raw).toBe(octets);
    expect(msg.toString()).toBe(new TextDecoder().decode(octets));
  });
});
