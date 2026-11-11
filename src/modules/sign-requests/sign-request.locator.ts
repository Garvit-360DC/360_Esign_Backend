import type { PDFFont } from "pdf-lib";
import { logger } from "../../config/logger";
import { AppError } from "../../utils/appError";
import { fingerprintDistance, fingerprintOf, type Fingerprint, type Pixels } from "./sign-request.fingerprint";
import { pictureFingerprintOf } from "./sign-request.placeholders";
import { signerLabel } from "./sign-request.types";
import type { DetectedPlaceholder, FieldRect } from "./sign-request.types";

/**
 * Locates each placeholder in the converted PDF so signature boxes land where the
 * Word add-in actually put them, instead of at a guessed position.
 *
 * Image placeholders are found by replaying the page's operator list and reading the
 * transform matrix in effect at each paint. Text placeholders are found by matching the
 * literal `{%role}` token in the extracted text.
 */

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Placeholder sizes survive conversion, but not always to the last decimal. */
const SIZE_TOLERANCE_PT = 2;

/** Fallback box when a text placeholder has no size of its own. Matches the add-in's picture. */
const DEFAULT_WIDTH_PT = 150;
const DEFAULT_HEIGHT_PT = 60;

/** Used when pdf.js reports no height for a text item. */
const FALLBACK_FONT_SIZE_PT = 12;

/** Descenders reach roughly a quarter of the font size below the baseline. */
const DESCENDER_RATIO = 0.25;

/**
 * Horizontal slack around an erased token, as a fraction of its font size.
 *
 * The token's edges are estimated (see `loadMeasure`), and the estimate's error grows with the
 * font, so the slack does too. It stays under half the width of a space: reaching into the gap
 * beside a token is harmless, reaching into the next word erases document content. When the two
 * pull against each other this errs towards leaving a hair of the brace visible.
 */
const ERASE_PADDING_EM = 0.12;

/**
 * How far past a placeholder picture its white-out reaches, in points.
 *
 * Covering the picture's exact rect is not enough. Renderers anti-alias both the picture's edge
 * and the white rectangle's edge, and two soft edges drawn on the same boundary never blend back
 * to solid white — a hairline of the placeholder's border survives, strongest where the edge falls
 * between device pixels. Reaching past the edge makes those pixels fully covered.
 *
 * Two points is at least two device pixels wherever the document is viewed at 100% or more, and
 * still less than the width of a space, so a word set beside the picture is left alone.
 */
const IMAGE_BLEED_PT = 2;

export type LocatedPlaceholder = {
  page: number;
  /** Where the field goes. For a text token this is larger than the token, to fit a signature. */
  rect: FieldRect;
  /**
   * What to paint over to hide the placeholder. For a picture, its rect plus a small bleed so no
   * anti-aliased edge survives (see `IMAGE_BLEED_PT`); for a `{%role}` token, the tight glyph box —
   * erasing the field box instead would take neighbouring words and the line above with it.
   */
  artwork: FieldRect;
};

export type LocateResult = {
  pageCount: number;
  located: LocatedPlaceholder[];
};

/** A box on a page, in PDF points with a top-left origin. */
type Box = { x: number; top: number; width: number; height: number };

/** A candidate found in the PDF, in PDF points with a top-left origin. */
type Candidate = Box & {
  page: number;
  pageWidth: number;
  pageHeight: number;
  /** The area to erase, when it differs from the field box. Falls back to the box itself. */
  artwork?: Box;
  /** What pdf.js calls the painted image, or its pixels when they were inlined in the page. */
  imageRef?: string | Pixels;
  /** The painted picture, when it could be read. See `sign-request.fingerprint.ts`. */
  fingerprint?: Fingerprint;
};

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function normalize(box: Box, pageWidth: number, pageHeight: number): FieldRect {
  return {
    x: box.x / pageWidth,
    y: box.top / pageHeight,
    width: box.width / pageWidth,
    height: box.height / pageHeight,
  };
}

function toLocated(candidate: Candidate): LocatedPlaceholder {
  const { pageWidth, pageHeight } = candidate;
  const rect = normalize(candidate, pageWidth, pageHeight);

  return {
    page: candidate.page,
    rect,
    artwork: candidate.artwork ? normalize(candidate.artwork, pageWidth, pageHeight) : rect,
  };
}

/** Reading order: down the page, then left to right within a row. */
function byReadingOrder(a: Candidate, b: Candidate): number {
  if (a.page !== b.page) return a.page - b.page;
  if (Math.abs(a.top - b.top) > SIZE_TOLERANCE_PT) return a.top - b.top;
  return a.x - b.x;
}

function sizeMatches(candidate: Candidate, widthPt: number, heightPt: number): boolean {
  return (
    Math.abs(candidate.width - widthPt) <= SIZE_TOLERANCE_PT &&
    Math.abs(candidate.height - heightPt) <= SIZE_TOLERANCE_PT
  );
}

function expectedSize(placeholder: DetectedPlaceholder): { widthPt: number; heightPt: number } {
  return {
    widthPt: placeholder.widthPt ?? DEFAULT_WIDTH_PT,
    heightPt: placeholder.heightPt ?? DEFAULT_HEIGHT_PT,
  };
}

/**
 * pdf.js expects a browser. Its bundle includes the canvas renderer, which builds a
 * `new DOMMatrix()` at module scope — so in Node the import itself throws
 * `ReferenceError: DOMMatrix is not defined` before any of our code runs.
 *
 * Nothing here rasterises: we read the operator list and the text layer, never
 * `page.render()`. So rather than pull in a native canvas binding for a path that draws
 * nothing, define the shapes the module needs to finish loading. They throw if anything
 * actually tries to use them, so a future code path that does need real rendering fails
 * loudly instead of drawing nonsense.
 */
function installDomShims(): void {
  const unsupported = (name: string) => {
    throw new Error(
      `${name} is not available in Node. This code path must not rasterise a PDF.`
    );
  };

  const globals = globalThis as Record<string, unknown>;

  globals.DOMMatrix ??= class {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    multiplySelf() {
      return unsupported("DOMMatrix.multiplySelf");
    }
    scaleSelf() {
      return unsupported("DOMMatrix.scaleSelf");
    }
  };

  globals.Path2D ??= class {
    constructor() {
      unsupported("Path2D");
    }
  };

  globals.ImageData ??= class {
    constructor() {
      unsupported("ImageData");
    }
  };
}

/**
 * pdfjs-dist ships as ESM only. The backend emits CommonJS, so it has to come in through a
 * dynamic import, which TypeScript preserves under module: Node16.
 */
async function loadPdfjs() {
  installDomShims();
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/** pdf.js image kinds that carry 8-bit colour, and how many bytes each pixel takes. */
const IMAGE_KIND_CHANNELS: Record<number, 3 | 4> = { 2: 3, 3: 4 };

/** Decoded pixels in the shape pdf.js hands them over, or null for any other kind. */
function asPixels(value: unknown): Pixels | null {
  const image = value as { width?: number; height?: number; kind?: number; data?: Uint8ClampedArray } | null;
  const channels = image?.kind ? IMAGE_KIND_CHANNELS[image.kind] : undefined;
  if (!image?.data || !image.width || !image.height || !channels) return null;
  return { width: image.width, height: image.height, channels, data: image.data };
}

type ObjectStore = { get(id: string, callback: (value: unknown) => void): unknown };

/**
 * The pixels of an image painted on a page that is still loaded. pdf.js resolves images
 * asynchronously, so this waits briefly; a picture that never arrives just goes unfingerprinted.
 */
async function readPagePixels(
  page: { objs: ObjectStore; commonObjs: ObjectStore },
  ref: string | Pixels
): Promise<Pixels | null> {
  if (typeof ref !== "string") return ref;
  const store = ref.startsWith("g_") ? page.commonObjs : page.objs;
  const value = await Promise.race([
    new Promise<unknown>((resolve) => {
      try {
        store.get(ref, resolve);
      } catch {
        resolve(null);
      }
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), IMAGE_WAIT_MS)),
  ]);
  return asPixels(value);
}

const IMAGE_WAIT_MS = 2000;

/**
 * Above this a painted picture is not taken for the placeholder it most resembles. Same-picture
 * pairs come out around 0.01 after conversion; a logo or photo of the same size is far off.
 */
const MAX_FINGERPRINT_DISTANCE = 0.12;

/**
 * Pairs picture placeholders with painted images by what they show, not by their order.
 *
 * Placeholders with the same tag share one picture, so they form a group, and only within a
 * group does order decide: those boxes belong to one signer and ask the same thing. Returns
 * null when anything needed is missing or the counts do not add up, and the caller falls back
 * to pairing by order.
 */
function pairByPicture(
  placeholders: DetectedPlaceholder[],
  candidates: Candidate[]
): Map<DetectedPlaceholder, Candidate> | null {
  const groups = new Map<string, { fingerprint: Fingerprint; placeholders: DetectedPlaceholder[]; size: { widthPt: number; heightPt: number } }>();

  for (const placeholder of placeholders) {
    const fingerprint = pictureFingerprintOf(placeholder);
    if (!fingerprint) return null;
    const size = expectedSize(placeholder);
    const key = `${placeholder.tag}|${size.widthPt}x${size.heightPt}`;
    const group = groups.get(key) ?? { fingerprint, placeholders: [], size };
    group.placeholders.push(placeholder);
    groups.set(key, group);
  }

  const assigned = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!candidate.fingerprint) return null;
    let best: { key: string; distance: number } | null = null;
    for (const [key, group] of groups) {
      if (!sizeMatches(candidate, group.size.widthPt, group.size.heightPt)) continue;
      const distance = fingerprintDistance(candidate.fingerprint, group.fingerprint);
      if (!best || distance < best.distance) best = { key, distance };
    }
    // Sized like a placeholder but showing something else: a logo, a photo. Not a box.
    if (!best || best.distance > MAX_FINGERPRINT_DISTANCE) continue;
    assigned.set(best.key, [...(assigned.get(best.key) ?? []), candidate]);
  }

  const pairs = new Map<DetectedPlaceholder, Candidate>();
  for (const [key, group] of groups) {
    const matches = (assigned.get(key) ?? []).sort(byReadingOrder);
    if (matches.length !== group.placeholders.length) return null;
    group.placeholders.forEach((placeholder, index) => pairs.set(placeholder, matches[index]));
  }
  return pairs;
}

/** Every image painted on the page, with the rect it was painted into. */
function collectImages(
  ops: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
  page: number,
  pageWidth: number,
  pageHeight: number
): Candidate[] {
  const found: Candidate[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];

    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn === OPS.transform) {
      ctm = multiply(ctm, ops.argsArray[i] as Matrix);
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageXObjectRepeat
    ) {
      // The matrix maps the image's unit square onto the page, so its scale is the
      // painted size and its translation is the bottom-left corner.
      const width = Math.abs(ctm[0]);
      const height = Math.abs(ctm[3]);
      if (width === 0 || height === 0) continue;

      const x = ctm[4];
      const top = pageHeight - (ctm[5] + height);
      const ref = (ops.argsArray[i] as unknown[] | undefined)?.[0];

      found.push({
        imageRef: typeof ref === "string" ? ref : asPixels(ref) ?? undefined,
        page,
        x,
        top,
        width,
        height,
        pageWidth,
        pageHeight,
        // The field box keeps the picture's exact size; only the eraser reaches past its edge.
        artwork: {
          x: x - IMAGE_BLEED_PT,
          top: top - IMAGE_BLEED_PT,
          width: width + IMAGE_BLEED_PT * 2,
          height: height + IMAGE_BLEED_PT * 2,
        },
      });
    }
  }

  return found;
}

/** Width of a string in em units, for estimating where characters fall inside a text item. */
type Measure = (text: string) => number;

let metricsFont: PDFFont | null = null;

/**
 * Relative glyph widths, borrowed from Helvetica.
 *
 * pdf.js gives a text item's total width but not where each character sits in it, and a
 * `{%role}` token usually shares an item with the words around it. Splitting the width evenly
 * per character drifts by a few points because `i`, `:` and spaces are narrow — enough to leave
 * the edge of a brace visible after erasing. The document's own font is not available here, but
 * Helvetica's proportions scaled to the item's real width land far closer for any Latin font.
 */
async function loadMeasure(): Promise<Measure> {
  if (!metricsFont) {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    metricsFont = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  }

  const font = metricsFont;

  // Helvetica encodes WinAnsi only; anything outside it is measured as an average-width letter
  // rather than throwing.
  return (text) => font.widthOfTextAtSize(text.replace(/[^\x20-\x7e\xa0-\xff]/g, "n"), 1);
}

/** The subset of a pdfjs text item this module needs. */
type PositionedText = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

function isPositionedText(item: unknown): item is PositionedText {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

/**
 * Finds `{%role}` tokens in the page text. Word frequently splits a token across several
 * text items, so the page is searched as one joined string and mapped back to the item
 * that starts each match.
 */
function collectTextTokens(
  items: PositionedText[],
  measure: Measure,
  tags: string[],
  page: number,
  pageWidth: number,
  pageHeight: number
): Map<string, Candidate[]> {
  const byTag = new Map<string, Candidate[]>();
  const starts: number[] = [];
  let joined = "";

  for (const item of items) {
    starts.push(joined.length);
    joined += item.str;
  }

  const itemAt = (offset: number): number => {
    for (let i = starts.length - 1; i >= 0; i -= 1) {
      if (starts[i] <= offset) return i;
    }
    return 0;
  };

  for (const tag of tags) {
    const hits: Candidate[] = [];
    let from = 0;

    for (;;) {
      const at = joined.indexOf(tag, from);
      if (at === -1) break;
      from = at + tag.length;

      const startIndex = itemAt(at);
      const endIndex = itemAt(from - 1);
      const start = items[startIndex];
      const end = items[endIndex];
      if (!start || !end) continue;

      // pdf.js positions whole text items, not glyphs, and a token typed mid-sentence usually
      // shares an item with the words around it. Taking the item's own start would put the box —
      // and the eraser — at the beginning of the line. Place the token inside its item by the
      // share of the item's measured width that the preceding characters take up.
      const xAt = (item: PositionedText, offset: number) => {
        const total = measure(item.str);
        const share =
          total > 0
            ? measure(item.str.slice(0, offset)) / total
            : item.str.length
              ? offset / item.str.length
              : 0;
        return item.transform[4] + item.width * share;
      };

      const left = xAt(start, at - starts[startIndex]);
      const right = xAt(end, from - starts[endIndex]);
      const baseline = start.transform[5];
      const textWidth = Math.max(right - left, 1);
      // pdf.js reports a text item's height as its font size. A token Word split across items
      // may carry two sizes; the larger one covers both.
      const fontSize = Math.max(start.height, end.height) || FALLBACK_FONT_SIZE_PT;

      // Glyphs sit above the baseline, so a box resting on the baseline covers the token
      // once a signature is stamped over it.
      hits.push({
        page,
        x: left,
        top: pageHeight - (baseline + DEFAULT_HEIGHT_PT),
        width: Math.max(DEFAULT_WIDTH_PT, textWidth),
        height: DEFAULT_HEIGHT_PT,
        pageWidth,
        pageHeight,
        // Only the token itself, from ascender to descender. The field box above is sized for a
        // signature and would wipe out the rest of the line if it were used to erase.
        artwork: {
          x: left - fontSize * ERASE_PADDING_EM,
          top: pageHeight - (baseline + fontSize),
          width: textWidth + fontSize * ERASE_PADDING_EM * 2,
          height: fontSize * (1 + DESCENDER_RATIO),
        },
      });
    }

    if (hits.length) byTag.set(tag, hits);
  }

  return byTag;
}

/**
 * Page count only — used when a document has no placeholders to locate, which is the common
 * case for a document prepared by hand.
 *
 * Uses pdf-lib rather than pdf.js. Counting pages needs the page tree and nothing else, so
 * loading a renderer to read one number means the most-travelled upload path carries pdf.js's
 * browser assumptions for no benefit. Falls back to 1 rather than failing an upload: a wrong
 * page count costs a scrollbar, and the real count arrives when the viewer renders.
 */
export async function countPages(pdf: Buffer): Promise<number> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const document = await PDFDocument.load(new Uint8Array(pdf), {
      updateMetadata: false,
    });
    return document.getPageCount();
  } catch (error) {
    logger.warn("Could not read the page count from the converted PDF", {
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

/**
 * What the file holds, whatever a page's drawing operations say: who made it, and the size and
 * encoding of each stored image, form and pattern. Holds nothing from the document's text.
 */
async function describePdf(pdf: Buffer): Promise<Record<string, unknown>> {
  try {
    const { PDFDocument, PDFDict, PDFName, PDFStream } = await import("pdf-lib");
    const document = await PDFDocument.load(new Uint8Array(pdf), {
      updateMetadata: false,
      ignoreEncryption: true,
    });
    const stored: string[] = [];

    for (const [, object] of document.context.enumerateIndirectObjects()) {
      const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : null;
      if (!dict) continue;

      const read = (key: string) => dict.get(PDFName.of(key))?.toString();
      const subtype = read("Subtype");
      const patternType = read("PatternType");

      if (subtype === "/Image") {
        stored.push(`image ${read("Width")}x${read("Height")} ${read("Filter") ?? "no filter"} ${read("SMask") ? "with mask" : ""}`.trim());
      } else if (subtype === "/Form") {
        stored.push(`form ${read("BBox") ?? ""}`.trim());
      } else if (patternType) {
        stored.push(`pattern type ${patternType}`);
      }
    }

    return { producer: document.getProducer(), creator: document.getCreator(), stored };
  } catch (error) {
    return { describeFailed: error instanceof Error ? error.message : String(error) };
  }
}

export async function locatePlaceholders(
  pdf: Buffer,
  expected: DetectedPlaceholder[]
): Promise<LocateResult> {
  const pdfjs = await loadPdfjs();
  const OPS = pdfjs.OPS as unknown as Record<string, number>;

  const imagePlaceholders = expected.filter((item) => item.source === "image");
  const textPlaceholders = expected.filter((item) => item.source === "text");
  const wantedTags = [...new Set(textPlaceholders.map((item) => item.tag))];

  // No font or cmap URLs: this reads geometry, never renders glyphs. Pointing those options
  // at filesystem paths makes pdfjs try to fetch() them under Node, which never settles.
  // Their absence only costs a warning on documents using the standard fonts.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    disableFontFace: true,
    useWorkerFetch: false,
  });

  const images: Candidate[] = [];
  const paintOps: Record<string, number> = {};
  const textHits = new Map<string, Candidate[]>();
  const measure = wantedTags.length ? await loadMeasure() : null;
  let pageCount = 0;

  try {
    const document = await loadingTask.promise;
    pageCount = document.numPages;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const { width, height } = page.getViewport({ scale: 1 });

      if (imagePlaceholders.length) {
        const ops = await page.getOperatorList();
        const pageImages = collectImages(ops, OPS, pageNumber, width, height);
        // Read now, while the page's objects are still loaded. Only pictures sized like a box
        // are worth it; the rest are left out of the pairing anyway.
        for (const image of pageImages) {
          const sized = imagePlaceholders.some((placeholder) => {
            const { widthPt, heightPt } = expectedSize(placeholder);
            return sizeMatches(image, widthPt, heightPt);
          });
          if (!sized || !image.imageRef) continue;
          const pixels = await readPagePixels(page as never, image.imageRef);
          const fingerprint = pixels ? fingerprintOf(pixels) : null;
          if (fingerprint) image.fingerprint = fingerprint;
          image.imageRef = undefined;
        }
        images.push(...pageImages);
        for (const [name, code] of Object.entries(OPS)) {
          const count = ops.fnArray.filter((fn) => fn === code).length;
          if (count) paintOps[name] = (paintOps[name] ?? 0) + count;
        }
      }

      if (measure) {
        const content = await page.getTextContent();
        const items: PositionedText[] = [];
        for (const item of content.items) {
          if (isPositionedText(item)) items.push(item);
        }
        for (const [tag, hits] of collectTextTokens(
          items,
          measure,
          wantedTags,
          pageNumber,
          width,
          height
        )) {
          textHits.set(tag, [...(textHits.get(tag) ?? []), ...hits]);
        }
      }

      page.cleanup();
    }
  } catch (error) {
    logger.error("Placeholder location failed", {
      stack: error instanceof Error ? error.stack : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new AppError(
      "Could not read the converted PDF to place the signature boxes.",
      502,
      "PLACEHOLDER_LOCATION_FAILED"
    );
  } finally {
    await loadingTask.destroy();
  }

  const located = new Map<DetectedPlaceholder, LocatedPlaceholder>();

  if (imagePlaceholders.length) {
    const sized = images.filter((candidate) =>
      imagePlaceholders.some((placeholder) => {
        const { widthPt, heightPt } = expectedSize(placeholder);
        return sizeMatches(candidate, widthPt, heightPt);
      })
    );

    // First by what each picture shows, so a signature table laid out in columns cannot hand one
    // signer's box to another.
    const byPicture = pairByPicture(imagePlaceholders, sized);
    if (byPicture) {
      for (const [placeholder, candidate] of byPicture) located.set(placeholder, toLocated(candidate));
    } else {
      logger.warn("Placeholders paired by order: their pictures could not be matched", {
        expected: imagePlaceholders.length,
        sized: sized.length,
        fingerprinted: sized.filter((candidate) => candidate.fingerprint).length,
      });
    }
  }

  // Fallback: document order against reading order. Right for boxes laid out down the page,
  // wrong for side-by-side columns, which is why pictures are compared first.
  if (imagePlaceholders.length && located.size === 0) {
    const candidates = images
      .filter((candidate) =>
        imagePlaceholders.some((placeholder) => {
          const { widthPt, heightPt } = expectedSize(placeholder);
          return sizeMatches(candidate, widthPt, heightPt);
        })
      )
      .sort(byReadingOrder);

    if (candidates.length !== imagePlaceholders.length) {
      // The converter decides how a picture is painted, so this shows what it actually produced.
      logger.warn("Signature pictures not matched in the converted PDF", {
        pageCount,
        expected: imagePlaceholders.map((item) => `${item.tag} ${item.widthPt}x${item.heightPt}`),
        imagesFound: images.map((item) => `page ${item.page}: ${item.width.toFixed(1)}x${item.height.toFixed(1)}`),
        paintOps,
        ...(await describePdf(pdf)),
      });
      throw new AppError(
        `Found ${imagePlaceholders.length} signature placeholder${imagePlaceholders.length === 1 ? "" : "s"} in the Word document but ${candidates.length} in the converted PDF. Re-insert the signature boxes with the add-in and try again.`,
        400,
        "PLACEHOLDER_COUNT_MISMATCH"
      );
    }

    imagePlaceholders.forEach((placeholder, index) => {
      located.set(placeholder, toLocated(candidates[index]));
    });
  }

  // Text placeholders carry their role in the token itself, so they match by tag.
  for (const placeholder of textPlaceholders) {
    const hits = (textHits.get(placeholder.tag) ?? []).sort(byReadingOrder);
    const candidate = hits[placeholder.index];

    if (!candidate) {
      throw new AppError(
        `Could not find the signature box for ${signerLabel(placeholder.role)} in the converted PDF. Re-insert it with the add-in and try again.`,
        400,
        "PLACEHOLDER_NOT_LOCATED"
      );
    }

    located.set(placeholder, toLocated(candidate));
  }

  return {
    pageCount,
    located: expected.map((placeholder) => {
      const match = located.get(placeholder);
      if (!match) {
        throw new AppError(
          `Could not find the signature box for ${signerLabel(placeholder.role)} in the converted PDF.`,
          400,
          "PLACEHOLDER_NOT_LOCATED"
        );
      }
      return match;
    }),
  };
}
