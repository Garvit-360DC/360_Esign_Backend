/**
 * Describes the eSign template objects in a connected Salesforce org and diffs them against
 * what the API expects.
 *
 *   npm run sf:describe                  # the first org with a live session
 *   npm run sf:describe -- 00Dxx...      # a specific org
 *
 * Reads through `sfRequest`, so an expired access token is refreshed rather than reported.
 */

process.env.CONVERTAPI_SECRET ||= "describe";

const API_VERSION = "v62.0";

/** What the template feature needs. Names are matched ignoring any namespace prefix. */
const EXPECTED: Record<string, Record<string, string>> = {
  eSign_Template__c: {
    Description__c: "textarea",
    SObject_Name__c: "string",
    Document_Version_Id__c: "string",
    Document_Name__c: "string",
    Page_Count__c: "double",
    Is_Active__c: "boolean",
    Email_Subject__c: "string",
    Email_Message__c: "textarea",
    Signing_Order__c: "picklist",
    Expires_In_Days__c: "double",
    Reminder_Days__c: "string",
    Template_Key__c: "string",
  },
  eSign_Template_Recipient__c: {
    Template__c: "reference",
    // The slot the API keys on: signer1, signer2, … Not the Signer/CC distinction, which is
    // Recipient_Type__c — the two were one field at first and could not both be satisfied.
    Role__c: "string",
    Recipient_Type__c: "picklist",
    Order__c: "double",
    Label__c: "string",
    Default_Name__c: "string",
    Default_Email__c: "email",
    Required__c: "boolean",
  },
  eSign_Template_Field__c: {
    Template__c: "reference",
    Recipient__c: "reference",
    Role__c: "string",
    Field_Type__c: "picklist",
    Page__c: "double",
    Position_X__c: "double",
    Position_Y__c: "double",
    Width__c: "double",
    Height__c: "double",
    Source__c: "picklist",
    Required__c: "boolean",
  },
};

/** Picklists whose values the API consumes verbatim, so a typo here is a runtime failure. */
const EXPECTED_PICKLISTS: Record<string, string[]> = {
  "eSign_Template__c.Signing_Order__c": ["Parallel", "Sequential"],
  "eSign_Template_Field__c.Field_Type__c": [
    "signature",
    "initial",
    "fullName",
    "email",
    "signDate",
    "company",
    "jobTitle",
  ],
  "eSign_Template_Field__c.Source__c": ["image", "text", "manual"],
};

type SfField = {
  name: string;
  label: string;
  type: string;
  length: number;
  precision: number;
  scale: number;
  nillable: boolean;
  unique: boolean;
  externalId: boolean;
  referenceTo: string[];
  /** Null on a lookup; 0 or 1 on a master-detail. */
  relationshipOrder: number | null;
  /** True when deleting the target is blocked rather than clearing this field. */
  restrictedDelete: boolean;
  calculatedFormula: string | null;
  picklistValues: { value: string; label: string; active: boolean }[];
};

/** Drops a namespace prefix so `abc__eSign_Template__c` matches `eSign_Template__c`. */
function bare(name: string): string {
  const parts = name.split("__");
  return parts.length > 2 ? parts.slice(1).join("__") : name;
}

function describeSize(field: SfField): string {
  if (field.type === "double" || field.type === "currency") {
    return `(${field.precision - field.scale}, ${field.scale})`;
  }
  if (field.length > 0) return `(${field.length})`;
  return "";
}

async function main() {
  const mongoose = (await import("mongoose")).default;
  const { env } = await import("../src/config/env");
  const { sfRequest } = await import("../src/integrations/salesforce");
  const { findOrgSession } = await import("../src/modules/auth/org-session.repository");

  await mongoose.connect(env.MONGO_URL);

  const wanted = process.argv[2]?.trim();
  let session = wanted ? await findOrgSession(wanted) : null;

  if (!session) {
    const row = await mongoose.connection.db
      ?.collection("dbtokens")
      .findOne({ accessToken: { $ne: null } });
    if (row) session = await findOrgSession(row.org_id as string);
  }

  if (!session?.accessToken) {
    console.error("No connected org with a Salesforce access token. Sign in first.");
    process.exit(1);
  }

  console.log(`Org ${session.org_id} (${session.username ?? "unknown user"})\n`);

  const listed = await sfRequest<{ sobjects: { name: string; label: string }[] }>(
    session,
    `/services/data/${API_VERSION}/sobjects/`
  );

  // Only the objects this feature owns. Matching on "esign" alone drags in the platform's
  // own `ConvIntelligenceSignalRule` and every __ChangeEvent / __Share shadow object.
  const matches = listed.data.sobjects.filter((o) => Boolean(EXPECTED[bare(o.name)]));

  if (matches.length === 0) {
    console.log("None of the eSign template objects exist in this org.");
    await mongoose.disconnect();
    return;
  }

  for (const object of matches) {
    const described = await sfRequest<{ fields: SfField[] }>(
      session,
      `/services/data/${API_VERSION}/sobjects/${object.name}/describe`
    );

    const custom = described.data.fields.filter((f) => f.name.endsWith("__c"));
    const byBare = new Map(custom.map((f) => [bare(f.name), f]));
    const expected = EXPECTED[bare(object.name)];

    console.log(`── ${object.name}  "${object.label}"`);

    for (const field of custom) {
      const want = expected?.[bare(field.name)];
      const ok = !expected || (want && want === field.type);
      const flags = [
        field.externalId ? "externalId" : "",
        field.unique ? "unique" : "",
        field.calculatedFormula ? `formula: ${field.calculatedFormula}` : "",
        field.referenceTo?.length
          ? `${field.relationshipOrder !== null ? "master-detail" : "lookup"} -> ${field.referenceTo.join("/")}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");

      const note = !expected
        ? ""
        : want
          ? want === field.type
            ? ""
            : `  << expected ${want}`
          : "  << not in the spec";

      console.log(
        `   ${ok ? " " : "!"} ${field.name.padEnd(34)} ${(field.type + describeSize(field)).padEnd(18)} ${flags}${note}`
      );

      if (field.type === "picklist") {
        const values = field.picklistValues.filter((v) => v.active).map((v) => v.value);
        const wantValues = EXPECTED_PICKLISTS[`${bare(object.name)}.${bare(field.name)}`];
        const wrong =
          wantValues &&
          (values.length !== wantValues.length ||
            wantValues.some((v, i) => values[i] !== v));

        console.log(
          `       values: ${values.join(", ") || "(none)"}` +
            (wrong ? `\n       !      expected: ${wantValues.join(", ")}` : "")
        );
      }

      // A lookup that clears on delete leaves orphaned rows behind, and a formula reading
      // through it then returns blank — breakage with no error anywhere.
      if (field.type === "reference" && field.relationshipOrder === null) {
        if (field.nillable || !field.restrictedDelete) {
          console.log(
            `       !      ${field.nillable ? "optional" : "required"}, ` +
              `deleting the target ${field.restrictedDelete ? "is blocked" : "clears this field"}`
          );
        }
      }
    }

    if (expected) {
      const missing = Object.keys(expected).filter((name) => !byBare.has(name));
      if (missing.length) console.log(`   MISSING: ${missing.join(", ")}`);
    }
    console.log();
  }

  const present = new Set(matches.map((o) => bare(o.name)));
  const absent = Object.keys(EXPECTED).filter((name) => !present.has(name));
  if (absent.length) console.log(`Objects not created yet: ${absent.join(", ")}`);

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
