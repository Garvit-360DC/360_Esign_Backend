import { Router, type Request, type Response } from "express";
import { orgIdOf, sfAuthMiddleware } from "../../middleware/sfAuth.middleware";
import { sendSuccess } from "../../utils/api-response";
import { AppError } from "../../utils/appError";
import { asyncHandler } from "../../utils/async-handler";
import {
  createDraftFromTemplate,
  deactivate,
  getByKey,
  list,
  saveDraftAsTemplate,
} from "./template.service";
import { parseCreateTemplateBody, parseTemplateListQuery } from "./template.validation";

/**
 * Templates are stored in Salesforce, so every route here runs as the caller's org session —
 * `req.sfConn`, put there by `sfAuthMiddleware`. Org scoping is a consequence of that rather
 * than a filter this module has to remember to apply.
 */

const router = Router();

router.use(sfAuthMiddleware);

function sessionOf(req: Request) {
  const session = req.sfConn;
  if (!session?.accessToken) {
    throw new AppError(
      "No Salesforce session on record. Please connect again.",
      401,
      "SF_SESSION_EXPIRED"
    );
  }
  return session;
}

/** Saves a prepared draft as a reusable template. */
router.post(
  "/drafts/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseCreateTemplateBody(req.body);
    const { t, ...input } = body;

    const template = await saveDraftAsTemplate(
      sessionOf(req),
      orgIdOf(req),
      req.params.id,
      t,
      input
    );

    return sendSuccess(res, template, 201);
  })
);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) =>
    sendSuccess(res, await list(sessionOf(req), parseTemplateListQuery(req.query)))
  )
);

router.get(
  "/:key",
  asyncHandler(async (req: Request, res: Response) =>
    sendSuccess(res, await getByKey(sessionOf(req), req.params.key))
  )
);

/** Starts an envelope from a template: converts its document and pre-places its boxes. */
router.post(
  "/:key/draft",
  asyncHandler(async (req: Request, res: Response) =>
    sendSuccess(
      res,
      await createDraftFromTemplate(sessionOf(req), orgIdOf(req), req.params.key),
      201
    )
  )
);

/** Deactivates rather than deletes, so envelopes already sent keep their provenance. */
router.delete(
  "/:key",
  asyncHandler(async (req: Request, res: Response) => {
    await deactivate(sessionOf(req), req.params.key);
    return sendSuccess(res, { ok: true });
  })
);

export const templateRoutes = router;
