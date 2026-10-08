import { PDFDocument } from "pdf-lib";
import { locatePlaceholders } from "../src/modules/sign-requests/sign-request.locator";
import type { DetectedPlaceholder } from "../src/modules/sign-requests/sign-request.types";

// The exact placeholder artwork the Word add-in used to insert (150x60 px).
const PLACEHOLDER_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAJYAAAA8CAYAAACEhkNqAAAAv0lEQVR4nO3SMRGAQBDAwBeLBFzgkooSBzA0KLh0W2wUZG378cC09eW8bhhjLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEsYiYSwSxiJhLBLGImEsEv9YMO0F5ne6CTyXYLkAAAAASUVORK5CYII=";

const W = 150;
const H = 60;
const PAGE_W = 612;
const PAGE_H = 792;

// Ground truth, in top-left points. Two on page 1, one on page 2.
const TRUTH = [
  { page: 1, x: 88, top: 220 },
  { page: 1, x: 300, top: 500 },
  { page: 2, x: 120, top: 96 },
];

async function main() {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([PAGE_W, PAGE_H]);
  const page2 = doc.addPage([PAGE_W, PAGE_H]);
  const img = await doc.embedPng(Buffer.from(PLACEHOLDER_PNG, "base64"));

  // An unrelated logo at a different size — the locator must not treat this as a placeholder.
  page1.drawImage(img, { x: 40, y: PAGE_H - 40 - 24, width: 64, height: 24 });

  for (const spot of TRUTH) {
    const page = spot.page === 1 ? page1 : page2;
    page.drawImage(img, { x: spot.x, y: PAGE_H - spot.top - H, width: W, height: H });
  }

  const pdf = Buffer.from(await doc.save());

  const detected: DetectedPlaceholder[] = TRUTH.map((_, index) => ({
    role: `signer${index + 1}` as const,
    type: "signature",
    tag:`{%signer${index + 1}}`,
    source: "image",
    widthPt: W,
    heightPt: H,
    index: 0,
  }));

  const { pageCount, located } = await locatePlaceholders(pdf, detected);

  console.log(`pageCount = ${pageCount} (expected 2)`);
  let failures = 0;

  located.forEach((found, index) => {
    const want = TRUTH[index];
    const expected = {
      x: want.x / PAGE_W,
      y: want.top / PAGE_H,
      width: W / PAGE_W,
      height: H / PAGE_H,
    };

    const drift = Math.max(
      Math.abs(found.rect.x - expected.x),
      Math.abs(found.rect.y - expected.y),
      Math.abs(found.rect.width - expected.width),
      Math.abs(found.rect.height - expected.height)
    );
    const pageOk = found.page === want.page;
    const ok = pageOk && drift < 0.001;
    if (!ok) failures += 1;

    console.log(
      `${ok ? "PASS" : "FAIL"} signer${index + 1}: page ${found.page} (want ${want.page}) ` +
        `rect x=${found.rect.x.toFixed(4)} y=${found.rect.y.toFixed(4)} ` +
        `w=${found.rect.width.toFixed(4)} h=${found.rect.height.toFixed(4)} | ` +
        `want y=${expected.y.toFixed(4)} | drift=${drift.toExponential(2)}`
    );
  });

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("ERROR", error);
  process.exit(1);
});
