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
   * The 360 File Connector, e.g. https://360filesync.360degreeapps.com. When set, an expired
   * Salesforce token on a connector row is renewed by asking the connector, so its refresh token
   * is only ever used in one place. Without it this service refreshes the row itself.
   */
  FILE_CONNECTOR_URL: z.string().url().optional(),

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

  // GlobalSign Digital Signing Service. With all four of key, secret, client certificate and
  // client key set, every completed PDF is sealed with a GlobalSign certificate (PAdES), so
  // Acrobat shows it as signed by a trusted identity and any later change to it is detectable.
  // Without them, completed PDFs are stored unsealed, as before.
  GLOBALSIGN_API_URL: z.string().url().default("https://emea.api.dss.globalsign.com:8443/v2"),
  GLOBALSIGN_API_KEY: z.string().min(1).optional(),
  GLOBALSIGN_API_SECRET: z.string().min(1).optional(),
  /** Paths to the mTLS client certificate and its private key (PEM) from the Atlas portal. */
  GLOBALSIGN_CLIENT_CERT_PATH: z.string().min(1).optional(),
  GLOBALSIGN_CLIENT_KEY_PATH: z.string().min(1).optional(),
  GLOBALSIGN_CLIENT_KEY_PASSPHRASE: z.string().optional(),
  /**
   * The certificate's subject, as JSON in the API's `subject_dn` shape, e.g.
   * {"common_name":"360 InstantDocs"}. Which fields are allowed depends on the account's
   * validation policy (`npm run globalsign:check` prints it). Fields the policy fixes are
   * filled by GlobalSign and must be left out.
   */
  GLOBALSIGN_SUBJECT_DN: z
    .string()
    .default("{}")
    .transform((value, ctx) => {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Reported below.
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object" });
      return z.NEVER;
    }),
});

const GLOBALSIGN_REQUIRED = [
  "GLOBALSIGN_API_KEY",
  "GLOBALSIGN_API_SECRET",
  "GLOBALSIGN_CLIENT_CERT_PATH",
  "GLOBALSIGN_CLIENT_KEY_PATH",
] as const;

const parsed = envSchema
  .superRefine((values, ctx) => {
    // Half a GlobalSign setup would silently produce unsealed PDFs; refuse to start instead.
    const set = GLOBALSIGN_REQUIRED.filter((key) => values[key]);
    if (set.length > 0 && set.length < GLOBALSIGN_REQUIRED.length) {
      for (const key of GLOBALSIGN_REQUIRED.filter((name) => !values[name])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "is required when any GlobalSign setting is set",
        });
      }
    }
  })
  .safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.flatten().fieldErrors;
  throw new Error(`Invalid environment variables: ${JSON.stringify(details)}`);
}

export const env = parsed.data;
