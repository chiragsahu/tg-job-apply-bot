import { InlineKeyboard } from "grammy";
import type { BotContext, MyConversation } from "../types.js";
import { encrypt } from "../services/crypto.js";
import type { UserSmtp } from "../models/User.js";
import { getSmtp, updateSmtp, updateSmtpField } from "../services/user.js";
import { escapeMarkdown } from "../services/format.js";
import { verifySmtp } from "../services/mailer.js";
import nodemailer from "nodemailer";
import { handleBack, HOME_KEYBOARD } from "../nav.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PORT_OPTIONS = [
  "587 (Recommended — Gmail/Outlook STARTTLS)",
  "465 (SSL)",
  "25 (Legacy)",
];

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
  ctx: BotContext,
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // ------- Show existing SMTP config and allow edit before wizard -------
  const savedSmtp = await conversation.external(() => getSmtp(telegramId));
  if (savedSmtp) {
    const list =
      `📧 *Current SMTP configuration*\n` +
      `1️⃣ Host: \`${savedSmtp.host}\`\n` +
      `2️⃣ Port: \`${savedSmtp.port}\`\n` +
      `3️⃣ Email: \`${savedSmtp.user}\`\n` +
      `4️⃣ From name: \`${savedSmtp.senderName ?? "—"}\`\n\n` +
      `Reply with "N. newValue" to edit a field (e.g. "2. 465"), send /continue to run the full setup wizard, or /cancel to exit.`;

    const keyboard = new InlineKeyboard()
      .text("🔌 Test Connection", "test_smtp")
      .row()
      .text("⚙️ Run Full Setup", "continue_setup")
      .text("❌ Cancel", "cancel_setup");

    await ctx.reply(list, { parse_mode: "Markdown", reply_markup: keyboard });

    while (true) {
      const updateCtx = await conversation.waitFor([
        "message:text",
        "callback_query:data",
      ]);

      if (updateCtx.callbackQuery) {
        await updateCtx.answerCallbackQuery();
        const action = updateCtx.callbackQuery.data;

        if (action === "cancel_setup") {
          await ctx.reply("❌ Setup cancelled.");
          return;
        }

        if (action === "continue_setup") {
          break;
        }

        if (action === "test_smtp") {
          await ctx.reply("🔌 Testing your SMTP connection...");
          try {
            const currentSmtp =
              (await conversation.external(() => getSmtp(telegramId))) ??
              savedSmtp;
            await conversation.external(() => verifySmtp(currentSmtp));
            await ctx.reply(
              `✅ *SMTP connection verified successfully!*\n\n` +
                `📤 From: \`${currentSmtp.user}\`\n` +
                `🌐 Host: \`${currentSmtp.host}:${currentSmtp.port}\``,
              { parse_mode: "Markdown" },
            );
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Unknown error";
            await ctx.reply(
              `❌ *SMTP connection failed*\n\n\`${message}\`\n\n` +
                `Please check your credentials or edit fields by replying with "N. newValue".`,
              { parse_mode: "Markdown" },
            );
          }
          continue;
        }
      }

      const editText = updateCtx.message?.text?.trim() ?? "";

      if (editText === "/cancel") {
        await ctx.reply("❌ Setup cancelled.", { reply_markup: HOME_KEYBOARD });
        return;
      }

      if (await handleBack(editText, ctx)) return;

      if (editText === "/continue") {
        break;
      }

      const match = editText.match(/^\s*(\d+)\s*[.:\-]?\s*(.+)$/);
      if (match) {
        const fieldNum = parseInt(match[1]!, 10);
        const newVal = match[2]!.trim();

        if (!newVal) {
          await ctx.reply(
            "⚠️ Please provide a new value for the field (e.g. \"2. 465\"), send /continue for full wizard, or /cancel to exit:",
          );
          continue;
        }

        const fieldMap: Record<number, keyof UserSmtp> = {
          1: "host",
          2: "port",
          3: "user",
          4: "senderName",
        };
        const field = fieldMap[fieldNum];

        if (!field) {
          await ctx.reply(
            "⚠️ Unknown field number (choose 1-4). Please try again, send /continue for full wizard, or /cancel to exit:",
          );
          continue;
        }

        const testKb = new InlineKeyboard().text(
          "🔌 Test Connection",
          "test_smtp",
        );

        if (field === "port") {
          const portVal = parseInt(newVal, 10);
          if (isNaN(portVal) || portVal <= 0 || portVal > 65535) {
            await ctx.reply(
              "⚠️ Invalid port number. Please enter a valid port (e.g. \"2. 587\"): ",
            );
            continue;
          }
          await conversation.external(() =>
            updateSmtpField(telegramId, field, portVal),
          );
          await ctx.reply(`✅ Updated ${field} successfully.`, {
            reply_markup: testKb,
          });
          return;
        }

        if (field === "user") {
          if (!EMAIL_REGEX.test(newVal)) {
            await ctx.reply(
              "⚠️ That doesn't look like a valid email address. Please try again (e.g. \"3. name@example.com\"): ",
            );
            continue;
          }
          await conversation.external(() =>
            updateSmtpField(telegramId, field, newVal),
          );
          await ctx.reply(`✅ Updated ${field} successfully.`, {
            reply_markup: testKb,
          });
          return;
        }

        const value = field === "host" ? newVal.toLowerCase() : newVal;
        await conversation.external(() =>
          updateSmtpField(telegramId, field, value),
        );
        await ctx.reply(`✅ Updated ${field} successfully.`, {
          reply_markup: testKb,
        });
        return;
      }

      await ctx.reply(
        "⚠️ Unrecognized edit format. Reply with \"N. newValue\" (e.g. \"2. 465\"), send /continue to run the full setup wizard, or /cancel to exit.",
      );
    }
  }

  // Continue with the original wizard steps
  await ctx.reply(
    "⚙️ *SMTP Setup Wizard*\n\n" +
      "This will configure your personal email so applications are sent *from your own address*.\n\n" +
      "You can cancel at any time by sending /cancel.\n\n" +
      "*Step 1/5* — What is your SMTP host?\n" +
      "Examples: `smtp.gmail.com` · `smtp.office365.com` · `mail.zoho.com`",
    { parse_mode: "Markdown" },
  );

  // Step 1: SMTP Host
  const hostCtx = await conversation.waitFor("message:text");
  const host = hostCtx.message.text.trim().toLowerCase();
  if (host === "/cancel") {
    await ctx.reply("❌ Setup cancelled.", { reply_markup: HOME_KEYBOARD });
    return;
  }
  if (await handleBack(host, ctx)) return;

  // Step 2: SMTP Port — InlineKeyboard
  const portKeyboard = new InlineKeyboard()
    .text("587 — STARTTLS ✅ Recommended", "port:587")
    .row()
    .text("465 — SSL", "port:465")
    .text("25 — Legacy", "port:25")
    .row()
    .text("✏️ Enter custom port", "port:custom");

  await ctx.reply(
    "*Step 2/5* — Which SMTP port?",
    { parse_mode: "Markdown", reply_markup: portKeyboard },
  );

  let port: number = 587;
  while (true) {
    const portCtx = await conversation.waitFor([
      "message:text",
      "callback_query:data",
    ]);

    if (portCtx.callbackQuery) {
      await portCtx.answerCallbackQuery();
      const data = portCtx.callbackQuery.data;

      if (data === "port:custom") {
        await ctx.reply(
          "✏️ Enter your custom port number (e.g. `2525`):",
          { parse_mode: "Markdown" },
        );
        continue;
      }

      if (data?.startsWith("port:")) {
        const val = parseInt(data.slice(5), 10);
        if (!isNaN(val) && val > 0) {
          port = val;
          break;
        }
      }
      continue;
    }

    const portInput = portCtx.message?.text?.trim() ?? "";
    if (portInput === "/cancel") {
      await ctx.reply("❌ Setup cancelled.", { reply_markup: HOME_KEYBOARD });
      return;
    }
    if (await handleBack(portInput, ctx)) return;

    const portNum = parseInt(portInput, 10);
    if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
      port = portNum;
      break;
    }
    await ctx.reply("⚠️ Invalid port. Please enter a number between 1–65535:");
  }

  // Step 3: Email address
  await ctx.reply(
    `*Step 3/5* — Enter your email address:\n_(This will be the From address on sent emails)_`,
    { parse_mode: "Markdown" },
  );

  let emailAddress = "";
  while (!EMAIL_REGEX.test(emailAddress)) {
    const emailCtx = await conversation.waitFor("message:text");
    const input = emailCtx.message.text.trim();
    if (input === "/cancel") {
      await ctx.reply("❌ Setup cancelled.", { reply_markup: HOME_KEYBOARD });
      return;
    }
    if (await handleBack(input, ctx)) return;
    if (!EMAIL_REGEX.test(input)) {
      await ctx.reply(
        "⚠️ That doesn't look like a valid email address. Please try again:",
      );
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
    { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
  );

  const passCtx = await conversation.waitFor("message:text");
  const rawPassword = passCtx.message.text.trim();
  if (rawPassword === "/cancel") {
    await ctx.reply("❌ Setup cancelled.", { reply_markup: HOME_KEYBOARD });
    return;
  }
  if (await handleBack(rawPassword, ctx)) return;

  // Clean password: strip all spaces (Google App Passwords are 16 letters often pasted with spaces like "abcd efgh ijkl mnop")
  const cleanPassword = rawPassword.replace(/\s+/g, "");

  // Encrypt immediately — never kept in plaintext after this point
  const encryptedPass = await conversation.external(() =>
    encrypt(cleanPassword),
  );

  // Step 5: Display name
  await ctx.reply(
    "*Step 5/5* — What name should appear in the From field?\n" +
      "Example: `Jane Doe` · Leave blank to use your email address.",
    { parse_mode: "Markdown" },
  );

  const nameCtx = await conversation.waitFor("message:text");
  const rawName = nameCtx.message.text.trim();
  if (rawName === "/cancel") {
    await ctx.reply("❌ Setup cancelled.", { reply_markup: HOME_KEYBOARD });
    return;
  }
  if (await handleBack(rawName, ctx)) return;
  const senderName = rawName || emailAddress;

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

    const safeSenderName = escapeMarkdown(senderName);
    await ctx.reply(
      `✅ *SMTP configured successfully!*\n\n` +
        `📤 From: *${safeSenderName}* \`<${emailAddress}>\`\n` +
        `🌐 Host: \`${host}:${port}\`\n\n` +
        `You're ready to send applications. Use /mail or /apply to get started!`,
      { parse_mode: "Markdown", reply_markup: HOME_KEYBOARD },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await ctx.reply(
      `❌ *SMTP connection failed*\n\n\`${message}\`\n\n` +
        "Please check your email and App Password, then run /setup again.",
      { parse_mode: "Markdown", reply_markup: HOME_KEYBOARD },
    );
  }
}
