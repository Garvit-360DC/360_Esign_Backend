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

  // Salesforce OAuth, named as in the connector. One connected app serves both flows —
  // note the connector's getToken reads SF_CLIENTID while its exchange reads SF_CLIENT_ID,
  // which lets the two halves drift onto different apps. Here there is only one.
  SF_CLIENT_ID: z.string().min(1),
  SF_CLIENT_SECRET: z.string().min(1),
  SF_LOGIN_URL: z.string().url().default("https://login.salesforce.com"),
  SF_TEST_LOGIN_URL: z.string().url().default("https://test.salesforce.com"),
  /** Where Salesforce returns the admin in the getToken flow. */
  SF_SERVER_CALLBACK_URI: z.string().url(),
  /** Default redirect_uri for the add-in's own exchange, when it does not send one. */
  SF_REDIRECT_URI: z.string().url(),

  /**
   * Namespace of the package the eSign objects ship in, e.g. `x360eSign__`. Empty when the
   * objects were created directly in the org, which is how they exist in development.
   */
  SF_NAMESPACE_PREFIX: z.string().default(""),

  /** Signs the app JWT. `Token_Key_Value` in the connector. */
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),

  // The connector's token encryption, for the routes Salesforce calls. Must match its values.
  // Optional so the console runs without them; those routes refuse every request until set.
  NODE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  NODE_TOKEN_ENCRYPTION_IV: z.string().optional(),
  /** Product assumed when a request names none. The connector's `DEFAULT_APP_NAME`. */
  DEFAULT_APP_NAME: z.string().optional(),

  /**
   * Each org's callback secret is derived from this. Changing it changes every org's secret.
   * Without it, status events go out unsigned, which Salesforce only accepts from an org with
   * no `Callback_Secret__c`.
   */
  CALLBACK_SIGNING_KEY: z.string().min(32).optional(),

  // Mail is optional. Without both SendGrid values the console's signing links are only handed
  // back in the API response, and sends from Salesforce are refused.
  SENDGRID_API_KEY: z.string().min(1).optional(),
  SENDGRID_FROM_EMAIL: z.string().min(1).optional(),
  MAIL_REPLY_TO: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.flatten().fieldErrors;
  throw new Error(`Invalid environment variables: ${JSON.stringify(details)}`);
}

export const env = parsed.data;
