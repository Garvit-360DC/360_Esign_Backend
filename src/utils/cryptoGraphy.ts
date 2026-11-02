import crypto from "node:crypto";
import { logger } from "../config/logger";

/**
 * Ported from `360_File_Connector_Node/src/utils/cryptoGraphy.js`.
 *
 * Same name and parameters, so tokens the connector issues decrypt here. Only the decrypting
 * half is needed: this service reads those tokens and never issues them. Unlike the original,
 * it does not log the token.
 */
export function decryptJsonDataWithKeys(
  encryptedData: string | null | undefined,
  secretKey: string | undefined,
  initializationVector: string | undefined
): string | null {
  try {
    if (!encryptedData || !secretKey || !initializationVector) {
      throw new Error("Missing parameters");
    }

    const key = Buffer.from(secretKey, "utf8").subarray(0, 16);
    const iv = Buffer.from(initializationVector, "utf8").subarray(0, 16);

    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);

    let decrypted = decipher.update(encryptedData, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    logger.warn("Could not decrypt a token", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
