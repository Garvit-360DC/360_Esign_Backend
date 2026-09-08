/**
 * Shared chrome for every Smart Sign email.
 *
 * Written for email clients, not browsers: table layout, inline styles, no flexbox or grid,
 * no external CSS. The console's typefaces are named first and fall back to system stacks,
 * because most clients will not load a web font.
 *
 * Palette is the admin console's, so an invitation looks like the product it comes from.
 */

export const PALETTE = {
  ink: "#16233B",
  paper: "#F5F4EF",
  card: "#FFFFFF",
  verified: "#0E8A6B",
  verifiedSoft: "#E2F2EC",
  verifiedLine: "#BFE3D6",
  pending: "#B7791F",
  refused: "#B3462E",
  refusedSoft: "#F8E7E1",
  rule: "#E5E3DB",
  ruleSoft: "#EFEDE6",
  text: "#20242E",
  muted: "#6E7480",
  faint: "#9AA0AB",
} as const;

const UI_FONT =
  "'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY_FONT =
  "'Bricolage Grotesque','Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO_FONT = "'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type Eyebrow = { text: string; tone: "verified" | "refused" | "pending" };

export type MetaRow = {
  label: string;
  value: string;
  /** Draws a colour chip before the value — used for the signer's slot colour. */
  swatch?: { fill: string; accent: string };
};

const TONE_COLOR: Record<Eyebrow["tone"], string> = {
  verified: PALETTE.verified,
  refused: PALETTE.refused,
  pending: PALETTE.pending,
};

/** Key/value block. A table, because email clients cannot be trusted with anything else. */
export function metaTable(rows: MetaRow[]): string {
  const cells = rows
    .map((row, index) => {
      const border =
        index === rows.length - 1 ? "" : `border-bottom:1px solid ${PALETTE.ruleSoft};`;

      const swatch = row.swatch
        ? `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${row.swatch.fill};border:1px solid ${row.swatch.accent};margin-right:7px;"></span>`
        : "";

      return `<tr>
        <td style="${border}padding:9px 0;font-family:${UI_FONT};font-size:13px;color:${PALETTE.muted};white-space:nowrap;">${escapeHtml(row.label)}</td>
        <td style="${border}padding:9px 0;font-family:${UI_FONT};font-size:13px;color:${PALETTE.text};font-weight:600;text-align:right;">${swatch}${escapeHtml(row.value)}</td>
      </tr>`;
    })
    .join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;border:1px solid ${PALETTE.rule};border-radius:10px;padding:2px 14px;margin:22px 0;">
    ${cells}
  </table>`;
}

/**
 * Table-based button. Outlook renders `border-radius` inconsistently, so the shape
 * degrades to a square block there rather than breaking the layout.
 */
export function button(href: string, label: string, color = PALETTE.verified): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 14px;">
    <tr>
      <td align="center" bgcolor="${color}" style="border-radius:8px;">
        <a href="${href}" style="display:inline-block;padding:13px 26px;font-family:${UI_FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

export function paragraph(html: string): string {
  return `<p style="margin:0 0 12px;font-family:${UI_FONT};font-size:15px;line-height:1.6;color:${PALETTE.text};">${html}</p>`;
}

export function muted(html: string): string {
  return `<p style="margin:0 0 12px;font-family:${UI_FONT};font-size:13px;line-height:1.6;color:${PALETTE.muted};">${html}</p>`;
}

/** The link spelled out, for clients that strip or mangle the button. */
export function fallbackLink(href: string): string {
  return `<p style="margin:0;font-family:${UI_FONT};font-size:11.5px;line-height:1.6;color:${PALETTE.faint};">
    If the button does not work, paste this into your browser:<br />
    <span style="font-family:${MONO_FONT};font-size:11px;color:${PALETTE.muted};word-break:break-all;">${href}</span>
  </p>`;
}

/** A tinted callout — used for a decline reason. */
export function callout(html: string, tone: "refused" | "verified" = "refused"): string {
  const background = tone === "refused" ? PALETTE.refusedSoft : PALETTE.verifiedSoft;
  const color = tone === "refused" ? PALETTE.refused : PALETTE.verified;

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;margin:4px 0 18px;">
    <tr><td style="background:${background};border-radius:8px;padding:12px 14px;font-family:${UI_FONT};font-size:13.5px;line-height:1.6;color:${color};">${html}</td></tr>
  </table>`;
}

export function layout(options: {
  preheader: string;
  eyebrow: Eyebrow;
  heading: string;
  body: string;
  footnote?: string;
}): string {
  const { preheader, eyebrow, heading, body, footnote } = options;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PALETTE.paper};">
  <!-- Inbox preview line; hidden in the message itself. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>

  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;background:${PALETTE.paper};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;background:${PALETTE.card};border:1px solid ${PALETTE.rule};border-radius:14px;overflow:hidden;">

          <tr>
            <td style="background:${PALETTE.ink};padding:18px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:10px;">
                    <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:8px;background:${PALETTE.verified};font-family:${DISPLAY_FONT};font-size:13px;font-weight:700;color:#ffffff;">S</span>
                  </td>
                  <td>
                    <span style="font-family:${DISPLAY_FONT};font-size:17px;font-weight:600;color:#ffffff;letter-spacing:.2px;">Smart Sign</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 8px;font-family:${UI_FONT};font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${TONE_COLOR[eyebrow.tone]};">${escapeHtml(eyebrow.text)}</p>
              <h1 style="margin:0 0 16px;font-family:${DISPLAY_FONT};font-size:22px;line-height:1.3;font-weight:600;color:${PALETTE.ink};">${escapeHtml(heading)}</h1>
              ${body}
            </td>
          </tr>

          <tr>
            <td style="border-top:1px solid ${PALETTE.rule};padding:16px 28px;background:#FBFAF7;">
              <p style="margin:0;font-family:${UI_FONT};font-size:11.5px;line-height:1.6;color:${PALETTE.faint};">
                ${escapeHtml(footnote ?? "This link is personal to you. Do not forward it — anyone holding it can sign in your name.")}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Renders the plain-text alternative from already-plain pieces. */
export function plainText(lines: (string | null | undefined)[]): string {
  return lines.filter((line) => line !== null && line !== undefined).join("\n");
}
