import { Readable } from "node:stream";
import mongoose, { Schema } from "mongoose";
import { AppError } from "../../utils/appError";
import {
  SIGNER_ROLE_RE,
  SIGN_FIELD_TYPES,
  type SignFieldType,
  type SignRequest,
  type SignRequestStatus,
  type SignRequestStats,
  type SignRequestSummary,
  type SignatureField,
  type Signer,
} from "./sign-request.types";

const GRIDFS_BUCKET = "sign_request_files";

const signerSchema = new Schema(
  {
    role: { type: String, required: true, match: SIGNER_ROLE_RE },
    name: { type: String, required: true },
    email: { type: String, required: true },
    token: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ["pending", "viewed", "signed", "declined"],
      default: "pending",
    },
    order: { type: Number },
    salesforceRecipientId: { type: String, default: null },
    declineReason: { type: String, default: null },
    viewedAt: { type: Date, default: null },
    signedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    remindedAt: { type: Date, default: null },
  },
  { _id: true }
);

const fieldRectSchema = new Schema(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
  },
  { _id: false }
);

const signatureFieldSchema = new Schema<SignatureField>(
  {
    id: { type: String, required: true },
    role: { type: String, required: true, match: SIGNER_ROLE_RE },
    // Envelopes created before field types existed hold signature boxes only, hence the
    // default here and the coalesce in `toSignRequest`.
    type: { type: String, required: true, enum: SIGN_FIELD_TYPES, default: "signature" },
    tag: { type: String, required: true },
    source: { type: String, required: true, enum: ["image", "text", "manual"] },
    widthPt: { type: Number },
    heightPt: { type: Number },
    index: { type: Number, required: true },
    page: { type: Number, required: true, default: 1 },
    rect: { type: fieldRectSchema, required: true },
    value: { type: String, default: null },
  },
  { _id: false }
);

const signRequestSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    status: {
      type: String,
      required: true,
      enum: ["draft", "pending", "in_progress", "completed", "cancelled", "declined"],
      default: "pending",
    },
    subject: { type: String, default: null },
    message: { type: String, default: null },
    voidReason: { type: String, default: null },
    salesforce: { type: Schema.Types.Mixed, default: null },
    fileName: { type: String, required: true },
    fileId: { type: Schema.Types.ObjectId, required: true },
    pdfFileId: { type: Schema.Types.ObjectId, required: true },
    signedPdfFileId: { type: Schema.Types.ObjectId, default: null },
    pageCount: { type: Number, required: true, default: 1 },
    mimeType: { type: String, required: true },
    signers: { type: [signerSchema], required: true },
    signatureFields: { type: [signatureFieldSchema], required: true },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "sign_requests" }
);

// The list screen is "this org's envelopes, newest first", which is exactly this index.
signRequestSchema.index({ orgId: 1, createdAt: -1 });

const SignRequestModel = mongoose.model("SignRequest", signRequestSchema);

type SignerDoc = {
  _id: mongoose.Types.ObjectId;
  role: Signer["role"];
  name: string;
  email: string;
  token: string;
  status: Signer["status"];
  order?: number;
  salesforceRecipientId?: string | null;
  declineReason: string | null;
  viewedAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
  remindedAt: Date | null;
};

/** As stored. `type` is optional because documents written before it existed lack it. */
type StoredSignatureField = Omit<SignatureField, "type"> & { type?: SignFieldType };

type SignRequestDoc = {
  _id: mongoose.Types.ObjectId;
  orgId: string;
  status: SignRequest["status"];
  subject?: string | null;
  message?: string | null;
  voidReason?: string | null;
  salesforce?: SignRequest["salesforce"];
  fileName: string;
  fileId: mongoose.Types.ObjectId;
  pdfFileId: mongoose.Types.ObjectId;
  signedPdfFileId: mongoose.Types.ObjectId | null;
  pageCount: number;
  mimeType: string;
  signers: SignerDoc[];
  signatureFields: StoredSignatureField[];
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function getBucket() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB is not connected");
  }
  return new mongoose.mongo.GridFSBucket(db, { bucketName: GRIDFS_BUCKET });
}

function toSigner(doc: SignerDoc): Signer {
  return {
    id: String(doc._id),
    role: doc.role,
    name: doc.name,
    email: doc.email,
    token: doc.token,
    status: doc.status,
    order: doc.order,
    salesforceRecipientId: doc.salesforceRecipientId ?? null,
    declineReason: doc.declineReason ?? null,
    viewedAt: doc.viewedAt ?? null,
    signedAt: doc.signedAt ?? null,
    declinedAt: doc.declinedAt ?? null,
    remindedAt: doc.remindedAt ?? null,
  };
}

function toSignRequest(doc: SignRequestDoc): SignRequest {
  return {
    id: String(doc._id),
    orgId: doc.orgId,
    status: doc.status,
    subject: doc.subject ?? null,
    message: doc.message ?? null,
    voidReason: doc.voidReason ?? null,
    salesforce: doc.salesforce ?? null,
    fileName: doc.fileName,
    fileId: String(doc.fileId),
    pdfFileId: String(doc.pdfFileId),
    signedPdfFileId: doc.signedPdfFileId ? String(doc.signedPdfFileId) : null,
    pageCount: doc.pageCount,
    mimeType: doc.mimeType,
    signers: doc.signers.map(toSigner),
    signatureFields: doc.signatureFields.map((field) => ({
      ...field,
      type: field.type ?? "signature",
    })),
    completedAt: doc.completedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function isObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

export async function saveDocumentFile(
  file: Buffer,
  fileName: string,
  mimeType: string
): Promise<string> {
  const bucket = getBucket();
  const uploadStream = bucket.openUploadStream(fileName, { contentType: mimeType });

  await new Promise<void>((resolve, reject) => {
    Readable.from(file)
      .pipe(uploadStream)
      .on("error", reject)
      .on("finish", () => resolve());
  });

  return String(uploadStream.id);
}

/** Name, size and upload time straight from the GridFS files collection. */
export async function getFileInfo(
  fileId: string
): Promise<{ fileName: string; sizeBytes: number; contentType: string; uploadedAt: Date } | null> {
  if (!isObjectId(fileId)) return null;

  const [file] = await getBucket()
    .find({ _id: new mongoose.Types.ObjectId(fileId) })
    .limit(1)
    .toArray();

  if (!file) return null;

  return {
    fileName: file.filename,
    sizeBytes: file.length,
    contentType: file.contentType ?? "application/octet-stream",
    uploadedAt: file.uploadDate,
  };
}

export async function getFileBuffer(fileId: string): Promise<Buffer> {
  if (!isObjectId(fileId)) {
    throw new AppError("File not found", 404, "NOT_FOUND");
  }

  const bucket = getBucket();
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    bucket
      .openDownloadStream(new mongoose.Types.ObjectId(fileId))
      .on("data", (chunk: Buffer) => chunks.push(chunk))
      .on("error", reject)
      .on("end", () => resolve());
  });

  return Buffer.concat(chunks);
}

export async function createSignRequest(data: {
  orgId: string;
  fileName: string;
  fileId: string;
  pdfFileId: string;
  pageCount: number;
  mimeType: string;
  signers: Omit<Signer, "id">[];
  signatureFields: SignatureField[];
  status?: SignRequestStatus;
  subject?: string | null;
  message?: string | null;
  salesforce?: SignRequest["salesforce"];
}): Promise<SignRequest> {
  const created = await SignRequestModel.create({
    orgId: data.orgId,
    status: data.status ?? "pending",
    subject: data.subject ?? null,
    message: data.message ?? null,
    salesforce: data.salesforce ?? null,
    fileName: data.fileName,
    fileId: new mongoose.Types.ObjectId(data.fileId),
    pdfFileId: new mongoose.Types.ObjectId(data.pdfFileId),
    signedPdfFileId: null,
    pageCount: data.pageCount,
    mimeType: data.mimeType,
    signers: data.signers,
    signatureFields: data.signatureFields,
  });

  return toSignRequest(created.toObject() as SignRequestDoc);
}

/**
 * Pass `orgId` on sender-facing paths so one org cannot address another's envelope. The
 * signing ceremony omits it deliberately: a signer arrives with a per-signer token and no
 * org context, and the token is what authorises them.
 */
export async function findById(id: string, orgId?: string): Promise<SignRequest | null> {
  if (!isObjectId(id)) {
    return null;
  }

  const doc = await SignRequestModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    ...(orgId ? { orgId } : {}),
  }).lean();

  if (!doc) {
    return null;
  }

  return toSignRequest(doc as SignRequestDoc);
}

/** Whatever the sender typed is a literal, never a pattern of their own. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type ListFilter = {
  status?: SignRequest["status"];
  /** Free text, matched against the file name and the signers' names and addresses. */
  q?: string;
};

/**
 * Newest first. `signatureFields` is projected out because its values are base64 signature
 * images, which would dominate the payload and are not needed for a list row.
 *
 * `total` counts the filtered set, not the org's whole history, so the pager stays honest
 * while a filter is on.
 */
export async function listSignRequests(
  orgId: string,
  limit: number,
  skip: number,
  filter: ListFilter = {}
): Promise<{ items: SignRequestSummary[]; total: number }> {
  const term = filter.q ? new RegExp(escapeRegExp(filter.q), "i") : null;
  const query = {
    orgId,
    status: filter.status ?? { $ne: "draft" },
    ...(term
      ? {
          $or: [
            { fileName: term },
            { "signers.name": term },
            { "signers.email": term },
          ],
        }
      : {}),
  };

  const [docs, total] = await Promise.all([
    SignRequestModel.find(query)
      .select("-signatureFields")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SignRequestModel.countDocuments(query),
  ]);

  const items = (docs as unknown as Omit<SignRequestDoc, "signatureFields">[]).map((doc) => ({
    id: String(doc._id),
    status: doc.status,
    fileName: doc.fileName,
    pageCount: doc.pageCount,
    signerCount: doc.signers.length,
    signedCount: doc.signers.filter((signer) => signer.status === "signed").length,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }));

  return { items, total };
}

const MONTHS_ON_CHART = 6;

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Dashboard aggregates.
 *
 * Computed in memory from a narrow projection rather than in an aggregation pipeline: the
 * documents involved are tiny once `signatureFields` is excluded, and the median needs the
 * full set anyway. Revisit if envelope volume ever reaches the tens of thousands.
 */
export async function getStats(now: Date, orgId: string): Promise<SignRequestStats> {
  type StatRow = {
    status: SignRequest["status"];
    signers: { status: Signer["status"] }[];
    createdAt: Date;
    updatedAt: Date;
  };

  const rows = (await SignRequestModel.find({ orgId, status: { $ne: "draft" } })
    .select("status signers.status createdAt updatedAt")
    .lean()) as unknown as StatRow[];

  const totals = { sent: rows.length, completed: 0, declined: 0, awaiting: 0, voided: 0 };
  const funnel = { sent: rows.length, viewed: 0, partiallySigned: 0, completed: 0, declined: 0 };
  const durations: number[] = [];
  const byMonth = new Map<string, { sent: number; completed: number }>();

  const thisKey = monthKey(now);
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastKey = monthKey(previous);

  let oldestAwaiting: number | null = null;

  for (const row of rows) {
    const signed = row.signers.filter((signer) => signer.status === "signed").length;
    const touched = row.signers.some(
      (signer) => signer.status !== "pending"
    );

    if (row.status === "completed") totals.completed += 1;
    if (row.status === "declined") totals.declined += 1;
    if (row.status === "cancelled") totals.voided += 1;
    if (row.status === "pending" || row.status === "in_progress") {
      totals.awaiting += 1;
      const days = (now.getTime() - new Date(row.createdAt).getTime()) / 86_400_000;
      oldestAwaiting = Math.max(oldestAwaiting ?? 0, days);
    }

    if (touched) funnel.viewed += 1;
    if (signed > 0) funnel.partiallySigned += 1;
    if (row.status === "completed") {
      funnel.completed += 1;
      durations.push(
        (new Date(row.updatedAt).getTime() - new Date(row.createdAt).getTime()) / 3_600_000
      );
    }
    if (row.status === "declined") funnel.declined += 1;

    const key = monthKey(new Date(row.createdAt));
    const bucket = byMonth.get(key) ?? { sent: 0, completed: 0 };
    bucket.sent += 1;
    if (row.status === "completed") bucket.completed += 1;
    byMonth.set(key, bucket);
  }

  // Always emit a full run of months so the chart keeps a stable shape when a month is empty.
  const monthly: SignRequestStats["monthly"] = [];
  for (let back = MONTHS_ON_CHART - 1; back >= 0; back -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const key = monthKey(date);
    const bucket = byMonth.get(key) ?? { sent: 0, completed: 0 };
    monthly.push({ month: key, ...bucket });
  }

  return {
    totals,
    completionRate: rows.length ? totals.completed / rows.length : null,
    medianHoursToComplete: median(durations),
    oldestAwaitingDays: oldestAwaiting === null ? null : Math.floor(oldestAwaiting),
    monthly,
    funnel,
    thisMonth: byMonth.get(thisKey) ?? { sent: 0, completed: 0 },
    lastMonth: byMonth.get(lastKey) ?? { sent: 0, completed: 0 },
  };
}

/**
 * Writes field values in place, touching only the `value` of the named fields.
 *
 * Deliberately not a read-modify-write of the whole document: several fields are filled at
 * once, and other signers may be filling theirs at the same time. Sending the entire
 * `signatureFields` array back would overwrite whatever landed in between, which silently
 * loses signatures.
 */
export async function setFieldValues(
  id: string,
  values: { fieldId: string; value: string }[]
): Promise<SignRequest> {
  // One filter identifier per field, so duplicates in the input would collide.
  const unique = [...new Map(values.map((entry) => [entry.fieldId, entry.value])).entries()];

  const $set: Record<string, string> = {};
  const arrayFilters = unique.map(([fieldId], index) => {
    $set[`signatureFields.$[f${index}].value`] = unique[index][1];
    return { [`f${index}.id`]: fieldId };
  });

  const updated = await SignRequestModel.findByIdAndUpdate(
    id,
    { $set },
    { new: true, arrayFilters }
  ).lean();

  if (!updated) {
    throw new AppError("Sign request not found", 404, "NOT_FOUND");
  }

  return toSignRequest(updated as SignRequestDoc);
}

const OPEN_STATUSES: SignRequestStatus[] = ["pending", "in_progress"];

type SignerPatch = Partial<
  Pick<Signer, "status" | "declineReason" | "viewedAt" | "signedAt" | "declinedAt">
>;

/**
 * Changes one signer in place, and only if the envelope is open and the signer is in one of
 * `fromStatuses`. Returns the envelope as it stands after the write, or null if nothing matched.
 *
 * Deliberately not a read-modify-write of the `signers` array: two signers can act at the same
 * moment, and writing back a copy loaded earlier would undo whatever the other one just did.
 * Because each write is atomic, exactly one caller sees the write that leaves everyone signed.
 */
export async function updateSigner(
  id: string,
  signerId: string,
  patch: SignerPatch,
  options: { fromStatuses: Signer["status"][]; requestStatus?: SignRequestStatus }
): Promise<SignRequest | null> {
  const $set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    $set[`signers.$.${key}`] = value;
  }
  if (options.requestStatus) $set.status = options.requestStatus;

  const updated = await SignRequestModel.findOneAndUpdate(
    {
      _id: id,
      status: { $in: OPEN_STATUSES },
      signers: { $elemMatch: { _id: signerId, status: { $in: options.fromStatuses } } },
    },
    { $set },
    { new: true }
  ).lean();

  return updated ? toSignRequest(updated as SignRequestDoc) : null;
}

/** Stamps the time on the signers a reminder actually reached. */
export async function markSignersReminded(
  id: string,
  signerIds: string[],
  remindedAt: Date
): Promise<void> {
  await SignRequestModel.updateOne(
    { _id: id },
    { $set: { "signers.$[signer].remindedAt": remindedAt } },
    {
      arrayFilters: [
        { "signer._id": { $in: signerIds.map((signerId) => new mongoose.Types.ObjectId(signerId)) } },
      ],
    }
  );
}

/**
 * Moves an envelope to a new status, if it is still in one of `fromStatuses`. Returns null if
 * it has moved on, so a void and a completion cannot both win, and two sends cannot both send.
 */
export async function transitionSignRequest(
  id: string,
  status: SignRequestStatus,
  options: {
    fromStatuses?: SignRequestStatus[];
    signedPdfFileId?: string;
    completedAt?: Date;
    voidReason?: string;
  } = {}
): Promise<SignRequest | null> {
  const updated = await SignRequestModel.findOneAndUpdate(
    { _id: id, status: { $in: options.fromStatuses ?? OPEN_STATUSES } },
    {
      $set: {
        status,
        ...(options.signedPdfFileId
          ? { signedPdfFileId: new mongoose.Types.ObjectId(options.signedPdfFileId) }
          : {}),
        ...(options.completedAt ? { completedAt: options.completedAt } : {}),
        ...(options.voidReason ? { voidReason: options.voidReason } : {}),
      },
    },
    { new: true }
  ).lean();

  return updated ? toSignRequest(updated as SignRequestDoc) : null;
}
