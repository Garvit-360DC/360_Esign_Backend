import { sendAll, type MailMessage } from "../../integrations/mail";
import {
  button,
  callout,
  escapeHtml,
  fallbackLink,
  layout,
  metaTable,
  muted,
  paragraph,
  plainText,
} from "./sign-request.email-layout";
import { buildDocumentUrl, buildSignUrl } from "./sign-request.mapper";
import { signerColor, signerLabel, type SignRequest, type Signer } from "./sign-request.types";

/**
 * Signing notifications.
 *
 * Every function here is best-effort — `sendAll` swallows delivery failures — so an
 * unreachable mail server never blocks or fails a signing operation.
 */

function pageWord(count: number): string {
  return `${count} page${count === 1 ? "" : "s"}`;
}

function signerWord(count: number): string {
  return `${count} signer${count === 1 ? "" : "s"}`;
}

/**
 * Message building is separate from sending throughout this module so the templates can be
 * rendered and reviewed without an SMTP server — see `scripts/preview-emails.ts`.
 */

/** Each signer gets their own link, so these are always one message per recipient. */
export function buildSignatureInvites(request: SignRequest): MailMessage[] {
  return request.signers.map((signer) => {
    const href = buildSignUrl(request.id, signer.id, signer.token);
    const label = signerLabel(signer.role);
    // Counts every field they have to touch, not just the signature ones.
    const boxes = request.signatureFields.filter(
      (field) => field.role === signer.role
    ).length;

    return {
      to: signer.email,
      subject: request.subject || `Signature requested: ${request.fileName}`,
      html: layout({
        preheader: `${request.fileName} is waiting for your signature.`,
        eyebrow: { text: "Signature requested", tone: "verified" },
        heading: `${signer.name}, please sign ${request.fileName}`,
        body:
          (request.message ? paragraph(escapeHtml(request.message)) : "") +
          paragraph(
            "You have been asked to sign this document electronically. It should take a couple of minutes — no account needed."
          ) +
          metaTable([
            { label: "Document", value: request.fileName },
            {
              label: "You are",
              value: label,
              swatch: signerColor(signer.role),
            },
            {
              label: "Your fields",
              value: `${boxes} field${boxes === 1 ? "" : "s"} to complete`,
            },
            { label: "Signers", value: signerWord(request.signers.length) },
            { label: "Length", value: pageWord(request.pageCount) },
          ]) +
          button(href, "Review and sign") +
          fallbackLink(href),
      }),
      text: plainText([
        `${signer.name}, please sign ${request.fileName}`,
        "",
        ...(request.message ? [request.message, ""] : []),
        "You have been asked to sign this document electronically.",
        "",
        `Document: ${request.fileName}`,
        `You are:   ${label}`,
        `Signers:   ${request.signers.length}`,
        `Length:    ${pageWord(request.pageCount)}`,
        "",
        "Review and sign:",
        href,
        "",
        "This link is personal to you. Do not forward it.",
      ]),
    };
  });
}

/** Returns how many went out, for callers that must not report a send that reached nobody. */
export async function sendSignatureInvites(request: SignRequest): Promise<number> {
  const { sent } = await sendAll(buildSignatureInvites(request));
  return sent;
}

/** Whole days since a date, for "waiting 3 days" phrasing. */
function daysSince(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

function waitedFor(days: number): string {
  if (days === 0) return "sent today";
  if (days === 1) return "waiting since yesterday";
  return `waiting for ${days} days`;
}

/**
 * A nudge for signers who have not finished. Deliberately the same link and the same shape
 * as the invitation — a reminder that looked different would read as a second document.
 */
export function buildReminders(
  request: SignRequest,
  signers: Signer[],
  now = new Date()
): MailMessage[] {
  const waited = waitedFor(daysSince(request.createdAt, now));

  return signers.map((signer) => {
    const href = buildSignUrl(request.id, signer.id, signer.token);
    const label = signerLabel(signer.role);
    const opened = signer.viewedAt !== null;

    return {
      to: signer.email,
      subject: `Reminder: ${request.fileName} is waiting for your signature`,
      html: layout({
        preheader: `${request.fileName} still needs your signature.`,
        eyebrow: { text: "Reminder", tone: "pending" },
        heading: `${signer.name}, ${request.fileName} still needs you`,
        body:
          paragraph(
            opened
              ? "You opened this document but did not finish signing it. Your place is saved — picking up where you left off takes a moment."
              : "This document is still waiting for your signature. It should take a couple of minutes — no account needed."
          ) +
          metaTable([
            { label: "Document", value: request.fileName },
            {
              label: "You are",
              value: label,
              swatch: signerColor(signer.role),
            },
            { label: "Status", value: opened ? "Opened, not signed" : "Not opened yet" },
            { label: "Request", value: waited },
          ]) +
          button(href, "Review and sign") +
          fallbackLink(href),
        footnote: "If you have already signed, you can ignore this message.",
      }),
      text: plainText([
        `${signer.name}, ${request.fileName} still needs your signature`,
        "",
        `Document: ${request.fileName}`,
        `You are:   ${label}`,
        `Status:    ${opened ? "Opened, not signed" : "Not opened yet"}`,
        `Request:   ${waited}`,
        "",
        "Review and sign:",
        href,
        "",
        "This link is personal to you. Do not forward it.",
      ]),
    };
  });
}

/** Returns the signers the reminder actually reached, in the order they were given. */
export async function sendReminders(
  request: SignRequest,
  signers: Signer[]
): Promise<Signer[]> {
  const { results } = await sendAll(buildReminders(request, signers));
  return signers.filter((_, index) => results[index]);
}

/** Sent once the last signer finishes, with a link to the stamped PDF. */
export function buildCompletionNotices(request: SignRequest): MailMessage[] {
  return request.signers.map((signer) => {
    const href = buildDocumentUrl(request.id, signer.token);

    return {
      to: signer.email,
      subject: `Completed: ${request.fileName}`,
      html: layout({
        preheader: `${request.fileName} has been signed by everyone.`,
        eyebrow: { text: "Completed", tone: "verified" },
        heading: "Everyone has signed",
        body:
          paragraph(
            `<strong>${escapeHtml(request.fileName)}</strong> is complete. Every signature has been applied to the document.`
          ) +
          metaTable([
            { label: "Document", value: request.fileName },
            { label: "Signed by", value: signerWord(request.signers.length) },
            { label: "Length", value: pageWord(request.pageCount) },
          ]) +
          button(href, "Download signed document") +
          fallbackLink(href),
        footnote:
          "Keep this link private — it opens the signed document without asking who you are.",
      }),
      text: plainText([
        "Everyone has signed",
        "",
        `${request.fileName} is complete. Every signature has been applied.`,
        "",
        "Download the signed document:",
        href,
      ]),
    };
  });
}

export async function sendCompletionNotices(request: SignRequest): Promise<void> {
  await sendAll(buildCompletionNotices(request));
}

/** Tells the remaining signers why the envelope stopped. */
export function buildDeclineNotices(
  request: SignRequest,
  decliner: Signer,
  reason: string
): MailMessage[] {
  const others = request.signers.filter((signer) => signer.id !== decliner.id);

  return others.map((signer) => ({
    to: signer.email,
    subject: `Declined: ${request.fileName}`,
    html: layout({
      preheader: `${decliner.name} declined to sign ${request.fileName}.`,
      eyebrow: { text: "Declined", tone: "refused" },
      heading: `${decliner.name} declined to sign`,
      body:
        paragraph(
          `<strong>${escapeHtml(request.fileName)}</strong> has been withdrawn and can no longer be signed. No further action is needed from you.`
        ) +
        callout(
          `<strong>Reason given</strong><br />${escapeHtml(reason)}`
        ) +
        metaTable([
          { label: "Document", value: request.fileName },
          {
            label: "Declined by",
            value: `${decliner.name} · ${signerLabel(decliner.role)}`,
            swatch: signerColor(decliner.role),
          },
        ]) +
        muted("If this was a mistake, the sender can start a new signing request."),
      footnote: "You are receiving this because you were a signer on this document.",
    }),
    text: plainText([
      `${decliner.name} declined to sign`,
      "",
      `${request.fileName} has been withdrawn and can no longer be signed.`,
      "",
      `Reason given: ${reason}`,
      "",
      "If this was a mistake, the sender can start a new signing request.",
    ]),
  }));
}

export async function sendDeclineNotices(
  request: SignRequest,
  decliner: Signer,
  reason: string
): Promise<void> {
  await sendAll(buildDeclineNotices(request, decliner, reason));
}
