import { z } from "zod";
import { AppError } from "../../utils/appError";
import {
  SIGNER_ROLE_RE,
  SIGN_REQUEST_STATUSES,
  type SignerInput,
  type SignerRole,
  type SignRequestStatus,
} from "./sign-request.types";

export type ListQuery = {
  limit: number;
  skip: number;
  status?: SignRequestStatus;
  q?: string;
};

export const signerInputSchema = z.object({
  role: z
    .string()
    .trim()
    .regex(SIGNER_ROLE_RE, "Signer role must look like signer1, signer2, ...")
    .transform((role) => role as SignerRole),
  name: z.string().trim().min(1, "Signer name is required"),
  email: z.string().trim().email("Signer email is invalid"),
});

export const signersSchema = z
  .array(signerInputSchema)
  .min(1, "At least one signer is required")
  .superRefine((signers, ctx) => {
    const roles = signers.map((signer) => signer.role);
    if (new Set(roles).size !== roles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each signer role must be unique",
      });
    }
  });

export function parseSignersField(raw: unknown): SignerInput[] {
  if (raw === undefined || raw === null || raw === "") {
    throw new AppError("signers is required", 400, "VALIDATION_ERROR");
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError("signers must be valid JSON", 400, "VALIDATION_ERROR");
    }
  }

  const result = signersSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new AppError(message || "Invalid signers", 400, "VALIDATION_ERROR");
  }

  return result.data;
}

const rectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
});

const placedFieldSchema = z.object({
  role: z
    .string()
    .trim()
    .regex(SIGNER_ROLE_RE, "Field role must look like signer1, signer2, ...")
    .transform((role) => role as SignerRole),
  // Defaults to a signature so callers written before field types keep working.
  type: z
    .enum(["signature", "initial", "fullName", "email", "signDate", "company", "jobTitle"])
    .default("signature"),
  page: z.number().int().min(1),
  rect: rectSchema,
  source: z.enum(["image", "text", "manual"]).default("manual"),
});

const sendDraftSchema = z.object({
  t: z.string().trim().min(1, "t is required"),
  signers: signersSchema,
  fields: z.array(placedFieldSchema).min(1, "Place at least one field"),
});

export function parseSendDraftBody(raw: unknown): z.infer<typeof sendDraftSchema> {
  const result = sendDraftSchema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new AppError(message || "Invalid request", 400, "VALIDATION_ERROR");
  }
  return result.data;
}

/** Reminders go to every outstanding signer unless one is named. */
const remindBodySchema = z.object({
  recipientId: z.string().trim().min(1).optional(),
});

export function parseRemindBody(raw: unknown): { recipientId?: string } {
  const result = remindBodySchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new AppError("Invalid request", 400, "VALIDATION_ERROR");
  }
  return result.data;
}

/** A cleared filter arrives as an empty string, which means "no filter", not "match empty". */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  skip: z.coerce.number().int().min(0).default(0),
  status: z.preprocess(blankToUndefined, z.enum(SIGN_REQUEST_STATUSES).optional()),
  /** Matched against the file name. Capped so a pasted document cannot become a regex. */
  q: z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
});

export function parseListQuery(raw: unknown): ListQuery {
  const result = listQuerySchema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new AppError(message || "Invalid list query", 400, "VALIDATION_ERROR");
  }
  return result.data;
}

const ceremonyAuthSchema = z.object({
  recipientId: z.string().trim().min(1, "recipientId is required"),
  t: z.string().trim().min(1, "t is required"),
});

export const saveFieldBodySchema = ceremonyAuthSchema.extend({
  value: z.string().min(1, "value is required"),
});

/** Several of a signer's fields in one write, so concurrent saves cannot lose each other. */
export const saveFieldsBodySchema = ceremonyAuthSchema.extend({
  values: z
    .array(
      z.object({
        fieldId: z.string().trim().min(1, "fieldId is required"),
        value: z.string().min(1, "value is required"),
      })
    )
    .min(1, "At least one field value is required")
    .max(100, "Too many fields in one request"),
});

/** `timeZone` only decides how the sign date is written, so a bad one falls back to UTC. */
export const completeBodySchema = ceremonyAuthSchema.extend({
  timeZone: z.string().trim().max(64).optional(),
});

export const declineBodySchema = ceremonyAuthSchema.extend({
  reason: z
    .string()
    .trim()
    .min(1, "Tell the sender why you are declining.")
    .max(1000, "Keep the reason under 1000 characters."),
});

export function parseCeremonyAuth(raw: unknown): { recipientId: string; t: string } {
  const result = ceremonyAuthSchema.safeParse(raw);
  if (!result.success) {
    throw new AppError("This signing link is invalid or has expired.", 404, "INVALID_LINK");
  }
  return result.data;
}

export function parseSaveFieldBody(raw: unknown): z.infer<typeof saveFieldBodySchema> {
  const result = saveFieldBodySchema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new AppError(message || "Invalid request", 400, "VALIDATION_ERROR");
  }
  return result.data;
}

export function parseSaveFieldsBody(raw: unknown): z.infer<typeof saveFieldsBodySchema> {
  const result = saveFieldsBodySchema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new AppError(message || "Invalid request", 400, "VALIDATION_ERROR");
  }
  return result.data;
}

export function parseCompleteBody(raw: unknown): z.infer<typeof completeBodySchema> {
  const auth = parseCeremonyAuth(raw);
  const result = completeBodySchema.safeParse(raw);
  return { ...auth, timeZone: result.success ? result.data.timeZone : undefined };
}

export function parseDeclineBody(raw: unknown): z.infer<typeof declineBodySchema> {
  const result = declineBodySchema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new AppError(message || "Invalid request", 400, "VALIDATION_ERROR");
  }
  return result.data;
}
