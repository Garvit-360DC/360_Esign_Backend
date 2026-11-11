import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { logger } from "../../config/logger";
import { AppError } from "../../utils/appError";
import { FIELD_TYPE_META, type FieldRect, type SignatureField } from "./sign-request.types";

/**
 * Draws everything the signers filled in into the converted PDF.
 *
 * Signature and initial boxes hold an image; the rest hold text and are typeset here.
 * Positions come from `locatePlaceholders` or from the prepare screen, so each value lands
 * exactly on its box. The box artwork is painted over first, otherwise the add-in's grey
 * rectangle (or the literal `{%role}` token) stays visible underneath.
 */

const DATA_URL_RE = /^data:image\/(png|jpe?g);base64,/i;

type PdfRect = { x: number; y: number; width: number; height: number };

/** PNG or JPEG, decided by the bytes rather than by what the client claimed. */
function detectImageType(buffer: Buffer): "png" | "jpg" | null {
  if (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  return null;
}

function decodeSignature(value: string, label: string): Buffer {
  const stripped = value.replace(DATA_URL_RE, "");
  const buffer = Buffer.from(stripped, "base64");

  if (!buffer.length) {
    throw new AppError(`${label}: the signature image is empty.`, 400, "INVALID_SIGNATURE_IMAGE");
  }

  return buffer;
}

/** Several boxes can hold this, and every value lives in one size-limited database document. */
const MAX_SIGNATURE_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Throws unless stamping could use this image, by doing the same embed into a scratch PDF.
 * Run when a signer saves it, so a bad image is reported to them and not at stamping time.
 */
export async function assertStampableImage(value: string): Promise<void> {
  const bytes = decodeSignature(value, "Signature");

  if (bytes.length > MAX_SIGNATURE_IMAGE_BYTES) {
    throw new AppError(
      "That signature image is too large. Please use one under 2 MB.",
      400,
      "INVALID_SIGNATURE_IMAGE"
    );
  }

  const kind = detectImageType(bytes);
  if (!kind) {
    throw new AppError("Signature: must be a PNG or JPEG image.", 400, "INVALID_SIGNATURE_IMAGE");
  }

  const scratch = await PDFDocument.create();
  try {
    await (kind === "png" ? scratch.embedPng(bytes) : scratch.embedJpg(bytes));
  } catch {
    throw new AppError(
      "Signature: could not read the signature image.",
      400,
      "INVALID_SIGNATURE_IMAGE"
    );
  }
}

/**
 * Normalized top-left coordinates to PDF points measured up from the bottom. Screens
 * measure down from the top; PDFs measure up from the bottom. Convert once, here.
 */
function toPdfRect(
  rect: FieldRect,
  pageWidth: number,
  pageHeight: number,
  label: string
): PdfRect {
  const x = rect.x * pageWidth;
  const width = rect.width * pageWidth;
  const height = rect.height * pageHeight;
  const bottom = pageHeight - rect.y * pageHeight - height;

  if (![x, bottom, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new AppError(`${label}: the signature box has no usable size.`, 500, "INVALID_FIELD_RECT");
  }

  // Clamp instead of rejecting: a box that hangs a hair off the page after conversion
  // rounding should still produce a signed document.
  const clampedX = Math.max(0, Math.min(x, pageWidth - width));
  const clampedBottom = Math.max(0, Math.min(bottom, pageHeight - height));

  return { x: clampedX, y: clampedBottom, width, height };
}

/**
 * Paints out the Word add-in's placeholder artwork, returning a new PDF.
 *
 * ConvertAPI turns each placeholder into part of the page, so without this the picture (or
 * the literal `{%role}` token) stays visible wherever the sender moves or removes its box: in
 * the prepare screen, in the signing ceremony, and in the signed document. Done once, when the
 * converted PDF is first stored, the document carries no scaffolding and the field boxes are
 * the only indication of where anything goes.
 *
 * This covers the artwork; it does not remove it from the content stream. A token stays in the
 * text layer and can still be found by search.
 */
export async function erasePlaceholders(
  pdf: Buffer,
  artwork: { page: number; rect: FieldRect }[]
): Promise<Buffer> {
  if (artwork.length === 0) return pdf;

  const document = await PDFDocument.load(new Uint8Array(pdf));
  const pages = document.getPages();

  for (const { page: pageNumber, rect } of artwork) {
    const page = pages[pageNumber - 1];
    if (!page) continue;

    const { width, height } = page.getSize();
    const box = toPdfRect(rect, width, height, "Placeholder");

    page.drawRectangle({ ...box, color: rgb(1, 1, 1) });
  }

  return Buffer.from(await document.save());
}

/** Left and right breathing room inside a text box, in points. */
const TEXT_PADDING = 2;
const MAX_TEXT_SIZE = 12;
const MIN_TEXT_SIZE = 5;

/** The characters WinAnsi adds on top of Latin-1: curly quotes, dashes, the euro sign and so on. */
const WIN_ANSI_EXTRAS = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Letters that have no WinAnsi form and do not decompose into one. */
const TRANSLITERATIONS: Record<string, string> = {
  Ł: "L", ł: "l", Đ: "D", đ: "d", Ħ: "H", ħ: "h", ı: "i", Ŀ: "L", ŀ: "l", Ŧ: "T", ŧ: "t",
  "′": "'", "″": '"', "‐": "-", "‑": "-", "‒": "-", "−": "-",
  " ": " ", " ": " ", " ": " ", " ": " ",
};

function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS.has(char);
}

/**
 * Helvetica is a WinAnsi font, so anything outside it would throw on encode. Each character is
 * kept if it can be, reduced to its base letter if not ("ą" becomes "a"), and only then replaced.
 * A signed document with a "?" in a name beats no signed document, but iOS turns every
 * apostrophe into "’", so that one at least must survive. Scripts such as Chinese or Arabic need
 * an embedded Unicode font, which this does not have.
 */
export function toWinAnsi(text: string): string {
  return Array.from(text.normalize("NFC"))
    .map((char) => {
      if (isWinAnsi(char)) return char;
      if (TRANSLITERATIONS[char]) return TRANSLITERATIONS[char];
      const base = char.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      return base && Array.from(base).every(isWinAnsi) ? base : "?";
    })
    .join("");
}

function drawFieldText(page: PDFPage, font: PDFFont, rect: PdfRect, value: string) {
  let text = toWinAnsi(value);
  const available = Math.max(rect.width - TEXT_PADDING * 2, 1);

  // Start from what the box height allows, then shrink until the text fits its width.
  let size = Math.min(rect.height * 0.72, MAX_TEXT_SIZE);
  while (size > MIN_TEXT_SIZE && font.widthOfTextAtSize(text, size) > available) {
    size -= 0.25;
  }

  // Still too wide at the smallest size: cut it short with an ellipsis rather than print over
  // whatever sits next to the box.
  if (font.widthOfTextAtSize(text, size) > available) {
    const chars = Array.from(text);
    while (chars.length > 1 && font.widthOfTextAtSize(`${chars.join("")}…`, size) > available) {
      chars.pop();
    }
    text = `${chars.join("").trimEnd()}…`;
  }

  // `drawText` positions the baseline, so centre on the ascender height.
  const baseline = rect.y + (rect.height - font.heightAtSize(size, { descender: false })) / 2;

  page.drawText(text, {
    x: rect.x + TEXT_PADDING,
    y: baseline,
    size,
    font,
    color: rgb(0.07, 0.11, 0.19),
  });
}

export async function stampSignatures(
  pdf: Buffer,
  fields: SignatureField[]
): Promise<Buffer> {
  let document: PDFDocument;

  try {
    document = await PDFDocument.load(new Uint8Array(pdf));
  } catch (error) {
    logger.error("Could not open the PDF for stamping", {
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new AppError(
      "Could not open the document to apply signatures.",
      500,
      "STAMP_FAILED"
    );
  }

  const pages = document.getPages();
  const hasText = fields.some(
    (field) => field.value && FIELD_TYPE_META[field.type].family === "text"
  );
  const font = hasText ? await document.embedFont(StandardFonts.Helvetica) : null;

  for (const field of fields) {
    if (!field.value) continue;

    const meta = FIELD_TYPE_META[field.type];
    const label = `${meta.label} for ${field.role}`;
    const page = pages[field.page - 1];
    if (!page) {
      throw new AppError(
        `${label}: page ${field.page} is not in the document.`,
        500,
        "INVALID_FIELD_PAGE"
      );
    }

    const { width: pageWidth, height: pageHeight } = page.getSize();
    const rect = toPdfRect(field.rect, pageWidth, pageHeight, label);

    // Cover the placeholder artwork before drawing over it, whatever goes on top.
    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      color: rgb(1, 1, 1),
    });

    if (meta.family === "text") {
      // `font` is non-null here: `hasText` was computed from these same fields.
      if (font) drawFieldText(page, font, rect, field.value);
      continue;
    }

    const bytes = decodeSignature(field.value, label);

    const kind = detectImageType(bytes);
    if (!kind) {
      throw new AppError(
        `${label}: must be a PNG or JPEG image.`,
        400,
        "INVALID_SIGNATURE_IMAGE"
      );
    }

    let image;
    try {
      image =
        kind === "png" ? await document.embedPng(bytes) : await document.embedJpg(bytes);
    } catch (error) {
      logger.error("Could not embed a signature image", {
        role: field.role,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new AppError(
        `${label}: could not read the signature image.`,
        400,
        "INVALID_SIGNATURE_IMAGE"
      );
    }

    // Scaled to fit and centred, never stretched — a distorted signature looks forged.
    const scale = Math.min(rect.width / image.width, rect.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;

    page.drawImage(image, {
      x: rect.x + (rect.width - width) / 2,
      y: rect.y + (rect.height - height) / 2,
      width,
      height,
    });
  }

  return Buffer.from(await document.save());
}
