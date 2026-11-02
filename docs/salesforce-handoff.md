# InstantSign: what the Salesforce app needs next

**For:** Salesforce team
**Date:** 2026-11-02

The signing service, x360-esign, is built for everything in Version 1. It hasn't been tested against a
real org yet. It can't take a real send until the changes below are in the `Esign` app. Change numbers
match `esign-integration-plan.md`, section 2, which says where each one goes.

Version 1 is done when a rep sends a Word add-in template with two signers from an Opportunity, both
sign, the status updates on the record, and the signed PDF appears in Files.

## 1. Questions for you

1. **Which product name should the app send?** The service finds the org's token in `dbtokens` by org
   and `product-name`. `InstantSignServiceClient` sends `360 InstantSign`, and the rest of the app
   defaults to `360 File Sync`. Tell us which row a real org has for InstantSign (S6).
2. **Which user is the integration user?** The service makes callbacks and downloads files as the user
   who authorized that `dbtokens` row. That user must be able to see each generated file and each
   `Signature_Request__c`. A private file fails with "no longer in Salesforce" (S13).
3. **What replaces the test org after it expires on 2026-11-22?**

## 2. Needed for a first send

| # | Change | What happens until it's done |
|---|---|---|
| S1, S2 | Read tags from picture alt text, and accept `{%signer1:initial}`. | Add-in templates show no signers. |
| S3 | Generate `DOCX` for sends. | Create returns 400: "Sending for signature needs a Word (.docx) document." |
| S4, S5 | Require `Service_Endpoint__c`, and add the Remote Site Setting. | Calls go to the connector, or are blocked. |
| S6 | Send the right `product-name`. | Every call returns 403. |
| S7 | Create and save as `Draft`, then send and set `Sent`, as two LWC calls. | Signers can be emailed with no record in Salesforce. Events sent before the save get a 404 and are retried. |
| S8 | Offer only templates with `Sign_Enabled__c`. | Templates without signing are offered. |
| S16 | Block templates with no boxes. Remove the fallback signer and appended page. | Create returns 400. |
| S17 | Hide `Email code`, and always send `None`. | Create returns 400. |
| **New: S18** | Hide CC recipients in Send for Signature until Phase 5. | The whole send fails with 400: "Copy recipients are not available yet." |

## 3. Needed for status and the signed PDF

| # | Change | Why |
|---|---|---|
| S12 | Make the callback signature mandatory. | A blank `Callback_Secret__c` accepts any caller. |
| S13 | Create a narrow permission set for the integration user. | Without access, callbacks fail and are retried for about 8 hours, then set aside. |
| S14 | Retry failed signed-PDF downloads. | **`InstantSignCompletionQueueable` fetches once.** If that fails, the signed PDF never reaches the record, and the only trace is a note in `Writeback_Result__c`. |

## 4. How the service behaves

The routes and request bodies are the ones `InstantSignServiceClient` already uses.

**Create and send**

- `POST /v1/envelopes` returns 201 with `{ id, status, recipients: [{ id, roleKey }] }`. Status is `draft`,
  and nobody is emailed.
- Send returns the same shape, with status `pending`. It's safe to retry: signers are emailed only once.
- Send fails with 502 if no invitation could be delivered, and 503 if the service has no mail server. The
  envelope stays a draft, so the rep can try again. **Don't set `Sent` on a failure.**
- All errors have a top-level `message`, which your `expect()` method already reads.
- `callbackUrl` must be `https` on a `.salesforce.com` host. `URL.getOrgDomainUrl()` should pass.
- Allow up to about 90 seconds for create, which includes converting the document. Your 120-second
  callout timeout covers it.

**Callbacks**

- They go to `callbackUrl`, with the org's session and `X-InstantSign-Signature`.
- Delivery is at least once and in order per envelope, so `handle()` can see the same event twice.
- The last `recipient.signed` is held until the signed PDF exists, because that event starts your
  download. `envelope.completed` follows it, and your code ignores it by then.
- `recipient.bounced` is only sent when SendGrid refuses a message outright. Bad addresses that bounce
  after SendGrid accepts the message aren't detected yet, so those signers show as sent.

**Setting the callback secret**

We give you the value for each org, and an admin enters it in InstantSign Setup as `Callback_Secret__c`.
It's 43 characters, and the field allows 255.

## 5. Version 1 limits

| Item | Behaviour | When it changes |
|---|---|---|
| Signing order | Everyone is invited at once. Your `openNextStep` will still show later signers as `Waiting` after they've been emailed. | Phase 6 |
| `/remind` | Returns 404, so the Remind button shows an error. | Phase 5 |
| `/certificate` | Returns 404, so each completed request gets a "Could not save Certificate" note in `Writeback_Result__c`. This is expected. | Phase 6 |
| Expiry and reminder days | Stored, but nothing acts on them yet. | Phase 6 |
| Email subject and message | Used in the invitation. | Now |
| Branding | Stored, but not used in emails yet. | Phase 5 |
