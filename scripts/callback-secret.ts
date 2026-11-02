import { deriveCallbackSecret } from "../src/modules/sign-requests/sign-request.event-worker";

/**
 * Prints the value an org's admin puts in `InstantSign_Settings__c.Callback_Secret__c`.
 *
 *   npm run callback:secret -- 00Ddi00000FANNpEAP
 */

const orgId = process.argv[2];

if (!orgId || (orgId.length !== 15 && orgId.length !== 18)) {
  console.error("Usage: npm run callback:secret -- <15 or 18 character org id>");
  process.exit(1);
}

const secret = deriveCallbackSecret(orgId);

if (!secret) {
  console.error("CALLBACK_SIGNING_KEY is not set.");
  process.exit(1);
}

console.log(secret);
process.exit(0);
