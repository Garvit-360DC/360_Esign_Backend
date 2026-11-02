import crypto from "node:crypto";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { sfRequest } from "../../integrations/salesforce";
import { findOrgSession } from "../auth/org-session.repository";
import {
  claimDueEnvelope,
  finishEventDelivery,
  findStuckEnvelopes,
  holdEvents,
  retryEvent,
  type ClaimedEnvelope,
} from "./sign-request.repository";
import { finishEnvelope } from "./sign-request.service";

/**
 * Delivers queued status events to Salesforce, one at a time per envelope so they arrive in
 * order. Several processes can run this: each envelope is claimed before it is worked on.
 *
 * Delivery is at least once. A failure of any kind is retried with a delay, including a 404,
 * because an event can arrive before Salesforce has saved the envelope's id. When the retries run
 * out, the event is set aside in `deadEvents` so later events on the envelope can still go.
 */

const TICK_MS = 5_000;
const STUCK_SWEEP_MS = 60_000;
/** How long an envelope may sit fully signed but incomplete before it is finished from here. */
const STUCK_AFTER_MS = 5 * 60 * 1000;
const HOLD_MS = 5_000;
const MAX_PER_TICK = 25;

const RETRY_DELAYS_MS = [
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
];

/**
 * The value an org's `Callback_Secret__c` must hold. Derived rather than stored, so there is no
 * table of secrets to keep or provision; print one with `npm run callback:secret -- <orgId>`.
 * Salesforce uses 15 and 18 character forms of the same org id, so only the first 15 count.
 */
export function deriveCallbackSecret(orgId: string): string | null {
  if (!env.CALLBACK_SIGNING_KEY) return null;
  return crypto
    .createHmac("sha256", env.CALLBACK_SIGNING_KEY)
    .update(orgId.slice(0, 15))
    .digest("base64url");
}

/**
 * Salesforce starts fetching the signed PDF on the last signer's `recipient.signed`, once, with no
 * retry. So that event waits until the envelope is complete, when the PDF is known to exist.
 */
function mustWaitForSignedPdf(envelope: ClaimedEnvelope): boolean {
  const head = envelope.pendingEvents[0];
  return (
    head?.payload.event === "recipient.signed" &&
    envelope.status === "in_progress" &&
    envelope.signers.every((signer) => signer.status === "signed")
  );
}

async function deliver(envelope: ClaimedEnvelope): Promise<void> {
  const { salesforce } = envelope;
  const head = envelope.pendingEvents[0];

  if (!salesforce) {
    throw new Error("This envelope has no Salesforce details.");
  }

  const session = await findOrgSession(envelope.orgId, salesforce.productName);
  if (!session) {
    throw new Error("No Salesforce session for this org and product.");
  }

  // Signed as sent: the signature is over these exact bytes, so it is serialized only once.
  const body = JSON.stringify(head.payload);
  const secret = deriveCallbackSecret(envelope.orgId);

  await sfRequest(session, salesforce.callbackUrl, {
    method: "post",
    data: body,
    headers: {
      "Content-Type": "application/json",
      ...(secret
        ? { "X-InstantSign-Signature": crypto.createHmac("sha256", secret).update(body).digest("base64") }
        : {}),
    },
  });
}

/** One pass over whatever is due. Returns how many envelopes it worked on. */
export async function deliverDueEvents(now = new Date()): Promise<number> {
  let worked = 0;

  while (worked < MAX_PER_TICK) {
    const envelope = await claimDueEnvelope(now);
    if (!envelope) break;
    worked += 1;

    const head = envelope.pendingEvents[0];

    if (head && mustWaitForSignedPdf(envelope)) {
      await holdEvents(envelope.id, new Date(now.getTime() + HOLD_MS));
      continue;
    }

    try {
      if (head) await deliver(envelope);
      await finishEventDelivery(envelope.id, head?.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = RETRY_DELAYS_MS[envelope.eventAttempts];

      logger.warn("Could not deliver a status event", {
        envelopeId: envelope.id,
        event: head?.payload.event,
        attempt: envelope.eventAttempts + 1,
        message,
      });

      if (delay === undefined) {
        logger.error("Gave up delivering a status event", {
          envelopeId: envelope.id,
          event: head?.payload.event,
          message,
        });
        await finishEventDelivery(envelope.id, head?.id, { deadEvent: head, error: message });
      } else {
        await retryEvent(envelope.id, new Date(now.getTime() + delay));
      }
    }
  }

  return worked;
}

/**
 * Finishes envelopes left fully signed but incomplete, which only a crash during stamping can
 * cause. The signers have all finished, so nobody else would ever retry them.
 */
export async function finishStuckEnvelopes(now = new Date()): Promise<number> {
  const stuck = await findStuckEnvelopes(new Date(now.getTime() - STUCK_AFTER_MS));

  for (const envelope of stuck) {
    try {
      await finishEnvelope(envelope);
    } catch (error) {
      logger.error("Could not finish a fully signed envelope", {
        envelopeId: envelope.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return stuck.length;
}

/** Runs one pass at a time, so a slow pass can't overlap the next. */
function everyInterval(work: () => Promise<unknown>, ms: number, label: string): void {
  let running = false;

  setInterval(() => {
    if (running) return;
    running = true;
    work()
      .catch((error: unknown) => {
        logger.error(`${label} failed`, {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  }, ms).unref();
}

export function startEventWorker(): void {
  everyInterval(deliverDueEvents, TICK_MS, "Status event delivery");
  everyInterval(finishStuckEnvelopes, STUCK_SWEEP_MS, "Stuck envelope sweep");
}
