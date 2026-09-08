import crypto from "node:crypto";
import { env } from "../config/env";

/**
 * AES-128-CBC with a fixed key and IV, matching the token scheme in
 * `360_File_Connector_Node/src/utils/cryptoGraphy.js` so the two services encode org tokens
 * the same way.
 *
 * A fixed IV makes this deterministic: the same payload always produces the same
 * ciphertext. That is what lets a stored token be compared against a presented one without
 * decrypting both, and it is why these values must never be used to encrypt anything
 * secret — they identify a caller, they do not protect content.
 *
 * The connector's version slices the key to 19 bytes when encrypting and 16 when
 * decrypting, which only works because its configured values happen to be 16 characters.
 * `env.ts` requires exactly 16 here instead, so the mismatch cannot arise.
 */

const KEY = Buffer.from(env.ORG_TOKEN_KEY, "utf8");
const IV = Buffer.from(env.ORG_TOKEN_IV, "utf8");

export function encryptJson(value: unknown): string {
  const cipher = crypto.createCipheriv("aes-128-cbc", KEY, IV);
  return cipher.update(JSON.stringify(value), "utf8", "base64") + cipher.final("base64");
}

/** Returns null for anything that does not decrypt to valid JSON — a tampered token. */
export function decryptJson<T>(encrypted: string): T | null {
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", KEY, IV);
    const json = decipher.update(encrypted, "base64", "utf8") + decipher.final("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison, so a token cannot be recovered a character at a time by
 * measuring how long a rejection takes.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // timingSafeEqual throws on a length mismatch, and the length itself is not a secret.
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
