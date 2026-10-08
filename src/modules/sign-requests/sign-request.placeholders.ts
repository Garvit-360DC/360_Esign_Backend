import PizZip from "pizzip";
import { AppError } from "../../utils/appError";
import {
  SIGNER_ROLE_PATTERN,
  SIGN_FIELD_TYPES,
  isSignerRole,
  type DetectedPlaceholder,
  type SignFieldType,
  type SignerRole,
} from "./sign-request.types";

// A tag names a signer and, optionally, what the box collects: `{%signer1}` is a signature,
// `{%signer1:initial}` an initial, `{%signer1:fullName}` a name, and so on. The bare form
// predates the suffix, so it stays a signature.
const FIELD_TYPE_PATTERN = SIGN_FIELD_TYPES.join("|");
const TAG_PATTERN = `\\{%(${SIGNER_ROLE_PATTERN})(?::(${FIELD_TYPE_PATTERN}))?\\}`;

// The add-in writes the tag into the picture's alt text (`descr`). It never sets `name`,
// which Word fills in with "Picture 1" and friends, but reading both is harmless.
const TAG_ATTR_RE = new RegExp(`(?:descr|name)\\s*=\\s*["'](${TAG_PATTERN})["']`, "i");
const TEXT_TAG_RE = new RegExp(TAG_PATTERN, "gi");

/** The attribute regex is case-insensitive, so map the suffix back to its canonical key. */
function toFieldType(raw: string | undefined): SignFieldType {
  if (!raw) return "signature";
  const lower = raw.toLowerCase();
  return SIGN_FIELD_TYPES.find((type) => type.toLowerCase() === lower) ?? "signature";
}
const EXTENT_RE = /<wp:extent\b[^>]*>/i;
const CX_RE = /\bcx="(\d+)"/;
const CY_RE = /\bcy="(\d+)"/;
const DRAWING_RE = /<w:drawing\b[\s\S]*?<\/w:drawing>/gi;
const WORD_PART_RE = /^word\/(document|header\d*|footer\d*)\.xml$/;
const BODY_PART = "word/document.xml";

const EMUS_PER_POINT = 12700;

function emuToPoints(emu: number): number {
  return Math.round((emu / EMUS_PER_POINT) * 100) / 100;
}

function readExtent(block: string): { widthPt?: number; heightPt?: number } {
  const extentTag = block.match(EXTENT_RE)?.[0];
  if (!extentTag) return {};
  const cx = extentTag.match(CX_RE)?.[1];
  const cy = extentTag.match(CY_RE)?.[1];
  if (!cx || !cy) return {};
  return {
    widthPt: emuToPoints(Number(cx)),
    heightPt: emuToPoints(Number(cy)),
  };
}

function extractImageFields(xml: string): DetectedPlaceholder[] {
  const fields: DetectedPlaceholder[] = [];
  const drawings = xml.matchAll(DRAWING_RE);

  for (const match of drawings) {
    const block = match[0];
    const tagMatch = block.match(TAG_ATTR_RE);
    const role = tagMatch?.[2];
    if (!tagMatch || !role || !isSignerRole(role)) continue;

    const size = readExtent(block);
    fields.push({
      role,
      type: toFieldType(tagMatch[3]),
      tag: tagMatch[1],
      source: "image",
      ...size,
      index: 0,
    });
  }

  return fields;
}

function extractTextFields(
  xml: string,
  imageFields: DetectedPlaceholder[]
): DetectedPlaceholder[] {
  const imageTags = new Set(imageFields.map((field) => field.tag));
  const fields: DetectedPlaceholder[] = [];

  for (const match of xml.matchAll(TEXT_TAG_RE)) {
    const role = match[1];
    if (!role || !isSignerRole(role)) continue;
    // The literal text, not a rebuilt tag: the locator searches the PDF's text for it.
    const tag = match[0];
    if (imageTags.has(tag)) continue;
    fields.push({
      role,
      type: toFieldType(match[2]),
      tag,
      source: "text",
      index: 0,
    });
  }

  return fields;
}

function indexFields(fields: DetectedPlaceholder[]): DetectedPlaceholder[] {
  const counts = new Map<SignerRole, number>();
  return fields.map((field) => {
    const next = counts.get(field.role) ?? 0;
    counts.set(field.role, next + 1);
    return { ...field, index: next };
  });
}

/**
 * Like `extractSignatureFields`, but returns an empty list instead of throwing when the
 * document has no placeholders. The prepare screen accepts such documents and lets the
 * sender place boxes by hand.
 */
export function detectSignatureFields(file: Buffer): DetectedPlaceholder[] {
  try {
    return extractSignatureFields(file);
  } catch (error) {
    if (error instanceof AppError && error.code === "NO_SIGNATURE_FIELDS") {
      return [];
    }
    throw error;
  }
}

export function extractSignatureFields(file: Buffer): DetectedPlaceholder[] {
  let zip: PizZip;
  try {
    zip = new PizZip(file);
  } catch {
    throw new AppError("Could not read that file as a Word document", 400, "INVALID_DOCX");
  }

  const fields: DetectedPlaceholder[] = [];
  let outsideBody = 0;

  for (const name of Object.keys(zip.files)) {
    if (!WORD_PART_RE.test(name) || zip.files[name].dir) continue;
    const xml = zip.file(name)?.asText();
    if (!xml) continue;
    const imageFields = extractImageFields(xml);
    const partFields = [...imageFields, ...extractTextFields(xml, imageFields)];

    if (name === BODY_PART) {
      fields.push(...partFields);
    } else {
      outsideBody += partFields.length;
    }
  }

  // A placeholder in a header or footer is repeated on every page of the converted PDF,
  // so there is no single position to sign at. Say so rather than picking one at random.
  if (outsideBody > 0) {
    throw new AppError(
      "Signature boxes in a header or footer are not supported. Move them into the body of the document.",
      400,
      "PLACEHOLDER_IN_HEADER_FOOTER"
    );
  }

  if (fields.length === 0) {
    throw new AppError(
      "No eSign placeholders found. Insert signature boxes in the Word add-in first.",
      400,
      "NO_SIGNATURE_FIELDS"
    );
  }

  return indexFields(fields);
}
