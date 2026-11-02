import crypto from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import {
  exchangeCodeForTokens,
  getLoginUrl,
  refreshSalesforceToken,
  sfRequest,
} from "../../integrations/salesforce";
import { AppError } from "../../utils/appError";
import { asyncHandler } from "../../utils/async-handler";
import { generateToken, verifyToken, verifyTokenIgnoreExpiry } from "../../utils/jwt";
import { findOrgSession, updateOrgSession } from "./org-session.repository";

/**
 * Salesforce sign-in, ported from `360_File_Connector_Node/src/controllers/authController.js`.
 *
 * Same six handlers, same request and response bodies, so the Word add-in's `Services/auth.ts`
 * works against this service unchanged. Responses are plain JSON rather than this repo's
 * `sendSuccess` envelope for the same reason — the add-in reads `tokens.access_token` and
 * `data.jwt` straight off the body.
 *
 * Two ways in, both ending with an org row and an app JWT:
 *
 *   Admin    getToken -> Salesforce -> handleCallback
 *   Add-in   (its own PKCE) -> exchangeToken
 *
 * `exchangeToken` refuses an org that has never been through the admin flow: an org is enabled
 * by an admin authorising it, not by whoever opens the add-in first.
 */

const NOT_INSTALLED =
  "360 Smart Sign isn't installed. Please install or contact your admin";

function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("Missing or invalid Authorization header", 401);
  }
  return header.split(" ")[1].replace(/^"|"$/g, "");
}

/** POST /auth/token — the add-in exchanges the code from its own PKCE flow. */
export const exchangeToken = asyncHandler(async (req: Request, res: Response) => {
  const { code, code_verifier, redirect_uri, environment } = req.body ?? {};

  if (!code) {
    throw new AppError("Missing required field: code", 400);
  }

  const data = await exchangeCodeForTokens({
    code,
    code_verifier,
    redirect_uri: redirect_uri || env.SF_REDIRECT_URI,
    environment,
  });

  // The token response's `id` is the identity URL for whoever just authorised.
  const userInfo = await sfRequest<{ organization_id: string }>(
    { accessToken: data.access_token },
    data.id
  );
  const orgId = userInfo.data.organization_id;

  const session = await findOrgSession(orgId);
  if (!session) {
    throw new AppError(NOT_INSTALLED, 400);
  }

  const jwt = generateToken({
    orgId,
    environmentType: environment || "production",
    instanceUrl: session.instance_url,
  });

  return res.json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    instance_url: data.instance_url,
    id: data.id,
    jwt,
  });
});

/** POST /auth/refresh — swap a caller's own Salesforce refresh token. */
export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const { refresh_token, environment } = req.body ?? {};

  if (!refresh_token) {
    throw new AppError("Missing required field: refresh_token", 400);
  }

  const data = await refreshSalesforceToken({ refresh_token, environment });

  return res.json({
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh_token,
    instance_url: data.instance_url,
    id: data.id,
  });
});

/**
 * POST /getToken — starts a sign-in.
 *
 * Returns the authorize URL to open. PKCE, with the verifier carried in `state` so the
 * callback can complete the exchange without a server-side record.
 *
 * Unlike the connector's, this issues no JWT. Anyone can call it, so a JWT here would be valid
 * for any org id they named. `handleCallback` creates the row from the identity Salesforce
 * returns, and hands the JWT back through the popup. Salesforce itself does not call this: it
 * reaches this service with the connector's token, through `authenticateTokenV1`.
 */
export const getToken = asyncHandler(async (req: Request, res: Response) => {
  const { environmentType } = req.body ?? {};

  if (!environmentType) {
    throw new AppError("Missing required field: environmentType", 400);
  }

  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const state = Buffer.from(JSON.stringify({ environmentType, codeVerifier })).toString(
    "base64url"
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.SF_CLIENT_ID,
    redirect_uri: env.SF_SERVER_CALLBACK_URI,
    scope: "api refresh_token",
    prompt: "select_account consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  const authUrl = `${getLoginUrl(environmentType)}/services/oauth2/authorize?${params}`;

  return res.json({ authUrl });
});

/**
 * GET /auth/callback — where Salesforce sends the admin back.
 *
 * Renders a page rather than JSON: a person is looking at this window. It tells the opener
 * the flow finished and closes itself.
 */
export const handleCallback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  };

  // Salesforce reports a refused authorization by redirecting here with `error` rather than
  // `code`. Surface what it said — "Missing code or state" would send anyone reading this
  // looking in the wrong place.
  if (error) {
    logger.warn("Salesforce refused the authorization", { error, error_description });
    throw new AppError(error_description || error, 400, "OAUTH_DENIED");
  }

  if (!code || !state) {
    throw new AppError("Missing code or state in callback", 400);
  }

  const { environmentType, codeVerifier } = JSON.parse(
    Buffer.from(state, "base64url").toString()
  ) as { environmentType: string; codeVerifier: string };

  const data = await exchangeCodeForTokens({
    code,
    code_verifier: codeVerifier,
    redirect_uri: env.SF_SERVER_CALLBACK_URI,
    environment: environmentType,
  });

  const userInfo = await sfRequest<{ username: string; organization_id: string }>(
    { accessToken: data.access_token },
    data.id
  );
  const { username, organization_id: orgId } = userInfo.data;

  await updateOrgSession(orgId, {
    username,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    instance_url: data.instance_url,
    loginTypeSF: environmentType || "production",
    tokenExpiry: new Date(Date.now() + 2 * 60 * 60 * 1000),
  });

  // The console never sees this response — the callback runs in the popup it opened — so the
  // JWT rides back on the postMessage. Targeted at FRONTEND_URL rather than "*", since a
  // wildcard would hand the token to whatever else happened to be listening. Both values go
  // through JSON.stringify so neither can break out of the script.
  const jwt = generateToken({
    orgId,
    environmentType: environmentType || "production",
    instanceUrl: data.instance_url ?? null,
  });

  // Two `helmet()` defaults have to be relaxed for this one response, and only this one.
  //
  // `script-src 'self'` blocks the inline script below, so the page would render but never
  // post the token or close itself. A per-request nonce authorises exactly this script
  // instead of loosening the policy everywhere.
  //
  // `Cross-Origin-Opener-Policy: same-origin` is the subtler one: it puts this page in its
  // own browsing context group, which severs `window.opener`. The script then silently posts
  // nothing and the popup just closes. A sign-in popup exists to talk to its opener, so this
  // page opts out.
  const nonce = crypto.randomBytes(16).toString("base64");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`
  );
  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");

  return res.send(`
    <html>
    <head>
      <title>Authorization Successful</title>
      <style>
      body {
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background-color: #f4f6f9;
      }
      .container {
        text-align: center;
        background: white;
        padding: 30px 40px;
        border-radius: 10px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      }
      </style>
    </head>
    <body>
      <div class="container">
      <h2>&#9989; Authorization Successful</h2>
      <p id="note"></p>
      </div>

      <script nonce="${nonce}">
      // Say so rather than closing silently if the opener is gone: a popup that vanishes and
      // a console that never signs in look identical from the outside, and this is the one
      // fact that tells them apart.
      if (window.opener) {
        window.opener.postMessage(
          {
            status: 'success',
            jwt: ${JSON.stringify(jwt)},
            orgId: ${JSON.stringify(orgId)},
            username: ${JSON.stringify(username ?? null)}
          },
          ${JSON.stringify(env.FRONTEND_URL)}
        );

        // Give user 1.5 seconds to see message before closing
        setTimeout(() => {
          window.close();
        }, 1500);
      } else {
        document.getElementById('note').textContent =
          'Signed in, but this window lost its link to the console. Close it and try again.';
      }
      </script>
    </body>
    </html>
  `);
});

/** POST /auth/refresh-jwt — reissue the app JWT while the org row still exists. */
export const refreshJwt = asyncHandler(async (req: Request, res: Response) => {
  const token = bearer(req);

  let decoded;
  try {
    decoded = verifyTokenIgnoreExpiry(token);
  } catch {
    throw new AppError("Invalid token", 401);
  }

  const session = await findOrgSession(decoded.orgId);
  if (!session) {
    throw new AppError("Session not found. Please log in again.", 401);
  }

  return res.json({
    jwt: generateToken({
      orgId: decoded.orgId,
      environmentType: decoded.environmentType,
      instanceUrl: decoded.instanceUrl,
    }),
  });
});

/** GET /verify-jwt — is the JWT good, and does the org's Salesforce session still answer? */
export const verifyJwt = asyncHandler(async (req: Request, res: Response) => {
  const token = bearer(req);

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    throw new AppError("Invalid or expired JWT", 401);
  }

  const session = await findOrgSession(decoded.orgId);
  if (!session) {
    throw new AppError("Session not found. Please log in again.", 401);
  }
  if (!session.accessToken) {
    throw new AppError(
      "No Salesforce access token on record. Please re-authenticate.",
      401
    );
  }

  // Through sfRequest, so an expired access token is refreshed rather than reported.
  await sfRequest(session, `${getLoginUrl(session.loginTypeSF)}/services/oauth2/userinfo`);

  return res.status(200).json({
    success: true,
    message: "JWT and Salesforce session are valid",
  });
});
