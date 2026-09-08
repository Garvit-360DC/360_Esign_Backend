/**
 * A signer is an ordinal slot, written into the document by the Word add-in as
 * `{%signer1}`, `{%signer2}`, and so on. Slots run 1..N with no gaps, so a document with
 * three signature boxes uses signer1 through signer3. There is no upper bound.
 */
export type SignerRole = `signer${number}`;

export const SIGNER_ROLE_PATTERN = "signer[1-9][0-9]*";
export const SIGNER_ROLE_RE = new RegExp(`^${SIGNER_ROLE_PATTERN}$`);

export function isSignerRole(value: string): value is SignerRole {
  return SIGNER_ROLE_RE.test(value);
}

/** The slot number behind a role, so roles can be ordered and labelled. */
export function signerSlot(role: SignerRole): number {
  return Number(role.slice("signer".length));
}

/**
 * The same ten colours the Word add-in draws placeholder boxes with and the ceremony
 * highlights fields in, so a signer keeps one colour from the document through to the
 * email that invites them.
 */
export const SIGNER_COLORS = [
  { fill: "#D6F5DD", accent: "#34A853" },
  { fill: "#E9DDF7", accent: "#8E4EC6" },
  { fill: "#FDEBC8", accent: "#E8A33D" },
  { fill: "#D6E4F7", accent: "#3B7DD8" },
  { fill: "#FBD9E6", accent: "#D94F86" },
  { fill: "#CFF0EC", accent: "#17A2A2" },
  { fill: "#FDE0D0", accent: "#E4703A" },
  { fill: "#DDDEF7", accent: "#5A5FC7" },
  { fill: "#E6F5C8", accent: "#7CB342" },
  { fill: "#F7D9D9", accent: "#C74545" },
] as const;

export function signerColor(role: SignerRole): { fill: string; accent: string } {
  const slot = signerSlot(role);
  return SIGNER_COLORS[(Math.max(1, slot) - 1) % SIGNER_COLORS.length];
}

/** "signer1" -> "Signer A", matching how the add-in labels them. */
export function signerLabel(role: SignerRole): string {
  let remaining = signerSlot(role);
  let label = "";

  while (remaining > 0) {
    remaining -= 1;
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26);
  }

  return `Signer ${label}`;
}

/**
 * What a box asks its signer for.
 *
 * Two families sit behind these. A `drawn` field holds a PNG data URL — the signer draws,
 * types or uploads it. A `text` field holds a plain string, and most of those we already
 * know, so they are filled in rather than asked for.
 */
export type SignFieldType =
  | "signature"
  | "initial"
  | "fullName"
  | "email"
  | "signDate"
  | "company"
  | "jobTitle";

export type SignFieldTypeMeta = {
  label: string;
  family: "drawn" | "text";
  /** Where the value comes from without asking. Null means the signer supplies it. */
  autoFill: "name" | "email" | "date" | null;
  /** Default box size as a fraction of the page, used when one is dropped by hand. */
  width: number;
  height: number;
};

export const FIELD_TYPE_META: Record<SignFieldType, SignFieldTypeMeta> = {
  signature: { label: "Signature", family: "drawn", autoFill: null, width: 0.25, height: 0.08 },
  initial: { label: "Initial", family: "drawn", autoFill: null, width: 0.1, height: 0.055 },
  fullName: { label: "Full Name", family: "text", autoFill: "name", width: 0.24, height: 0.035 },
  email: { label: "Email", family: "text", autoFill: "email", width: 0.28, height: 0.035 },
  signDate: { label: "Sign Date", family: "text", autoFill: "date", width: 0.16, height: 0.035 },
  company: { label: "Company", family: "text", autoFill: null, width: 0.24, height: 0.035 },
  jobTitle: { label: "Job Title", family: "text", autoFill: null, width: 0.24, height: 0.035 },
};

export const SIGN_FIELD_TYPES = Object.keys(FIELD_TYPE_META) as SignFieldType[];

export function isSignFieldType(value: string): value is SignFieldType {
  return Object.prototype.hasOwnProperty.call(FIELD_TYPE_META, value);
}

/** True for the fields whose value is an image rather than a string. */
export function isDrawnField(type: SignFieldType): boolean {
  return FIELD_TYPE_META[type].family === "drawn";
}

export type SignerStatus = "pending" | "viewed" | "signed" | "declined";
export type SignRequestStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "declined";
/** Where a field came from: an add-in picture, a literal text tag, or placed by hand. */
export type SignatureFieldSource = "image" | "text" | "manual";

export type SignerInput = {
  role: SignerRole;
  name: string;
  email: string;
};

export type FieldRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Signer = SignerInput & {
  id: string;
  token: string;
  status: SignerStatus;
  /** Why this signer declined. Null until they do. */
  declineReason: string | null;
  /** When this signer first opened the document. */
  viewedAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
  /** When a reminder was last sent to them. Null until the sender nudges them. */
  remindedAt: Date | null;
};

export type PublicSigner = Omit<Signer, "token"> & {
  signUrl: string;
};

export type DetectedPlaceholder = {
  role: SignerRole;
  tag: string;
  source: SignatureFieldSource;
  widthPt?: number;
  heightPt?: number;
  index: number;
};

export type SignatureField = DetectedPlaceholder & {
  id: string;
  /** What this box collects. Boxes the Word add-in inserts are always signatures. */
  type: SignFieldType;
  page: number;
  rect: FieldRect;
  value?: string | null;
};

export type SignRequest = {
  id: string;
  /** The Salesforce org that owns this envelope. Every sender-facing query filters on it. */
  orgId: string;
  status: SignRequestStatus;
  fileName: string;
  fileId: string;
  pdfFileId: string;
  signedPdfFileId: string | null;
  pageCount: number;
  mimeType: string;
  signers: Signer[];
  signatureFields: SignatureField[];
  /** When the last signer finished. Null until the envelope completes. */
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicSignRequest = Omit<SignRequest, "signers"> & {
  signers: PublicSigner[];
};

/** A file held for this envelope, as shown in the detail screen's Documents panel. */
export type DocumentInfo = {
  kind: "original" | "converted" | "signed";
  fileName: string;
  sizeBytes: number;
  contentType: string;
  uploadedAt: Date;
};

/** The envelope plus the files behind it. */
export type SignRequestDetail = PublicSignRequest & {
  documents: DocumentInfo[];
};

/** Aggregates behind the admin dashboard. */
export type SignRequestStats = {
  totals: {
    sent: number;
    completed: number;
    declined: number;
    awaiting: number;
    voided: number;
  };
  /** 0..1, completed over everything ever sent. Null when nothing has been sent. */
  completionRate: number | null;
  /**
   * Median hours from creation to the last update on completed envelopes. The model has no
   * explicit completedAt, so updatedAt stands in for it.
   */
  medianHoursToComplete: number | null;
  /** Oldest still-open envelope, in days. Null when nothing is waiting. */
  oldestAwaitingDays: number | null;
  monthly: { month: string; sent: number; completed: number }[];
  funnel: {
    sent: number;
    viewed: number;
    partiallySigned: number;
    completed: number;
    declined: number;
  };
  thisMonth: { sent: number; completed: number };
  lastMonth: { sent: number; completed: number };
};

/**
 * Row shape for the envelope list. Deliberately excludes `signatureFields`, whose values
 * are full base64 signature images and would make listing enormous.
 */
export type SignRequestSummary = {
  id: string;
  status: SignRequestStatus;
  fileName: string;
  pageCount: number;
  signerCount: number;
  signedCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSignRequestInput = {
  orgId: string;
  file: Buffer;
  fileName: string;
  mimeType: string;
  signers: SignerInput[];
};

/**
 * A converted-but-not-yet-sent document. Drafts exist so the sender can see the PDF and
 * position signature boxes before any signer is invited.
 */
export type SignRequestDraft = {
  id: string;
  orgId: string;
  token: string;
  fileName: string;
  fileId: string;
  pdfFileId: string;
  pageCount: number;
  mimeType: string;
  /** Boxes detected in the .docx, pre-placed where they could be located. */
  fields: PlacedField[];
  createdAt: Date;
};

/** A box as positioned on the PDF, before it is bound to a stored envelope. */
export type PlacedField = {
  role: SignerRole;
  type: SignFieldType;
  page: number;
  rect: FieldRect;
  source: SignatureFieldSource;
};

/** What the prepare screen receives. Carries no file bytes. */
export type DraftView = {
  id: string;
  token: string;
  fileName: string;
  pageCount: number;
  documentUrl: string;
  fields: PlacedField[];
  /** True when the boxes came from the add-in but could not be located in the PDF. */
  needsPlacement: boolean;
};

export type CeremonyField = {
  id: string;
  type: SignFieldType;
  recipientKey: SignerRole;
  page: number;
  rect: FieldRect;
  required: boolean;
  value?: string | null;
};

export type CeremonyRecipient = {
  id: string;
  name: string;
  email: string;
  status: "PENDING" | "VIEWED" | "SIGNED" | "DECLINED";
  recipientKey: SignerRole;
};

export type CeremonySession = {
  envelope: {
    id: string;
    name: string;
    status: "SENT" | "VIEWED" | "PARTIALLY_SIGNED" | "COMPLETED" | "DECLINED" | "VOIDED";
    pageCount: number;
    estimatedMinutes: number;
    senderName: string;
    senderCompany: string;
    consentText: string;
  };
  recipient: CeremonyRecipient;
  recipients: CeremonyRecipient[];
  documentUrl: string;
  fields: CeremonyField[];
  downloadUrl: string | null;
  waitingForOthers: boolean;
};
