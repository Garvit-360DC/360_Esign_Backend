import { randomBytes } from "node:crypto";
import { logger } from "../../config/logger";
import { convertDocxToPdf } from "../../integrations/convertapi";
import { isMailEnabled } from "../../integrations/mail";
import { AppError } from "../../utils/appError";
import {
  sendCompletionNotices,
  sendDeclineNotices,
  sendReminders,
  sendSignatureInvites,
} from "./sign-request.emails";
import { createDraftRecord, deleteDraft, findDraft } from "./sign-request.drafts";
import { toSignatureFields } from "./sign-request.layout";
import { countPages, locatePlaceholders } from "./sign-request.locator";
import {
  buildDocumentUrl,
  buildDraftDocumentUrl,
  toCeremonySession,
  toPublicSignRequest,
} from "./sign-request.mapper";
import { detectSignatureFields, extractSignatureFields } from "./sign-request.placeholders";
import { erasePlaceholders, stampSignatures } from "./sign-request.stamp";
import {
  createSignRequest,
  findById,
  getFileBuffer,
  getFileInfo,
  getStats,
  listSignRequests,
  saveDocumentFile,
  setFieldValues,
  updateSignRequest,
  type ListFilter,
} from "./sign-request.repository";
import { isDrawnField, signerLabel } from "./sign-request.types";
import type {
  CeremonySession,
  CreateSignRequestInput,
  DetectedPlaceholder,
  FieldRect,
  DocumentInfo,
  DraftView,
  PlacedField,
  PublicSignRequest,
  SignRequest,
  SignRequestDetail,
  SignRequestStats,
  SignRequestSummary,
  SignatureField,
  Signer,
  SignerInput,
  SignerRole,
} from "./sign-request.types";

function newToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Every signer needs something to sign, and every field needs a signer to fill it.
 *
 * "Something to sign" means a signature or initial box specifically: an envelope where a
 * signer has only a Full Name box collects no signature from them at all.
 */
function assertSignersMatchFields(
  signerRoles: SignerRole[],
  fields: Pick<PlacedField, "role" | "type">[]
) {
  const signerSet = new Set(signerRoles);
  const signable = new Set(
    fields.filter((field) => isDrawnField(field.type)).map((field) => field.role)
  );

  const missingSlots = signerRoles.filter((role) => !signable.has(role));
  if (missingSlots.length) {
    throw new AppError(
      `No signature or initial box has been placed for: ${missingSlots.map(signerLabel).join(", ")}`,
      400,
      "SIGNER_SLOT_MISSING"
    );
  }

  const missingSigners = [
    ...new Set(fields.map((field) => field.role).filter((role) => !signerSet.has(role))),
  ];
  if (missingSigners.length) {
    throw new AppError(
      `A signer is required for: ${missingSigners.map(signerLabel).join(", ")}`,
      400,
      "SIGNER_REQUIRED"
    );
  }
}

/**
 * Loads an envelope for the signing ceremony, where the caller is a signer holding a
 * per-signer token rather than a Salesforce org. Use `loadOwnRequest` on sender-facing
 * paths so an org can only reach its own envelopes.
 */
async function loadRequest(id: string): Promise<SignRequest> {
  const request = await findById(id);
  if (!request) {
    throw new AppError("This signing link is invalid or has expired.", 404, "INVALID_LINK");
  }
  return request;
}

/** 404 rather than 403 for another org's envelope: whether it exists is not their business. */
async function loadOwnRequest(id: string, orgId: string): Promise<SignRequest> {
  const request = await findById(id, orgId);
  if (!request) {
    throw new AppError("Envelope not found.", 404, "NOT_FOUND");
  }
  return request;
}

function requireSigner(request: SignRequest, recipientId: string, token: string): Signer {
  const signer = request.signers.find((item) => item.id === recipientId);
  if (!signer || signer.token !== token) {
    throw new AppError("This signing link is invalid or has expired.", 404, "INVALID_LINK");
  }

  if (request.status === "cancelled") {
    throw new AppError("This envelope is no longer available.", 410, "VOIDED");
  }

  if (request.status === "declined" || signer.status === "declined") {
    throw new AppError("This signer declined to sign.", 409, "DECLINED");
  }

  return signer;
}

function requireActiveSigner(request: SignRequest, recipientId: string, token: string): Signer {
  const signer = requireSigner(request, recipientId, token);

  if (signer.status === "signed" || request.status === "completed") {
    throw new AppError("You have already completed this document.", 409, "ALREADY_DONE");
  }

  return signer;
}

function requireDocumentToken(request: SignRequest, token: string): Signer {
  const signer = request.signers.find((item) => item.token === token);
  if (!signer) {
    throw new AppError("This signing link is invalid or has expired.", 404, "INVALID_LINK");
  }
  requireSigner(request, signer.id, token);
  return signer;
}

function pdfFileName(fileName: string): string {
  return fileName.replace(/\.docx$/i, "") + ".pdf";
}

export async function create(input: CreateSignRequestInput): Promise<PublicSignRequest> {
  const detected = extractSignatureFields(input.file);
  assertSignersMatchFields(
    input.signers.map((signer) => signer.role),
    detected.map((field) => ({ role: field.role, type: "signature" as const }))
  );

  const pdf = await convertDocxToPdf(input.file, input.fileName);

  // Positions come from the converted PDF, so the signature boxes land on the placeholders
  // the add-in inserted rather than at a guessed spot on page 1.
  const { pageCount, located } = await locatePlaceholders(pdf, detected);
  const signatureFields = toSignatureFields(detected, located);

  const fileId = await saveDocumentFile(input.file, input.fileName, input.mimeType);
  const pdfFileId = await saveDocumentFile(pdf, pdfFileName(input.fileName), "application/pdf");

  const created = await createSignRequest({
    orgId: input.orgId,
    fileName: input.fileName,
    fileId,
    pdfFileId,
    pageCount,
    mimeType: input.mimeType,
    signers: input.signers.map((signer) => ({
      ...signer,
      token: newToken(),
      status: "pending",
      declineReason: null,
      viewedAt: null,
      signedAt: null,
      declinedAt: null,
      remindedAt: null,
    })),
    signatureFields,
  });

  // Best-effort: the envelope exists whether or not the invitations get through, and the
  // links are returned below either way.
  await sendSignatureInvites(created);

  return toPublicSignRequest(created);
}

/** How long to let placeholder location run before falling back to manual placement. */
const LOCATE_TIMEOUT_MS = 20_000;

/**
 * Resolves to null if the work outruns the deadline. The underlying promise is not
 * cancellable, so it may still be running — this only stops it holding up the request.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fallback layout: stack the boxes down the first page for the sender to drag into place. */
function defaultPlacement(detected: DetectedPlaceholder[]): PlacedField[] {
  return detected.map((field, index) => ({
    role: field.role,
    type: "signature" as const,
    page: 1,
    rect: {
      x: 0.12,
      y: Math.min(0.82, 0.15 + index * 0.14),
      width: 0.25,
      height: 0.08,
    },
    source: field.source,
  }));
}

/**
 * Positions the boxes the add-in left in the document. Location can fail or run long on an
 * awkward PDF; rather than reject the upload, hand back a default layout and let the sender
 * drag the boxes where they belong.
 */
async function placeDetected(
  pdf: Buffer,
  detected: DetectedPlaceholder[]
): Promise<{
  pageCount: number;
  fields: PlacedField[];
  needsPlacement: boolean;
  /** Where each placeholder's own artwork sits, to be painted out. Empty when location failed. */
  artwork: { page: number; rect: FieldRect }[];
}> {
  if (detected.length === 0) {
    // Guarded like the branch below. Reading a page count is the least important thing this
    // function does, and it has no business failing an upload — it did exactly that when
    // pdf.js started throwing on import.
    let pageCount: number | null = null;

    try {
      pageCount = await withDeadline(countPages(pdf), LOCATE_TIMEOUT_MS);
    } catch (error) {
      logger.warn("Could not count the pages in the converted PDF", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return { pageCount: pageCount ?? 1, fields: [], needsPlacement: false, artwork: [] };
  }

  let result: Awaited<ReturnType<typeof locatePlaceholders>> | null = null;

  try {
    result = await withDeadline(locatePlaceholders(pdf, detected), LOCATE_TIMEOUT_MS);
  } catch (error) {
    logger.warn("Placeholder location failed; falling back to manual placement", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (!result) {
    logger.warn("Placeholder location did not finish; falling back to manual placement", {
      placeholders: detected.length,
    });
    // Nothing to erase: location failed, so where the artwork sits is unknown. The banner on
    // the prepare screen already tells the sender to move the boxes by hand.
    return {
      pageCount: 1,
      fields: defaultPlacement(detected),
      needsPlacement: true,
      artwork: [],
    };
  }

  return {
    pageCount: result.pageCount,
    fields: detected.map((field, index) => ({
      role: field.role,
      type: "signature" as const,
      page: result.located[index].page,
      rect: result.located[index].rect,
      source: field.source,
    })),
    needsPlacement: false,
    artwork: result.located.map((entry) => ({ page: entry.page, rect: entry.artwork })),
  };
}

/**
 * Locates the add-in's placeholders in a freshly converted PDF and paints their artwork out.
 *
 * Shared by the upload path and by sending from a template, which both convert a `.docx` and
 * both would otherwise leave the placeholder pictures on the page — visible behind any box the
 * sender moves, in the signing ceremony, and in the signed document.
 *
 * The erase is best-effort: a placeholder left visible is cosmetic, and failing an upload over it
 * would not be.
 */
export async function prepareConvertedPdf(
  docx: Buffer,
  pdf: Buffer
): Promise<{
  pdf: Buffer;
  pageCount: number;
  fields: PlacedField[];
  needsPlacement: boolean;
}> {
  const detected = detectSignatureFields(docx);
  const { pageCount, fields, needsPlacement, artwork } = await placeDetected(pdf, detected);

  let cleaned = pdf;

  try {
    cleaned = await erasePlaceholders(pdf, artwork);
  } catch (error) {
    logger.warn("Could not erase placeholder artwork; keeping the converted PDF as it is", {
      placeholders: artwork.length,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { pdf: cleaned, pageCount, fields, needsPlacement };
}

export async function createDraft(input: {
  orgId: string;
  file: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<DraftView> {
  const converted = await convertDocxToPdf(input.file, input.fileName);
  const { pdf, pageCount, fields, needsPlacement } = await prepareConvertedPdf(
    input.file,
    converted
  );

  const fileId = await saveDocumentFile(input.file, input.fileName, input.mimeType);
  const pdfFileId = await saveDocumentFile(pdf, pdfFileName(input.fileName), "application/pdf");

  const draft = await createDraftRecord({
    orgId: input.orgId,
    token: newToken(),
    fileName: input.fileName,
    fileId,
    pdfFileId,
    pageCount,
    mimeType: input.mimeType,
    fields,
  });

  return {
    id: draft.id,
    token: draft.token,
    fileName: draft.fileName,
    pageCount: draft.pageCount,
    documentUrl: buildDraftDocumentUrl(draft.id, draft.token),
    fields: draft.fields,
    needsPlacement,
  };
}

async function loadDraft(id: string, token: string) {
  const draft = await findDraft(id);
  if (!draft || draft.token !== token) {
    throw new AppError("This draft is no longer available.", 404, "DRAFT_NOT_FOUND");
  }
  return draft;
}

export async function getDraftPdf(
  id: string,
  token: string
): Promise<{ buffer: Buffer; fileName: string }> {
  const draft = await loadDraft(id, token);
  const buffer = await getFileBuffer(draft.pdfFileId);
  return { buffer, fileName: pdfFileName(draft.fileName) };
}

/** Turns the prepared boxes into stored fields, giving each role its own running index. */
function toStoredFields(fields: PlacedField[]): SignatureField[] {
  const counts = new Map<SignerRole, number>();

  return fields.map((field) => {
    const index = counts.get(field.role) ?? 0;
    counts.set(field.role, index + 1);

    return {
      id: `${field.role}_${index}`,
      role: field.role,
      type: field.type,
      tag: `{%${field.role}}`,
      source: field.source,
      index,
      page: field.page,
      rect: field.rect,
      value: null,
    };
  });
}

export async function sendDraft(
  id: string,
  token: string,
  orgId: string,
  input: { signers: SignerInput[]; fields: PlacedField[] }
): Promise<PublicSignRequest> {
  const draft = await loadDraft(id, token);

  // The draft token alone would let any org send someone else's prepared document.
  if (draft.orgId !== orgId) {
    throw new AppError("This draft is no longer available.", 404, "DRAFT_NOT_FOUND");
  }

  if (input.fields.length === 0) {
    throw new AppError("Place at least one field before sending.", 400, "NO_SIGNATURE_FIELDS");
  }

  assertSignersMatchFields(
    input.signers.map((signer) => signer.role),
    input.fields
  );

  const created = await createSignRequest({
    orgId: draft.orgId,
    fileName: draft.fileName,
    fileId: draft.fileId,
    pdfFileId: draft.pdfFileId,
    pageCount: draft.pageCount,
    mimeType: draft.mimeType,
    signers: input.signers.map((signer) => ({
      ...signer,
      token: newToken(),
      status: "pending",
      declineReason: null,
      viewedAt: null,
      signedAt: null,
      declinedAt: null,
      remindedAt: null,
    })),
    signatureFields: toStoredFields(input.fields),
  });

  // The envelope now owns the GridFS files, so only the pointer record goes away.
  await deleteDraft(draft.id);
  await sendSignatureInvites(created);

  return toPublicSignRequest(created);
}

export async function list(
  orgId: string,
  limit: number,
  skip: number,
  filter: ListFilter = {}
): Promise<{ items: SignRequestSummary[]; total: number }> {
  return listSignRequests(orgId, limit, skip, filter);
}

export async function stats(orgId: string): Promise<SignRequestStats> {
  return getStats(new Date(), orgId);
}

export async function getById(id: string, orgId: string): Promise<SignRequestDetail> {
  const request = await loadOwnRequest(id, orgId);

  const wanted: { kind: DocumentInfo["kind"]; fileId: string }[] = [
    { kind: "original", fileId: request.fileId },
    { kind: "converted", fileId: request.pdfFileId },
    ...(request.signedPdfFileId
      ? [{ kind: "signed" as const, fileId: request.signedPdfFileId }]
      : []),
  ];

  const documents = (
    await Promise.all(
      wanted.map(async ({ kind, fileId }) => {
        const info = await getFileInfo(fileId);
        return info ? { kind, ...info } : null;
      })
    )
  ).filter((entry): entry is DocumentInfo => entry !== null);

  return { ...toPublicSignRequest(request), documents };
}

export async function cancel(id: string, orgId: string): Promise<PublicSignRequest> {
  const request = await loadOwnRequest(id, orgId);

  if (request.status === "completed") {
    throw new AppError(
      "This envelope is already complete and cannot be voided.",
      409,
      "ALREADY_DONE"
    );
  }

  if (request.status === "cancelled") {
    return toPublicSignRequest(request);
  }

  request.status = "cancelled";
  const updated = await updateSignRequest(request);
  return toPublicSignRequest(updated);
}

/** Signers who could still act: not yet signed, not declined. */
function outstandingSigners(request: SignRequest): Signer[] {
  return request.signers.filter(
    (signer) => signer.status !== "signed" && signer.status !== "declined"
  );
}

/**
 * Re-sends the signing link to signers who have not finished.
 *
 * Unlike the invitation that goes out with a new envelope, this is the whole point of the
 * request rather than a side effect of one, so it reports failure instead of swallowing it:
 * a sender who clicks Send reminder must not be told it worked when nothing was delivered.
 */
export async function remind(
  id: string,
  orgId: string,
  recipientId?: string
): Promise<{ sent: number; recipients: { id: string; name: string; email: string }[] }> {
  const request = await loadOwnRequest(id, orgId);

  if (request.status !== "pending" && request.status !== "in_progress") {
    throw new AppError(
      "This envelope is closed, so no reminder can be sent.",
      409,
      "ENVELOPE_CLOSED"
    );
  }

  const outstanding = outstandingSigners(request);
  const targets = recipientId
    ? outstanding.filter((signer) => signer.id === recipientId)
    : outstanding;

  if (targets.length === 0) {
    throw new AppError(
      recipientId
        ? "That signer has already finished, so there is nothing to remind them about."
        : "Everyone has already signed or declined.",
      409,
      "NOTHING_TO_REMIND"
    );
  }

  if (!isMailEnabled()) {
    throw new AppError(
      "Email is not configured on this server, so reminders cannot be sent.",
      503,
      "MAIL_DISABLED"
    );
  }

  const delivered = await sendReminders(request, targets);

  if (delivered.length === 0) {
    throw new AppError(
      "The reminder could not be delivered. Check the mail server settings and try again.",
      502,
      "MAIL_FAILED"
    );
  }

  // Stamped only for the ones that actually went out, so the timestamp means "they were
  // told" rather than "we tried".
  const now = new Date();
  const reminded = new Set(delivered.map((signer) => signer.id));
  for (const signer of request.signers) {
    if (reminded.has(signer.id)) signer.remindedAt = now;
  }
  await updateSignRequest(request);

  return {
    sent: delivered.length,
    recipients: delivered.map((signer) => ({
      id: signer.id,
      name: signer.name,
      email: signer.email,
    })),
  };
}

export async function getSession(
  id: string,
  recipientId: string,
  token: string
): Promise<CeremonySession> {
  const request = await loadRequest(id);
  const signer = requireSigner(request, recipientId, token);

  if (signer.status === "signed") {
    throw new AppError("You have already completed this document.", 409, "ALREADY_DONE");
  }

  if (signer.status === "pending") {
    signer.status = "viewed";
    signer.viewedAt = new Date();
    if (request.status === "pending") {
      request.status = "in_progress";
    }
    await updateSignRequest(request);
  }

  return toCeremonySession(request, signer);
}

export async function getDocumentPdf(
  id: string,
  token: string
): Promise<{ buffer: Buffer; fileName: string }> {
  const request = await loadRequest(id);
  requireDocumentToken(request, token);
  // Signers review the clean document; once everyone has signed the stamped one takes over.
  const buffer = await getFileBuffer(request.signedPdfFileId ?? request.pdfFileId);
  return { buffer, fileName: pdfFileName(request.fileName) };
}

/** Longest a typed field value may be. Boxes are small; anything longer is a mistake. */
const MAX_TEXT_VALUE = 200;

const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g);base64,/i;

/**
 * A drawn field holds an image and a text field holds a string. Reject the wrong one rather
 * than storing it, because stamping cannot tell them apart later.
 */
function normalizeFieldValue(field: SignatureField, value: string): string {
  if (isDrawnField(field.type)) {
    if (!IMAGE_DATA_URL_RE.test(value)) {
      throw new AppError(
        "That field needs a signature image.",
        400,
        "INVALID_FIELD_VALUE"
      );
    }
    return value;
  }

  const text = value.trim();
  if (!text) {
    throw new AppError("That field cannot be left blank.", 400, "INVALID_FIELD_VALUE");
  }
  if (text.length > MAX_TEXT_VALUE) {
    throw new AppError(
      `That field takes at most ${MAX_TEXT_VALUE} characters.`,
      400,
      "INVALID_FIELD_VALUE"
    );
  }

  return text;
}

/**
 * Fills one or more of this signer's fields in a single write.
 *
 * Taking them together matters: the ceremony fills the name, email and date boxes at once,
 * and applies one signature across several boxes. As separate requests those would race,
 * and the loser's value would never reach the database while the screen showed it saved.
 */
export async function saveFieldValues(
  id: string,
  recipientId: string,
  token: string,
  values: { fieldId: string; value: string }[]
): Promise<CeremonySession["fields"]> {
  const request = await loadRequest(id);
  const signer = requireActiveSigner(request, recipientId, token);

  const entries = values.map(({ fieldId, value }) => {
    const field = request.signatureFields.find((item) => item.id === fieldId);
    if (!field || field.role !== signer.role) {
      throw new AppError("That field does not belong to this signer.", 403, "INVALID_LINK");
    }
    return { field, fieldId, value: normalizeFieldValue(field, value) };
  });

  await setFieldValues(request.id, entries.map(({ fieldId, value }) => ({ fieldId, value })));

  return entries.map(({ field, value }) => ({
    id: field.id,
    type: field.type,
    recipientKey: field.role,
    page: field.page,
    rect: field.rect,
    required: true,
    value,
  }));
}

export async function saveFieldValue(
  id: string,
  fieldId: string,
  recipientId: string,
  token: string,
  value: string
): Promise<CeremonySession["fields"][number]> {
  const [field] = await saveFieldValues(id, recipientId, token, [{ fieldId, value }]);
  return field;
}

export async function completeSigning(
  id: string,
  recipientId: string,
  token: string
): Promise<{ waitingForOthers: boolean; downloadUrl: string | null }> {
  const request = await loadRequest(id);
  const signer = requireActiveSigner(request, recipientId, token);
  const ownFields = request.signatureFields.filter((field) => field.role === signer.role);

  if (ownFields.length === 0 || ownFields.some((field) => !field.value)) {
    throw new AppError("All of your fields must be completed first.", 400, "FIELDS_INCOMPLETE");
  }

  const now = new Date();
  signer.status = "signed";
  signer.signedAt = now;
  // A signer who never opened the landing screen still counts as having viewed it.
  signer.viewedAt = signer.viewedAt ?? now;

  const everyoneSigned = request.signers.every((item) => item.status === "signed");
  request.status = everyoneSigned ? "completed" : "in_progress";
  if (everyoneSigned) request.completedAt = now;

  if (everyoneSigned) {
    const pdf = await getFileBuffer(request.pdfFileId);
    const signed = await stampSignatures(pdf, request.signatureFields);
    request.signedPdfFileId = await saveDocumentFile(
      signed,
      pdfFileName(request.fileName),
      "application/pdf"
    );
  }

  await updateSignRequest(request);

  if (everyoneSigned) {
    await sendCompletionNotices(request);
  }

  return {
    waitingForOthers: !everyoneSigned,
    downloadUrl: everyoneSigned ? buildDocumentUrl(request.id, signer.token) : null,
  };
}

export async function declineSigning(
  id: string,
  recipientId: string,
  token: string,
  reason: string
): Promise<{ ok: true }> {
  const request = await loadRequest(id);
  const signer = requireActiveSigner(request, recipientId, token);
  signer.status = "declined";
  signer.declineReason = reason;
  signer.declinedAt = new Date();
  request.status = "declined";
  await updateSignRequest(request);

  await sendDeclineNotices(request, signer, reason);

  return { ok: true };
}
