/**
 * Sends one real message through SendGrid, to prove the API key and sender work
 * without creating an envelope.
 *
 *   npm run mail:test -- you@example.com
 *
 * `preview:emails` renders the same templates to disk but never opens a socket, so it cannot
 * tell a working mailbox from a missing one. This can. It goes through the real `sendMail`
 * and the real layout helpers, so a success here means an invitation would arrive too.
 */

// The config module validates the whole environment on import, and this script has no use
// for the converter or for org authentication.
process.env.CONVERTAPI_SECRET ||= "mail-test";
process.env.SF_CLIENT_ID ||= "unused";
process.env.SF_CLIENT_SECRET ||= "unused";
process.env.SF_SERVER_CALLBACK_URI ||= "http://localhost:4600/sf/auth/callback";
process.env.SF_REDIRECT_URI ||= "http://localhost:3001/oauth/callback";
process.env.JWT_SECRET ||= "0123456789abcdef";

async function main() {
  const to = process.argv[2]?.trim();

  if (!to) {
    console.error("Usage: npm run mail:test -- you@example.com");
    process.exit(1);
  }

  const { isMailEnabled, sendMail } = await import("../src/integrations/mail");
  const { env } = await import("../src/config/env");

  if (!isMailEnabled()) {
    console.error(
      "Mail is not configured. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL in .env — both are required."
    );
    process.exit(1);
  }

  const { layout, paragraph, metaTable, muted } = await import(
    "../src/modules/sign-requests/sign-request.email-layout"
  );

  console.log(`Sending via SendGrid as ${env.SENDGRID_FROM_EMAIL}`);

  const sent = await sendMail({
    to,
    subject: "Smart Sign test message",
    html: layout({
      preheader: "Smart Sign can reach your inbox.",
      eyebrow: { text: "Test message", tone: "verified" },
      heading: "Email is working",
      body:
        paragraph(
          "This message was sent by <strong>npm run mail:test</strong>. If you are reading it, signing invitations, completion notices and decline notices will reach signers too."
        ) +
        metaTable([
          { label: "Provider", value: "SendGrid" },
          { label: "From", value: env.SENDGRID_FROM_EMAIL ?? "" },
          { label: "To", value: to },
        ]) +
        muted("Nothing was signed and no envelope was created."),
      footnote: "Sent from a development environment.",
    }),
    text: [
      "Email is working",
      "",
      "This message was sent by `npm run mail:test`.",
      "Provider: SendGrid",
      `To:       ${to}`,
    ].join("\n"),
  });

  if (!sent) {
    // sendMail never throws — it logs SendGrid's error and reports false — so the reason is
    // already on the console above this line.
    console.error("\nSend failed. SendGrid's error is logged above.");
    process.exit(1);
  }

  console.log(`\nSent to ${to}. Check the inbox, and the spam folder if it is not there.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
