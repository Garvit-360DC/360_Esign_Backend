import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { senderOf, signedDocumentName } from "./sign-request.mapper";
import { toWinAnsi } from "./sign-request.stamp";
import { signerLabel, type AuditEntry, type SignRequest } from "./sign-request.types";

/**
 * The certificate of completion: who was asked to sign, what each of them did and when, from
 * which address and browser, and a SHA-256 of the signed PDF so anyone holding a copy can check
 * it is the one that was signed. Built when asked for, from what the envelope already records.
 */

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const INK = rgb(0.09, 0.09, 0.09);
const MUTED = rgb(0.36, 0.36, 0.36);
const RULE = rgb(0.9, 0.9, 0.9);
const BRAND = rgb(0.004, 0.463, 0.827);

const ACTION_LABEL: Record<AuditEntry["action"], string> = {
  viewed: "Opened the document",
  consented: "Agreed to sign electronically",
  signed: "Signed",
  declined: "Declined",
};

function formatUtc(date: Date | null | undefined): string {
  if (!date) return "Not recorded";
  return `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/** A browser string trimmed to something a person can read on one line. */
function shortAgent(agent: string | null): string {
  if (!agent) return "Browser not recorded";
  return agent.length > 90 ? `${agent.slice(0, 87)}...` : agent;
}

class Writer {
  page: PDFPage;
  y: number;

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont
  ) {
    this.page = doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  private ensure(space: number) {
    if (this.y - space < MARGIN) {
      this.page = this.doc.addPage([PAGE.width, PAGE.height]);
      this.y = PAGE.height - MARGIN;
    }
  }

  /** Wraps to the page width; long unbroken strings (hashes) are split by character. */
  text(value: string, options: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number } = {}) {
    const size = options.size ?? 10;
    const font = options.bold ? this.bold : this.regular;
    const indent = options.indent ?? 0;
    const width = PAGE.width - MARGIN * 2 - indent;
    const lines: string[] = [];

    for (const paragraph of toWinAnsi(value).split("\n")) {
      let line = "";
      for (const word of paragraph.split(" ")) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = word;
        while (font.widthOfTextAtSize(line, size) > width) {
          let cut = line.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut -= 1;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      lines.push(line);
    }

    for (const line of lines) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font, color: options.color ?? INK });
      this.y -= size + 4;
    }
  }

  row(label: string, value: string, indent = 0) {
    const size = 9.5;
    this.ensure(size + 4);
    this.page.drawText(toWinAnsi(label), { x: MARGIN + indent, y: this.y - size, size, font: this.regular, color: MUTED });
    const startY = this.y;
    const valueIndent = indent + 150;
    this.y = startY;
    this.text(value, { size, indent: valueIndent });
  }

  gap(points: number) {
    this.y -= points;
  }

  rule() {
    this.ensure(10);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y - 4 },
      end: { x: PAGE.width - MARGIN, y: this.y - 4 },
      thickness: 0.75,
      color: RULE,
    });
    this.y -= 12;
  }
}

export async function buildCertificate(request: SignRequest, signedPdf: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate of completion - ${signedDocumentName(request.fileName)}`);
  doc.setProducer("360 InstantDocs");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, regular, bold);

  const sender = senderOf(request);
  const hash = createHash("sha256").update(signedPdf).digest("hex");

  w.text("360 InstantDocs", { size: 11, bold: true, color: BRAND });
  w.gap(6);
  w.text("Certificate of completion", { size: 20, bold: true });
  w.gap(10);

  w.row("Document", signedDocumentName(request.fileName));
  w.row("Envelope ID", request.id);
  w.row("Pages", String(request.pageCount));
  if (sender.name || sender.email) {
    w.row("Sent by", [sender.name, sender.company && `(${sender.company})`, sender.email && `<${sender.email}>`].filter(Boolean).join(" "));
  }
  w.row("Sent", formatUtc(request.createdAt));
  w.row("Completed", formatUtc(request.completedAt));
  w.row("Signers", String(request.signers.length));
  w.gap(4);
  w.row("Signed PDF SHA-256", hash);
  w.text(
    "To check a copy, compute its SHA-256 hash and compare it with the value above. Any change to the file, however small, gives a different value.",
    { size: 8.5, color: MUTED, indent: 150 }
  );

  for (const signer of request.signers) {
    w.gap(8);
    w.rule();
    w.text(`${signerLabel(signer.role)}: ${signer.name}`, { size: 12, bold: true });
    w.gap(2);
    w.row("Email", signer.email);
    w.row("Status", signer.status === "signed" ? "Signed" : signer.status === "declined" ? "Declined" : "Did not sign");
    w.row("Agreed to sign electronically", formatUtc(signer.consentedAt));
    w.row("Signed", formatUtc(signer.signedAt));
    w.gap(4);

    if (signer.audit.length === 0) {
      w.text("No activity was recorded for this signer.", { size: 9, color: MUTED });
      continue;
    }
    w.text("Activity", { size: 9.5, bold: true });
    for (const entry of signer.audit) {
      w.text(`${formatUtc(entry.at)}  ${ACTION_LABEL[entry.action]}`, { size: 9, indent: 8 });
      w.text(`IP ${entry.ip ?? "not recorded"} · ${shortAgent(entry.userAgent)}`, { size: 8, color: MUTED, indent: 8 });
    }
  }

  w.gap(10);
  w.rule();
  w.text(
    "Each signer was sent a personal link by email and agreed to sign electronically before signing. Times are in UTC. Addresses and browsers are as reported by the signer's connection.",
    { size: 8.5, color: MUTED }
  );

  return Buffer.from(await doc.save());
}
