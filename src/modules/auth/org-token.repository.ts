import mongoose, { Schema } from "mongoose";

/**
 * One row per Salesforce org per product, holding the token that org must present.
 *
 * Shaped after `dbtokens` in the connector so the two are recognisable side by side, minus
 * the OAuth columns this service has no use for.
 */

const orgTokenSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    productName: { type: String, required: true },
    token: { type: String, required: true },
    /** Whoever registered the org, for support. Not used in any check. */
    userEmail: { type: String, default: null },
  },
  { timestamps: true, collection: "org_tokens" }
);

// Registration is an upsert on this pair, so it has to be unique.
orgTokenSchema.index({ orgId: 1, productName: 1 }, { unique: true });

const OrgTokenModel = mongoose.model("OrgToken", orgTokenSchema);

export type OrgToken = {
  orgId: string;
  productName: string;
  token: string;
  userEmail: string | null;
};

type OrgTokenDoc = OrgToken & { _id: mongoose.Types.ObjectId };

export async function upsertOrgToken(data: OrgToken): Promise<OrgToken> {
  const doc = (await OrgTokenModel.findOneAndUpdate(
    { orgId: data.orgId, productName: data.productName },
    { $set: { token: data.token, userEmail: data.userEmail } },
    { new: true, upsert: true }
  ).lean()) as OrgTokenDoc;

  return {
    orgId: doc.orgId,
    productName: doc.productName,
    token: doc.token,
    userEmail: doc.userEmail ?? null,
  };
}

export async function findOrgToken(
  orgId: string,
  productName: string
): Promise<OrgToken | null> {
  const doc = (await OrgTokenModel.findOne({
    orgId,
    productName,
  }).lean()) as OrgTokenDoc | null;

  if (!doc) return null;

  return {
    orgId: doc.orgId,
    productName: doc.productName,
    token: doc.token,
    userEmail: doc.userEmail ?? null,
  };
}
