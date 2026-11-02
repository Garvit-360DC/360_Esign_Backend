# eSign integration plan: 360 InstantSign

**Status:** Draft, 2026-11-02. Replaces the 2026-10-30 plan, which routed sends through a new File
Connector endpoint.

## Goal

Use the existing Salesforce app (the `Esign` project, "360 InstantSign") as the sender experience
and the source of truth for templates and status. x360-esign becomes the signing service behind it.

## Who owns what

| Component | Responsibility | Change needed |
|---|---|---|
| **Word add-in** | Places signer boxes in the template. | None. Its tag format becomes the standard. |
| **Salesforce app** | Template setup, Send for Signature, status, cancel, remind, saving the signed PDF, saving answers back to records. | Fixes in section 2. |
| **File Connector** | Generates the document from the record, as it does today, and charges the credit. | Signer tags pass through generation unchanged. Done. |
| **x360-esign** | Envelopes, signing links, emails, reminders, expiry, stamping, sealing, certificate, status callbacks. | New API and callbacks, section 3. |
| **Signer frontend** (`esgin-front`) | The signing ceremony. | Only what new features require. |

## End-to-end flow

```
Rep clicks Send for Signature (Salesforce)
  │
  ├─ 1. prepareSend ──▶ File Connector POST /generate-document
  │                     returns a .docx ContentVersion, charges the credit
  │     Rep confirms signers
  │
  ├─ 2. POST /v1/envelopes ──▶ x360-esign
  │     x360-esign downloads the .docx from Salesforce, converts it, locates the boxes
  │     Salesforce saves Signature_Request__c as Draft (commits)
  │
  ├─ 3. POST /v1/envelopes/{id}/send ──▶ x360-esign emails the signers
  │     Salesforce sets the request to Sent
  │
  ├─ 4. Signers sign in esgin-front
  │     x360-esign POSTs each event ──▶ /services/apexrest/x360dc/instantsign/events
  │
  └─ 5. On completion, Salesforce GETs signed-pdf and certificate, and saves them to the record
```

## 1. Check first

These answers can change the work below, so do them before building.

1. **Do signer boxes survive generation?** They failed generation at first, because the connector read
   `{%signer1}` as a Salesforce field. `parseDocument.js` now keeps them unchanged, and a built `.docx`
   passes `extractSignatureFields`. Still to test: a real add-in template in the test org, and a box
   inside a loop, which would repeat it.
2. **Test org.** Use scratch org `00Ddi00000FANNp`, namespace `x360dc`. Checked 2026-11-02: it has the
   InstantSign objects, classes, LWCs and permission sets. It expires 2026-11-22, so plan for a
   replacement if testing runs past that date.

## 2. Salesforce app: what to change

### Blocking

| # | Change | Where | Why |
|---|---|---|---|
| S1 | Read tags from picture alt text (`descr`) as well as document text. | `InstantSignTagParser` | It only reads `<w:t>` text. Add-in templates come back with no signers, and sending silently falls back to one "Signer 1" with an appended page. |
| S2 | Accept the add-in's colon format, `{%signer1:initial}`. Keep accepting `_`. | `TAG_PATTERN` | The current pattern doesn't match a colon. |
| S3 | Generate `DOCX` instead of `PDF` for sends. Keep PDF for the preview. | `documentManagerInput` | x360-esign needs the `.docx` to find the boxes. |
| S4 | Require `Service_Endpoint__c`. Remove the fallback to the connector URL. | `InstantSignServiceClient.endpoint` | With it blank, calls go to the connector, which has no such routes. |
| S5 | Add a Remote Site Setting for the x360-esign host. | Metadata | Without it Apex can't make the callout. |
| S6 | Send the `product-name` the token was issued for. | `HttpTransport` | The client sends `360 InstantSign`, but other callouts default to `360 File Sync`. Auth compares the product stored in the token, so this would be rejected. |
| S7 | Split `createAndSend` into two steps with the database save between them. | `InstantSignSendController.send`, `instantSignSendAction` | Today the envelope is sent before anything is saved. If the save fails, signers have emails and Salesforce has no record. Apex can't make a callout after an uncommitted save, so the LWC must make two calls: create and save as `Draft`, then send and set `Sent`. |
| S8 | Offer only templates with `Sign_Enabled__c` checked in Send for Signature. | `getSendContext` | This flag separates documents with a signature from documents without one. It isn't checked today, so every active template is offered. |
| S16 | Block sending when a template has no signer boxes, with a clear message. Remove the fallback that adds "Signer 1" and an appended page. | `prepareSend`, `instantSignSendAction` | Documents without a signature don't go through signing, and x360-esign can't append a page. |
| S17 | Hide the `Email code` option and always send `None`. | `instantSignTemplateEditor`, `instantSignSendAction` | Not being built for now. |

### Should fix before go-live

| # | Change | Where |
|---|---|---|
| S9 | Re-read signers at send time if `Active_Version_Id__c` differs from `Signers_Read_Version_Id__c`, so a new signer added in Word isn't missed. | `prepareSend` |
| S10 | Check that every signer role on the template is in the send payload. | `normaliseSlots` / `validate` |
| S11 | Warn at setup when boxes are in a header or footer. x360-esign rejects them. | `InstantSignTemplateSync` |
| S12 | Make the callback signature mandatory. A blank `Callback_Secret__c` currently accepts everything. | `signatureOk` |
| S13 | Create a narrow permission set for the integration user. Only `InstantSign_Admin` can reach the callback today. The class runs with sharing, so requests that user can't see return 404. | Permission sets |
| S14 | Retry failed signed-PDF downloads. Today a failure is only written to `Writeback_Result__c`. | `InstantSignCompletionQueueable` |
| S15 | Add `Sign_Email_Message__c`. The email message is hardcoded. | `Template__c`, `prepareSend` |

### Security, do now

- **Rotate** the OAuth client secret hardcoded at `DriveConfigSetup.cls:18` and the shared secret at
  `DriveConfigSetup.cls:1012`, then move both out of source.
- **Remove** token logging: `X360SmartDocsUtilityClass.cls:389` and `:1185`, `DriveConfigSetup.cls:133`,
  `:191` and `:854`.
- **Put the `Esign` folder in git.** It has no version history.

## 3. x360-esign: what to build

### 3.1 Authentication

x360-esign uses the same MongoDB as the File Connector. Port the connector's `authenticateTokenV1` as
it is, because Salesforce already sends that token and the `org-id` and `product-name` headers. This
needs:

- the same `dbtokens` collection
- the same `NODE_TOKEN_ENCRYPTION_KEY` and `NODE_TOKEN_ENCRYPTION_IV`

It also gives x360-esign the org's Salesforce session, for downloading documents and posting callbacks.
`dbtokens` has one row per org and product, so x360-esign reads and refreshes it by both. It uses the
same `isRefreshing` lock fields as the connector so their token refreshes don't collide.

**Console sessions stay out of `dbtokens`.** The console's sign-in writes a session for the org. In a
shared database that would overwrite a connector row, and several connector paths find rows by org
alone, so an extra row could also be picked up by mistake. Console sessions use their own collection.

**`POST /getToken` no longer issues a JWT.** It issued a non-expiring JWT for any org ID with no
authentication. The console only uses it to get the sign-in URL, so that part stays. `esgin-front` also
uses the sender `/sign-requests` and `/templates` routes, so they stay on, behind the console's JWT.

### 3.2 The API Salesforce already calls

Match these exactly. The contract is defined by `InstantSignServiceClient.cls`.

| Route | Behaviour |
|---|---|
| `POST /v1/envelopes` | Create without sending. Returns `{ id, status, recipients: [{ id, roleKey }] }`. |
| `POST /v1/envelopes/:id/send` | Start the signing flow. |
| `POST /v1/envelopes/:id/remind` | Email the current signers. |
| `POST /v1/envelopes/:id/void` | Body `{ reason }`. Stops all links working. |
| `GET /v1/envelopes/:id/signed-pdf` | PDF bytes. |
| `GET /v1/envelopes/:id/certificate` | PDF bytes. |
| `GET /v1/health` | 200 when healthy. |

**Errors** must return top-level `{ "message": "..." }`. That is what the client reads, and the
current `{ success, error: { message } }` shape would display badly.

**Create request:**

```json
{
  "subject": "Please sign: Sales Agreement",
  "message": "Hi, please review and sign.",
  "documentName": "Sales Agreement",
  "documentVersionId": "068...",
  "sourceObjectType": "Opportunity",
  "sourceObjectId": "006...",
  "routingType": "SEQUENTIAL",
  "appendSignaturePage": false,
  "expiresInDays": 30,
  "remindEveryDays": 3,
  "callbackUrl": "https://<org>.my.salesforce.com/services/apexrest/x360dc/instantsign/events",
  "branding": { "companyName": "...", "color": "#...", "senderName": "...", "senderEmail": "..." },
  "recipients": [
    { "roleKey": "signer1", "name": "...", "email": "...", "role": "SIGNER", "order": 1, "verification": "None" },
    { "roleKey": "cc:a@b.com", "name": "...", "email": "a@b.com", "role": "CC", "order": 99, "verification": "None" }
  ]
}
```

Notes for implementers:

- **Download the document once and keep a copy.** Pull it with the existing `downloadContentVersion`.
  Generation can add new versions to the same Salesforce file, so an envelope must not depend on it
  later.
- **Keep create fast.** It runs inside an Apex callout, with a 120-second limit.
- **Version 1 limits.** Return a clear error if `appendSignaturePage` is true or `verification` isn't
  `None`. Salesforce won't send these once S16 and S17 are done.
- **Same `order` means signing in parallel.** `routingType` is always `SEQUENTIAL` from Salesforce.
- **CC recipients are new.** The `cc:` role key fails the current `SIGNER_ROLE_RE`, and CC recipients
  have no fields. They receive a copy on completion.
- **Branding is new.** `senderName` is hardcoded as "Sender" in `sign-request.mapper.ts`, and emails
  don't use the company name or colour yet.

### 3.3 Status callbacks

POST to the envelope's `callbackUrl` with the org's Salesforce session.

```json
{
  "event": "recipient.signed",
  "envelopeId": "...",
  "recipientId": "...",
  "roleKey": "signer1",
  "reason": null,
  "detail": null,
  "timestamp": "2026-11-02T10:02:00Z",
  "typedValues": { "Company": "...", "Job Title": "..." }
}
```

Events: `recipient.viewed`, `recipient.signed`, `recipient.declined`, `recipient.bounced`,
`envelope.completed`, `envelope.declined`, `envelope.voided`, `envelope.expired`.

- **Signature:** header `X-InstantSign-Signature` = base64 of HMAC-SHA256 of the body, using a secret
  per org that matches `Callback_Secret__c`.
- **Delivery:** write each event to an outbox in the same database operation as the status change. A
  worker sends them with retries and a dead-letter state.
- **Order:** the signed PDF must exist before `envelope.completed` goes out, because Salesforce fetches
  it immediately.
- **Bounces:** SMTP only reports failures it sees at send time. Later bounces need a mail provider
  webhook, so treat that as a later item.

### 3.4 Fix before go-live

- **Signer status can be overwritten.** `updateSignRequest` writes the whole `signers` array from a copy
  loaded earlier. Use per-signer `$set` updates and one conditional update to mark completion.
- **One bad signature image blocks the envelope.** Decode and size-check images when they are saved.
- **Rate limiting.** Set `trust proxy`, or all users share one limit behind a proxy.
- **Remove `ngrok.yml` from git** and rotate its token.

### 3.5 Then add

Sequential sending, scheduled reminders and expiry, audit trail, certificate of completion, and the
third-party seal.

## 4. Decisions made

| # | Topic | Decision |
|---|---|---|
| 1 | **Database** | x360-esign uses the same MongoDB as the File Connector (section 3.1). |
| 2 | **Document types** | Salesforce has two types: with signature and without signature. Only templates with `Sign_Enabled__c` and signer boxes can be sent for signature (S8, S16). Documents without a signature keep the normal generation flow. There is no appended signature page. |
| 3 | **Email code verification** | Not for now (S17). |
| 4 | **Credits** | Unchanged. Each send uses one document generation credit at `prepareSend`, even if the rep abandons the send. |

**To confirm:** can a template with signer boxes also be generated through normal document generation?
If so, the output would still show the placeholder boxes.

## 5. Phases

Phases run in order. Each one ends with something that can be tested.

### Phase 0: Prerequisites

Owner: Garvit's team and the Salesforce team. Can run alongside Phase 1.

- [x] Signer tags pass through connector generation (`parseDocument.js`). Tested on a built `.docx`.
- [ ] Generate a real add-in template in the test org and confirm the boxes survive.
- [ ] Rotate the secrets at `DriveConfigSetup.cls:18` and `:1012`, and the ngrok token.
- [ ] Remove token logging, and put `Esign` in git.

**Done when** a real generated `.docx` passes `extractSignatureFields`.

### Phase 1: x360-esign foundation

Owner: x360-esign.

- [x] Port `authenticateTokenV1`, reading `dbtokens` by org and product. Not mounted until Phase 2.
- [x] Keep console sessions out of `dbtokens`, so x360-esign can't overwrite connector rows.
- [x] Remove the unauthenticated JWT from `POST /getToken`.
- [x] Per-signer status updates, with one caller completing the envelope.
- [x] Check signature images when they are saved.
- [x] Set `trust proxy`, and stop tracking `ngrok.yml`.

**Done when** the service can safely point at the shared database. Pointing it there is a separate
step, taken when Phase 2 is ready to test.

### Phase 2: Envelope API

Owner: x360-esign.

- [x] `POST /v1/envelopes`, `/send`, `/void` and `GET /v1/health`, with `{ "message": "..." }` errors.
- [x] Download and keep a copy of the document from Salesforce.
- [ ] Test against the real test org: real token, real generated document, ConvertAPI and SMTP.

**Done when** a request matching `InstantSignServiceClient` creates, sends and voids an envelope.

Version 1 limits: everyone is invited at once, whatever their `order`, until sequential sending in
Phase 6. CC recipients are refused until Phase 5. Expiry and reminder days are stored but not acted on.

### Phase 3: First real send

Owner: Salesforce team.

- S1–S8, S16 and S17.

**Done when** a rep sends from the test org and signers can sign. Status doesn't update yet.

### Phase 4: Status and signed PDF

Owner: both.

- **x360-esign:** outbox, callbacks and `/signed-pdf`.
- **Salesforce:** S12–S14.

**Done when** Version 1 is met: a rep can send a Word add-in template with two signers from an
Opportunity, both sign in `esgin-front`, the status updates on the record, and the signed PDF appears
in Files.

### Phase 5: Complete the sender features

Owner: both.

- CC recipients, branding, `/remind`, and S9–S11 and S15.

### Phase 6: Later

Owner: x360-esign.

- Sequential sending, scheduled reminders and expiry, audit trail, certificate, third-party seal.
- Clean up abandoned draft envelopes and their files.

The test org expires on 2026-11-22, during Phases 2–4, so a replacement is needed before then.
