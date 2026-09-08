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

  const error = isZodError(err)
    ? formatZodError(err)
    : err instanceof AppError
      ? err
      : multerCode === "LIMIT_FILE_SIZE"
        ? new AppError("Document is too large (max 25MB)", 413, "FILE_TOO_LARGE")
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
      ...(env.NODE_ENV === "development" && err instanceof Error && err.stack
        ? { stack: err.stack }
        : {}),
    },
  });
}

export function unknownRoute(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404, "NOT_FOUND"));
}
