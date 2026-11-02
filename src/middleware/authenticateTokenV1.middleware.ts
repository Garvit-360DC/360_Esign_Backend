import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { findDbToken } from "../modules/auth/org-session.repository";
import { asyncHandler } from "../utils/async-handler";
import { decryptJsonDataWithKeys } from "../utils/cryptoGraphy";

/**
 * Ported from `authenticateTokenV1` in `360_File_Connector_Node/src/middlewares/auth.js`.
 *
 * Applied to the routes Salesforce calls. Apex already sends the connector's token with the
 * `org-id` and `product-name` headers, so the same `dbtokens` row authorises both services.
 *
 * Two deliberate differences from the original: a token that fails to parse is refused rather
 * than left to throw, and a 401 carries a `message`, which is what the Apex client reads.
 * `req.sfUser` holds app claims here, as it does behind `sfAuthMiddleware`, so `orgIdOf` works
 * behind either one.
 */

type NodeTokenClaims = { user?: string; productName?: string };

declare module "express-serve-static-core" {
  interface Request {
    nodeTokenUser?: NodeTokenClaims;
  }
}

const NOT_AUTHORIZED = "you are not authorized to access this resource";

function decrypt(value: string | null | undefined): string | null {
  return decryptJsonDataWithKeys(
    value,
    env.NODE_TOKEN_ENCRYPTION_KEY,
    env.NODE_TOKEN_ENCRYPTION_IV
  );
}

function parseClaims(value: string | null): NodeTokenClaims | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as NodeTokenClaims;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

export const authenticateTokenV1 = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const token = req.header("Authorization");
    const orgId = firstString(req.headers["org-id"], req.body?.org_id, req.query?.org_id);
    const productName = firstString(
      req.headers["product-name"],
      req.body?.productName,
      req.query?.productName,
      env.DEFAULT_APP_NAME
    );

    const jwtToken = token?.split(" ")[1]?.replace(/"/g, "");
    if (!jwtToken) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    if (!orgId || !productName) {
      res.status(403).json({ message: NOT_AUTHORIZED });
      return;
    }

    const tokenExist = await findDbToken(orgId, productName);
    if (!tokenExist) {
      res.status(403).json({ message: NOT_AUTHORIZED });
      return;
    }

    // The stored token is encrypted twice, the one in the request once.
    const parseDBToken = parseClaims(decrypt(decrypt(tokenExist.token)));
    const parseHeaderToken = parseClaims(decrypt(jwtToken));

    const user = parseHeaderToken?.user;
    const allowed =
      !!parseDBToken &&
      !!user &&
      parseDBToken.user === user &&
      parseDBToken.user === orgId &&
      parseDBToken.productName === parseHeaderToken?.productName &&
      (user.length === 15 || user.length === 18);

    if (!allowed) {
      res.status(403).json({ message: NOT_AUTHORIZED });
      return;
    }

    req.nodeTokenUser = parseHeaderToken ?? undefined;
    req.sfSession = tokenExist;
    req.sfConn = tokenExist;
    req.sfUser = {
      orgId,
      environmentType: tokenExist.loginTypeSF,
      instanceUrl: tokenExist.instance_url,
    };
    next();
  }
);
