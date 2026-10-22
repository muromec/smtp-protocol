// ── outgoing attachments, and the type of a file ────────────────────────────
//
// The other half of parsing them: a message composed here can carry files, and the type of a
// file the caller names but does not classify is inferred from its name.  Each case is checked
// by parsing what was composed with this library's own parser, so the round trip is the test.

import { describe, expect, it } from 'vitest';
import { EmailMessage } from '../src/message.ts';
import { mimeTypeOf } from '../src/media-type.ts';

const bytes = new TextEncoder().encode('PNG-ISH BYTES, not a real image');

describe('mimeTypeOf', () => {
  it('names the type of a file from its extension, whatever its case', () => {
    expect(mimeTypeOf('photo.jpg')).toBe('image/jpeg');
    expect(mimeTypeOf('PHOTO.JPEG')).toBe('image/jpeg');
    expect(mimeTypeOf('shot.png')).toBe('image/png');
    expect(mimeTypeOf('notes.pdf')).toBe('application/pdf');
    expect(mimeTypeOf('data.json')).toBe('application/json');
    expect(mimeTypeOf('readme.md')).toBe('text/markdown');
  });

  it('answers octet-stream for a name it does not know', () => {
    expect(mimeTypeOf('mystery.zzz')).toBe('application/octet-stream');
    expect(mimeTypeOf('no-extension')).toBe('application/octet-stream');
  });
});

describe('composing with attachments', () => {
  it('carries a file as a base64 part, and the parser finds it again', async () => {
    const composed = EmailMessage.compose({
      from: 'me@example.org',
      to: 'you@example.org',
      subject: 'with a picture',
      text: 'see attached',
      attachments: [{ name: 'shot.png', bytes }],
    });

    const raw = composed.toRfc822();
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('Content-Disposition: attachment; filename="shot.png"');
    expect(raw).toContain('Content-Type: image/png');

    const parsed = await EmailMessage.fromFetched(raw);
    expect(parsed.text.trim()).toBe('see attached');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.name).toBe('shot.png');
    expect(parsed.attachments[0]?.mime).toBe('image/png');
    expect([...(parsed.attachments[0]?.bytes ?? [])]).toEqual([...bytes]);
  });

  it('takes the type the caller names over the one its name suggests', async () => {
    const composed = EmailMessage.compose({
      from: 'me@example.org',
      to: 'you@example.org',
      subject: 'typed',
      text: 'body',
      attachments: [{ name: 'thing.bin', mime: 'application/vnd.acme.receipt', bytes }],
    });

    const parsed = await EmailMessage.fromFetched(composed.toRfc822());
    expect(parsed.attachments[0]?.mime).toBe('application/vnd.acme.receipt');
  });

  it('sends a name outside ASCII so that it arrives as written', async () => {
    const composed = EmailMessage.compose({
      from: 'me@example.org',
      to: 'you@example.org',
      subject: 'naam',
      text: 'body',
      attachments: [{ name: 'factuur-çà.pdf', bytes }],
    });

    const parsed = await EmailMessage.fromFetched(composed.toRfc822());
    expect(parsed.attachments[0]?.name).toBe('factuur-çà.pdf');
  });

  it('stays a plain message when there is nothing to attach', () => {
    const composed = EmailMessage.compose({
      from: 'me@example.org',
      to: 'you@example.org',
      subject: 'plain',
      text: 'just words',
    });

    const raw = composed.toRfc822();
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8; format=flowed');
    expect(raw).not.toContain('multipart');
  });
});

describe('composing with an HTML body', () => {
  it('carries the HTML beside the text, and both arrive', async () => {
    const composed = EmailMessage.compose({
      from: 'me@example.org',
      to: 'you@example.org',
      subject: 'bold',
      text: '**bold**',
      html: '<strong>bold</strong>',
    });

    const raw = composed.toRfc822();
    expect(raw).toContain('multipart/alternative');

    const parsed = await EmailMessage.fromFetched(raw);
    expect(parsed.text.trim()).toBe('**bold**');
    expect(parsed.html).toContain('<strong>bold</strong>');
  });

  it('puts the alternative inside the mixed message when there are files too', async () => {
    const composed = EmailMessage.compose({
      from: 'me@example.org',
      to: 'you@example.org',
      subject: 'both',
      text: 'see attached',
      html: '<p>see attached</p>',
      attachments: [{ name: 'a.txt', bytes: new TextEncoder().encode('x') }],
    });

    const raw = composed.toRfc822();
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('multipart/alternative');

    const parsed = await EmailMessage.fromFetched(raw);
    expect(parsed.html).toContain('see attached');
    expect(parsed.attachments).toHaveLength(1);
  });

  it('sends no HTML when there is none — the plain shape is unchanged', async () => {
    const composed = EmailMessage.compose({
      from: 'me@example.org',
      to: 'you@example.org',
      subject: 'plain',
      text: 'just words',
    });
    expect(composed.toRfc822()).not.toContain('multipart');
  });
});
