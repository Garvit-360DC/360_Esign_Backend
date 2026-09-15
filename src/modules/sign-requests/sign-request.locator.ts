import type { PDFFont } from "pdf-lib";
import { logger } from "../../config/logger";
import { AppError } from "../../utils/appError";
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

      found.push({
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
        images.push(...collectImages(ops, OPS, pageNumber, width, height));
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

  // Images all share one artwork, so they can only be told apart by document order.
  // Keep the ones sized like a placeholder and pair them up in reading order.
  if (imagePlaceholders.length) {
    const candidates = images
      .filter((candidate) =>
        imagePlaceholders.some((placeholder) => {
          const { widthPt, heightPt } = expectedSize(placeholder);
          return sizeMatches(candidate, widthPt, heightPt);
        })
      )
      .sort(byReadingOrder);

    if (candidates.length !== imagePlaceholders.length) {
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
