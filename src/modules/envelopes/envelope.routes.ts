import express, { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { logger } from "../../config/logger";
import { authenticateTokenV1 } from "../../middleware/authenticateTokenV1.middleware";
import { formatZodError, isZodError } from "../../middleware/validation.middleware";
import { AppError } from "../../utils/appError";
import { healthRoutes } from "../health/health.routes";
import {
  createEnvelope,
  getEnvelopeCertificate,
  getEnvelopeSignedPdf,
  sendEnvelope,
  voidEnvelope,
} from "./envelope.controller";

/**
 * Everything Salesforce calls, mounted at /v1. It sits ahead of the app's general rate limit and
 * has its own, per org: all Salesforce callouts arrive from a few shared addresses, so one busy
 * org would otherwise use up every other org's allowance.
 */

const v1RateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.headers["org-id"] ?? req.ip),
  message: { message: "Too many requests" },
});

/** The Apex client reads a top-level `message`, not this repo's `error.message`. */
function v1ErrorMiddleware(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Thrown by the body parser, for example on malformed JSON.
  const parserStatus = (err as { status?: number })?.status;

  const error = isZodError(err)
    ? formatZodError(err)
    : err instanceof AppError
      ? err
      : parserStatus && parserStatus < 500
        ? new AppError("The request body could not be read.", parserStatus, "INVALID_BODY")
        : new AppError("Internal Server Error", 500, "INTERNAL_ERROR");

  if (error.statusCode >= 500) {
    logger.error(error.message, { stack: err instanceof Error ? err.stack : undefined });
  }

  res.status(error.statusCode).json({ message: error.message, code: error.code });
}

const router = Router();

router.use(v1RateLimit);
router.use(express.json({ limit: "1mb" }));

router.use("/health", healthRoutes);

router.post("/envelopes", authenticateTokenV1, createEnvelope);
router.post("/envelopes/:id/send", authenticateTokenV1, sendEnvelope);
router.post("/envelopes/:id/void", authenticateTokenV1, voidEnvelope);
router.get("/envelopes/:id/signed-pdf", authenticateTokenV1, getEnvelopeSignedPdf);
router.get("/envelopes/:id/certificate", authenticateTokenV1, getEnvelopeCertificate);

router.use((req: Request, _res: Response, next: NextFunction) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404, "NOT_FOUND"));
});
router.use(v1ErrorMiddleware);

export const envelopeRoutes = router;
