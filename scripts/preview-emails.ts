/**
 * Renders every Smart Sign email to `out/emails/` with sample data, so the templates can be
 * reviewed in a browser without an SMTP server or a real envelope.
 *
 *   npm run preview:emails
 *
 * Open the generated .html files, and forward one to a real inbox before trusting how it
 * looks in Outlook — desktop Outlook renders HTML with Word, not a browser engine.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The config module validates the whole environment on import; these only need to be present.
process.env.CONVERTAPI_SECRET ||= "preview";
process.env.FRONTEND_URL ||= "http://localhost:3001";
process.env.PUBLIC_API_URL ||= "http://localhost:4600";
process.env.SF_CLIENT_ID ||= "unused";
process.env.SF_CLIENT_SECRET ||= "unused";
process.env.SF_SERVER_CALLBACK_URI ||= "http://localhost:4600/sf/auth/callback";
process.env.SF_REDIRECT_URI ||= "http://localhost:3001/oauth/callback";
process.env.JWT_SECRET ||= "0123456789abcdef";

const OUT_DIR = join(process.cwd(), "out", "emails");

async function main() {
  const {
    buildSignatureInvites,
    buildReminders,
    buildCompletionNotices,
    buildDeclineNotices,
  } = await import("../src/modules/sign-requests/sign-request.emails");
  const type = await import("../src/modules/sign-requests/sign-request.types");

  const now = new Date();

  const signer = (
    slot: number,
    name: string,
    email: string,
    status: "pending" | "signed" | "declined"
  ) => ({
    id: `65f000000000000000000${slot}`,
    role: `signer${slot}` as (typeof type)["SIGNER_COLORS"] extends unknown
      ? `signer${number}`
      : never,
    name,
    email,
    token: `sample-token-${slot}`,
    status,
    declineReason: null,
    viewedAt: null,
    signedAt: status === "signed" ? now : null,
    declinedAt: null,
    remindedAt: null,
  });

  const request = {
    id: "65f0aa11bb22cc33dd44ee55",
    status: "in_progress" as const,
    fileName: "Master Service Agreement.docx",
    fileId: "f1",
    pdfFileId: "f2",
    signedPdfFileId: null,
    pageCount: 14,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    signers: [
      signer(1, "Ananya Sharma", "ananya.sharma@example.com", "signed"),
      signer(2, "Rohan Mehta", "rohan.mehta@example.com", "pending"),
      signer(3, "Sanjay Verma", "s.verma@example.com", "pending"),
    ],
    signatureFields: [1, 1, 2, 3].map((slot, index) => ({
      id: `signer${slot}_${index}`,
      role: `signer${slot}` as `signer${number}`,
      tag: `{%signer${slot}}`,
      source: "manual" as const,
      index,
      page: 1,
      rect: { x: 0.1, y: 0.5, width: 0.25, height: 0.08 },
      value: null,
    })),
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const decliner = request.signers[1];

  const files: { name: string; html: string; subject: string }[] = [
    ...buildSignatureInvites(request).slice(0, 1).map((message) => ({
      name: "1-invitation.html",
      html: message.html,
      subject: message.subject,
    })),
    // Reminder for the signer who has not opened it yet, three days in.
    ...buildReminders(
      request,
      [request.signers[1]],
      new Date(now.getTime() + 3 * 86_400_000)
    ).map((message) => ({
      name: "2-reminder.html",
      html: message.html,
      subject: message.subject,
    })),
    ...buildCompletionNotices(request).slice(0, 1).map((message) => ({
      name: "3-completed.html",
      html: message.html,
      subject: message.subject,
    })),
    ...buildDeclineNotices(request, decliner, "The payment terms in section 4 need revising before I can sign.")
      .slice(0, 1)
      .map((message) => ({
        name: "4-declined.html",
        html: message.html,
        subject: message.subject,
      })),
  ];

  await mkdir(OUT_DIR, { recursive: true });

  for (const file of files) {
    await writeFile(join(OUT_DIR, file.name), file.html, "utf8");
    console.log(`${file.name.padEnd(20)} ${file.subject}`);
  }

  console.log(`\nWrote ${files.length} files to ${OUT_DIR}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
