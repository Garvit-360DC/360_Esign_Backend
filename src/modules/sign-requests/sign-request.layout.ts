import type { LocatedPlaceholder } from "./sign-request.locator";
import type { DetectedPlaceholder, SignatureField } from "./sign-request.types";

/**
 * Joins each placeholder found in the .docx with the position it was located at in the
 * converted PDF. The two lists are parallel — `locatePlaceholders` returns one entry per
 * detected placeholder, in the same order.
 */
export function toSignatureFields(
  detected: DetectedPlaceholder[],
  located: LocatedPlaceholder[]
): SignatureField[] {
  return detected.map((field, index) => {
    const position = located[index];

    return {
      id: `${field.role}_${field.index}`,
      role: field.role,
      type: field.type,
      tag: field.tag,
      source: field.source,
      widthPt: field.widthPt,
      heightPt: field.heightPt,
      index: field.index,
      page: position.page,
      rect: position.rect,
      value: null,
    };
  });
}
