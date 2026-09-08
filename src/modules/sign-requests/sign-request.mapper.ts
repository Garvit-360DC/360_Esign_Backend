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

export function toCeremonySession(request: SignRequest, signer: Signer): CeremonySession {
  const documentUrl = buildDocumentUrl(request.id, signer.token);
  const waitingForOthers = request.signers.some(
    (item) => item.id !== signer.id && item.status !== "signed"
  );

  return {
    envelope: {
      id: request.id,
      name: request.fileName,
      status: mapEnvelopeStatus(request.status, request.signers),
      pageCount: request.pageCount,
      estimatedMinutes: Math.max(2, request.signatureFields.length),
      senderName: "Sender",
      senderCompany: "",
      consentText:
        "By clicking Finish, I agree that the signature will be the electronic representation of my signature for this document.",
    },
    recipient: toCeremonyRecipient(signer),
    recipients: request.signers.map(toCeremonyRecipient),
    documentUrl,
    fields: request.signatureFields.map(toCeremonyField),
    downloadUrl: request.status === "completed" ? documentUrl : null,
    waitingForOthers,
  };
}
