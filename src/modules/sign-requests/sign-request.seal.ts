import { createHash, createPublicKey, verify } from "node:crypto";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { SignPdf } from "@signpdf/signpdf";
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import * as asn1js from "asn1js";
import { PDFDocument } from "pdf-lib";
import * as pkijs from "pkijs";
import { logger } from "../../config/logger";
import {
  createIdentity,
  describe,
  getCertificatePath,
  getTrustChain,
  isGlobalSignEnabled,
  signDigest,
  timestampDigest,
} from "../../integrations/globalsign";
import { env } from "../../config/env";
import { AppError } from "../../utils/appError";

/**
 * Seals a completed PDF with a GlobalSign certificate: one invisible PAdES (ETSI.CAdES.detached)
 * signature over the whole file, timestamped by GlobalSign's TSA and carrying the OCSP responses
 * a reader needs to check it later without going online (Acrobat's "LTV enabled").
 *
 * The signers' drawn signatures are already stamped on the pages; this seal is what proves the
 * file has not changed since 360 InstantDocs finished it.
 */

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  signatureTimeStampToken: "1.2.840.113549.1.9.16.2.14",
  adbeRevocationInfoArchival: "1.2.840.113583.1.1.8",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  ecPublicKey: "1.2.840.10045.2.1",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
} as const;

/**
 * Room for the CMS, in hex characters: 60,000 holds 30 KB. A seal carries the signing
 * certificate, its chain, OCSP responses and the timestamp token with the TSA's own chain:
 * typically 10–20 KB. Unused room is zero padding.
 */
const SIGNATURE_LENGTH = 60_000;

const SEAL_NAME = "360 InstantDocs";

/** What a seal needs from whoever holds the key. GlobalSign in production; a test key in tests. */
export interface SealSigner {
  /** PEM. */
  signingCert: string;
  /** PEM certificates from the signing certificate's issuer up. */
  chain: string[];
  /** DER OCSP responses for the signing certificate and its chain. */
  ocspResponses: Buffer[];
  /** Raw signature value over a SHA-256 digest given in hex. */
  sign(digestHex: string): Promise<Buffer>;
  /** RFC 3161 token (DER) over a SHA-256 digest given in hex, or null for no timestamp. */
  timestamp(digestHex: string): Promise<Buffer | null>;
}

export function isSealingEnabled(): boolean {
  return isGlobalSignEnabled();
}

/** Seals with GlobalSign. Throws `SEAL_FAILED` (502) if GlobalSign cannot be reached or refuses. */
export async function sealPdf(pdf: Buffer): Promise<Buffer> {
  try {
    return await sealPdfWith(pdf, await globalSignSigner());
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error("Sealing the signed PDF failed", { reason: describe(error) });
    throw new AppError(
      "We couldn't finish the signed document just now. Please try again in a moment.",
      502,
      "SEAL_FAILED"
    );
  }
}

async function globalSignSigner(): Promise<SealSigner> {
  const [identity, issuer, trust] = await Promise.all([
    createIdentity(env.GLOBALSIGN_SUBJECT_DN),
    getCertificatePath(),
    // Only adds revocation data for the chain; a seal without it is still valid.
    getTrustChain().catch((error) => {
      logger.warn("GlobalSign trust chain unavailable; sealing without it", { reason: describe(error) });
      return { trustchain: [] as string[], ocspRevocationInfo: [] as string[] };
    }),
  ]);

  return {
    signingCert: identity.signingCert,
    chain: [issuer, ...trust.trustchain],
    ocspResponses: [identity.ocspResponse, ...trust.ocspRevocationInfo]
      .filter(Boolean)
      .map((value) => Buffer.from(value, "base64")),
    sign: (digestHex) => signDigest(identity.id, digestHex),
    timestamp: (digestHex) => timestampDigest(digestHex),
  };
}

export async function sealPdfWith(pdf: Buffer, signer: SealSigner): Promise<Buffer> {
  const doc = await PDFDocument.load(pdf);
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: "Signed and sealed by 360 InstantDocs",
    contactInfo: "",
    name: SEAL_NAME,
    location: "",
    appName: SEAL_NAME,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    signatureLength: SIGNATURE_LENGTH,
  });
  // The signature dictionary must be findable as plain text, so no object streams.
  const prepared = Buffer.from(await doc.save({ useObjectStreams: false }));

  return new SignPdf().sign(prepared, new CmsSigner(signer));
}

class CmsSigner extends Signer {
  constructor(private readonly signer: SealSigner) {
    super();
  }

  /** `content` is the PDF without the placeholder: exactly the bytes the ByteRange covers. */
  async sign(content: Buffer): Promise<Buffer> {
    return buildCms(content, this.signer);
  }
}

export async function buildCms(content: Buffer, signer: SealSigner): Promise<Buffer> {
  const cert = parseCertificate(signer.signingCert);
  const chain = dedupeCertificates(signer.chain.flatMap(splitPem).map(parseCertificate), cert);
  const keyAlgorithm = cert.subjectPublicKeyInfo.algorithm.algorithmId;
  const signatureAlgorithmId =
    keyAlgorithm === OID.ecPublicKey ? OID.ecdsaWithSha256 : OID.sha256WithRSA;

  const signedAttributes = sortAttributes([
    attribute(OID.contentType, new asn1js.ObjectIdentifier({ value: OID.data })),
    attribute(OID.messageDigest, new asn1js.OctetString({ valueHex: toArrayBuffer(sha256(content)) })),
    attribute(OID.signingCertificateV2, signingCertificateV2(cert)),
    ...(signer.ocspResponses.length
      ? [attribute(OID.adbeRevocationInfoArchival, revocationInfoArchival(signer.ocspResponses))]
      : []),
  ]);

  // RFC 5652 5.4: the signature covers the DER of the attributes as a SET OF, not as [0].
  const signedAttrsDer = Buffer.from(
    new asn1js.Set({ value: signedAttributes.map((a) => a.toSchema()) }).toBER(false)
  );
  const signature = await signer.sign(sha256(signedAttrsDer).toString("hex"));

  // Caught here, a wrong key or digest convention fails the seal instead of shipping a PDF
  // that every reader reports as tampered with.
  if (!verifies(signedAttrsDer, signer.signingCert, signature)) {
    throw new Error("The signature returned does not verify against the signing certificate");
  }

  const timestamp = await signer.timestamp(sha256(signature).toString("hex"));

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
    digestAlgorithm: sha256Algorithm(),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: signedAttributes }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: signatureAlgorithmId,
      ...(signatureAlgorithmId === OID.sha256WithRSA ? { algorithmParams: new asn1js.Null() } : {}),
    }),
    signature: new asn1js.OctetString({ valueHex: toArrayBuffer(signature) }),
    ...(timestamp
      ? {
          unsignedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 1,
            attributes: [attribute(OID.signatureTimeStampToken, parseDer(timestamp))],
          }),
        }
      : {}),
  });

  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [sha256Algorithm()],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    certificates: [cert, ...chain],
    signerInfos: [signerInfo],
  });

  const contentInfo = new pkijs.ContentInfo({
    contentType: OID.signedData,
    content: signedData.toSchema(true),
  });
  return Buffer.from(contentInfo.toSchema().toBER(false));
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function verifies(data: Buffer, certPem: string, signature: Buffer): boolean {
  try {
    return verify("sha256", data, createPublicKey(certPem), signature);
  } catch {
    return false;
  }
}

function sha256Algorithm(): pkijs.AlgorithmIdentifier {
  return new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256, algorithmParams: new asn1js.Null() });
}

function attribute(type: string, value: asn1js.AsnType): pkijs.Attribute {
  return new pkijs.Attribute({ type, values: [value] });
}

/** DER orders a SET OF by encoding; the bytes signed and the bytes embedded must agree. */
function sortAttributes(attributes: pkijs.Attribute[]): pkijs.Attribute[] {
  return attributes
    .map((a) => ({ a, der: Buffer.from(a.toSchema().toBER(false)) }))
    .sort((x, y) => Buffer.compare(x.der, y.der))
    .map(({ a }) => a);
}

/**
 * ESS signing-certificate-v2 (RFC 5035), which PAdES requires: binds the signature to this
 * exact certificate. SHA-256 is the default hash algorithm, so it is left out.
 */
function signingCertificateV2(cert: pkijs.Certificate): asn1js.Sequence {
  const certHash = sha256(Buffer.from(cert.toSchema().toBER(false)));
  const issuerSerial = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [
          // GeneralName directoryName [4] EXPLICIT Name
          new asn1js.Constructed({
            idBlock: { tagClass: 3, tagNumber: 4 },
            value: [cert.issuer.toSchema()],
          }),
        ],
      }),
      cert.serialNumber,
    ],
  });
  const essCertIdV2 = new asn1js.Sequence({
    value: [new asn1js.OctetString({ valueHex: toArrayBuffer(certHash) }), issuerSerial],
  });
  return new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] });
}

/** Adobe's RevocationInfoArchival, holding OCSP responses in `ocsp [1] EXPLICIT SEQUENCE OF`. */
function revocationInfoArchival(ocspResponses: Buffer[]): asn1js.Sequence {
  return new asn1js.Sequence({
    value: [
      new asn1js.Constructed({
        idBlock: { tagClass: 3, tagNumber: 1 },
        value: [new asn1js.Sequence({ value: ocspResponses.map(parseDer) })],
      }),
    ],
  });
}

function splitPem(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

function parseCertificate(pem: string): pkijs.Certificate {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return pkijs.Certificate.fromBER(toArrayBuffer(Buffer.from(body, "base64")));
}

/** Drops repeats and the signing certificate itself; the chain endpoints overlap. */
function dedupeCertificates(certs: pkijs.Certificate[], signing: pkijs.Certificate): pkijs.Certificate[] {
  const seen = new Set([derHex(signing)]);
  return certs.filter((c) => {
    const key = derHex(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function derHex(cert: pkijs.Certificate): string {
  return Buffer.from(cert.toSchema().toBER(false)).toString("hex");
}

function parseDer(der: Buffer): asn1js.AsnType {
  const parsed = asn1js.fromBER(toArrayBuffer(der));
  if (parsed.offset === -1) throw new Error("Malformed DER from the signing service");
  return parsed.result;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
