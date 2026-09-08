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

/** Left and right breathing room inside a text box, in points. */
const TEXT_PADDING = 2;
const MAX_TEXT_SIZE = 12;
const MIN_TEXT_SIZE = 5;

/**
 * Helvetica is a WinAnsi font, so anything outside that range would throw on encode.
 * Substitute rather than fail: a signed document with a "?" in a company name beats no
 * signed document at all.
 */
function toWinAnsi(text: string): string {
  return text.replace(/[^ -ÿ]/g, "?");
}

function drawFieldText(page: PDFPage, font: PDFFont, rect: PdfRect, value: string) {
  const text = toWinAnsi(value);
  const available = Math.max(rect.width - TEXT_PADDING * 2, 1);

  // Start from what the box height allows, then shrink until the text fits its width.
  let size = Math.min(rect.height * 0.72, MAX_TEXT_SIZE);
  while (size > MIN_TEXT_SIZE && font.widthOfTextAtSize(text, size) > available) {
    size -= 0.25;
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
