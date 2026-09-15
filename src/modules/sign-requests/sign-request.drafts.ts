import mongoose, { Schema } from "mongoose";
import {
  SIGNER_ROLE_RE,
  SIGN_FIELD_TYPES,
  type PlacedField,
  type SignRequestDraft,
} from "./sign-request.types";

/**
 * Drafts are converted documents waiting to be prepared and sent.
 *
 * They expire on their own: a sender who uploads a file and walks away should not leave a
 * record behind forever. The GridFS files they point at are removed when the draft is
 * discarded explicitly; TTL expiry only drops the pointer, which is an accepted trade for
 * keeping this simple.
 */

const DRAFT_TTL_SECONDS = 24 * 60 * 60;

const rectSchema = new Schema(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
  },
  { _id: false }
);

const placedFieldSchema = new Schema<PlacedField>(
  {
    role: { type: String, required: true, match: SIGNER_ROLE_RE },
    type: { type: String, required: true, enum: SIGN_FIELD_TYPES, default: "signature" },
    page: { type: Number, required: true },
    rect: { type: rectSchema, required: true },
    source: { type: String, required: true, enum: ["image", "text", "manual"] },
  },
  { _id: false }
);

const draftSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    templateKey: { type: String, default: null },
    token: { type: String, required: true },
    fileName: { type: String, required: true },
    fileId: { type: Schema.Types.ObjectId, required: true },
    pdfFileId: { type: Schema.Types.ObjectId, required: true },
    pageCount: { type: Number, required: true },
    mimeType: { type: String, required: true },
    fields: { type: [placedFieldSchema], required: true },
    createdAt: { type: Date, default: Date.now, expires: DRAFT_TTL_SECONDS },
  },
  { collection: "sign_request_drafts" }
);

const DraftModel = mongoose.model("SignRequestDraft", draftSchema);

type DraftDoc = {
  _id: mongoose.Types.ObjectId;
  orgId: string;
  templateKey: string | null;
  token: string;
  fileName: string;
  fileId: mongoose.Types.ObjectId;
  pdfFileId: mongoose.Types.ObjectId;
  pageCount: number;
  mimeType: string;
  fields: PlacedField[];
  createdAt: Date;
};

function toDraft(doc: DraftDoc): SignRequestDraft {
  return {
    id: String(doc._id),
    orgId: doc.orgId,
    templateKey: doc.templateKey ?? null,
    token: doc.token,
    fileName: doc.fileName,
    fileId: String(doc.fileId),
    pdfFileId: String(doc.pdfFileId),
    pageCount: doc.pageCount,
    mimeType: doc.mimeType,
    fields: doc.fields,
    createdAt: doc.createdAt,
  };
}

export async function createDraftRecord(data: {
  orgId: string;
  templateKey?: string | null;
  token: string;
  fileName: string;
  fileId: string;
  pdfFileId: string;
  pageCount: number;
  mimeType: string;
  fields: PlacedField[];
}): Promise<SignRequestDraft> {
  const created = await DraftModel.create({
    orgId: data.orgId,
    templateKey: data.templateKey ?? null,
    token: data.token,
    fileName: data.fileName,
    fileId: new mongoose.Types.ObjectId(data.fileId),
    pdfFileId: new mongoose.Types.ObjectId(data.pdfFileId),
    pageCount: data.pageCount,
    mimeType: data.mimeType,
    fields: data.fields,
  });

  return toDraft(created.toObject() as DraftDoc);
}

export async function findDraft(id: string): Promise<SignRequestDraft | null> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  const doc = await DraftModel.findById(id).lean();
  return doc ? toDraft(doc as DraftDoc) : null;
}

export async function deleteDraft(id: string): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(id)) return;
  await DraftModel.findByIdAndDelete(id);
}
