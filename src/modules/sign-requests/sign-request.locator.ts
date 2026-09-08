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

export type LocatedPlaceholder = {
  page: number;
  rect: FieldRect;
};

export type LocateResult = {
  pageCount: number;
  located: LocatedPlaceholder[];
};

/** A candidate found in the PDF, in PDF points with a top-left origin. */
type Candidate = {
  page: number;
  x: number;
  top: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
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

function normalize(candidate: Candidate): FieldRect {
  return {
    x: candidate.x / candidate.pageWidth,
    y: candidate.top / candidate.pageHeight,
    width: candidate.width / candidate.pageWidth,
    height: candidate.height / candidate.pageHeight,
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
 * pdfjs-dist ships as ESM only. The backend emits CommonJS, so it has to come in through a
 * dynamic import, which TypeScript preserves under module: Node16.
 */
async function loadPdfjs() {
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

      found.push({
        page,
        x: ctm[4],
        top: pageHeight - (ctm[5] + height),
        width,
        height,
        pageWidth,
        pageHeight,
      });
    }
  }

  return found;
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

      const start = items[itemAt(at)];
      const end = items[itemAt(from - 1)];
      if (!start) continue;

      const left = start.transform[4];
      const baseline = start.transform[5];
      const textWidth = Math.max(end.transform[4] + end.width - left, start.width);

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
      });
    }

    if (hits.length) byTag.set(tag, hits);
  }

  return byTag;
}

/** Page count only — used when a document has no placeholders to locate. */
export async function countPages(pdf: Buffer): Promise<number> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    disableFontFace: true,
    useWorkerFetch: false,
  });

  try {
    const document = await loadingTask.promise;
    return document.numPages;
  } catch (error) {
    logger.warn("Could not read the page count from the converted PDF", {
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    await loadingTask.destroy();
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

      if (wantedTags.length) {
        const content = await page.getTextContent();
        const items: PositionedText[] = [];
        for (const item of content.items) {
          if (isPositionedText(item)) items.push(item);
        }
        for (const [tag, hits] of collectTextTokens(items, wantedTags, pageNumber, width, height)) {
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
      const candidate = candidates[index];
      located.set(placeholder, { page: candidate.page, rect: normalize(candidate) });
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

    located.set(placeholder, { page: candidate.page, rect: normalize(candidate) });
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
