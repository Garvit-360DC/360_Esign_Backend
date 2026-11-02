import type { Request, Response } from "express";
import { orgIdOf } from "../../middleware/sfAuth.middleware";
import { AppError } from "../../utils/appError";
import { asyncHandler } from "../../utils/async-handler";
import {
  cancel,
  createSalesforceEnvelope,
  getSignedPdf,
  sendSalesforceEnvelope,
} from "../sign-requests/sign-request.service";
import { isSignerRole, type SignRequest, type SignerRole } from "../sign-requests/sign-request.types";
import { createEnvelopeSchema, voidEnvelopeSchema, type CreateEnvelopeBody } from "./envelope.validation";

/**
 * The API `InstantSignServiceClient.cls` calls. Responses are plain JSON, not this repo's
 * `sendSuccess` envelope, because that is what the client parses: `id`, `status`, and
 * `recipients` with `id` and `roleKey`. Signing links are deliberately not returned, since they
 * would end up stored in Salesforce.
 */

function toEnvelopeResponse(request: {
  id: string;
  status: SignRequest["status"];
  signers: { id: string; role: SignerRole }[];
}) {
  return {
    id: request.id,
    status: request.status,
    recipients: request.signers.map((signer) => ({ id: signer.id, roleKey: signer.role })),
  };
}

/** Requests Salesforce can form today that this version can't honour. Better refused than lost. */
function assertSupported(body: CreateEnvelopeBody) {
  if (body.appendSignaturePage) {
    throw new AppError(
      "This template has no signer boxes. Add them in the Word add-in before sending for signature.",
      400,
      "APPEND_PAGE_UNSUPPORTED"
    );
  }

  for (const recipient of body.recipients) {
    if (recipient.verification !== "None") {
      throw new AppError(
        `${recipient.verification} verification is not available yet.`,
        400,
        "VERIFICATION_UNSUPPORTED"
      );
    }
    if (recipient.role === "CC") {
      throw new AppError("Copy recipients are not available yet.", 400, "CC_UNSUPPORTED");
    }
    if (!isSignerRole(recipient.roleKey)) {
      throw new AppError(
        `Signer role "${recipient.roleKey}" must look like signer1, signer2, ...`,
        400,
        "VALIDATION_ERROR"
      );
    }
  }

  const roles = body.recipients.map((recipient) => recipient.roleKey);
  if (new Set(roles).size !== roles.length) {
    throw new AppError("Each signer role must be unique.", 400, "VALIDATION_ERROR");
  }
}

/** POST /v1/envelopes */
export const createEnvelope = asyncHandler(async (req: Request, res: Response) => {
  const body = createEnvelopeSchema.parse(req.body);
  assertSupported(body);

  if (!req.sfConn) {
    throw new AppError("Authentication required", 401, "UNAUTHENTICATED");
  }

  const created = await createSalesforceEnvelope({
    orgId: orgIdOf(req),
    session: req.sfConn,
    documentVersionId: body.documentVersionId,
    documentName: body.documentName,
    subject: body.subject,
    message: body.message,
    signers: body.recipients.map((recipient) => ({
      role: recipient.roleKey as SignerRole,
      name: recipient.name,
      email: recipient.email,
      order: recipient.order,
      salesforceRecipientId: recipient.salesforceRecipientId,
    })),
    salesforce: {
      productName: req.sfConn.productName,
      documentVersionId: body.documentVersionId,
      callbackUrl: body.callbackUrl,
      salesforceRequestId: body.salesforceRequestId,
      sourceObjectType: body.sourceObjectType,
      sourceObjectId: body.sourceObjectId,
      routingType: body.routingType,
      expiresInDays: body.expiresInDays,
      remindEveryDays: body.remindEveryDays,
      branding: body.branding,
    },
  });

  return res.status(201).json(toEnvelopeResponse(created));
});

/** POST /v1/envelopes/:id/send */
export const sendEnvelope = asyncHandler(async (req: Request, res: Response) => {
  const sent = await sendSalesforceEnvelope(req.params.id, orgIdOf(req));
  return res.json(toEnvelopeResponse(sent));
});

/** GET /v1/envelopes/:id/signed-pdf */
export const getEnvelopeSignedPdf = asyncHandler(async (req: Request, res: Response) => {
  const { buffer, fileName } = await getSignedPdf(req.params.id, orgIdOf(req));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
  return res.send(buffer);
});

/**
 * GET /v1/envelopes/:id/certificate
 *
 * Salesforce asks for this every time an envelope completes, and writes the reason it failed to
 * the request's `Writeback_Result__c`. So it gets a sentence rather than a bare route-not-found.
 */
export const getEnvelopeCertificate = asyncHandler(async () => {
  throw new AppError("Certificates of completion are not available yet.", 404, "NOT_AVAILABLE");
});

/** POST /v1/envelopes/:id/void */
export const voidEnvelope = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = voidEnvelopeSchema.parse(req.body ?? {});
  const voided = await cancel(req.params.id, orgIdOf(req), reason);
  return res.json(toEnvelopeResponse(voided));
});
