import type { NextFunction, Request, Response } from "express";
import { logger } from "../config/logger";

/**
 * Logs each request as it arrives and again when it ends, with the reason if it failed. Only the
 * path is logged: signing links carry their token in the query string, so the query never is,
 * and neither are headers or bodies.
 */

/** The two error shapes this API sends: `{ message }` to Salesforce, `{ error }` elsewhere. */
function errorFrom(body: unknown): { message?: unknown; code?: unknown } {
  const data = body as { message?: unknown; code?: unknown; error?: { message?: unknown; code?: unknown } };
  return data?.error ?? data ?? {};
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startedAt = Date.now();
  const path = req.originalUrl.split("?")[0];
  // Polled by monitors, so only shown when LOG_LEVEL is debug.
  const quiet = path.endsWith("/health");
  const orgId = req.headers["org-id"];
  const productName = req.headers["product-name"];
  const who = { ...(orgId ? { orgId } : {}), ...(productName ? { productName } : {}) };

  if (!quiet) logger.info(`--> ${req.method} ${path}`, who);

  let failure: { message?: unknown; code?: unknown } = {};
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400) {
      const { message, code } = errorFrom(body);
      failure = { message, ...(code ? { code } : {}) };
    }
    return json(body);
  };

  res.on("close", () => {
    const meta = { ms: Date.now() - startedAt, ...who, ...failure };

    // The caller gave up first, as Salesforce does after its 120-second callout limit.
    if (!res.writableFinished) {
      logger.warn(`<-- ${req.method} ${path} closed before the response finished`, meta);
      return;
    }

    const line = `<-- ${req.method} ${path} ${res.statusCode}`;
    if (res.statusCode >= 500) logger.error(line, meta);
    else if (res.statusCode >= 400) logger.warn(line, meta);
    else if (quiet) logger.debug(line, meta);
    else logger.info(line, meta);
  });

  next();
}
