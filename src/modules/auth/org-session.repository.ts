import mongoose, { Schema } from "mongoose";

/**
 * Org sessions, shaped after `dbtokens` in `360_File_Connector_Node/src/utils/dbconnection.js`.
 *
 * Field names follow that schema — `org_id`, `instance_url`, `loginTypeSF` — so the two
 * services stay recognisable side by side and a row could be moved between them. Only the
 * columns this service actually uses are carried over.
 */

const dbtokensSchema = new Schema(
  {
    org_id: { type: String, required: true, index: true },
    username: { type: String, default: null },
    userEmail: { type: String, default: null },
    productName: { type: String, default: null },
    token: { type: String, default: null },
    instance_url: { type: String, default: null },
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    loginTypeSF: { type: String, default: "production" },
    tokenExpiry: { type: Date, default: null },
    isRefreshing: { type: Boolean, default: false },
    refreshStartedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: "createdat", updatedAt: "updatedat" }, collection: "dbtokens" }
);

const DbTokensModel = mongoose.model("dbtokens", dbtokensSchema);

export type OrgSession = {
  org_id: string;
  username: string | null;
  instance_url: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  loginTypeSF: string;
  tokenExpiry: Date | null;
};

type OrgSessionDoc = OrgSession & {
  _id: mongoose.Types.ObjectId;
  isRefreshing: boolean;
  refreshStartedAt: Date | null;
};

function toSession(doc: OrgSessionDoc): OrgSession {
  return {
    org_id: doc.org_id,
    username: doc.username ?? null,
    instance_url: doc.instance_url ?? null,
    accessToken: doc.accessToken ?? null,
    refreshToken: doc.refreshToken ?? null,
    loginTypeSF: doc.loginTypeSF ?? "production",
    tokenExpiry: doc.tokenExpiry ?? null,
  };
}

export async function findOrgSession(orgId: string): Promise<OrgSession | null> {
  const doc = (await DbTokensModel.findOne({ org_id: orgId }).lean()) as OrgSessionDoc | null;
  return doc ? toSession(doc) : null;
}

/** Used by getToken, which creates the row before the admin has authorised anything. */
export async function createOrgSession(data: {
  org_id: string;
  loginTypeSF?: string;
  instance_url?: string | null;
  username?: string | null;
}): Promise<OrgSession> {
  const doc = (await DbTokensModel.findOneAndUpdate(
    { org_id: data.org_id },
    {
      $setOnInsert: {
        org_id: data.org_id,
        loginTypeSF: data.loginTypeSF ?? "production",
        instance_url: data.instance_url ?? null,
        username: data.username ?? null,
      },
    },
    { new: true, upsert: true }
  ).lean()) as OrgSessionDoc;

  return toSession(doc);
}

export async function updateOrgSession(
  orgId: string,
  data: Partial<Omit<OrgSession, "org_id">>
): Promise<OrgSession> {
  const doc = (await DbTokensModel.findOneAndUpdate(
    { org_id: orgId },
    { $set: data },
    { new: true, upsert: true }
  ).lean()) as OrgSessionDoc;

  return toSession(doc);
}

/**
 * Takes the refresh lock for an org, or returns null when someone else holds a fresh one.
 * A lock older than `staleMs` is treated as abandoned, so a crashed process cannot wedge an
 * org out of refreshing forever. Mirrors the loop in the connector's `getSalesforceToken`.
 */
export async function acquireRefreshLock(
  orgId: string,
  staleMs: number
): Promise<OrgSession | null> {
  const doc = (await DbTokensModel.findOneAndUpdate(
    {
      org_id: orgId,
      $or: [
        { isRefreshing: { $ne: true } },
        { refreshStartedAt: { $lt: new Date(Date.now() - staleMs) } },
      ],
    },
    { $set: { isRefreshing: true, refreshStartedAt: new Date() } },
    { new: true }
  ).lean()) as OrgSessionDoc | null;

  return doc ? toSession(doc) : null;
}

export async function releaseRefreshLock(orgId: string): Promise<void> {
  await DbTokensModel.updateOne(
    { org_id: orgId },
    { $set: { isRefreshing: false }, $unset: { refreshStartedAt: 1 } }
  );
}
