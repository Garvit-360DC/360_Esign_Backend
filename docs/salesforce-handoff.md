# InstantSign: instructions for the Salesforce team

**Date:** 2026-11-02. **Goal:** a rep sends a Word add-in template with two signers from an Opportunity, both sign, the status updates on the record, and the signed PDF appears in Files.

The signing service (x360-esign) is built for this, but it hasn't been tested against a real org yet. Everything below is a change in the `Esign` app. Line numbers come from our copy, so check them against yours.

Do the parts in order. Part 2 gets a first send working, and Part 3 gets status and the signed PDF back to the record. Part 4 lists what to redo when the code moves to the new org.

## Part 1: What's decided

| Topic | Decision | What it means for you |
|---|---|---|
| Product name | `360 File Sync` | Every call to the signing service sends this as `product-name`, so it uses the org's existing `dbtokens` row. Any other name gives a 403. |
| Integration user | The Salesforce admin user | Callbacks and file downloads run as the admin who authorized that `dbtokens` row. See Step 9. |
| Org | `x360dc` (`00Ddi00000FANNp`) is for development only | The code moves to a new Salesforce org and then the marketplace when we're done. See Part 4. This org expires on 2026-11-22, so it needs a replacement if development runs past that date. |

## Part 2: First send

### Step 1. Read signer tags from picture alt text (S1, S2)

**File:** `InstantSignTagParser.cls`

The add-in puts tags in picture alt text, as `{%signer1}` or `{%signer1:fullName}`. The parser only reads `<w:t>` text and doesn't accept a colon, so add-in templates come back with no signers.

Add the colon to `TAG_PATTERN` (line 16), and keep the other separators:

```apex
public static final String TAG_PATTERN = '\\{%\\s*signer(\\d{1,2})(?:\\s*[:_\\-.]?\\s*([a-z]+))?\\s*\\}';
```

Read alt text in `scanXml` (line 98), before the paragraph loop:

```apex
private static final Pattern ALT_TEXT = Pattern.compile('(?i)\\bdescr\\s*=\\s*"([^"]*)"');

Matcher am = ALT_TEXT.matcher(xml);
while (am.find()) {
    collectTags(am.group(1).unescapeXml(), byIndex);
}
```

Add a test using a `document.xml` with a `<wp:docPr descr="{%signer1:fullName}"/>`.

### Step 2. Generate a Word file for sends (S3)

**File:** `InstantSignSendController.cls`, `documentManagerInput` (line 394)

The service needs the `.docx` to find the boxes. It refuses anything else with "Sending for signature needs a Word (.docx) document."

Add a parameter for the document type. Pass `'DOCX'` from `prepareSend` (line 183) and keep `'PDF'` for `previewLink` (line 244).

### Step 3. Point the client at the service (S4, S5, S6)

**File:** `InstantSignServiceClient.cls`

- **`endpoint()` (lines 110–112):** remove the fallback to `getNodeEndPoint()`. With no value set, calls go to the connector, which has no such routes. The existing "endpoint is not set" error then does the right thing.
- **`HttpTransport` (line 175):** change the `product-name` from `360 InstantSign` to `360 File Sync`.
- **Remote site:** add `force-app/main/default/remoteSiteSettings/InstantSignService.remoteSite-meta.xml`. We'll send you the production host. In `x360dc`, the existing `NodeEndPoint` remote site already covers our test host.

### Step 4. Split create and send into two calls (S7)

**Files:** `InstantSignServiceClient.cls`, `InstantSignSendController.cls`, `instantSignSendAction.js`

Today signers are emailed before anything is saved. If the save fails, signers have emails and Salesforce has no record. Apex can't make a callout after an uncommitted save, so the LWC has to make two separate calls.

**In the client,** replace `createAndSend` with two methods:

```apex
public static EnvelopeResult createEnvelope(EnvelopeRequest req) {
    HttpResponse res = transport.call('POST', '/v1/envelopes', JSON.serialize(req, true));
    expect(res, 'create the signing request');
    return parseEnvelope(res.getBody());
}

public static void sendEnvelope(String envelopeId) {
    expect(transport.call('POST', '/v1/envelopes/' + enc(envelopeId) + '/send', '{}'), 'send the signing request');
}
```

**In the controller,** split `send` (line 254):

- `createRequest(payloadJson)`: everything `send` does today, except that it calls `createEnvelope`, saves `Signature_Request__c` as `Draft`, saves recipients as `Waiting`, and returns the request Id. It doesn't set `Sent_Date__c` or write the parent status.
- `sendRequest(requestId)`: load the request. If it's not `Draft`, return success. Otherwise call `sendEnvelope`, then set the request to `Sent` with `Sent_Date__c`, set signers to `Sent`, and call `InstantSignRecordStatus.write`. Query the recipients directly, not through the `Recipients__r` subquery, because user-mode DML refuses subquery rows.

**In the LWC** (line 212), `await` one and then the other. If `sendRequest` fails, keep the request Id so the rep can retry it. Don't call `createRequest` again.

**Don't set `Sent` on a failed send.** The service returns 502 if no invitation could be delivered and 503 if it has no mail set up. The envelope stays a draft, ready to retry.

### Step 5. Only offer templates that can be signed (S8, S16)

**File:** `InstantSignSendController.cls`

- **`getSendContext` (line 133):** add `AND Sign_Enabled__c = true`. Saving a template in the editor sets this flag, so an existing template only appears after someone saves it.
- **`getSendContext` (line 157):** skip templates with no signers: `if (!o.hasBoxes) { continue; }`.
- **`prepareSend`:** move the check to right after `loadTemplate` (line 178), and remove the fallback slot (lines 221–227). This has to run **before** `DocumentGeneration.dispatch` on line 184, or the rep is charged a credit for a document they can't send.

```apex
if (t.Signing_Roles__r.isEmpty()) {
    return fail('This template has no signer boxes. Add them in the Word add-in, then read the signers again.');
}
```

- **`envelopeRequest` (line 495):** set `req.appendSignaturePage = false`.
- **`instantSignSendAction.js`:** remove the "add a signer" path (around line 251) and the "no signer boxes" wording (lines 43–44 and 52).

### Step 6. Hide what isn't available yet (S17, S18)

The service refuses these with a 400, which fails the whole send.

| What | Where | Change |
|---|---|---|
| Email code | `InstantSignTemplateController.cls` line 447 | Offer only `None`. Update the test at `InstantSignTemplateControllerTest.cls` line 69. |
| Email code | `InstantSignSendController.cls` lines 410 and 442 | Always use `None`, so templates that already hold `Email code` still send. |
| CC recipients | `instantSignSendAction` | Hide the "send a copy" section. |
| CC recipients | `InstantSignSendController.cls` lines 307–313 and 513–521 | Remove for now, and we'll bring them back in Phase 5. |

### Step 7. Correct the messages and statuses

These describe things the service doesn't do yet.

| Where | Today | Change to |
|---|---|---|
| `send`, line 319 | "We'll email you as each person signs." | "Sent to {names}. The status updates here as each person signs." |
| `cancel`, line 360 | "Everyone has been told and their links no longer work." | "Cancelled. The signing links no longer work." Signers aren't notified. |
| `send`, line 304 | Later signers are `Waiting` | Set every signer to `Sent`, because everyone is invited at once until Phase 6. |
| Remind button | Calls `/remind`, which returns 404 | Hide it until Phase 5. |

## Part 3: Status and the signed PDF

### Step 8. Make the callback signature mandatory (S12)

**File:** `InstantSignEventsResource.cls`, `signatureOk` (line 265)

A blank secret accepts any caller. Change it to `if (String.isBlank(secret)) { return false; }`, and update the message at `InstantSignAdminController.cls` line 136.

We give you the secret for `x360dc`, and an admin enters it in InstantSign Setup as `Callback_Secret__c`. It's 43 characters. The signature format already matches your code.

### Step 9. Set up the admin as the integration user (S13)

No new permission set is needed. Do these in the org:

1. **Confirm the user.** It must be the admin who authorized the `360 File Sync` token, because callbacks run as that user.
2. **Assign `InstantSign_Admin` to that admin.** The System Administrator profile isn't enough, because the callback code uses `USER_MODE`, which enforces field access. This permission set already covers the Apex classes and the InstantSign objects and fields.
3. **Check field access on your own fields.** The admin needs edit access to the parent objects' status fields, and to any `Contact` or `Account` fields in your write-back maps. `InstantSign_Admin` doesn't cover these.
4. **Check record access.** The callback class runs with sharing, so a request the admin can't see returns a 404. The admin's profile needs View All Data and Modify All Data. Also confirm the admin can open a generated file.

### Step 10. Retry the signed PDF download (S14)

**File:** `InstantSignCompletionQueueable.cls`

**This is the most important fix in Part 3.** Your code fetches the signed PDF once. If that fails, the PDF never reaches the record, and the only trace is a note in `Writeback_Result__c`.

Add an attempt count to the constructor. At the end of `execute`:

```apex
if (sr.Signed_Document_Id__c == null && attempt < 5 && !Test.isRunningTest()) {
    System.enqueueJob(new InstantSignCompletionQueueable(requestId, attempt + 1), 5);
}
```

- Run `writeBack` only when `attempt == 0`, so answers aren't saved twice.
- Don't retry for the certificate alone. It returns 404 until Phase 6.

## Part 4: Moving to the new org and the marketplace

You don't need any of this for the first send, but keep it in mind while you make the changes above.

**Redo in each new org**

- Authorize the `360 File Sync` token as that org's admin, which creates its `dbtokens` row.
- Set `Service_Endpoint__c`, and enter that org's `Callback_Secret__c`. The secret is different for every org, so the `x360dc` one won't work.
- Repeat Step 9 for that org's admin.

**Change in the code**

- **Namespace:** `x360dc` is hard-coded at `GDAuthConnect.cls` line 33 and `InstantSignServiceClientTest.cls` line 74. Replace these if the namespace changes. `callbackUrl()` builds its path from the namespace, so with no namespace it produces `/services/apexrest//instantsign/events`.
- **Package contents:** include the `InstantSignService` remote site from Step 3 and the `InstantSign_Admin` permission set. Customer orgs have neither unless the package adds them.
- **Security items:** the hard-coded secrets and token logging listed below have to be gone before marketplace security review.

**Still open on our side**

Entering each org's callback secret by hand works for development, but not for marketplace customers. We'll tell you how the secret reaches a customer org before you start packaging. Don't build anything for this yet.

## How the service behaves

**Create and send**

- `POST /v1/envelopes` returns 201 with `{ id, status, recipients: [{ id, roleKey }] }`. Status is `draft`, and nobody is emailed.
- `POST /v1/envelopes/{id}/send` returns the same shape with status `pending`. It's safe to retry, because signers are emailed once.
- All errors have a top-level `message`, which your `expect()` method already reads.
- `callbackUrl` must be `https` on a `.salesforce.com` host.
- Create can take up to about 90 seconds, because it converts the document. Your 120-second timeout covers it.

**Callbacks**

- Delivery is at least once and in order per envelope, so `handle()` can see the same event twice.
- A failed event, including a 404, is retried for about 8 hours and then set aside.
- The last `recipient.signed` is held until the signed PDF exists, because that event starts your download. `envelope.completed` follows it, and your code ignores it by then.
- `recipient.bounced` is only sent when SendGrid refuses a message outright. An address that bounces after SendGrid accepts it isn't detected yet, so that signer shows as `Sent`.

**Not available yet**

| Item | Behaviour | Arrives in |
|---|---|---|
| Certificate | Returns 404, so each completed request gets a "Could not save Certificate" note. This is expected. | Phase 6 |
| Signing order | Everyone is invited at once. | Phase 6 |
| Expiry and reminder days | Stored, but nothing acts on them. `Expires_On__c` is only a label for now. | Phase 6 |
| Reminders | `/remind` returns 404. | Phase 5 |
| Branding | Stored, but not used in emails. | Phase 5 |

## Security, do now

These aren't part of signing, but they shouldn't wait.

- **Rotate** the OAuth client secret at `DriveConfigSetup.cls` line 18 and the shared secret at line 1012, then move both out of source.
- **Remove token logging** at `X360SmartDocsUtilityClass.cls` lines 389 and 1185, and `DriveConfigSetup.cls` lines 133, 191 and 854.
- **Put `Esign` in git.** It has no version history.

## How to check it's done

Update the existing tests for the changes above, then run them all. They use `MockTransport`, so they won't prove the real connection. In the test org:

- [ ] Reading signers on an add-in template shows the right people and boxes.
- [ ] A template with no boxes, or without `Sign_Enabled__c`, isn't offered, and no credit is charged.
- [ ] Sending creates a `Draft`, then moves it to `Sent`, and both signers get an email.
- [ ] If send fails, the request stays `Draft`, and retrying doesn't charge another credit.
- [ ] Opening the link moves that signer to `Opened`.
- [ ] After one signature, the request shows `Partly signed`.
- [ ] After both, it shows `Signed`, and the signed PDF is in Files on the Opportunity.
- [ ] Typed company and job title values are saved to the mapped fields.
- [ ] Declining shows `Declined` with the reason.
- [ ] Cancelling shows `Cancelled`, and the links stop working.
- [ ] A callback with a wrong signature is refused with a 401.
