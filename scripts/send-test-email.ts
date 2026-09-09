/**
 * Sends one real message through the configured SMTP server, to prove the credentials work
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
      "Mail is not configured. Set SMTP_HOST and MAIL_FROM in .env — both are required."
    );
    process.exit(1);
  }

  const { layout, paragraph, metaTable, muted } = await import(
    "../src/modules/sign-requests/sign-request.email-layout"
  );

  console.log(`Sending via ${env.SMTP_HOST}:${env.SMTP_PORT} as ${env.MAIL_FROM}`);

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
          { label: "Server", value: `${env.SMTP_HOST}:${env.SMTP_PORT}` },
          { label: "From", value: env.MAIL_FROM ?? "" },
          { label: "To", value: to },
        ]) +
        muted("Nothing was signed and no envelope was created."),
      footnote: "Sent from a development environment.",
    }),
    text: [
      "Email is working",
      "",
      "This message was sent by `npm run mail:test`.",
      `Server: ${env.SMTP_HOST}:${env.SMTP_PORT}`,
      `To:     ${to}`,
    ].join("\n"),
  });

  if (!sent) {
    // sendMail never throws — it logs the SMTP error and reports false — so the reason is
    // already on the console above this line.
    console.error("\nSend failed. The SMTP error is logged above.");
    process.exit(1);
  }

  console.log(`\nSent to ${to}. Check the inbox, and the spam folder if it is not there.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
