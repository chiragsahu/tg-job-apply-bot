import type { BotContext, MyConversation } from "../types.js";
import { encrypt } from "../services/crypto.js";
import { updateSmtp } from "../services/user.js";
import nodemailer from "nodemailer";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PORT_OPTIONS = ["587 (Recommended — Gmail/Outlook STARTTLS)", "465 (SSL)", "25 (Legacy)"];

function extractPort(choice: string): number {
  const match = /^\d+/.exec(choice);
  return match ? parseInt(match[0], 10) : 587;
}

/**
 * Conversation: SMTP Setup Wizard
 *
 * Walks the user through configuring their personal email account for sending.
 * SMTP password is encrypted with AES-256-GCM immediately after capture.
 * The plaintext password is never stored anywhere.
 *
 * Register as: bot.use(createConversation(setupFlow, "setupFlow"))
 */
export async function setupFlow(
  conversation: MyConversation,
  ctx: BotContext
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  await ctx.reply(
    "⚙️ *SMTP Setup Wizard*\n\n" +
      "This will configure your personal email so applications are sent *from your own address*.\n\n" +
      "You can cancel at any time by sending /cancel.\n\n" +
      "*Step 1/5* — What is your SMTP host?\n" +
      "Examples: `smtp.gmail.com` · `smtp.office365.com` · `mail.zoho.com`",
    { parse_mode: "Markdown" }
  );

  // Step 1: SMTP Host
  const hostCtx = await conversation.waitFor("message:text");
  const host = hostCtx.message.text.trim().toLowerCase();
  if (host === "/cancel") { await ctx.reply("❌ Setup cancelled."); return; }

  // Step 2: SMTP Port
  await ctx.reply(
    "*Step 2/5* — Which SMTP port?\n\n" +
      PORT_OPTIONS.map((p, i) => `${i + 1}. ${p}`).join("\n") +
      "\n\nReply with the number (1, 2, or 3) or type a custom port.",
    { parse_mode: "Markdown" }
  );

  const portCtx = await conversation.waitFor("message:text");
  const portInput = portCtx.message.text.trim();
  if (portInput === "/cancel") { await ctx.reply("❌ Setup cancelled."); return; }

  let port: number;
  const portNum = parseInt(portInput, 10);
  if (portNum >= 1 && portNum <= 3) {
    port = extractPort(PORT_OPTIONS[portNum - 1] ?? "587");
  } else if (!isNaN(portNum) && portNum > 0) {
    port = portNum;
  } else {
    port = 587;
  }

  // Step 3: Email address
  await ctx.reply(
    `*Step 3/5* — Enter your email address:\n_(This will be the From address on sent emails)_`,
    { parse_mode: "Markdown" }
  );

  let emailAddress = "";
  while (!EMAIL_REGEX.test(emailAddress)) {
    const emailCtx = await conversation.waitFor("message:text");
    const input = emailCtx.message.text.trim();
    if (input === "/cancel") { await ctx.reply("❌ Setup cancelled."); return; }
    if (!EMAIL_REGEX.test(input)) {
      await ctx.reply("⚠️ That doesn't look like a valid email address. Please try again:");
    } else {
      emailAddress = input;
    }
  }

  // Step 4: App Password (never echoed)
  await ctx.reply(
    "*Step 4/5* — Enter your email App Password:\n\n" +
      "⚠️ Use an *App Password*, not your regular account password.\n" +
      "For Gmail: [generate here](https://myaccount.google.com/apppasswords) (requires 2FA)\n\n" +
      "_Your password is encrypted with AES-256 and never stored in plaintext._",
    { parse_mode: "Markdown", link_preview_options: { is_disabled: true } }
  );

  const passCtx = await conversation.waitFor("message:text");
  const rawPassword = passCtx.message.text.trim();
  if (rawPassword === "/cancel") { await ctx.reply("❌ Setup cancelled."); return; }

  // Clean password: strip all spaces (Google App Passwords are 16 letters often pasted with spaces like "abcd efgh ijkl mnop")
  const cleanPassword = rawPassword.replace(/\s+/g, "");

  // Encrypt immediately — never kept in plaintext after this point
  const encryptedPass = await conversation.external(() => encrypt(cleanPassword));

  // Step 5: Display name
  await ctx.reply(
    "*Step 5/5* — What name should appear in the From field?\n" +
      "Example: `Jane Doe` · Leave blank to use your email address.",
    { parse_mode: "Markdown" }
  );

  const nameCtx = await conversation.waitFor("message:text");
  const senderName = nameCtx.message.text.trim() || emailAddress;
  if (senderName === "/cancel") { await ctx.reply("❌ Setup cancelled."); return; }

  // Test the connection
  await ctx.reply("🔌 Testing your SMTP connection...");

  try {
    await conversation.external(async () => {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user: emailAddress, pass: cleanPassword },
      });
      await transporter.verify();

      // Save to MongoDB
      await updateSmtp(telegramId, {
        host,
        port,
        user: emailAddress,
        encryptedPass,
        senderName,
      });
    });

    await ctx.reply(
      `✅ *SMTP configured successfully!*\n\n` +
        `📤 From: *${senderName}* \`<${emailAddress}>\`\n` +
        `🌐 Host: \`${host}:${port}\`\n\n` +
        `You're ready to send applications. Use /mail or /apply to get started!`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await ctx.reply(
      `❌ *SMTP connection failed*\n\n\`${message}\`\n\n` +
        "Please check your email and App Password, then run /setup again.",
      { parse_mode: "Markdown" }
    );
  }
}

