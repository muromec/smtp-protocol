import PostalMime from 'postal-mime';

// ── types ──────────────────────────────────────────────────────────────────

export interface EmailHeaders {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  from?: { address?: string; name?: string };
  to?: { address?: string; name?: string }[];
  subject?: string;
  date?: Date;
  contentType?: string;
}

/** A part of a message that is not its text body: what the sender called it, and its bytes. */
export interface EmailAttachment {
  /** The filename as sent; empty when the part carries none. */
  name: string;
  mime: string;
  bytes: Uint8Array;
}

// ── EmailMessage ───────────────────────────────────────────────────────────

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

export interface OutgoingEmail {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  /** Auto-generated from `from` domain if omitted. */
  messageId?: string;
}

/**
 * Wraps an email message with parsed headers and body, plus a
 * selective logging representation that omits noisy transport headers
 * (Received, ARC, DKIM, spam verdicts, etc.).
 *
 * Two construction paths:
 *   - Inbound:  `await EmailMessage.fromFetched(body, uid?)` — parses raw RFC822.
 *   - Outbound: `EmailMessage.compose({...})` — builds from fields.
 *
 * Use `fromFetched` for inbound messages (async parse).
 */
export class EmailMessage {
  readonly uid: number;
  readonly raw: string;
  readonly outbound: boolean;
  #parsed: Parsed | null = null;
  #parsePromise: Promise<Parsed> | null = null;
  #outboundHeaders: EmailHeaders;
  #outboundText: string;

  private constructor() {
    this.uid = 0;
    this.raw = '';
    this.outbound = false;
    this.#outboundHeaders = {} as EmailHeaders;
    this.#outboundText = '';
  }

  /**
   * Create an EmailMessage from a raw RFC822 message body.
   * Parsing runs asynchronously; accessors will throw if called
   * before the returned promise resolves.
   *
   * @param body  The raw RFC822 message text.
   * @param uid   Optional IMAP UID (defaults to 0 when not applicable).
   */
  static async fromFetched(body: string, uid?: number): Promise<EmailMessage> {
    const self = new EmailMessage();
    (self as { uid: number }).uid = uid ?? 0;
    (self as { raw: string }).raw = body;
    self.#parsePromise = PostalMime.parse(body);
    self.#parsed = await self.#parsePromise;
    return self;
  }

  /**
   * Create an outgoing email message from structured fields.
   * A Message-ID is generated automatically from the `from` domain
   * unless `opts.messageId` is explicitly provided.
   * The `uid` is set to 0 (not applicable).
   */
  static compose(opts: OutgoingEmail): EmailMessage {
    const domain = opts.from.split('@')[1] ?? 'localhost';
    const messageId = opts.messageId ?? `<${crypto.randomUUID()}@${domain}>`;

    const msg = new EmailMessage();
    (msg as { uid: number }).uid = 0;
    (msg as { outbound: boolean }).outbound = true;
    msg.#outboundHeaders = {
      from: { address: opts.from, name: opts.fromName ?? '' },
      to: [{ address: opts.to, name: '' }],
      subject: opts.subject,
      messageId,
      inReplyTo: opts.inReplyTo,
      references: opts.references ?? [],
      date: new Date(),
    };
    msg.#outboundText = opts.text;
    (msg as { raw: string }).raw = msg.toRfc822();
    return msg;
  }

  /**
   * Serialize to a full RFC822 message suitable for SMTP submission.
   */
  toRfc822(): string {
    const h = this.headers;
    const headers = [
      'MIME-Version: 1.0',
      'User-Agent: Mozilla Thunderbird',
      'Content-Language: en-US',
      h.messageId ? `Message-ID: ${h.messageId}` : '',
      h.inReplyTo ? `In-Reply-To: ${h.inReplyTo}` : '',
      `References: ${h.references.join(' ')}`,
      `To: ${h.to?.map((t) => (t.name ? `${t.name} <${t.address ?? ''}>` : (t.address ?? ''))).join(', ') ?? ''}`,
      `From: ${h.from?.name ? `${h.from.name} <${h.from.address ?? ''}>` : (h.from?.address ?? '')}`,
      `Subject: ${h.subject ?? ''}`,
      `Date: ${(h.date ?? new Date()).toUTCString()}`,
      'Content-Type: text/plain; charset=UTF-8; format=flowed',
      'Content-Transfer-Encoding: 7bit',
    ]
      .filter(Boolean)
      .join('\r\n');

    return `${headers}\r\n\r\n${this.text}`;
  }

  // ── headers ────────────────────────────────────────────────────────────

  get headers(): EmailHeaders {
    if (this.outbound) return this.#outboundHeaders;
    const p = this.#parsed!;
    return {
      messageId: p.messageId,
      inReplyTo: p.inReplyTo,
      references: p.references ? p.references.split(/\s+/) : [],
      from: p.from,
      to: p.to,
      subject: p.subject,
      date: p.date ? new Date(p.date) : undefined,
      contentType: p.headers?.find((h) => h.key === 'content-type')?.value,
    };
  }

  /**
   * Parsed `from` address, or `undefined`.
   */
  get from(): string | undefined {
    return this.headers.from?.address;
  }

  /**
   * Build a reply to this message.  Pre-fills In-Reply-To and
   * References from this message's headers.  A Message-ID is
   * auto-generated unless `opts.messageId` is provided.
   */
  reply(opts: Omit<OutgoingEmail, 'inReplyTo' | 'references'>): EmailMessage {
    const h = this.headers;
    const refs = [...h.references];
    if (h.messageId && !refs.includes(h.messageId)) refs.push(h.messageId);
    return EmailMessage.compose({
      ...opts,
      inReplyTo: h.messageId,
      references: refs,
    });
  }

  /**
   * Plain-text body, trimmed.
   */
  get text(): string {
    if (this.outbound) return this.#outboundText;
    return (this.#parsed!.text ?? '').trim();
  }

  /**
   * HTML body, if present.
   */
  get html(): string | undefined {
    return this.#parsed?.html ?? undefined;
  }

  /**
   * The parts of this message that are not its text body, in the order they arrive.
   *
   * Every part the parser found is here, an image the html refers to included: which of
   * them count as files is the caller's question, not this one's.
   */
  get attachments(): EmailAttachment[] {
    if (this.outbound) return [];
    return (this.#parsed?.attachments ?? []).map((part) => ({
      name: part.filename ?? '',
      mime: part.mimeType,
      bytes: toBytes(part.content),
    }));
  }

  // ── logging ─────────────────────────────────────────────────────────────

  /**
   * Compact representation for logging: omits noisy transport headers
   * (Received, ARC-*, DKIM-*, X-KPN-*, X-CMAE-*, X-CMASSUN, X-Google-*,
   * X-Gm-*, X-Received, etc.) but keeps From, Subject, Message-ID,
   * In-Reply-To, References, Date, Content-Type, and the body.
   */
  get logString(): string {
    const h = this.headers;
    const lines: string[] = [];

    if (h.from)
      lines.push(
        `From: ${h.from.name ? `${h.from.name} <${h.from.address ?? ''}>` : (h.from.address ?? '')}`,
      );
    if (h.to?.length) {
      lines.push(
        `To: ${h.to.map((t) => (t.name ? `${t.name} <${t.address ?? ''}>` : (t.address ?? ''))).join(', ')}`,
      );
    }
    if (h.subject) lines.push(`Subject: ${h.subject}`);
    if (h.date) lines.push(`Date: ${h.date.toISOString()}`);
    if (h.messageId) lines.push(`Message-ID: ${h.messageId}`);
    if (h.inReplyTo) lines.push(`In-Reply-To: ${h.inReplyTo}`);
    if (h.references.length) lines.push(`References: ${h.references.join(' ')}`);
    if (h.contentType) lines.push(`Content-Type: ${h.contentType}`);

    if (this.text) {
      lines.push('');
      lines.push(this.text);
    }

    return lines.join('\n');
  }

  /**
   * Full raw message (inbound) or RFC822 serialization (outbound).
   */
  toString(): string {
    return this.outbound ? this.toRfc822() : this.raw;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** The bytes of a parsed part, in whichever shape the parser handed them back. */
function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}
