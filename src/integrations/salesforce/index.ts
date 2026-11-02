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
const REFRESH_WAIT_INTERVAL = 150;
/** Well inside the 120-second limit on the Apex callouts that can end up waiting here. */
const MAX_REFRESH_WAIT = 20 * 1000;

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
  /** Set on a connector session. Refreshes go back to that row, not to the console's. */
  productName?: string | null;
  accessToken: string | null;
  instance_url?: string | null;
  loginTypeSF?: string;
};

export const API_VERSION = "v62.0";

export function getLoginUrl(environment?: string): string {
  return (environment || "").toLowerCase() === "sandbox"
    ? env.SF_TEST_LOGIN_URL
    : env.SF_LOGIN_URL;
}

/**
 * Prefixes a custom object or field with the package namespace.
 *
 * Empty in a org where the objects were created by hand, which is how they exist today; a
 * packaged install would set `SF_NAMESPACE_PREFIX` and every name shifts with it. The
 * connector does the same through `X360_SMART_DOCS_PREFIX`.
 */
export function ns(name: string): string {
  return `${env.SF_NAMESPACE_PREFIX}${name}`;
}

/** Strips the namespace back off, so callers can read fields by their bare name. */
export function unNs<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  const prefix = env.SF_NAMESPACE_PREFIX;
  if (!prefix) return record;

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key.startsWith(prefix) ? key.slice(prefix.length) : key,
      value,
    ])
  );
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
 * tokens as each new one is issued. On a connector row, the lock holder may be the connector.
 */
async function getSalesforceToken(orgId: string, productName?: string | null): Promise<OrgDetails> {
  const locked = await acquireRefreshLock(orgId, REFRESH_LOCK_TIMEOUT, productName);

  if (!locked) {
    const deadline = Date.now() + MAX_REFRESH_WAIT;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_INTERVAL));
      const latest = await findOrgSession(orgId, productName);
      if (latest && !latest.isRefreshing && latest.accessToken) return latest;
    }

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

    return await updateOrgSession(
      orgId,
      {
        accessToken: tokens.access_token,
        // Salesforce only returns a new refresh token when rotation is on; keep the old one.
        refreshToken: tokens.refresh_token || locked.refreshToken,
        instance_url: tokens.instance_url || locked.instance_url,
      },
      productName
    );
  } finally {
    await releaseRefreshLock(orgId, productName);
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
    current = await getSalesforceToken(current.org_id, current.productName);
    return doCall();
  }
}

// ---- data access -----------------------------------------------------------

/** Turns a Salesforce write failure into the message it actually gave. */
function writeError(error: unknown, what: string): AppError {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as { message?: string; errorCode?: string }[] | undefined;
    const first = Array.isArray(body) ? body[0] : undefined;

    logger.error("Salesforce write failed", {
      what,
      status: error.response?.status,
      body: JSON.stringify(body ?? {}).slice(0, 500),
    });

    if (first?.message) {
      return new AppError(`${what}: ${first.message}`, 400, first.errorCode ?? "SALESFORCE_ERROR");
    }
  }

  return salesforceError(error, `${what} failed in Salesforce.`);
}

/**
 * Runs a SOQL query and returns every row.
 *
 * Follows `nextRecordsUrl` rather than stopping at the first 2000: a template's field rows
 * are well under that, but a list of templates across a large org need not be.
 */
export async function soql<T>(session: OrgDetails, query: string): Promise<T[]> {
  const records: T[] = [];
  let path: string | null = `/services/data/${API_VERSION}/query?q=${encodeURIComponent(query)}`;

  while (path) {
    const page: AxiosResponse<{ records: T[]; nextRecordsUrl?: string; done: boolean }> =
      await sfRequest(session, path);

    records.push(...page.data.records);
    path = page.data.done ? null : (page.data.nextRecordsUrl ?? null);
  }

  return records;
}

export async function createRecord(
  session: OrgDetails,
  objectName: string,
  values: Record<string, unknown>
): Promise<string> {
  try {
    const { data } = await sfRequest<{ id: string }>(
      session,
      `/services/data/${API_VERSION}/sobjects/${objectName}`,
      { method: "post", data: values, headers: { "Content-Type": "application/json" } }
    );
    return data.id;
  } catch (error) {
    throw writeError(error, `Creating ${objectName}`);
  }
}

export async function updateRecord(
  session: OrgDetails,
  objectName: string,
  id: string,
  values: Record<string, unknown>
): Promise<void> {
  try {
    await sfRequest(session, `/services/data/${API_VERSION}/sobjects/${objectName}/${id}`, {
      method: "patch",
      data: values,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    throw writeError(error, `Updating ${objectName}`);
  }
}

export async function deleteRecord(
  session: OrgDetails,
  objectName: string,
  id: string
): Promise<void> {
  try {
    await sfRequest(session, `/services/data/${API_VERSION}/sobjects/${objectName}/${id}`, {
      method: "delete",
    });
  } catch (error) {
    throw writeError(error, `Deleting ${objectName}`);
  }
}

export type CompositeEntry = {
  /** Referenced by later entries as `@{referenceId.id}`. */
  referenceId: string;
  objectName: string;
  values: Record<string, unknown>;
};

/**
 * Creates several records in one call, all or nothing.
 *
 * A template is a parent plus its recipients plus its boxes. Sent one at a time, a failure
 * halfway leaves a half-built template in the org that nobody asked for; `allOrNone` makes
 * the whole thing succeed or leave no trace.
 */
export async function compositeCreate(
  session: OrgDetails,
  entries: CompositeEntry[]
): Promise<Record<string, string>> {
  type Result = {
    compositeResponse: {
      referenceId: string;
      httpStatusCode: number;
      body: { id?: string; message?: string; errorCode?: string }[] | { id?: string };
    }[];
  };

  const { data } = await sfRequest<Result>(
    session,
    `/services/data/${API_VERSION}/composite`,
    {
      method: "post",
      headers: { "Content-Type": "application/json" },
      data: {
        allOrNone: true,
        compositeRequest: entries.map((entry) => ({
          method: "POST",
          url: `/services/data/${API_VERSION}/sobjects/${entry.objectName}`,
          referenceId: entry.referenceId,
          body: entry.values,
        })),
      },
    }
  );

  const ids: Record<string, string> = {};

  for (const result of data.compositeResponse) {
    if (result.httpStatusCode >= 300) {
      // Every entry reports a failure when one fails, so name the one that actually broke.
      const body = Array.isArray(result.body) ? result.body[0] : undefined;
      if (body?.errorCode === "PROCESSING_HALTED") continue;

      throw new AppError(
        body?.message
          ? `Saving to Salesforce failed at ${result.referenceId}: ${body.message}`
          : "Saving to Salesforce failed.",
        400,
        body?.errorCode ?? "SALESFORCE_ERROR"
      );
    }

    const body = Array.isArray(result.body) ? result.body[0] : result.body;
    if (body?.id) ids[result.referenceId] = body.id;
  }

  return ids;
}

// ---- files -----------------------------------------------------------------

/** Uploads bytes as a new ContentVersion and returns its id. */
export async function uploadContentVersion(
  session: OrgDetails,
  file: { buffer: Buffer; fileName: string; title: string }
): Promise<string> {
  return createRecord(session, "ContentVersion", {
    Title: file.title,
    PathOnClient: file.fileName,
    VersionData: file.buffer.toString("base64"),
  });
}

/**
 * Attaches an uploaded file to a record, so it appears in that record's Files related list.
 *
 * A `ContentDocumentLink` joins a **ContentDocument**, not the ContentVersion just created,
 * so the document id has to be read back first. Without this the file exists in the org but
 * is reachable only by id — the template record shows a text field and no visible document.
 */
export async function linkFileToRecord(
  session: OrgDetails,
  contentVersionId: string,
  recordId: string
): Promise<void> {
  const [version] = await soql<{ ContentDocumentId: string }>(
    session,
    `SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${contentVersionId}' LIMIT 1`
  );

  if (!version?.ContentDocumentId) {
    throw new AppError("The uploaded file could not be found.", 404, "DOCUMENT_NOT_FOUND");
  }

  await createRecord(session, "ContentDocumentLink", {
    ContentDocumentId: version.ContentDocumentId,
    LinkedEntityId: recordId,
    ShareType: "V",
    Visibility: "AllUsers",
  });
}

/**
 * Downloads a ContentVersion's bytes.
 *
 * Two calls, as the connector's `getSalesforceFile` does: SOQL for the `VersionData` URL,
 * then fetch that URL. The blob is not returned inline by the query.
 */
export async function downloadContentVersion(
  session: OrgDetails,
  contentVersionId: string
): Promise<{ buffer: Buffer; fileExtension: string }> {
  const [record] = await soql<{ VersionData: string; FileExtension: string }>(
    session,
    `SELECT VersionData, FileExtension FROM ContentVersion WHERE Id = '${contentVersionId}' LIMIT 1`
  );

  if (!record?.VersionData) {
    throw new AppError(
      "The template's document is no longer in Salesforce.",
      404,
      "DOCUMENT_NOT_FOUND"
    );
  }

  const { data } = await sfRequest<ArrayBuffer>(session, record.VersionData, {
    responseType: "arraybuffer",
  });

  return { buffer: Buffer.from(data), fileExtension: record.FileExtension };
}

/** Escapes a value for inlining into SOQL, so a quote in a name cannot change the query. */
export function soqlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
