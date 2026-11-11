import { Router } from "express";
import { sfAuthMiddleware } from "../../middleware/sfAuth.middleware";
import { uploadDocument } from "../../middleware/upload.middleware";
import {
  cancelSignRequest,
  completeSignRequest,
  consentSignRequest,
  createSignRequest,
  createSignRequestDraft,
  declineSignRequest,
  getSignRequest,
  getSignRequestDocument,
  getSignRequestDraftDocument,
  getSignRequestSession,
  getSignRequestStats,
  listSignRequests,
  remindSignRequest,
  saveSignRequestField,
  saveSignRequestFields,
  sendSignRequestDraft,
} from "./sign-request.controller";

const router = Router();

/*
 * Two audiences share this router.
 *
 * Sender routes belong to a Salesforce org and carry `sfAuthMiddleware`, which scopes every
 * query to that org. Signer routes are reached from an emailed link by someone who has no
 * org and no account; their per-signer token is the credential, and putting the middleware
 * in front of them would break every signing link in circulation. The draft document is
 * served the same way, because the prepare screen renders it in an element that cannot set
 * headers.
 */

// Drafts are declared before "/:id" so the literal segment is not swallowed by the param.
router.post("/drafts", sfAuthMiddleware, uploadDocument, createSignRequestDraft);
router.get("/drafts/:id/document", getSignRequestDraftDocument);
router.post("/drafts/:id/send", sfAuthMiddleware, sendSignRequestDraft);

router.post("/", sfAuthMiddleware, uploadDocument, createSignRequest);
router.get("/", sfAuthMiddleware, listSignRequests);
// Also ahead of "/:id", which would otherwise capture "stats" as an envelope id.
router.get("/stats", sfAuthMiddleware, getSignRequestStats);
router.get("/:id", sfAuthMiddleware, getSignRequest);
router.post("/:id/cancel", sfAuthMiddleware, cancelSignRequest);
router.post("/:id/remind", sfAuthMiddleware, remindSignRequest);

// ---- Signer-facing: authorised by the per-signer token in the link ----
router.get("/:id/session", getSignRequestSession);
router.get("/:id/document", getSignRequestDocument);
router.post("/:id/consent", consentSignRequest);
// Batch first: the ceremony fills several fields at once, and one request per field races.
router.put("/:id/fields", saveSignRequestFields);
router.put("/:id/fields/:fieldId", saveSignRequestField);
router.post("/:id/complete", completeSignRequest);
router.post("/:id/decline", declineSignRequest);

export const signRequestRoutes = router;
