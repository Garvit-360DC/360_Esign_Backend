/**
 * Assigns an owning Salesforce org to envelopes and drafts created before org
 * authentication existed.
 *
 *   npm run backfill:org -- 00D5j00000ABCDEAA1          # show what would change
 *   npm run backfill:org -- 00D5j00000ABCDEAA1 --apply  # write it
 *
 * Rows without an `orgId` match no org, so they are invisible to every caller until this
 * runs. Defaulting them in the query layer instead would quietly hand one org another's
 * documents, which is the thing org scoping exists to prevent.
 */

// The config module validates the whole environment on import; these only need to be present.
process.env.CONVERTAPI_SECRET ||= "backfill";
process.env.SF_CLIENT_ID ||= "unused";
process.env.SF_CLIENT_SECRET ||= "unused";
process.env.SF_SERVER_CALLBACK_URI ||= "http://localhost:4600/sf/auth/callback";
process.env.SF_REDIRECT_URI ||= "http://localhost:3001/oauth/callback";
process.env.JWT_SECRET ||= "0123456789abcdef";

const COLLECTIONS = ["sign_requests", "sign_request_drafts"] as const;

async function main() {
  const orgId = process.argv[2]?.trim();
  const apply = process.argv.includes("--apply");

  if (!orgId || !/^[A-Za-z0-9]{15,18}$/.test(orgId)) {
    console.error(
      "Usage: npm run backfill:org -- <15-18 character org id> [--apply]"
    );
    process.exit(1);
  }

  const mongoose = (await import("mongoose")).default;
  const { env } = await import("../src/config/env");

  await mongoose.connect(env.MONGO_URL);
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");

  console.log(`${apply ? "Assigning" : "Would assign"} orphaned rows to ${orgId}\n`);

  for (const name of COLLECTIONS) {
    const collection = db.collection(name);
    const filter = { orgId: { $exists: false } };
    const orphaned = await collection.countDocuments(filter);
    const total = await collection.countDocuments();

    if (apply && orphaned > 0) {
      const { modifiedCount } = await collection.updateMany(filter, { $set: { orgId } });
      console.log(`${name.padEnd(22)} ${modifiedCount} of ${total} updated`);
    } else {
      console.log(`${name.padEnd(22)} ${orphaned} of ${total} without an org`);
    }
  }

  if (!apply) {
    console.log("\nNothing was written. Re-run with --apply to make the change.");
  }

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
