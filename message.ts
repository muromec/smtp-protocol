import PostalMime from "postal-mime";
import type { FetchedMessage } from "imap-connector";

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

// ── EmailMessage ───────────────────────────────────────────────────────────

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

/**
 * Wraps a raw RFC822 message with parsed headers and body, plus a
 * selective logging representation that omits noisy transport headers
 * (Received, ARC, DKIM, spam verdicts, etc.).
 *
 * Parsing is eager: PostalMime runs synchronously in practice (it wraps
 * its result in Promise.resolve), so we call it in the constructor and
 * all accessors are synchronous.
 */
export class EmailMessage {
  readonly uid: number;
  readonly raw: string;
  #parsed: Parsed;

  constructor(msg: FetchedMessage) {
    this.uid = msg.uid;
    this.raw = msg.body;
    // PostalMime.parse is sync in practice; the returned promise
    // resolves immediately.  We call it here so all accessors can
    // be synchronous.  If the parse throws, the constructor throws.
    this.#parsed = PostalMime.parse(msg.body) as unknown as Parsed;
  }

  // ── headers ────────────────────────────────────────────────────────────

  get headers(): EmailHeaders {
    const p = this.#parsed;
    return {
      messageId: p.messageId,
      inReplyTo: p.inReplyTo,
      references: p.references ? p.references.split(/\s+/) : [],
      from: p.from,
      to: p.to,
      subject: p.subject,
      date: p.date ? new Date(p.date) : undefined,
      contentType: p.headers?.find((h) => h.key === "content-type")?.value,
    };
  }

  /**
   * Parsed `from` address, or `undefined`.
   */
  get from(): string | undefined {
    return this.headers.from?.address;
  }

  /**
   * Plain-text body, trimmed.
   */
  get text(): string {
    return (this.#parsed.text ?? "").trim();
  }

  /**
   * HTML body, if present.
   */
  get html(): string | undefined {
    return this.#parsed.html ?? undefined;
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

    if (h.from) lines.push(`From: ${h.from.name ?? ""} <${h.from.address ?? ""}>`.trim());
    if (h.to?.length) {
      lines.push(
        `To: ${h.to.map((t) => `${t.name ?? ""} <${t.address ?? ""}>`.trim()).join(", ")}`,
      );
    }
    if (h.subject) lines.push(`Subject: ${h.subject}`);
    if (h.date) lines.push(`Date: ${h.date.toISOString()}`);
    if (h.messageId) lines.push(`Message-ID: ${h.messageId}`);
    if (h.inReplyTo) lines.push(`In-Reply-To: ${h.inReplyTo}`);
    if (h.references.length) lines.push(`References: ${h.references.join(" ")}`);
    if (h.contentType) lines.push(`Content-Type: ${h.contentType}`);

    if (this.text) {
      lines.push("");
      lines.push(this.text);
    }

    return lines.join("\n");
  }

  /**
   * Full raw message with all headers — for when you really need everything.
   */
  toString(): string {
    return this.raw;
  }
}
