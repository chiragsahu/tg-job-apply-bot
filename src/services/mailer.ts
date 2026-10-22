import nodemailer from "nodemailer";
import type { UserSmtp } from "../models/User.js";
import { decrypt } from "./crypto.js";
import { downloadTelegramFile } from "./pdf.js";

export interface MailParams {
  to: string;
  subject: string;
  htmlBody: string;         // AI-generated HTML body
  userSmtp: UserSmtp;       // Loaded from MongoDB, password encrypted
  resumeFileId: string;     // Telegram permanent file_id
  resumeFileName: string;
  botToken: string;
}

export interface MailResult {
  messageId: string;
  accepted: string[];
}

/**
 * Wraps the AI-generated HTML body in a minimal, inbox-safe email template.
 * Uses inline styles only (required for email client compatibility).
 */
function wrapHtml(body: string, senderName: string): string {
  // Ensure strong/bold tags stand out in prominent black formatting (#000000)
  const styledBody = body.replace(
    /<(strong|b)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/gi,
    '<strong style="color:#000000;font-weight:700;">$2</strong>'
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body, p, li { color: #1f2937; }
    strong, b { color: #000000 !important; font-weight: 700 !important; }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);overflow:hidden;">
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 28px;color:#1f2937;font-size:15px;line-height:1.7;">
              ${styledBody}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 40px 24px;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
                Sent via <strong>Resume Bot</strong> · This email was composed and sent by ${senderName}
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

/**
 * Strips HTML tags to produce a plain-text fallback for email clients
 * that cannot render HTML.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Sends a job application email using the user's own SMTP credentials.
 *
 * Flow:
 * 1. Decrypt SMTP password (never stored in plaintext)
 * 2. Build Nodemailer transporter from user config
 * 3. Verify SMTP connection before attempting send
 * 4. Download fresh PDF buffer from Telegram CDN
 * 5. Send HTML + plain text email with PDF attachment
 */
export async function sendApplicationEmail(
  params: MailParams
): Promise<MailResult> {
  const { to, subject, htmlBody, userSmtp, resumeFileId, resumeFileName, botToken } = params;

  // 1. Decrypt password at call time — never stored decrypted
  const smtpPass = decrypt(userSmtp.encryptedPass);

  // 2. Build transporter using user's personal SMTP config
  const transporter = nodemailer.createTransport({
    host: userSmtp.host,
    port: userSmtp.port,
    secure: userSmtp.port === 465, // true for 465 (SSL), false for 587 (STARTTLS)
    auth: {
      user: userSmtp.user,
      pass: smtpPass,
    },
  });

  // 3. Verify SMTP connection — surface config errors early
  await transporter.verify();

  // 4. Fetch fresh PDF buffer (download URL expires, so always resolve at send time)
  const pdfBuffer = await downloadTelegramFile(resumeFileId, botToken);

  const senderName = userSmtp.senderName ?? userSmtp.user;

  // 5. Send the email
  const info = await transporter.sendMail({
    from: `"${senderName}" <${userSmtp.user}>`,
    to,
    subject,
    html: wrapHtml(htmlBody, senderName),
    text: htmlToPlainText(htmlBody),
    attachments: [
      {
        filename: resumeFileName,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });

  return {
    messageId: info.messageId as string,
    accepted: info.accepted as string[],
  };
}
