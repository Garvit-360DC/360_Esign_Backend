import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../utils/appError";
import { isZodError, formatZodError } from "./validation.middleware";

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) {
  if (res.headersSent) {
    next(err);
    return;
  }

  const multerCode = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: string }).code)
    : "";

  // Set by the JSON body parser, for example on a signature image far over the size limit.
  const parserType = typeof err === "object" && err !== null && "type" in err
    ? String((err as { type?: string }).type)
    : "";

  const error = isZodError(err)
    ? formatZodError(err)
    : err instanceof AppError
      ? err
      : multerCode === "LIMIT_FILE_SIZE"
        ? new AppError("Document is too large (max 25MB)", 413, "FILE_TOO_LARGE")
        : parserType === "entity.too.large"
          ? new AppError(
              "That is too large to save. If you uploaded a signature, use a smaller image.",
              413,
              "PAYLOAD_TOO_LARGE"
            )
          : parserType === "entity.parse.failed"
            ? new AppError("The request could not be read.", 400, "VALIDATION_ERROR")
            : new AppError("Internal Server Error", 500, "INTERNAL_ERROR");

  if (error.statusCode >= 500) {
    logger.error(error.message, {
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  res.status(error.statusCode).json({
    success: false,
    error: {
      message: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
      ...(env.NODE_ENV === "development" && err instanceof Error && err.stack
        ? { stack: err.stack }
        : {}),
    },
  });
}

export function unknownRoute(req: Request, _res: Response, next: NextFunction) {
  // The path only: a query string can carry a signing token, and this message is logged.
  next(new AppError(`Can't find ${req.path} on this server!`, 404, "NOT_FOUND"));
}
