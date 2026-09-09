import type { Request, Response } from "express";
import { orgIdOf } from "../../middleware/sfAuth.middleware";
import { sendSuccess } from "../../utils/api-response";
import { AppError } from "../../utils/appError";
import { asyncHandler } from "../../utils/async-handler";
import {
  cancel,
  completeSigning,
  create,
  createDraft,
  declineSigning,
  getById,
  getDocumentPdf,
  getDraftPdf,
  getSession,
  list,
  remind,
  saveFieldValue,
  saveFieldValues,
  sendDraft,
  stats,
} from "./sign-request.service";
import {
  parseCeremonyAuth,
  parseCompleteBody,
  parseDeclineBody,
  parseListQuery,
  parseRemindBody,
  parseSaveFieldBody,
  parseSaveFieldsBody,
  parseSendDraftBody,
  parseSignersField,
} from "./sign-request.validation";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * The uploaded file name reaches this header verbatim. A quote would break out of the
 * quoted string and a control character makes setHeader throw, so strip both.
 */
function safeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^\w.\- ]+/g, "_").trim();
  return cleaned || "document.pdf";
}

export const createSignRequest = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) {
    throw new AppError(
      'No document uploaded. Send a Word .docx in the "document" field.',
      400,
      "MISSING_DOCUMENT"
    );
  }

  const signers = parseSignersField(req.body.signers);
  const result = await create({
    orgId: orgIdOf(req),
    file: req.file.buffer,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype || DOCX_MIME,
    signers,
  });

  return sendSuccess(res, result, 201);
});

export const createSignRequestDraft = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) {
    throw new AppError(
      'No document uploaded. Send a Word .docx in the "document" field.',
      400,
      "MISSING_DOCUMENT"
    );
  }

  const result = await createDraft({
    orgId: orgIdOf(req),
    file: req.file.buffer,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype || DOCX_MIME,
  });

  return sendSuccess(res, result, 201);
});

export const getSignRequestDraftDocument = asyncHandler(
  async (req: Request, res: Response) => {
    const token = typeof req.query.t === "string" ? req.query.t : "";
    if (!token) {
      throw new AppError("This draft is no longer available.", 404, "DRAFT_NOT_FOUND");
    }

    const { buffer, fileName } = await getDraftPdf(req.params.id, token);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeFileName(fileName)}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(buffer);
  }
);

export const sendSignRequestDraft = asyncHandler(async (req: Request, res: Response) => {
  const body = parseSendDraftBody(req.body);
  const result = await sendDraft(req.params.id, body.t, orgIdOf(req), {
    signers: body.signers,
    fields: body.fields,
  });
  return sendSuccess(res, result, 201);
});

export const listSignRequests = asyncHandler(async (req: Request, res: Response) => {
  const { limit, skip } = parseListQuery(req.query);
  const { items, total } = await list(orgIdOf(req), limit, skip);
  return sendSuccess(res, { items, total, limit, skip });
});

export const getSignRequestStats = asyncHandler(async (req: Request, res: Response) => {
  return sendSuccess(res, await stats(orgIdOf(req)));
});

export const getSignRequest = asyncHandler(async (req: Request, res: Response) => {
  const result = await getById(req.params.id, orgIdOf(req));
  return sendSuccess(res, result);
});

export const cancelSignRequest = asyncHandler(async (req: Request, res: Response) => {
  const result = await cancel(req.params.id, orgIdOf(req));
  return sendSuccess(res, result);
});

export const remindSignRequest = asyncHandler(async (req: Request, res: Response) => {
  const { recipientId } = parseRemindBody(req.body);
  const result = await remind(req.params.id, orgIdOf(req), recipientId);
  return sendSuccess(res, result);
});

export const getSignRequestSession = asyncHandler(async (req: Request, res: Response) => {
  const { recipientId, t } = parseCeremonyAuth({
    recipientId: req.query.recipientId,
    t: req.query.t,
  });
  const result = await getSession(req.params.id, recipientId, t);
  return sendSuccess(res, result);
});

export const getSignRequestDocument = asyncHandler(async (req: Request, res: Response) => {
  const token = typeof req.query.t === "string" ? req.query.t : "";
  if (!token) {
    throw new AppError("This signing link is invalid or has expired.", 404, "INVALID_LINK");
  }
  const { buffer, fileName } = await getDocumentPdf(req.params.id, token);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${safeFileName(fileName)}"`);
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(buffer);
});

export const saveSignRequestField = asyncHandler(async (req: Request, res: Response) => {
  const body = parseSaveFieldBody(req.body);
  const result = await saveFieldValue(
    req.params.id,
    req.params.fieldId,
    body.recipientId,
    body.t,
    body.value
  );
  return sendSuccess(res, result);
});

export const saveSignRequestFields = asyncHandler(async (req: Request, res: Response) => {
  const body = parseSaveFieldsBody(req.body);
  const result = await saveFieldValues(req.params.id, body.recipientId, body.t, body.values);
  return sendSuccess(res, result);
});

export const completeSignRequest = asyncHandler(async (req: Request, res: Response) => {
  const body = parseCompleteBody(req.body);
  const result = await completeSigning(req.params.id, body.recipientId, body.t);
  return sendSuccess(res, result);
});

export const declineSignRequest = asyncHandler(async (req: Request, res: Response) => {
  const body = parseDeclineBody(req.body);
  const result = await declineSigning(req.params.id, body.recipientId, body.t, body.reason);
  return sendSuccess(res, result);
});
