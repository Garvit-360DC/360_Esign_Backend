import { randomBytes } from "node:crypto";
import { logger } from "../../config/logger";
import { convertDocxToPdf } from "../../integrations/convertapi";
import {
  downloadContentVersion,
  linkFileToRecord,
  uploadContentVersion,
  type OrgDetails,
} from "../../integrations/salesforce";
import { AppError } from "../../utils/appError";
import { buildDraftDocumentUrl } from "../sign-requests/sign-request.mapper";
import { createDraftRecord, findDraft } from "../sign-requests/sign-request.drafts";
import { prepareConvertedPdf } from "../sign-requests/sign-request.service";
import { getFileBuffer, saveDocumentFile } from "../sign-requests/sign-request.repository";
import { isDrawnField, signerLabel } from "../sign-requests/sign-request.types";
import type { DraftView } from "../sign-requests/sign-request.types";
import {
  createTemplate,
  deactivateTemplate,
  findTemplateByKey,
  listTemplates,
} from "./template.repository";
import type { CreateTemplateInput, Template, TemplateSummary } from "./template.types";

/**
 * Saving and reading templates.
 *
 * Templates live in Salesforce, so nothing is written to MongoDB here and every read is
 * scoped to the caller's org by virtue of running as that org's Salesforce session.
 */

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Opaque handle, so a request never carries a raw Salesforce record id. */
function newTemplateKey(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Every signer slot needs somewhere to sign and every box needs a recipient.
 *
 * The same rule the send path enforces (`assertSignersMatchFields`), applied when the
 * template is saved rather than when someone first tries to use it — a template that cannot
 * be sent is worth rejecting at the point it is created.
 */
function assertSendable(input: CreateTemplateInput): void {
  if (input.recipients.length === 0) {
    throw new AppError("A template needs at least one recipient.", 400, "NO_RECIPIENTS");
  }
  if (input.fields.length === 0) {
    throw new AppError("A template needs at least one field.", 400, "NO_FIELDS");
  }

  const roles = input.recipients.map((recipient) => recipient.role);
  if (new Set(roles).size !== roles.length) {
    throw new AppError("Each recipient role must be unique.", 400, "DUPLICATE_ROLE");
  }

  const signers = input.recipients.filter(
    (recipient) => (recipient.recipientType ?? "SIGNER") === "SIGNER"
  );

  const signable = new Set(
    input.fields.filter((field) => isDrawnField(field.type)).map((field) => field.role)
  );

  const unsigned = signers.filter((recipient) => !signable.has(recipient.role));
  if (unsigned.length) {
    throw new AppError(
      `No signature or initial box has been placed for: ${unsigned
        .map((recipient) => recipient.label || signerLabel(recipient.role))
        .join(", ")}`,
      400,
      "SIGNER_SLOT_MISSING"
    );
  }

  const known = new Set(roles);
  const orphans = [...new Set(input.fields.map((field) => field.role))].filter(
    (role) => !known.has(role)
  );
  if (orphans.length) {
    throw new AppError(
      `A recipient is required for: ${orphans.map(signerLabel).join(", ")}`,
      400,
      "SIGNER_REQUIRED"
    );
  }

  // A CC never signs, so a box addressed to one could never be filled.
  const ccRoles = new Set(
    input.recipients
      .filter((recipient) => recipient.recipientType === "CC")
      .map((recipient) => recipient.role)
  );
  const ccWithFields = [...new Set(input.fields.map((field) => field.role))].filter((role) =>
    ccRoles.has(role)
  );
  if (ccWithFields.length) {
    throw new AppError(
      `A copied recipient cannot be given fields to fill: ${ccWithFields
        .map(signerLabel)
        .join(", ")}`,
      400,
      "CC_HAS_FIELDS"
    );
  }
}

/**
 * Saves a prepared draft as a reusable template.
 *
 * The draft already holds the uploaded .docx and the boxes as positioned on the prepare
 * screen, so this uploads that same file to Salesforce as a ContentVersion and records the
 * layout against it. The draft is left alone — the sender may still want to send it.
 */
export async function saveDraftAsTemplate(
  session: OrgDetails,
  orgId: string,
  draftId: string,
  draftToken: string,
  input: CreateTemplateInput
): Promise<Template> {
  const draft = await findDraft(draftId);

  if (!draft || draft.token !== draftToken || draft.orgId !== orgId) {
    throw new AppError("This draft is no longer available.", 404, "DRAFT_NOT_FOUND");
  }

  assertSendable(input);

  const document = await getFileBuffer(draft.fileId);
  const key = newTemplateKey();

  const contentVersionId = await uploadContentVersion(session, {
    buffer: document,
    fileName: draft.fileName,
    title: input.name,
  });

  const templateId = await createTemplate(session, key, input, {
    contentVersionId,
    fileName: draft.fileName,
    pageCount: draft.pageCount,
  });

  // Best-effort: the document is already stored and referenced by id, so the template works
  // either way. This only decides whether a Salesforce admin can open it from the record.
  try {
    await linkFileToRecord(session, contentVersionId, templateId);
  } catch (error) {
    logger.warn("Could not attach the template document to its record", {
      templateId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const saved = await findTemplateByKey(session, key);
  if (!saved) {
    throw new AppError("The template was saved but could not be read back.", 502, "SALESFORCE_ERROR");
  }

  return saved;
}

/**
 * Starts an envelope from a template.
 *
 * Produces the same `DraftView` the upload path produces, so the prepare screen opens exactly
 * as it would for a hand-uploaded document — only with the boxes already in place. The
 * template's boxes are already `PlacedField`s, which is the point of having kept one geometry
 * contract from the Word add-in through to the PDF stamper: nothing is converted here.
 */
export async function createDraftFromTemplate(
  session: OrgDetails,
  orgId: string,
  key: string
): Promise<DraftView> {
  const template = await getByKey(session, key);

  if (!template.documentVersionId) {
    throw new AppError(
      "This template has no document attached.",
      409,
      "TEMPLATE_HAS_NO_DOCUMENT"
    );
  }

  const { buffer } = await downloadContentVersion(session, template.documentVersionId);
  const fileName = template.documentName ?? `${template.name}.docx`;

  // A document prepared with the Word add-in still carries its placeholder pictures. Paint them
  // out, or they show behind every box — including ones the template has since moved or dropped.
  // Detection is used only to find that artwork: the template's own boxes decide where fields go.
  const { pdf, pageCount } = await prepareConvertedPdf(
    buffer,
    await convertDocxToPdf(buffer, fileName)
  );

  const fileId = await saveDocumentFile(buffer, fileName, DOCX_MIME);
  const pdfFileId = await saveDocumentFile(
    pdf,
    fileName.replace(/\.docx$/i, "") + ".pdf",
    "application/pdf"
  );

  const draft = await createDraftRecord({
    orgId,
    templateKey: template.key,
    token: newTemplateKey(),
    fileName,
    fileId,
    pdfFileId,
    pageCount,
    mimeType: DOCX_MIME,
    fields: template.fields.map((field) => ({
      role: field.role,
      type: field.type,
      page: field.page,
      rect: field.rect,
      source: field.source,
    })),
  });

  return {
    id: draft.id,
    token: draft.token,
    fileName: draft.fileName,
    pageCount: draft.pageCount,
    documentUrl: buildDraftDocumentUrl(draft.id, draft.token),
    fields: draft.fields,
    needsPlacement: false,
    templateKey: template.key,
    templateName: template.name,
    // CC recipients hold no boxes and occupy no signer slot, so the send path would reject
    // one. They are stored on the template but never become a signer row.
    recipients: template.recipients
      .filter((recipient) => recipient.recipientType === "SIGNER")
      .map((recipient) => ({
        role: recipient.role,
        label: recipient.label,
        defaultName: recipient.defaultName,
        defaultEmail: recipient.defaultEmail,
      })),
  };
}

export async function list(
  session: OrgDetails,
  options: { sObjectName?: string; includeInactive?: boolean }
): Promise<TemplateSummary[]> {
  return listTemplates(session, options);
}

export async function getByKey(session: OrgDetails, key: string): Promise<Template> {
  const template = await findTemplateByKey(session, key);

  if (!template) {
    throw new AppError("Template not found.", 404, "NOT_FOUND");
  }

  return template;
}

export async function deactivate(session: OrgDetails, key: string): Promise<void> {
  const template = await getByKey(session, key);
  await deactivateTemplate(session, template.id);
}
