import PizZip from "pizzip";
import { AppError } from "../../utils/appError";
import { decodePng, fingerprintOf, type Fingerprint } from "./sign-request.fingerprint";
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

const EMBED_RE = /\br:embed\s*=\s*["']([^"']+)["']/i;

/** Each picture placeholder, with the relationship id of the image file it shows. */
function extractImageFields(xml: string): { field: DetectedPlaceholder; embedId: string | null }[] {
  const fields: { field: DetectedPlaceholder; embedId: string | null }[] = [];
  const drawings = xml.matchAll(DRAWING_RE);

  for (const match of drawings) {
    const block = match[0];
    const tagMatch = block.match(TAG_ATTR_RE);
    const role = tagMatch?.[2];
    if (!tagMatch || !role || !isSignerRole(role)) continue;

    const size = readExtent(block);
    fields.push({
      field: {
        role,
        type: toFieldType(tagMatch[3]),
        tag: tagMatch[1],
        source: "image",
        ...size,
        index: 0,
      },
      embedId: block.match(EMBED_RE)?.[1] ?? null,
    });
  }

  return fields;
}

/**
 * The picture each placeholder shows, as a fingerprint. Held beside the placeholders rather than
 * on them, because placeholders are stored with the envelope and this is only needed to locate
 * them once. Missing when the image could not be read; the locator then pairs boxes by order.
 */
const pictureFingerprints = new WeakMap<DetectedPlaceholder, Fingerprint>();

export function pictureFingerprintOf(placeholder: DetectedPlaceholder): Fingerprint | undefined {
  return pictureFingerprints.get(placeholder);
}

/** `rId4` -> `word/media/image1.png`, from the part's relationships file. */
function readImageTargets(zip: PizZip, partName: string): Map<string, string> {
  const targets = new Map<string, string>();
  const relsName = partName.replace(/^word\//, "word/_rels/") + ".rels";
  const rels = zip.file(relsName)?.asText();
  if (!rels) return targets;

  for (const match of rels.matchAll(/<Relationship\b[^>]*>/gi)) {
    const id = match[0].match(/\bId\s*=\s*["']([^"']+)["']/i)?.[1];
    const target = match[0].match(/\bTarget\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!id || !target || /TargetMode\s*=\s*["']External/i.test(match[0])) continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : `word/${target}`);
  }
  return targets;
}

function fingerprintPicture(zip: PizZip, path: string | undefined): Fingerprint | null {
  if (!path) return null;
  const file = zip.file(path);
  if (!file) return null;
  const pixels = decodePng(Buffer.from(file.asUint8Array()));
  return pixels ? fingerprintOf(pixels) : null;
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
  /** Parallel to `fields`: the image file behind each picture placeholder. */
  const picturePaths: (string | undefined)[] = [];
  let outsideBody = 0;

  for (const name of Object.keys(zip.files)) {
    if (!WORD_PART_RE.test(name) || zip.files[name].dir) continue;
    const xml = zip.file(name)?.asText();
    if (!xml) continue;
    const pictures = extractImageFields(xml);
    const imageFields = pictures.map((picture) => picture.field);
    const textFields = extractTextFields(xml, imageFields);

    if (name === BODY_PART) {
      const targets = readImageTargets(zip, name);
      fields.push(...imageFields, ...textFields);
      picturePaths.push(
        ...pictures.map((picture) => (picture.embedId ? targets.get(picture.embedId) : undefined)),
        ...textFields.map(() => undefined)
      );
    } else {
      outsideBody += imageFields.length + textFields.length;
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

  const indexed = indexFields(fields);
  // Identical boxes share one image file, so each is read once.
  const byPath = new Map<string, Fingerprint | null>();
  indexed.forEach((field, i) => {
    const path = picturePaths[i];
    if (!path) return;
    if (!byPath.has(path)) byPath.set(path, fingerprintPicture(zip, path));
    const fingerprint = byPath.get(path);
    if (fingerprint) pictureFingerprints.set(field, fingerprint);
  });
  return indexed;
}
