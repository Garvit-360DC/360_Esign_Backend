import { randomUUID } from "node:crypto";
import {
  FIELD_TYPE_META,
  type SignRequest,
  type SignFieldType,
  type Signer,
} from "./sign-request.types";

/**
 * Status events for Salesforce, in the shape `InstantSignEventsResource.cls` reads.
 *
 * Events are queued on the envelope itself and written by the same update as the status change
 * they describe, so a crash can't leave one without the other. The shared database may not be a
 * replica set, which rules out a transaction across two collections.
 */

export type SalesforceEventName =
  | "recipient.viewed"
  | "recipient.signed"
  | "recipient.declined"
  | "recipient.bounced"
  | "envelope.completed"
  | "envelope.declined"
  | "envelope.voided";

export type QueuedEvent = {
  id: string;
  payload: {
    event: SalesforceEventName;
    envelopeId: string;
    recipientId: string | null;
    roleKey: string | null;
    reason: string | null;
    detail: string | null;
    timestamp: string;
    typedValues?: Record<string, string>;
  };
};

/** Empty for an envelope made in the console, which has nobody to tell. */
export function buildEvent(
  request: Pick<SignRequest, "id" | "salesforce">,
  event: SalesforceEventName,
  details: {
    signer?: Pick<Signer, "id" | "role">;
    reason?: string;
    detail?: string;
    typedValues?: Record<string, string>;
  } = {}
): QueuedEvent[] {
  if (!request.salesforce) return [];

  return [
    {
      id: randomUUID(),
      payload: {
        event,
        envelopeId: request.id,
        recipientId: details.signer?.id ?? null,
        roleKey: details.signer?.role ?? null,
        reason: details.reason ?? null,
        detail: details.detail ?? null,
        timestamp: new Date().toISOString(),
        ...(details.typedValues ? { typedValues: details.typedValues } : {}),
      },
    },
  ];
}

const SAVED_BACK_TYPES: SignFieldType[] = ["company", "jobTitle"];

/** Answers Salesforce can save back to records, keyed by label: "Company", "Job Title". */
export function typedValuesFor(
  request: Pick<SignRequest, "signatureFields">,
  signer: Pick<Signer, "role">
): Record<string, string> | undefined {
  const entries = request.signatureFields
    .filter(
      (field) =>
        field.role === signer.role && SAVED_BACK_TYPES.includes(field.type) && !!field.value
    )
    .map((field) => [FIELD_TYPE_META[field.type].label, field.value as string]);

  return entries.length ? Object.fromEntries(entries) : undefined;
}
