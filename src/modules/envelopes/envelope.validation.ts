import { z } from "zod";

/**
 * The bodies `InstantSignServiceClient.cls` sends. It serializes with nulls suppressed, so an
 * unset field arrives as missing. Fields it sends that are unused here, such as `documentUrl`,
 * are dropped.
 */

const recipientSchema = z.object({
  roleKey: z.string().trim().min(1, "Each recipient needs a roleKey"),
  name: z.string().trim().min(1, "Each recipient needs a name"),
  email: z.string().trim().email("A recipient's email is invalid"),
  role: z.enum(["SIGNER", "CC"]).default("SIGNER"),
  order: z.number().int().positive().default(1),
  verification: z.string().default("None"),
  salesforceRecipientId: z.string().optional(),
});

/**
 * Status callbacks will carry the org's Salesforce session, so this must never name another
 * host. Only Salesforce's own domains are accepted.
 */
function isSalesforceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".salesforce.com");
  } catch {
    return false;
  }
}

export const createEnvelopeSchema = z.object({
  subject: z.string().trim().max(255).optional(),
  message: z.string().trim().max(4000).optional(),
  documentName: z.string().trim().min(1, "documentName is required").max(255),
  // Goes straight into a SOQL query, so nothing but a ContentVersion id gets through.
  documentVersionId: z
    .string()
    .regex(/^068[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, "documentVersionId must be a ContentVersion id"),
  sourceObjectType: z.string().optional(),
  sourceObjectId: z.string().optional(),
  salesforceRequestId: z.string().optional(),
  routingType: z.string().optional(),
  appendSignaturePage: z.boolean().default(false),
  expiresInDays: z.number().int().positive().optional(),
  remindEveryDays: z.number().int().positive().optional(),
  callbackUrl: z.string().refine(isSalesforceUrl, "callbackUrl must be a Salesforce https URL"),
  branding: z.record(z.string()).optional(),
  recipients: z.array(recipientSchema).min(1, "At least one recipient is required"),
});

export type CreateEnvelopeBody = z.infer<typeof createEnvelopeSchema>;

export const voidEnvelopeSchema = z.object({
  reason: z.string().trim().max(4000).optional(),
});
