import jwt from "jsonwebtoken";
import { env } from "../config/env";

/**
 * The app JWT, matching `360_File_Connector_Node/src/utils/jwtHelper.js`.
 *
 * Same claim names — `orgId`, `environmentType`, `instanceUrl` — and the same three
 * functions, so a token minted by either service is readable by the other and the Word
 * add-in needs no change.
 *
 * Note this signs without `expiresIn`, exactly as the connector does, so tokens do not
 * expire on their own. `verifyTokenIgnoreExpiry` and `/auth/refresh-jwt` exist for the same
 * reason they do there: a session is ended by removing the org's row, not by the clock.
 */

export type AppClaims = {
  orgId: string;
  environmentType: string;
  instanceUrl: string | null;
};

export function generateToken({ orgId, environmentType, instanceUrl }: AppClaims): string {
  return jwt.sign({ orgId, environmentType, instanceUrl }, env.JWT_SECRET);
}

export function verifyToken(token: string): AppClaims {
  return jwt.verify(token, env.JWT_SECRET) as AppClaims;
}

export function verifyTokenIgnoreExpiry(token: string): AppClaims {
  return jwt.verify(token, env.JWT_SECRET, { ignoreExpiration: true }) as AppClaims;
}
