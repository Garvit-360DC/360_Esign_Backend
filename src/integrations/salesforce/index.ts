import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import {
  acquireRefreshLock,
  findOrgSession,
  releaseRefreshLock,
  updateOrgSession,
} from "../../modules/auth/org-session.repository";
import { AppError } from "../../utils/appError";

/**
 * Salesforce OAuth and REST, ported from the connector's `services/salesforce.js` and
 * `controllers/salesforceAccessToken.js`.
 *
 * `sfRequest` keeps the same contract: give it an org's details and a path or absolute URL,
 * and it retries once through a refresh if the access token has expired.
 */

const TIMEOUT_MS = 20_000;

/** A refresh lock older than this is assumed abandoned by a crashed process. */
const REFRESH_LOCK_TIMEOUT = 60 * 1000;

export type SalesforceTokens = {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  /** Identity URL — GET it with the access token to learn who authorised. */
  id: string;
};

/** Anything carrying enough to call Salesforce. A full org row satisfies it. */
export type OrgDetails = {
  org_id?: string;
  accessToken: string | null;
  instance_url?: string | null;
  loginTypeSF?: string;
};

export function getLoginUrl(environment?: string): string {
  return (environment || "").toLowerCase() === "sandbox"
    ? env.SF_TEST_LOGIN_URL
    : env.SF_LOGIN_URL;
}

/** Surfaces the message Salesforce actually gave rather than "Request failed". */
function salesforceError(error: unknown, fallback: string, status = 400): AppError {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error_description?: string; error?: string }
      | undefined;

    logger.error("Salesforce request failed", {
      status: error.response?.status,
      data: JSON.stringify(data ?? {}).slice(0, 500),
    });

    const message = data?.error_description || data?.error;
    if (message) return new AppError(message, status, "SALESFORCE_ERROR");
  } else {
    logger.error("Salesforce request failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return new AppError(fallback, status, "SALESFORCE_ERROR");
}

export async function exchangeCodeForTokens(input: {
  code: string;
  code_verifier?: string;
  redirect_uri: string;
  environment?: string;
}): Promise<SalesforceTokens> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: env.SF_CLIENT_ID,
    client_secret: env.SF_CLIENT_SECRET,
    redirect_uri: input.redirect_uri,
  });

  if (input.code_verifier) params.append("code_verifier", input.code_verifier);

  try {
    const { data } = await axios.post<SalesforceTokens>(
      `${getLoginUrl(input.environment)}/services/oauth2/token`,
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: TIMEOUT_MS,
      }
    );
    return data;
  } catch (error) {
    throw salesforceError(error, "Token exchange failed");
  }
}

export async function refreshSalesforceToken(input: {
  refresh_token: string;
  environment?: string;
}): Promise<SalesforceTokens> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refresh_token,
    client_id: env.SF_CLIENT_ID,
    client_secret: env.SF_CLIENT_SECRET,
  });

  try {
    const { data } = await axios.post<SalesforceTokens>(
      `${getLoginUrl(input.environment)}/services/oauth2/token`,
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: TIMEOUT_MS,
      }
    );
    return data;
  } catch (error) {
    throw salesforceError(error, "Token refresh failed", 401);
  }
}

/**
 * Refreshes an org's access token once, under a lock.
 *
 * Whoever takes the lock does the refresh; everyone else waits and re-reads the result.
 * Without it, N concurrent 401s become N refreshes, and Salesforce invalidates the earlier
 * tokens as each new one is issued.
 */
async function getSalesforceToken(orgId: string): Promise<OrgDetails> {
  const locked = await acquireRefreshLock(orgId, REFRESH_LOCK_TIMEOUT);

  if (!locked) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const latest = await findOrgSession(orgId);
    if (latest?.accessToken) return latest;
    throw new AppError(
      "Salesforce session expired or revoked. Please re-authenticate.",
      401,
      "SF_SESSION_EXPIRED"
    );
  }

  try {
    if (!locked.refreshToken) {
      throw new AppError("Missing Salesforce refresh token", 401, "SF_SESSION_EXPIRED");
    }

    const tokens = await refreshSalesforceToken({
      refresh_token: locked.refreshToken,
      environment: locked.loginTypeSF,
    });

    return await updateOrgSession(orgId, {
      accessToken: tokens.access_token,
      // Salesforce only returns a new refresh token when rotation is on; keep the old one.
      refreshToken: tokens.refresh_token || locked.refreshToken,
      instance_url: tokens.instance_url || locked.instance_url,
    });
  } finally {
    await releaseRefreshLock(orgId);
  }
}

function isExpiredSession(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.response?.status === 401) return true;

  const body = error.response?.data as { errorCode?: string }[] | undefined;
  return Array.isArray(body) && body[0]?.errorCode === "INVALID_SESSION_ID";
}

/**
 * Calls Salesforce as an org. `urlOrPath` may be absolute — an identity or VersionData URL —
 * or relative to the org's instance.
 *
 * An org without `org_id` cannot be refreshed, which is the case during the initial code
 * exchange: there is no row yet, only a token that was issued seconds ago.
 */
export async function sfRequest<T = unknown>(
  orgDetails: OrgDetails,
  urlOrPath: string,
  config: AxiosRequestConfig = {}
): Promise<AxiosResponse<T>> {
  let current = orgDetails;

  const doCall = () =>
    axios.request<T>({
      method: "get",
      timeout: TIMEOUT_MS,
      ...config,
      url: /^https?:\/\//i.test(urlOrPath)
        ? urlOrPath
        : `${current.instance_url ?? ""}${urlOrPath}`,
      headers: {
        Authorization: `Bearer ${current.accessToken}`,
        ...(config.headers ?? {}),
      },
    });

  try {
    return await doCall();
  } catch (error) {
    if (!isExpiredSession(error) || !current.org_id) {
      throw salesforceError(error, "Salesforce request failed", 401);
    }

    logger.info("Salesforce token expired, refreshing once", { orgId: current.org_id });
    current = await getSalesforceToken(current.org_id);
    return doCall();
  }
}
