import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4600),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MONGO_URL: z.string().min(1).default("mongodb://127.0.0.1:27017/x360-esign"),
  FRONTEND_URL: z.string().url().default("http://localhost:3001"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4600"),
  CONVERTAPI_SECRET: z.string().min(1),

  // Org authentication. AES-128-CBC needs exactly 16 bytes for each, and the length is
  // enforced here rather than at first use so a bad value fails at boot, not mid-request.
  ORG_TOKEN_KEY: z.string().length(16, "ORG_TOKEN_KEY must be exactly 16 characters"),
  ORG_TOKEN_IV: z.string().length(16, "ORG_TOKEN_IV must be exactly 16 characters"),
  /** Used when a caller omits the product-name header. */
  DEFAULT_PRODUCT_NAME: z.string().min(1).default("360 SmartSign"),

  // Mail is optional. Without SMTP_HOST and MAIL_FROM the app runs exactly as before and
  // signing links are only handed back in the API response.
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().min(1).optional(),
  MAIL_REPLY_TO: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.flatten().fieldErrors;
  throw new Error(`Invalid environment variables: ${JSON.stringify(details)}`);
}

export const env = parsed.data;
