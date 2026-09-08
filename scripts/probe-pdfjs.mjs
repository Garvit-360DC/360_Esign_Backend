// Isolates where pdfjs stalls: module load, document load, or teardown.
// Run under plain node and under tsx to tell the two runtimes apart.

const say = (m) => process.stderr.write(m + "\n");

const guard = setTimeout(() => {
  say("TIMEOUT — stalled before finishing");
  process.exit(2);
}, 20000);

say("1 importing pdfjs");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
say("2 imported, OPS=" + typeof pdfjs.OPS);

const { PDFDocument } = await import("pdf-lib");
const doc = await PDFDocument.create();
doc.addPage([612, 792]);
const bytes = await doc.save();
say("3 built pdf, " + bytes.length + " bytes");

const task = pdfjs.getDocument({
  data: new Uint8Array(bytes),
  disableFontFace: true,
  useWorkerFetch: false,
});
say("4 task created");

const pdf = await task.promise;
say("5 loaded, pages=" + pdf.numPages);

const page = await pdf.getPage(1);
const ops = await page.getOperatorList();
say("6 operator list, " + ops.fnArray.length + " ops");

await task.destroy();
say("7 destroyed — ALL OK");

clearTimeout(guard);
process.exit(0);
