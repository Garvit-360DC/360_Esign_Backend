import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

/**
 * SMTP delivery.
 *
 * Sending is best-effort by design: a signing request is still valid if the invitation
 * bounces, and the links are always available from the API response and the dashboard.
 * Nothing here throws — failures are logged and reported through the return value.
 */

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Improves deliverability and serves text-only clients. */
  text?: string;
  cc?: string | string[];
};

let transporter: Transporter | null = null;

export function isMailEnabled(): boolean {
  return Boolean(env.SMTP_HOST && env.MAIL_FROM);
}

function getTransporter(): Transporter | null {
  if (!isMailEnabled()) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; everything else negotiates STARTTLS.
    secure: env.SMTP_PORT === 465,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
    // Bounded so a wedged SMTP host cannot hold an API request open indefinitely.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transporter;
}

export async function sendMail(message: MailMessage): Promise<boolean> {
  const mailer = getTransporter();

  if (!mailer) {
    logger.warn("Mail is not configured; skipping send", { subject: message.subject });
    return false;
  }

  try {
    const info = await mailer.sendMail({
      from: env.MAIL_FROM,
      replyTo: env.MAIL_REPLY_TO || undefined,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    logger.info("Email sent", { to: message.to, subject: message.subject, id: info.messageId });
    return true;
  } catch (error) {
    logger.error("Email sending failed", {
      to: message.to,
      subject: message.subject,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Sends everything it can and never rejects, so one bad address cannot stop the rest.
 *
 * The counts are there for callers where delivery is the point rather than a side effect —
 * a reminder that silently reached nobody is a failure the sender needs to be told about.
 */
export async function sendAll(
  messages: MailMessage[]
): Promise<{ sent: number; failed: number; results: boolean[] }> {
  const results = await Promise.all(messages.map((message) => sendMail(message)));
  const sent = results.filter(Boolean).length;

  return { sent, failed: results.length - sent, results };
}
