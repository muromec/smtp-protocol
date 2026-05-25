import { SMTPClient, type SMTPClientOptions } from "smtp-client";
import { EmailMessage } from "./message.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}

// ── SmtpSender ─────────────────────────────────────────────────────────────

/**
 * Simple SMTP sender.  Creates a fresh connection per message and
 * sends an {@link EmailMessage} serialized to RFC822.
 */
export class SmtpSender {
  #config: SmtpConfig;

  constructor(config: SmtpConfig) {
    this.#config = config;
  }

  /**
   * Send an email.  The message must have been created via
   * {@link EmailMessage.compose}.
   */
  async send(msg: EmailMessage): Promise<void> {
    const smtp = new SMTPClient({
      host: this.#config.host,
      port: this.#config.port,
      secure: this.#config.tls,
    } as SMTPClientOptions);

    const raw = msg.toRfc822();

    await smtp.connect();
    await smtp.greet({ hostname: this.#config.host });
    await smtp.authLogin({
      username: this.#config.user,
      password: this.#config.password,
    });
    await smtp.mail({ from: this.#config.user });
    for (const recipient of msg.headers.to ?? []) {
      if (recipient.address) await smtp.rcpt({ to: recipient.address });
    }
    await smtp.data(raw);
    await smtp.quit();
  }
}
