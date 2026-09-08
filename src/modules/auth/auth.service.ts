import { env } from "../../config/env";
import { AppError } from "../../utils/appError";
import { decryptJson, encryptJson, safeEqual } from "../../utils/crypto";
import { findOrgToken, upsertOrgToken } from "./org-token.repository";

/**
 * Org authentication, following the connector's `tokengenerationV1` /
 * `authenticateTokenV1` pair.
 *
 * A caller registers a Salesforce org id and receives a token; every later request presents
 * that token together with the same org id. The token is an encrypted claim rather than a
 * random string, so a presented token can be checked both against what is stored and
 * against the org id in the headers.
 *
 * Registration is deliberately open, as it is in the connector: anything shaped like an org
 * id is accepted. That means this identifies a caller rather than proving who they are —
 * anyone who knows an org id can obtain its token. Gating it behind a shared secret or a
 * Salesforce userinfo check is the natural next step.
 */

export type OrgClaim = {
  /** Named `user` to match the connector's payload, which stores the org id under it. */
  user: string;
  productName: string;
  issuedAt: string;
};

/** Salesforce org ids are 15 or 18 characters; the connector accepts the range between. */
const ORG_ID_RE = /^[A-Za-z0-9]{15,18}$/;

export function normalizeProductName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  return name || env.DEFAULT_PRODUCT_NAME;
}

function assertOrgId(orgId: string): void {
  if (!ORG_ID_RE.test(orgId)) {
    throw new AppError(
      "org-id must be a 15 to 18 character Salesforce organization id.",
      400,
      "INVALID_ORG_ID"
    );
  }
}

export async function issueToken(input: {
  orgId: string;
  productName: string;
  userEmail?: string;
}): Promise<{ token: string; orgId: string; productName: string }> {
  const orgId = input.orgId.trim();
  assertOrgId(orgId);

  const claim: OrgClaim = {
    user: orgId,
    productName: input.productName,
    issuedAt: new Date().toISOString(),
  };

  const token = encryptJson(claim);

  await upsertOrgToken({
    orgId,
    productName: input.productName,
    token,
    userEmail: input.userEmail?.trim() || null,
  });

  return { token, orgId, productName: input.productName };
}

const DENIED = new AppError(
  "You are not authorized to access this resource.",
  403,
  "FORBIDDEN"
);

/**
 * Checks a presented token three ways: it must decrypt, its claim must name the same org
 * and product as the headers, and it must equal the token on record. The last is what makes
 * re-registering an org invalidate the tokens issued to it before.
 */
export async function verifyToken(input: {
  orgId: string;
  productName: string;
  token: string;
}): Promise<OrgClaim> {
  const claim = decryptJson<OrgClaim>(input.token);

  if (!claim || claim.user !== input.orgId || claim.productName !== input.productName) {
    throw DENIED;
  }

  const stored = await findOrgToken(input.orgId, input.productName);
  if (!stored || !safeEqual(stored.token, input.token)) {
    throw DENIED;
  }

  return claim;
}
