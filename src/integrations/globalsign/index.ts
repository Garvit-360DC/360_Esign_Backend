import { readFileSync } from "node:fs";
import https from "node:https";
import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from "axios";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { AppError } from "../../utils/appError";

/**
 * GlobalSign Digital Signing Service (DSS) v2.
 *
 * Every call goes over mutual TLS with the client certificate from the Atlas portal, and every
 * call but login carries the bearer token login returns. Each seal asks for a fresh identity:
 * a short-lived signing certificate with its OCSP response, which the service issues per request.
 */

export interface GlobalSignIdentity {
  /** 32 hex characters. */
  id: string;
  /** PEM. */
  signingCert: string;
  /** Base64 DER OCSP response for `signingCert`. */
  ocspResponse: string;
}

export interface GlobalSignTrustChain {
  /** PEM certificates. */
  trustchain: string[];
  /** Base64 DER OCSP responses for the chain, root excluded. */
  ocspRevocationInfo: string[];
}

export function isGlobalSignEnabled(): boolean {
  return Boolean(
    env.GLOBALSIGN_API_KEY &&
      env.GLOBALSIGN_API_SECRET &&
      env.GLOBALSIGN_CLIENT_CERT_PATH &&
      env.GLOBALSIGN_CLIENT_KEY_PATH
  );
}

/** The service does not state a token lifetime, so it is renewed well before any likely one. */
const TOKEN_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const RETRIES = 3;

let client: AxiosInstance | null = null;
let token: { value: string; expiresAt: number } | null = null;
let pendingLogin: Promise<string> | null = null;

function http(): AxiosInstance {
  if (client) return client;
  if (!isGlobalSignEnabled()) {
    throw new AppError("GlobalSign is not configured.", 500, "GLOBALSIGN_NOT_CONFIGURED");
  }

  const agent = new https.Agent({
    cert: readFileSync(env.GLOBALSIGN_CLIENT_CERT_PATH!),
    key: readFileSync(env.GLOBALSIGN_CLIENT_KEY_PATH!),
    passphrase: env.GLOBALSIGN_CLIENT_KEY_PASSPHRASE || undefined,
    keepAlive: true,
  });

  client = axios.create({
    baseURL: env.GLOBALSIGN_API_URL.replace(/\/+$/, ""),
    httpsAgent: agent,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { "Content-Type": "application/json;charset=utf-8" },
  });
  return client;
}

async function login(): Promise<string> {
  const response = await withRetries(() =>
    http().post<{ access_token: string }>("/login", {
      api_key: env.GLOBALSIGN_API_KEY,
      api_secret: env.GLOBALSIGN_API_SECRET,
    })
  );
  const accessToken = response.data?.access_token;
  if (!accessToken) throw new Error("GlobalSign login returned no access_token");
  token = { value: accessToken, expiresAt: Date.now() + TOKEN_TTL_MS };
  return accessToken;
}

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now()) return token.value;
  // Concurrent completions share one login rather than each starting their own.
  pendingLogin ??= login().finally(() => {
    pendingLogin = null;
  });
  return pendingLogin;
}

/** A call with the bearer token, logging in again once if the token was refused. */
async function call<T>(config: AxiosRequestConfig): Promise<T> {
  const send = async () =>
    withRetries(async () =>
      http().request<T>({
        ...config,
        headers: { ...config.headers, Authorization: `Bearer ${await accessToken()}` },
      })
    );

  try {
    return (await send()).data;
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 401) {
      token = null;
      return (await send()).data;
    }
    throw error;
  }
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof AxiosError)) return false;
  const status = error.response?.status;
  // No response at all is a network failure or timeout.
  return status === undefined || status === 429 || status === 503 || status === 502 || status === 504;
}

async function withRetries<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= RETRIES || !isTransient(error)) throw error;
      const wait = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      logger.warn("GlobalSign call failed, retrying", { attempt, wait, reason: describe(error) });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** The service's problem+json `description`, or the HTTP status, for logs and errors. */
export function describe(error: unknown): string {
  if (error instanceof AxiosError) {
    const body = error.response?.data as { description?: unknown } | undefined;
    const status = error.response?.status;
    const detail = typeof body?.description === "string" ? body.description : error.message;
    return status ? `HTTP ${status}: ${detail}` : detail;
  }
  return error instanceof Error ? error.message : String(error);
}

const HEX_DIGEST_RE = /^[A-Fa-f0-9]{64}$/;

function requireDigest(digestHex: string): string {
  if (!HEX_DIGEST_RE.test(digestHex)) throw new Error("A SHA-256 digest in hex is required");
  return digestHex.toUpperCase();
}

export async function createIdentity(subjectDn: Record<string, unknown>): Promise<GlobalSignIdentity> {
  const data = await call<{ id: string; signing_cert: string; ocsp_response: string }>({
    method: "POST",
    url: "/identity",
    data: { subject_dn: subjectDn },
  });
  if (!data?.id || !data.signing_cert) throw new Error("GlobalSign returned an incomplete identity");
  return { id: data.id, signingCert: data.signing_cert, ocspResponse: data.ocsp_response };
}

/** PEM of the certificate that issued the signing certificates. */
export async function getCertificatePath(): Promise<string> {
  const data = await call<{ path: string }>({ method: "GET", url: "/certificate_path" });
  if (!data?.path) throw new Error("GlobalSign returned no certificate path");
  return data.path;
}

export async function getTrustChain(): Promise<GlobalSignTrustChain> {
  const data = await call<{ trustchain?: string[]; ocsp_revocation_info?: string[] }>({
    method: "GET",
    url: "/trustchain",
  });
  return {
    trustchain: data?.trustchain ?? [],
    ocspRevocationInfo: data?.ocsp_revocation_info ?? [],
  };
}

/** Signs a SHA-256 digest with the identity's key. Returns the raw signature value. */
export async function signDigest(identityId: string, digestHex: string): Promise<Buffer> {
  const data = await call<{ signature: string }>({
    method: "GET",
    url: `/identity/${encodeURIComponent(identityId)}/sign/${requireDigest(digestHex)}`,
  });
  if (!data?.signature) throw new Error("GlobalSign returned no signature");
  return Buffer.from(data.signature, "hex");
}

/** An RFC 3161 timestamp token (DER) over a SHA-256 digest. */
export async function timestampDigest(digestHex: string): Promise<Buffer> {
  const data = await call<{ token: string }>({
    method: "GET",
    url: `/timestamp/${requireDigest(digestHex)}`,
  });
  if (!data?.token) throw new Error("GlobalSign returned no timestamp token");
  return Buffer.from(data.token, "base64");
}

export async function getValidationPolicy(): Promise<unknown> {
  return call<unknown>({ method: "GET", url: "/validationpolicy" });
}

export async function getQuotas(): Promise<{ signatures: number | null; timestamps: number | null }> {
  const [signatures, timestamps] = await Promise.all(
    ["/quotas/signatures", "/quotas/timestamps"].map((url) =>
      call<{ value?: number }>({ method: "GET", url })
        .then((data) => data?.value ?? null)
        .catch(() => null)
    )
  );
  return { signatures, timestamps };
}
