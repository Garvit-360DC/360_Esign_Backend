import { Router } from "express";
import type { Request, Response } from "express";
import { sendSuccess } from "../../utils/api-response";
import { AppError } from "../../utils/appError";
import { asyncHandler } from "../../utils/async-handler";
import { issueToken, normalizeProductName } from "./auth.service";

const router = Router();

/**
 * Registers a Salesforce org and returns the token it must present on later requests.
 *
 * The org id may come from the `org-id` header or the body, matching how the connector's
 * Salesforce clients call the equivalent endpoint.
 */
export const createOrgToken = asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { org_id?: string; orgId?: string; user_email?: string };
  const header = req.headers["org-id"];

  const orgId =
    (typeof header === "string" ? header : "") || body.org_id || body.orgId || "";

  if (!orgId.trim()) {
    throw new AppError("org-id is required", 400, "VALIDATION_ERROR");
  }

  const result = await issueToken({
    orgId,
    productName: normalizeProductName(req.headers["product-name"]),
    userEmail: body.user_email,
  });

  return sendSuccess(res, result);
});

router.post("/token", createOrgToken);

export const authRoutes = router;
