import mongoose, { Schema } from "mongoose";
import { AppError } from "../../utils/appError";

/**
 * Org sessions, shaped after `dbtokens` in `360_File_Connector_Node/src/utils/dbconnection.js`.
 *
 * Field names follow that schema — `org_id`, `instance_url`, `loginTypeSF` — so the two
 * services stay recognisable side by side and a row could be moved between them. Only the
 * columns this service actually uses are carried over.
 *
 * There are two kinds of session, chosen by `productName`:
 *
 *   With a product     A connector row in `dbtokens`, one per org and product, reached through
 *                      `authenticateTokenV1`. Never created here, only read and refreshed.
 *   Without a product  A console sign-in, in its own collection.
 *
 * The collections are separate because this service shares a database with the connector,
 * and several connector paths find `dbtokens` rows by org alone. A console row there could be
 * picked up as the org's session, and a console sign-in could overwrite the connector's tokens.
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
  // The connector's model is named `dbtokensfileConnect`, which Mongoose stores under this name.
  { timestamps: { createdAt: "createdat", updatedAt: "updatedat" }, collection: "dbtokensfileconnects" }
);

const DbTokensModel = mongoose.model("dbtokens", dbtokensSchema);
const ConsoleSessionModel = mongoose.model(
  "esign_console_sessions",
  dbtokensSchema.clone() as typeof dbtokensSchema,
  "esign_console_sessions"
) as typeof DbTokensModel;

export type OrgSession = {
  org_id: string;
  productName: string | null;
  username: string | null;
  instance_url: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  loginTypeSF: string;
  tokenExpiry: Date | null;
  isRefreshing: boolean;
};

type OrgSessionDoc = OrgSession & {
  _id: mongoose.Types.ObjectId;
  token: string | null;
  refreshStartedAt: Date | null;
};

function toSession(doc: OrgSessionDoc): OrgSession {
  return {
    org_id: doc.org_id,
    productName: doc.productName ?? null,
    username: doc.username ?? null,
    instance_url: doc.instance_url ?? null,
    accessToken: doc.accessToken ?? null,
    refreshToken: doc.refreshToken ?? null,
    loginTypeSF: doc.loginTypeSF ?? "production",
    tokenExpiry: doc.tokenExpiry ?? null,
    isRefreshing: doc.isRefreshing ?? false,
  };
}

/** The collection and filter for one session. */
function locate(
  orgId: string,
  productName?: string | null
): { model: typeof DbTokensModel; filter: Record<string, string> } {
  return productName
    ? { model: DbTokensModel, filter: { org_id: orgId, productName } }
    : { model: ConsoleSessionModel, filter: { org_id: orgId } };
}

export async function findOrgSession(
  orgId: string,
  productName?: string | null
): Promise<OrgSession | null> {
  const { model, filter } = locate(orgId, productName);
  const doc = (await model.findOne(filter).lean()) as OrgSessionDoc | null;
  return doc ? toSession(doc) : null;
}

/** A connector row with its encrypted token, for `authenticateTokenV1` to compare against. */
export async function findDbToken(
  orgId: string,
  productName: string
): Promise<(OrgSession & { token: string | null }) | null> {
  const doc = (await DbTokensModel.findOne({
    org_id: orgId,
    productName,
  }).lean()) as OrgSessionDoc | null;
  return doc ? { ...toSession(doc), token: doc.token ?? null } : null;
}

/**
 * A console sign-in may create its session. A connector row is never created here: if it has
 * gone, the org has to be re-authorised through the connector.
 */
export async function updateOrgSession(
  orgId: string,
  data: Partial<Omit<OrgSession, "org_id" | "productName" | "isRefreshing">>,
  productName?: string | null
): Promise<OrgSession> {
  const { model, filter } = locate(orgId, productName);
  const doc = (await model
    .findOneAndUpdate(filter, { $set: data }, { new: true, upsert: !productName })
    .lean()) as OrgSessionDoc | null;

  if (!doc) {
    throw new AppError(
      "Salesforce session not found. Please re-authenticate.",
      401,
      "SESSION_NOT_FOUND"
    );
  }

  return toSession(doc);
}

/**
 * Takes the refresh lock for a session, or returns null when someone else holds a fresh one.
 * A lock older than `staleMs` is treated as abandoned, so a crashed process cannot wedge an
 * org out of refreshing forever. Uses the connector's `isRefreshing` fields, so on a shared
 * row the two services wait for each other.
 */
export async function acquireRefreshLock(
  orgId: string,
  staleMs: number,
  productName?: string | null
): Promise<OrgSession | null> {
  const { model, filter } = locate(orgId, productName);
  const doc = (await model.findOneAndUpdate(
    {
      ...filter,
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

export async function releaseRefreshLock(
  orgId: string,
  productName?: string | null
): Promise<void> {
  const { model, filter } = locate(orgId, productName);
  await model.updateOne(filter, {
    $set: { isRefreshing: false },
    $unset: { refreshStartedAt: 1 },
  });
}
