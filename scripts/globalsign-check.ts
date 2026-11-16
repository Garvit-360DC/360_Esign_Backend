import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  describe,
  getQuotas,
  getValidationPolicy,
  isGlobalSignEnabled,
} from "../src/integrations/globalsign";
import { sealPdf } from "../src/modules/sign-requests/sign-request.seal";

/**
 * Checks the GlobalSign setup end to end: logs in, prints the account's validation policy (which
 * subject fields GLOBALSIGN_SUBJECT_DN may set) and remaining quota, then seals a one-page PDF.
 * Uses one signature and one timestamp from the quota.
 *
 *   npm run globalsign:check                 policy and quota only
 *   npm run globalsign:check -- out.pdf      also seal a test PDF and save it there
 */

async function main(): Promise<void> {
  if (!isGlobalSignEnabled()) {
    console.error(
      "GlobalSign is not configured. Set GLOBALSIGN_API_KEY, GLOBALSIGN_API_SECRET, " +
        "GLOBALSIGN_CLIENT_CERT_PATH and GLOBALSIGN_CLIENT_KEY_PATH."
    );
    process.exit(1);
  }

  console.log("Validation policy (subject_dn fields marked REQUIRED or OPTIONAL may be set):");
  console.log(JSON.stringify(await getValidationPolicy(), null, 2));
  console.log("Remaining quota:", await getQuotas());

  const out = process.argv[2];
  if (!out) return;

  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText("360 InstantDocs: GlobalSign seal test", {
    x: 50,
    y: 780,
    size: 16,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  const sealed = await sealPdf(Buffer.from(await doc.save()));
  writeFileSync(out, sealed);
  console.log(`Sealed test PDF written to ${out}. Open it in Acrobat to check the signature panel.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("GlobalSign check failed:", describe(error));
    process.exit(1);
  });
