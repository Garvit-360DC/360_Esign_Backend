import type {
  FieldRect,
  SignFieldType,
  SignatureFieldSource,
  SignerRole,
} from "../sign-requests/sign-request.types";

/**
 * Reusable send definitions, stored in Salesforce rather than MongoDB.
 *
 * The documents already live there as ContentVersions and the records that drive a send are
 * there too, so a template belongs alongside them. The API owns no copy — every read is a
 * SOQL query against the caller's org, which also means org scoping is inherent rather than
 * something this service has to remember to apply.
 *
 * Objects: `eSign_Template__c` with `eSign_Template_Recipient__c` and
 * `eSign_Template_Field__c` as master-detail children.
 */

/** Whether a recipient signs or is only copied. The signing API knows nothing of CC. */
export type RecipientType = "SIGNER" | "CC";

export type TemplateRecipient = {
  id: string;
  /** The slot the signing API keys on: signer1, signer2, … */
  role: SignerRole;
  recipientType: RecipientType;
  /** What the sender sees on the send screen — "Customer", "Account Manager". */
  label: string | null;
  order: number;
  /** Pre-fills the send screen. Recipients are still confirmed before anything goes out. */
  defaultName: string | null;
  defaultEmail: string | null;
};

export type TemplateField = {
  id: string;
  role: SignerRole;
  recipientId: string | null;
  type: SignFieldType;
  page: number;
  rect: FieldRect;
  source: SignatureFieldSource;
  required: boolean;
};

export type Template = {
  id: string;
  /** Stable handle used by the API, so a request never carries a raw Salesforce record id. */
  key: string;
  name: string;
  description: string | null;
  /** Salesforce object this template is offered on, e.g. `Opportunity`. */
  sObjectName: string | null;
  documentVersionId: string;
  documentName: string | null;
  pageCount: number | null;
  isActive: boolean;
  emailSubject: string | null;
  emailMessage: string | null;
  signingOrder: "Parallel" | "Sequential";
  expiresInDays: number | null;
  reminderDays: string | null;
  recipients: TemplateRecipient[];
  fields: TemplateField[];
};

/** A row in the template picker. Deliberately without recipients or boxes. */
export type TemplateSummary = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  sObjectName: string | null;
  documentName: string | null;
  pageCount: number | null;
  isActive: boolean;
  recipientCount: number;
  fieldCount: number;
};

/** What the prepare screen sends to save its work as a template. */
export type CreateTemplateInput = {
  name: string;
  description?: string;
  sObjectName?: string;
  emailSubject?: string;
  emailMessage?: string;
  signingOrder?: "Parallel" | "Sequential";
  expiresInDays?: number;
  reminderDays?: string;
  recipients: {
    role: SignerRole;
    recipientType?: RecipientType;
    label?: string;
    order?: number;
    defaultName?: string;
    defaultEmail?: string;
  }[];
  fields: {
    role: SignerRole;
    type: SignFieldType;
    page: number;
    rect: FieldRect;
    source?: SignatureFieldSource;
    required?: boolean;
  }[];
};
