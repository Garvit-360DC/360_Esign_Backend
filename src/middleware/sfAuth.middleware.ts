import type { NextFunction, Request, Response } from "express";
import { findOrgSession, type OrgSession } from "../modules/auth/org-session.repository";
import { AppError } from "../utils/appError";
import { asyncHandler } from "../utils/async-handler";
import { verifyToken, type AppClaims } from "../utils/jwt";

/**
 * Ported from `360_File_Connector_Node/src/middlewares/sfAuth.js`.
 *
 * Verifies the app JWT, loads the org's Salesforce session, and hangs both off the request
 * as `sfUser` and `sfSession` / `sfConn` — the same names the connector's controllers read.
 *
 * Applied to the sender-facing routes only. The signing ceremony is deliberately left open:
 * signers are not Salesforce users, they arrive from an emailed link, and their per-signer
 * token is what authorises them. Putting this in front of those routes would break every
 * signing link in circulation.
 */

declare module "express-serve-static-core" {
  interface Request {
    sfUser?: AppClaims;
    sfSession?: OrgSession;
    sfConn?: OrgSession;
  }
}

export const sfAuthMiddleware = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError("Authentication required", 401, "UNAUTHENTICATED");
    }

    const token = authHeader.split(" ")[1].replace(/^"|"$/g, "");

    let decoded: AppClaims;
    try {
      decoded = verifyToken(token);
    } catch {
      throw new AppError("Invalid or expired token", 401, "INVALID_TOKEN");
    }

    const session = await findOrgSession(decoded.orgId);
    if (!session) {
      throw new AppError(
        "Salesforce session not found. Please re-authenticate.",
        401,
        "SESSION_NOT_FOUND"
      );
    }

    req.sfUser = decoded;
    req.sfSession = session;
    req.sfConn = session;
    next();
  }
);

/** The authenticated org, for handlers running behind `sfAuthMiddleware`. */
export function orgIdOf(req: Request): string {
  if (!req.sfUser) {
    // Only reachable if a route is mounted without the middleware.
    throw new AppError("Authentication required", 401, "UNAUTHENTICATED");
  }
  return req.sfUser.orgId;
}
