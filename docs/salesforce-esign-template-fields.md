# Salesforce data model for eSign

**For:** Salesforce team
**Status:** Draft, 2026-11-02. Replaces the 2026-10-30 version. Please discard that version: it asked
for new fields and objects that duplicate what the InstantSign source already has.

## Summary

**No new objects are needed.** The `Esign` project already defines the eSign data model. Only one new
field is proposed. The rest of the work is Apex and LWC changes, listed in
`esign-integration-plan.md`, section 2.

Field names below are shown without the `x360dc__` prefix.

## Test org

Scratch org `00Ddi00000FANNp`, namespace `x360dc`, expires 2026-11-22. Checked 2026-11-02: it has the
objects below, the InstantSign classes and LWCs, and both permission sets. They are deployed directly,
not installed from a package. Note that `sfdx-project.json` in our copy has an empty namespace, while
the org and the Apex use `x360dc__`.

## 1. Fields to add

| Object | Field | Type | Why |
|---|---|---|---|
| `Template__c` | `Sign_Email_Message__c` | Long Text Area, 4,000 | The invitation message is hardcoded in `prepareSend`. Add to the template editor and both permission sets. |

## 2. Configuration to add

| Item | Detail |
|---|---|
| Remote Site Setting | The x360-esign host, so Apex can call it. |
| `InstantSign_Settings__c.Service_Endpoint__c` | Set to the x360-esign URL. Must not be blank. |
| `InstantSign_Settings__c.Callback_Secret__c` | Set per org, matching the secret x360-esign holds. |
| Integration permission set | New and narrow: the callback class, plus the access it needs on the objects below. Today only `InstantSign_Admin` reaches the class. |

## 3. Existing model, no change needed

### `Template__c`: signing settings

| Field | Type | Purpose |
|---|---|---|
| `Sign_Enabled__c` | Checkbox | Separates documents with a signature from documents without one. Not enforced when sending yet (S8 in the plan). |
| `Sign_Email_Subject__c` | Text(255) | Invitation subject. |
| `Sign_Expiry_Days__c` | Number(3,0) | Days until the request expires. |
| `Sign_Reminder_Days__c` | Number(3,0) | Reminder interval in days. |
| `Sign_Setup_Status__c` | Picklist: Ready, Needs set-up, No signer boxes | Whether the template is ready. |
| `Signers_Read_Version_Id__c` | Text(18) | The Word file version last read for signers. |
| `Signers_Read_At__c` | Date/Time | When it was last read. |

Reused from before: `Name`, `SObject_Name__c`, `Active_Version_Id__c`, `IsActive__c`, `Document_Name__c`.

### `Signing_Template_Role__c`: one per signer on a template

Master-detail to `Template__c`.

| Field | Type | Purpose |
|---|---|---|
| `Role_Key__c` | Text(40) | `signer1`, `signer2`. Links the role to boxes in the Word file. |
| `Word_Label__c` | Text(80) | "Signer A", as shown in Word. |
| `Rep_Label__c` | Text(80) | "Customer", as shown to the sender. |
| `Boxes__c` | Text(255) | Boxes found for this signer. |
| `Default_Source__c` | Picklist: Ask, Owner, Sender, Primary contact, Contact role | Who usually signs. |
| `Contact_Role__c` | Text(80) | The contact role, when the source is Contact role. |
| `Routing_Order__c` | Number(3,0) | Signing step. The same number means signing in parallel. |
| `Locked__c` | Checkbox | The sender can't change this person. |
| `Verification__c` | Picklist: None, Email code | Always None for now. Hide Email code in the UI. |
| `Color__c` | Text(7) | Display colour. |
| `Is_New__c`, `Is_Removed__c` | Checkbox | Result of the last re-read of the Word file. |

### `Signing_Writeback_Map__c`: saves typed answers to records

Master-detail to `Template__c`.

| Field | Type | Purpose |
|---|---|---|
| `Role__c` | Lookup to `Signing_Template_Role__c` | Which signer. |
| `Box_Type__c` | Picklist: Company, Job Title | Which answer. |
| `Target_Field__c` | Text(255) | E.g. `Contact.Title`. |
| `Keep_Existing__c` | Checkbox | Don't overwrite an existing value. |

### `Signature_Request__c`: one per sent envelope

| Field | Type | Purpose |
|---|---|---|
| `Template__c` | Lookup | The template used. |
| `Document_Manager__c` | Lookup | The generated document's record. |
| `Parent_Record_Id__c`, `Parent_Object_Name__c` | Text | The record it was sent from. |
| `Envelope_Id__c` | Text(64) | x360-esign's envelope id. |
| `Status__c` | Picklist: Draft, Sent, Partly signed, Signed, Declined, Cancelled, Expired, Error | Current status. |
| `Document_Name__c`, `Message__c` | Text, Long Text | Document name and email message. |
| `Sent_By__c`, `Sent_Date__c`, `Expires_On__c`, `Completed_Date__c` | Lookup, Date/Time | Who and when. |
| `Decline_Reason__c`, `Error_Message__c`, `Writeback_Result__c` | Long Text | Outcomes. |
| `Signed_Document_Id__c`, `Certificate_Document_Id__c` | Text(18) | The saved files. |
| `Append_Signature_Page__c` | Checkbox | Stays unchecked. Templates with no boxes can't be sent for signature. |

### `Signature_Request_Recipient__c`: one per person on an envelope

Master-detail to `Signature_Request__c`.

| Field | Type | Purpose |
|---|---|---|
| `Type__c` | Picklist: Signer, Copy | Signs or receives a copy. |
| `Role_Key__c`, `Rep_Label__c` | Text | Matches the template role. |
| `Recipient_Name__c`, `Email__c` | Text, Email | Who it went to. |
| `Contact__c`, `User__c` | Lookup | The person's record, if any. |
| `Routing_Order__c` | Number(3,0) | Signing step. |
| `Status__c` | Picklist: Waiting, Sent, Opened, Signed, Declined, Bounced, Copy sent | Current status. |
| `Status_Detail__c`, `Signed_Date__c` | Text, Date/Time | Detail and timing. |
| `Envelope_Recipient_Id__c` | Text(64) | x360-esign's recipient id. |
| `Typed_Company__c`, `Typed_Job_Title__c` | Text(255) | Typed answers, saved back through the map above. |
| `Verification__c` | Picklist: None, Email code | Always None for now. |

### `InstantSign_Settings__c`: org defaults

`Service_Endpoint__c`, `Callback_Secret__c`, `Company_Name__c`, `Brand_Color__c`, `Logo_Document_Id__c`,
`Expiry_Days__c`, `Reminder_Days__c`, `Allow_Decline__c`, `Allow_Finish_Later__c`, `Sender_Mode__c`.

## 4. Questions for the Salesforce team

1. What replaces the scratch org after it expires on 2026-11-22, and when will a package version include
   InstantSign?
2. Are the older objects `Recipients_Detail__c` and `Recipient_Input_Detail__c`, and the field
   `Template__c.Recipeint_Input_Field_Details__c`, still needed? InstantSign doesn't use them. They are
   empty in the scratch org, and no code in the add-in, connector or x360-esign references them.

## Checklist

- [ ] Confirm the replacement org and the package version
- [ ] Add `Sign_Email_Message__c`
- [ ] Add the Remote Site Setting
- [ ] Set `Service_Endpoint__c` and `Callback_Secret__c`
- [ ] Create the integration permission set
- [ ] Answer the two questions above
