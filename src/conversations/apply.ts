import { InlineKeyboard } from "grammy";
import type { BotContext, MyConversation } from "../types.js";
import {
  getUser,
  updateResume,
  getCandidateProfile,
} from "../services/user.js";
import {
  downloadTelegramFile,
  extractResumeText,
  validateResumeDocument,
} from "../services/pdf.js";
import { tailorApplication } from "../services/ai.js";
import { sendApplicationEmail } from "../services/mailer.js";
import { escapeMarkdown } from "../services/format.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Conversation: Apply Flow (main job application flow)
 *
 * Steps:
 * 1. Guard: verify resume + SMTP are configured
 * 2. (Optional) new PDF upload
 * 3. Collect job description
 * 4. Collect recipient email
 * 5. Generate & preview AI-tailored application
 * 6. Confirm (send) or cancel
 *
 * Register as: bot.use(createConversation(applyFlow, "applyFlow"))
 */
export async function applyFlow(
  conversation: MyConversation,
  ctx: BotContext,
): Promise<void> {
  const telegramId = ctx.from?.id;
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];

  if (!telegramId || !botToken) return;

  // ── Step 1: Guard checks ────────────────────────────────────────────────
  const user = await conversation.external(() => getUser(telegramId));

  if (!user?.smtp) {
    await ctx.reply(
      "⚠️ You haven't configured your email yet.\n\n" +
        "Run /setup to connect your SMTP account first.",
    );
    return;
  }

  if (!user.resume) {
    await ctx.reply(
      "📄 No resume found.\n\n" +
        "Please upload your resume PDF now, or use /resume to manage it.",
    );

    // Wait for PDF upload
    const docCtx = await conversation.waitFor("message:document");
    const doc = docCtx.message.document;

    const validation = validateResumeDocument(doc);
    if (!validation.valid) {
      await ctx.reply(validation.error!);
      return;
    }

    await ctx.reply("⏳ Parsing your resume...");

    try {
      const buffer = await conversation.external(() =>
        downloadTelegramFile(doc.file_id, botToken),
      );
      const text = await conversation.external(() => extractResumeText(buffer));

      await conversation.external(() =>
        updateResume(telegramId, {
          fileId: doc.file_id,
          fileName: doc.file_name ?? "Resume.pdf",
          text,
          uploadedAt: new Date(),
        }),
      );

      await ctx.reply(`✅ Resume saved: \`${doc.file_name ?? "Resume.pdf"}\``, {
        parse_mode: "Markdown",
      });

      // Reload user with updated resume
      const updated = await conversation.external(() => getUser(telegramId));
      if (!updated?.resume) return;
      Object.assign(user, updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await ctx.reply(`❌ ${msg}`);
      return;
    }
  }

  const resume = user.resume!;

  // ── Step 2: Job Description ─────────────────────────────────────────────
  await ctx.reply(
    "📋 *Step 1 of 3 — Job Description*\n\n" +
      "Paste the job posting, description, or requirements below:",
    { parse_mode: "Markdown" },
  );

  const jdCtx = await conversation.waitFor("message:text");
  const jobDesc = jdCtx.message.text.trim();
  if (jobDesc === "/cancel") {
    await ctx.reply("❌ Cancelled.");
    return;
  }

  // ── Step 3: Recipient Email ─────────────────────────────────────────────
  await ctx.reply(
    "📧 *Step 2 of 3 — Recipient Email*\n\n" +
      "What is the recruiter or HR email address?",
    { parse_mode: "Markdown" },
  );

  let recipientEmail = "";
  while (!EMAIL_REGEX.test(recipientEmail)) {
    const emailCtx = await conversation.waitFor("message:text");
    const input = emailCtx.message.text.trim();
    if (input === "/cancel") {
      await ctx.reply("❌ Cancelled.");
      return;
    }
    if (!EMAIL_REGEX.test(input)) {
      await ctx.reply(
        "⚠️ That doesn't look like a valid email. Please try again:",
      );
    } else {
      recipientEmail = input;
    }
  }

  // ── Step 4: Generate Application ────────────────────────────────────────
  const thinkingMsg = await ctx.reply(
    "🤖 *Step 3 of 3 — Generating your application...*\n\n" +
      "Analysing your resume against the job description...",
    { parse_mode: "Markdown" },
  );

  let application: { subject: string; body: string };
  try {
    const candidateProfile = await conversation.external(() =>
      getCandidateProfile(telegramId),
    );
    application = await conversation.external(() =>
      tailorApplication(
        resume.text,
        jobDesc,
        user.templates.default ?? "",
        candidateProfile,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await ctx.reply(
      `❌ AI generation failed: ${msg}\n\nPlease try /apply again.`,
    );
    return;
  }

  // Delete the "generating..." message
  await ctx.api
    .deleteMessage(ctx.chat!.id, thinkingMsg.message_id)
    .catch(() => {});

  // ── Step 5: Preview ─────────────────────────────────────────────────────
  const fromName = escapeMarkdown(user.smtp.senderName ?? user.smtp.user);
  const safeSubject = escapeMarkdown(application.subject);
  const strippedBody = escapeMarkdown(
    application.body
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .trim()
      .slice(0, 2000),
  );

  const preview =
    `📬 *Application Preview*\n\n` +
    `📤 *From:* ${fromName} \`<${user.smtp.user}>\`\n` +
    `📧 *To:* \`${recipientEmail}\`\n` +
    `📌 *Subject:* ${safeSubject}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    strippedBody +
    `\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📎 *Attachment:* \`${resume.fileName}\``;

  const keyboard = new InlineKeyboard()
    .text("🚀 Send Application", "confirm_send")
    .text("✏️ Regenerate", "regenerate")
    .row()
    .text("❌ Cancel", "cancel_send");

  await ctx.reply(preview, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });

  // ── Step 6: Confirm / Cancel / Regenerate ───────────────────────────────
  const callbackCtx = await conversation.waitFor("callback_query:data");
  const action = callbackCtx.callbackQuery.data;

  await callbackCtx.answerCallbackQuery();

  if (action === "cancel_send") {
    await ctx.reply("❌ Application cancelled. Run /apply to start again.");
    return;
  }

  if (action === "regenerate") {
    await ctx.reply(
      "🔄 Regenerating... please run /apply again to restart the flow.",
    );
    return;
  }

  if (action === "confirm_send") {
    const sendingMsg = await ctx.reply("📨 Sending your application...");

    try {
      const result = await conversation.external(() =>
        sendApplicationEmail({
          to: recipientEmail,
          subject: application.subject,
          htmlBody: application.body,
          userSmtp: user.smtp!,
          resumeFileId: resume.fileId,
          resumeFileName: resume.fileName,
          botToken,
        }),
      );

      await ctx.api
        .deleteMessage(ctx.chat!.id, sendingMsg.message_id)
        .catch(() => {});

      await ctx.reply(
        `✅ *Application sent successfully!*\n\n` +
          `📧 To: \`${recipientEmail}\`\n` +
          `📤 From: \`${user.smtp!.user}\`\n` +
          `📌 Subject: ${safeSubject}\n` +
          `📎 Attached: \`${resume.fileName}\`\n\n` +
          `_Message ID: \`${result.messageId}\`_`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await ctx.reply(
        `❌ *Failed to send email*\n\n\`${msg}\`\n\n` +
          "Check your SMTP settings with /setup and try again.",
        { parse_mode: "Markdown" },
      );
    }
  }
}
