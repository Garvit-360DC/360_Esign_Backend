import { env } from "../../config/env";
import type {
  CeremonyField,
  CeremonyRecipient,
  CeremonySession,
  PublicSignRequest,
  PublicSigner,
  SignRequest,
  SignRequestStatus,
  SignatureField,
  Signer,
  SignerStatus,
} from "./sign-request.types";

function trimSlash(url: string): string {
  return url.replace(/\/$/, "");
}

export function buildSignUrl(requestId: string, signerId: string, token: string): string {
  return `${trimSlash(env.FRONTEND_URL)}/e/${requestId}/${signerId}?t=${encodeURIComponent(token)}`;
}

export function buildDraftDocumentUrl(draftId: string, token: string): string {
  return `${trimSlash(env.PUBLIC_API_URL)}/sign-requests/drafts/${draftId}/document?t=${encodeURIComponent(token)}`;
}

export function buildDocumentUrl(requestId: string, token: string): string {
  return `${trimSlash(env.PUBLIC_API_URL)}/sign-requests/${requestId}/document?t=${encodeURIComponent(token)}`;
}

export function toPublicSigner(requestId: string, signer: Signer): PublicSigner {
  return {
    id: signer.id,
    role: signer.role,
    name: signer.name,
    email: signer.email,
    status: signer.status,
    declineReason: signer.declineReason,
    viewedAt: signer.viewedAt,
    signedAt: signer.signedAt,
    declinedAt: signer.declinedAt,
    remindedAt: signer.remindedAt,
    consentedAt: signer.consentedAt,
    signUrl: buildSignUrl(requestId, signer.id, signer.token),
  };
}

export function toPublicSignRequest(request: SignRequest): PublicSignRequest {
  return {
    ...request,
    signers: request.signers.map((signer) => toPublicSigner(request.id, signer)),
  };
}

function mapRecipientStatus(status: SignerStatus): CeremonyRecipient["status"] {
  switch (status) {
    case "signed":
      return "SIGNED";
    case "viewed":
      return "VIEWED";
    case "declined":
      return "DECLINED";
    default:
      return "PENDING";
  }
}

function mapEnvelopeStatus(status: SignRequestStatus, signers: Signer[]): CeremonySession["envelope"]["status"] {
  if (status === "cancelled") return "VOIDED";
  if (status === "declined") return "DECLINED";
  if (status === "completed") return "COMPLETED";

  const signedCount = signers.filter((signer) => signer.status === "signed").length;
  if (signedCount > 0) return "PARTIALLY_SIGNED";
  if (signers.some((signer) => signer.status === "viewed")) return "VIEWED";
  return "SENT";
}

function toCeremonyRecipient(signer: Signer): CeremonyRecipient {
  return {
    id: signer.id,
    name: signer.name,
    email: signer.email,
    status: mapRecipientStatus(signer.status),
    recipientKey: signer.role,
  };
}

function toCeremonyField(field: SignatureField): CeremonyField {
  return {
    id: field.id,
    type: field.type,
    recipientKey: field.role,
    page: field.page,
    rect: field.rect,
    required: true,
    value: field.value ?? null,
  };
}

/** The document as the signer receives it: always a PDF, whatever was uploaded. */
export function signedDocumentName(fileName: string): string {
  return fileName.replace(/\.docx$/i, "") + ".pdf";
}

/**
 * Who sent the envelope. Salesforce passes these in `branding`; envelopes made in the console
 * carry none, so each may be empty.
 */
export function senderOf(request: SignRequest): { name: string; email: string; company: string } {
  const branding = request.salesforce?.branding ?? {};
  return {
    name: (branding.senderName ?? "").trim(),
    email: (branding.senderEmail ?? "").trim(),
    company: (branding.companyName ?? "").trim(),
  };
}

/**
 * The disclosure a signer agrees to before anything is recorded. Paragraphs are separated by a
 * blank line, which is how the ceremony splits them.
 */
export function consentText(request: SignRequest): string {
  const sender = senderOf(request);
  const contact = sender.email
    ? `${sender.name || "the sender"} at ${sender.email}`
    : sender.name || "the sender";

  return [
    `You are about to receive and sign ${signedDocumentName(request.fileName)} electronically. Please read this before you continue.`,
    "By ticking the box, you agree to receive this document and the notices about it electronically, and to sign it electronically. Your electronic signature has the same effect as a handwritten one.",
    `You can ask for a paper copy, or to sign on paper instead, at no charge. To do so, contact ${contact}.`,
    "You can withdraw this consent at any time before you finish by choosing Decline instead of signing. Withdrawing does not affect anything you have already signed.",
    "You need a current web browser and access to your email. Once everyone has signed, you can download and keep a PDF copy.",
    "When you open, agree to, sign or decline this document, we record the time, your IP address and your browser, and include them in a certificate of completion.",
  ].join("\n\n");
}

export function toCeremonySession(request: SignRequest, signer: Signer): CeremonySession {
  const documentUrl = buildDocumentUrl(request.id, signer.token);
  const waitingForOthers = request.signers.some(
    (item) => item.id !== signer.id && item.status !== "signed"
  );
  const sender = senderOf(request);
  const ownFieldCount = request.signatureFields.filter((field) => field.role === signer.role).length;

  return {
    envelope: {
      id: request.id,
      name: signedDocumentName(request.fileName),
      status: mapEnvelopeStatus(request.status, request.signers),
      pageCount: request.pageCount,
      estimatedMinutes: Math.max(2, ownFieldCount),
      senderName: sender.name,
      senderCompany: sender.company,
      senderEmail: sender.email,
      consentText: consentText(request),
    },
    recipient: {
      ...toCeremonyRecipient(signer),
      consentedAt: signer.consentedAt ? signer.consentedAt.toISOString() : null,
    },
    recipients: request.signers.map(toCeremonyRecipient),
    documentUrl,
    fields: request.signatureFields.map(toCeremonyField),
    downloadUrl: request.status === "completed" ? documentUrl : null,
    waitingForOthers,
  };
}
