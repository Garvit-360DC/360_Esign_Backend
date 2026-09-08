import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodType } from "zod";
import { AppError } from "../utils/appError";

type RequestPart = "body" | "query" | "params";

export function validate(schema: ZodType, part: RequestPart = "body") {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      throw result.error;
    }
    req[part] = result.data;
    next();
  };
}

export function isZodError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}

export function formatZodError(error: ZodError): AppError {
  const message = error.issues.map((issue) => issue.message).join("; ");
  return new AppError(message || "Invalid request", 400, "VALIDATION_ERROR");
}
