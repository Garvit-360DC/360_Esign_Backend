import { z } from "zod";
import { AppError } from "../../utils/appError";
import { SIGNER_ROLE_RE, type SignerRole } from "../sign-requests/sign-request.types";

const roleSchema = z
  .string()
  .trim()
  .regex(SIGNER_ROLE_RE, "Role must look like signer1, signer2, ...")
  .transform((role) => role as SignerRole);

const rectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
});

const createTemplateSchema = z.object({
  t: z.string().trim().min(1, "t is required"),
  name: z.string().trim().min(1, "A template name is required").max(80),
  description: z.string().trim().max(255).optional(),
  sObjectName: z.string().trim().max(255).optional(),
  emailSubject: z.string().trim().max(255).optional(),
  emailMessage: z.string().trim().max(4000).optional(),
  signingOrder: z.enum(["Parallel", "Sequential"]).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  // Salesforce holds this as text; the shape is checked here so a template cannot record a
  // schedule nothing could later read.
  reminderDays: z
    .string()
    .trim()
    .regex(/^\d+(,\d+)*$/, "Reminder days must look like 3,7,14")
    .max(50)
    .optional(),
  recipients: z
    .array(
      z.object({
        role: roleSchema,
        recipientType: z.enum(["SIGNER", "CC"]).optional(),
        label: z.string().trim().max(80).optional(),
        order: z.number().int().min(1).max(999).optional(),
        defaultName: z.string().trim().max(255).optional(),
        defaultEmail: z.string().trim().email("Default email is invalid").optional(),
      })
    )
    .min(1, "At least one recipient is required")
    .max(100),
  fields: z
    .array(
      z.object({
        role: roleSchema,
        type: z.enum([
          "signature",
          "initial",
          "fullName",
          "email",
          "signDate",
          "company",
          "jobTitle",
        ]),
        page: z.number().int().min(1),
        rect: rectSchema,
        source: z.enum(["image", "text", "manual"]).default("manual"),
        required: z.boolean().default(true),
      })
    )
    .min(1, "Place at least one field")
    .max(1000),
});

export function parseCreateTemplateBody(raw: unknown): z.infer<typeof createTemplateSchema> {
  const result = createTemplateSchema.safeParse(raw);

  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new AppError(message || "Invalid request", 400, "VALIDATION_ERROR");
  }

  return result.data;
}

const listQuerySchema = z.object({
  sObject: z.string().trim().max(255).optional(),
  includeInactive: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => value === true || value === "true"),
});

export function parseTemplateListQuery(raw: unknown): {
  sObjectName?: string;
  includeInactive: boolean;
} {
  const result = listQuerySchema.safeParse(raw);

  if (!result.success) {
    throw new AppError("Invalid list query", 400, "VALIDATION_ERROR");
  }

  return {
    sObjectName: result.data.sObject,
    includeInactive: result.data.includeInactive,
  };
}
