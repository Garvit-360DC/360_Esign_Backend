import sgMail from "@sendgrid/mail";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

/**
 * Delivery through SendGrid, with the same settings as the connector's `mail.service.js`.
 *
 * Sending is best-effort by design: a signing request is still valid if the invitation
 * bounces, and the links are always available from the API response and the dashboard.
 * Nothing here throws — failures are logged and reported through the return value.
 *
 * "Sent" means SendGrid accepted the message. A later bounce only shows up in its event webhook.
 */

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Improves deliverability and serves text-only clients. */
  text?: string;
  cc?: string | string[];
  /** Shown as the sender, e.g. "Priya Shah via 360 InstantDocs". The address stays ours. */
  fromName?: string;
  /** Where a reply goes. Defaults to MAIL_REPLY_TO. */
  replyTo?: string;
};

/** Bounded so a slow SendGrid response cannot hold an API request open indefinitely. */
const SEND_TIMEOUT_MS = 20_000;

let configured = false;

export function isMailEnabled(): boolean {
  return Boolean(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);
}

function configure(apiKey: string): void {
  if (configured) return;
  sgMail.setApiKey(apiKey);
  sgMail.setTimeout(SEND_TIMEOUT_MS);
  configured = true;
}

/** SendGrid's own explanation is on the response body, not in the error's message. */
function describeError(error: unknown): string {
  const details = (error as { response?: { body?: { errors?: { message?: string }[] } } })?.response
    ?.body?.errors;
  const reasons = details?.map((item) => item.message).filter(Boolean);
  if (reasons?.length) return reasons.join("; ");
  return error instanceof Error ? error.message : String(error);
}

export async function sendMail(message: MailMessage): Promise<boolean> {
  if (!env.SENDGRID_API_KEY || !env.SENDGRID_FROM_EMAIL) {
    logger.warn("Mail is not configured; skipping send", { subject: message.subject });
    return false;
  }

  try {
    configure(env.SENDGRID_API_KEY);

    const [response] = await sgMail.send({
      // Our verified address with the sender's name on it: sending as them would fail SPF.
      from: message.fromName
        ? { email: env.SENDGRID_FROM_EMAIL, name: message.fromName }
        : env.SENDGRID_FROM_EMAIL,
      replyTo: message.replyTo || env.MAIL_REPLY_TO || undefined,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    logger.info("Email sent", {
      to: message.to,
      subject: message.subject,
      id: response?.headers?.["x-message-id"],
    });
    return true;
  } catch (error) {
    logger.error("Email sending failed", {
      to: message.to,
      subject: message.subject,
      message: describeError(error),
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
