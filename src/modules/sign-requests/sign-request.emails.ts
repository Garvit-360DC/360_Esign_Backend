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
  type MetaRow,
} from "./sign-request.email-layout";
import { buildDocumentUrl, buildSignUrl, senderOf, signedDocumentName } from "./sign-request.mapper";
import { signerColor, signerLabel, type SignRequest, type Signer } from "./sign-request.types";

/**
 * Signing notifications.
 *
 * Every function here is best-effort — `sendAll` swallows delivery failures — so an
 * unreachable mail server never blocks or fails a signing operation.
 */

const PRODUCT_NAME = "360 InstantDocs";

function pageWord(count: number): string {
  return `${count} page${count === 1 ? "" : "s"}`;
}

function signerWord(count: number): string {
  return `${count} signer${count === 1 ? "" : "s"}`;
}

/** What signers receive: always a PDF, even when a Word file was sent for signature. */
function documentName(request: SignRequest): string {
  return signedDocumentName(request.fileName);
}

/** "Priya Shah at Northwind", "Priya Shah", or null when the envelope does not say. */
function senderLine(request: SignRequest): string | null {
  const sender = senderOf(request);
  if (!sender.name) return null;
  return sender.company ? `${sender.name} at ${sender.company}` : sender.name;
}

/**
 * Who a signer sees the message from, and where their reply goes. Naming the person who asked
 * is what separates a real request from phishing, to the signer and to spam filters alike.
 */
function fromSender(request: SignRequest): Pick<MailMessage, "fromName" | "replyTo"> {
  const sender = senderOf(request);
  return {
    fromName: sender.name ? `${sender.name} via ${PRODUCT_NAME}` : PRODUCT_NAME,
    replyTo: sender.email || undefined,
  };
}

function senderRow(request: SignRequest): MetaRow[] {
  const line = senderLine(request);
  return line ? [{ label: "Sent by", value: line }] : [];
}

/** The sender's own address, unless they are also one of the signers and hear about it anyway. */
function senderInbox(request: SignRequest): string | null {
  const email = senderOf(request).email.toLowerCase();
  if (!email) return null;
  return request.signers.some((signer) => signer.email.toLowerCase() === email) ? null : email;
}

/**
 * Message building is separate from sending throughout this module so the templates can be
 * rendered and reviewed without an SMTP server — see `scripts/preview-emails.ts`.
 */

/** Each signer gets their own link, so these are always one message per recipient. */
export function buildSignatureInvites(request: SignRequest): MailMessage[] {
  const name = documentName(request);
  const asker = senderLine(request);

  return request.signers.map((signer) => {
    const href = buildSignUrl(request.id, signer.id, signer.token);
    const label = signerLabel(signer.role);
    // Counts every field they have to touch, not just the signature ones.
    const boxes = request.signatureFields.filter(
      (field) => field.role === signer.role
    ).length;
    const ask = asker
      ? `${escapeHtml(asker)} has asked you to sign this document electronically.`
      : "You have been asked to sign this document electronically.";

    return {
      ...fromSender(request),
      to: signer.email,
      subject: request.subject || `Signature requested: ${name}`,
      html: layout({
        preheader: asker ? `${asker} is waiting for your signature.` : `${name} is waiting for your signature.`,
        eyebrow: { text: "Signature requested", tone: "verified" },
        heading: `${signer.name}, please sign ${name}`,
        body:
          (request.message ? paragraph(escapeHtml(request.message)) : "") +
          paragraph(`${ask} It should take a couple of minutes — no account needed.`) +
          metaTable([
            ...senderRow(request),
            { label: "Document", value: name },
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
          (senderOf(request).email ? muted("Questions? Reply to this email to reach the sender.") : "") +
          button(href, "Review and sign") +
          fallbackLink(href),
      }),
      text: plainText([
        `${signer.name}, please sign ${name}`,
        "",
        ...(request.message ? [request.message, ""] : []),
        asker ? `${asker} has asked you to sign this document electronically.` : "You have been asked to sign this document electronically.",
        "",
        ...(asker ? [`Sent by:   ${asker}`] : []),
        `Document:  ${name}`,
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

/** Returns the signers it could not reach, for callers that must not report a failed send as sent. */
export async function sendSignatureInvites(request: SignRequest): Promise<Signer[]> {
  const { results } = await sendAll(buildSignatureInvites(request));
  return request.signers.filter((_, index) => !results[index]);
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
  const name = documentName(request);
  const waited = waitedFor(daysSince(request.createdAt, now));

  return signers.map((signer) => {
    const href = buildSignUrl(request.id, signer.id, signer.token);
    const label = signerLabel(signer.role);
    const opened = signer.viewedAt !== null;

    return {
      ...fromSender(request),
      to: signer.email,
      subject: `Reminder: ${name} is waiting for your signature`,
      html: layout({
        preheader: `${name} still needs your signature.`,
        eyebrow: { text: "Reminder", tone: "pending" },
        heading: `${signer.name}, ${name} still needs you`,
        body:
          paragraph(
            opened
              ? "You opened this document but did not finish signing it. Your place is saved — picking up where you left off takes a moment."
              : "This document is still waiting for your signature. It should take a couple of minutes — no account needed."
          ) +
          metaTable([
            ...senderRow(request),
            { label: "Document", value: name },
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
        `${signer.name}, ${name} still needs your signature`,
        "",
        ...(senderLine(request) ? [`Sent by:   ${senderLine(request)}`] : []),
        `Document:  ${name}`,
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

/**
 * Sent once the last signer finishes: each signer gets a link to the stamped PDF, and the sender
 * a note that it is done. The sender's copy lands in Salesforce, so theirs carries no link.
 */
export function buildCompletionNotices(request: SignRequest): MailMessage[] {
  const name = documentName(request);

  const toSigners: MailMessage[] = request.signers.map((signer) => {
    const href = buildDocumentUrl(request.id, signer.token);

    return {
      ...fromSender(request),
      to: signer.email,
      subject: `Completed: ${name}`,
      html: layout({
        preheader: `${name} has been signed by everyone.`,
        eyebrow: { text: "Completed", tone: "verified" },
        heading: "Everyone has signed",
        body:
          paragraph(
            `<strong>${escapeHtml(name)}</strong> is complete. Every signature has been applied to the document.`
          ) +
          metaTable([
            ...senderRow(request),
            { label: "Document", value: name },
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
        `${name} is complete. Every signature has been applied.`,
        "",
        "Download the signed document:",
        href,
      ]),
    };
  });

  const inbox = senderInbox(request);
  if (!inbox) return toSigners;

  return [
    ...toSigners,
    {
      fromName: PRODUCT_NAME,
      to: inbox,
      subject: `Completed: ${name}`,
      html: layout({
        preheader: `Everyone has signed ${name}.`,
        eyebrow: { text: "Completed", tone: "verified" },
        heading: `Everyone has signed ${name}`,
        body:
          paragraph(
            `All ${signerWord(request.signers.length)} have signed. The signed copy is being saved to the record in Salesforce.`
          ) +
          metaTable(
            request.signers.map((signer) => ({
              label: signerLabel(signer.role),
              value: `${signer.name} · signed`,
              swatch: signerColor(signer.role),
            }))
          ),
        footnote: "You are receiving this because you sent this document for signature.",
      }),
      text: plainText([
        `Everyone has signed ${name}`,
        "",
        `All ${signerWord(request.signers.length)} have signed. The signed copy is being saved to the record in Salesforce.`,
      ]),
    },
  ];
}

export async function sendCompletionNotices(request: SignRequest): Promise<void> {
  await sendAll(buildCompletionNotices(request));
}

/**
 * When someone declines: the sender hears why, the person who declined gets a confirmation, and
 * the other signers learn the document is withdrawn. The reason is written for the sender, so it
 * is not passed on to the other signers.
 */
export function buildDeclineNotices(
  request: SignRequest,
  decliner: Signer,
  reason: string
): MailMessage[] {
  const name = documentName(request);
  const others = request.signers.filter((signer) => signer.id !== decliner.id);
  const declinedBy: MetaRow = {
    label: "Declined by",
    value: `${decliner.name} · ${signerLabel(decliner.role)}`,
    swatch: signerColor(decliner.role),
  };

  const toOthers: MailMessage[] = others.map((signer) => ({
    ...fromSender(request),
    to: signer.email,
    subject: `Declined: ${name}`,
    html: layout({
      preheader: `${decliner.name} declined to sign ${name}.`,
      eyebrow: { text: "Declined", tone: "refused" },
      heading: `${decliner.name} declined to sign`,
      body:
        paragraph(
          `<strong>${escapeHtml(name)}</strong> has been withdrawn and can no longer be signed. No further action is needed from you.`
        ) +
        metaTable([...senderRow(request), { label: "Document", value: name }, declinedBy]) +
        muted("If this was a mistake, the sender can start a new signing request."),
      footnote: "You are receiving this because you were a signer on this document.",
    }),
    text: plainText([
      `${decliner.name} declined to sign`,
      "",
      `${name} has been withdrawn and can no longer be signed.`,
      "",
      "If this was a mistake, the sender can start a new signing request.",
    ]),
  }));

  const toDecliner: MailMessage = {
    ...fromSender(request),
    to: decliner.email,
    subject: `You declined: ${name}`,
    html: layout({
      preheader: `You declined to sign ${name}.`,
      eyebrow: { text: "Declined", tone: "refused" },
      heading: `You declined to sign ${name}`,
      body:
        paragraph("Your decision has been recorded, and the sender has been told why. Nothing was signed in your name.") +
        callout(`<strong>Your reason</strong><br />${escapeHtml(reason)}`) +
        muted("If you declined by mistake, reply to this email or contact the sender for a new request."),
      footnote: "This is a confirmation. You do not need to do anything.",
    }),
    text: plainText([
      `You declined to sign ${name}`,
      "",
      "Your decision has been recorded, and the sender has been told why.",
      "",
      `Your reason: ${reason}`,
    ]),
  };

  const inbox = senderInbox(request);
  const toSender: MailMessage[] = inbox
    ? [
        {
          fromName: PRODUCT_NAME,
          replyTo: decliner.email,
          to: inbox,
          subject: `${decliner.name} declined: ${name}`,
          html: layout({
            preheader: `${decliner.name} declined to sign ${name}.`,
            eyebrow: { text: "Declined", tone: "refused" },
            heading: `${decliner.name} declined to sign ${name}`,
            body:
              paragraph("The request has been withdrawn. The other signers have been told it can no longer be signed.") +
              callout(`<strong>Reason given</strong><br />${escapeHtml(reason)}`) +
              metaTable([{ label: "Document", value: name }, declinedBy, { label: "Email", value: decliner.email }]) +
              muted(`Reply to this email to reach ${escapeHtml(decliner.name)}.`),
            footnote: "You are receiving this because you sent this document for signature.",
          }),
          text: plainText([
            `${decliner.name} declined to sign ${name}`,
            "",
            `Reason given: ${reason}`,
            "",
            `Reply to this email to reach ${decliner.name} (${decliner.email}).`,
          ]),
        },
      ]
    : [];

  return [...toOthers, toDecliner, ...toSender];
}

export async function sendDeclineNotices(
  request: SignRequest,
  decliner: Signer,
  reason: string
): Promise<void> {
  await sendAll(buildDeclineNotices(request, decliner, reason));
}

/** Tells signers who had not finished that the sender cancelled, so their link stops surprising them. */
export function buildCancellationNotices(request: SignRequest, signers: Signer[], reason?: string | null): MailMessage[] {
  const name = documentName(request);

  return signers.map((signer) => ({
    ...fromSender(request),
    to: signer.email,
    subject: `Cancelled: ${name}`,
    html: layout({
      preheader: `${name} no longer needs your signature.`,
      eyebrow: { text: "Cancelled", tone: "pending" },
      heading: `${name} was cancelled`,
      body:
        paragraph(
          `${senderLine(request) ? escapeHtml(senderLine(request) as string) : "The sender"} cancelled this signing request. Your signing link no longer works, and there is nothing you need to do.`
        ) +
        (reason ? callout(`<strong>Reason given</strong><br />${escapeHtml(reason)}`, "verified") : "") +
        metaTable([...senderRow(request), { label: "Document", value: name }]),
      footnote: "You are receiving this because you were a signer on this document.",
    }),
    text: plainText([
      `${name} was cancelled`,
      "",
      "The sender cancelled this signing request. Your signing link no longer works.",
      ...(reason ? ["", `Reason given: ${reason}`] : []),
    ]),
  }));
}

export async function sendCancellationNotices(
  request: SignRequest,
  signers: Signer[],
  reason?: string | null
): Promise<void> {
  if (signers.length) await sendAll(buildCancellationNotices(request, signers, reason));
}
