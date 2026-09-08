import type { NextFunction, Request, Response } from "express";
import { normalizeProductName, verifyToken } from "../modules/auth/auth.service";
import { AppError } from "../utils/appError";
import { asyncHandler } from "../utils/async-handler";

/**
 * Requires a caller to present the token issued for their Salesforce org.
 *
 * Applied to the sender-facing routes only. The signing ceremony is deliberately left open:
 * signers are not Salesforce users, they arrive from an emailed link, and their per-signer
 * token is what authorises them. Putting this in front of those routes would break every
 * signing link in circulation.
 */

export type OrgContext = { orgId: string; productName: string };

declare module "express-serve-static-core" {
  interface Request {
    org?: OrgContext;
  }
}

function bearer(header: string | undefined): string {
  if (!header) return "";
  // Tolerate the quoted form the connector's Salesforce clients sometimes send.
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return "";
  return value.replace(/^"|"$/g, "");
}

function headerValue(req: Request, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value.trim() : "";
}

export const requireOrg = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req.headers.authorization);
    const orgId = headerValue(req, "org-id");

    if (!token || !orgId) {
      throw new AppError(
        "Authentication required. Send an Authorization bearer token and an org-id header.",
        401,
        "UNAUTHENTICATED"
      );
    }

    const productName = normalizeProductName(req.headers["product-name"]);
    const claim = await verifyToken({ orgId, productName, token });

    req.org = { orgId: claim.user, productName: claim.productName };
    next();
  }
);

/** The authenticated org, for handlers that run behind `requireOrg`. */
export function orgOf(req: Request): OrgContext {
  if (!req.org) {
    // Only reachable if a route is mounted without the middleware.
    throw new AppError("Authentication required.", 401, "UNAUTHENTICATED");
  }
  return req.org;
}
