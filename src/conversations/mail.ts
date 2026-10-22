import { InlineKeyboard } from "grammy";
import type { BotContext, MyConversation } from "../types.js";
import { getUser, getRoles, getCandidateProfile } from "../services/user.js";
import { tailorApplication } from "../services/ai.js";
import { sendApplicationEmail } from "../services/mailer.js";
import type { UserResume, UserRole } from "../models/User.js";
import { escapeMarkdown, htmlToTelegramMarkdown } from "../services/format.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmails(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => EMAIL_REGEX.test(e));
}

/**
 * Conversation: /mail Flow
 *
 * 1. Collect & validate comma-separated recipient emails
 * 2. Select Role from inline keyboard (1:1 with attached resume)
 * 3. Collect Job Description (or /skip)
 * 4. Generate AI-tailored application with candidate profile & role resume
 * 5. Preview & confirm
 * 6. Batch send via user's SMTP with selected role's resume PDF
 */
export async function mailFlow(
  conversation: MyConversation,
  ctx: BotContext,
): Promise<void> {
  const telegramId = ctx.from?.id;
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];

  if (!telegramId || !botToken) return;

  // ── Step 1: Guard checks ──────────────────────────────────────────────────
  const user = await conversation.external(() => getUser(telegramId));
  if (!user?.smtp) {
    await ctx.reply(
      "⚠️ You haven't configured your email yet.\n\n" +
        "Run /setup to connect your SMTP account first.",
    );
    return;
  }

  // ── Step 2: Extract or prompt for recipient emails ─────────────────────────
  let recipientEmails: string[] = [];

  // Check if emails were passed directly in the initial command (e.g. /mail a@b.com, c@d.com)
  const initialText = ctx.message?.text ?? "";
  const matchAfterCommand = initialText.replace(/^\/mail(@\w+)?/i, "").trim();

  if (matchAfterCommand) {
    recipientEmails = Array.from(new Set(parseEmails(matchAfterCommand)));
  }

  while (recipientEmails.length === 0) {
    await ctx.reply(
      "📧 *Enter Recipient Emails*\n\n" +
        "Please provide one or more recruiter/HR email addresses, separated by commas:\n\n" +
        "_e.g. hr@company.com, recruiter@startup.io_\n\n" +
        "Send /cancel to abort.",
      { parse_mode: "Markdown" },
    );

    const emailCtx = await conversation.waitFor("message:text");
    const input = emailCtx.message.text.trim();

    if (input === "/cancel") {
      await ctx.reply("❌ Cancelled.");
      return;
    }

    const parsed = parseEmails(input);
    recipientEmails = Array.from(new Set(parsed));

    if (recipientEmails.length === 0) {
      await ctx.reply(
        "⚠️ No valid email addresses found. Please check format and try again:",
      );
    }
  }

  // ── Step 3: Select Role (with 1:1 resume) ──────────────────────────────────
  const roles = await conversation.external(() => getRoles(telegramId));
  const rolesWithResume = roles.filter((r) => !!r.resume);

  // If no role has a resume, check legacy default resume
  if (rolesWithResume.length === 0 && !user.resume) {
    await ctx.reply(
      "📄 *No Resumes Found!*\n\n" +
        "You need to upload a resume and attach it to a role first.\n" +
        "Use /roles to create a role and upload a PDF resume.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const roleKeyboard = new InlineKeyboard();

  rolesWithResume.forEach((r, idx) => {
    roleKeyboard.text(
      `👔 ${r.name} (${r.resume?.fileName ?? "Resume.pdf"})`,
      `mail_role:${r.id}`,
    );
    if ((idx + 1) % 1 === 0) roleKeyboard.row();
  });

  // If legacy default resume exists, show it as an option
  if (user.resume) {
    roleKeyboard
      .text(`📄 Default Resume (${user.resume.fileName})`, "mail_role:default")
      .row();
  }

  roleKeyboard.text("❌ Cancel", "mail_cancel");

  const emailListDisplay = recipientEmails.map((e) => `\`${e}\``).join(", ");
  await ctx.reply(
    `🎯 *Select Role for Application*\n\n` +
      `Recipients: *${recipientEmails.length}* (${emailListDisplay})\n\n` +
      `Which role would you like to apply for? The corresponding resume will be attached:`,
    { parse_mode: "Markdown", reply_markup: roleKeyboard },
  );

  const roleCallback = await conversation.waitFor("callback_query:data");
  const roleData = roleCallback.callbackQuery.data;
  await roleCallback.answerCallbackQuery();

  if (roleData === "mail_cancel") {
    await ctx.reply("❌ Application cancelled.");
    return;
  }

  let selectedRoleName = "General Application";
  let selectedResume: UserResume | undefined;
  let selectedRole: UserRole | undefined;

  if (roleData === "mail_role:default") {
    selectedRoleName = "Default Profile";
    selectedResume = user.resume;
  } else if (roleData.startsWith("mail_role:")) {
    const roleId = roleData.replace("mail_role:", "");
    const found = rolesWithResume.find((r) => r.id === roleId);
    if (found && found.resume) {
      selectedRoleName = found.name;
      selectedResume = found.resume;
      selectedRole = found;
    }
  }

  if (!selectedResume) {
    await ctx.reply(
      "❌ Could not load resume for the selected role. Please try again.",
    );
    return;
  }

  // ── Step 4: Job Description ───────────────────────────────────────────────
  const safeRoleName = escapeMarkdown(selectedRoleName);
  await ctx.reply(
    `📋 *Job Description for ${safeRoleName}*\n\n` +
      "Paste the job posting, description, or requirements below.\n\n" +
      "_Tip: Send /skip to generate a tailored pitch using your role and profile data, or /cancel to abort._",
    { parse_mode: "Markdown" },
  );

  const jdCtx = await conversation.waitFor("message:text");
  const jdInput = jdCtx.message.text.trim();

  if (jdInput === "/cancel") {
    await ctx.reply("❌ Application cancelled.");
    return;
  }

  const jobDesc = jdInput === "/skip" ? "" : jdInput;

  // ── Step 5: AI Generation ─────────────────────────────────────────────────
  const thinkingMsg = await ctx.reply(
    `🤖 *Tailoring Application for ${safeRoleName}...*\n\n` +
      "Synthesizing your resume, candidate profile, and requirements...",
    { parse_mode: "Markdown" },
  );

  const candidateProfile = await conversation.external(() =>
    getCandidateProfile(telegramId),
  );

  let application: { subject: string; body: string };
  try {
    application = await conversation.external(() =>
      tailorApplication(
        selectedResume.text,
        jobDesc,
        user.templates.default ?? "",
        candidateProfile,
        selectedRole,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await ctx.reply(
      `❌ AI generation failed: ${msg}\n\nPlease try /mail again.`,
    );
    return;
  }

  await ctx.api
    .deleteMessage(ctx.chat!.id, thinkingMsg.message_id)
    .catch(() => {});

  // ── Step 6: Application Preview ───────────────────────────────────────────
  const strippedBody = htmlToTelegramMarkdown(application.body);

  let roleDetailsText = "";
  if (selectedRole?.relevantExperience || selectedRole?.expectedCtc) {
    const expText = escapeMarkdown(selectedRole.relevantExperience || "—");
    const ctcText = escapeMarkdown(selectedRole.expectedCtc || "—");
    roleDetailsText = `🎯 *Role Screening:* Exp: ${expText} | Exp CTC: ${ctcText}\n`;
  }

  const fromName = escapeMarkdown(user.smtp.senderName ?? user.smtp.user);
  const safeSubject = escapeMarkdown(application.subject);

  const preview =
    `📬 *Bulk Application Preview*\n\n` +
    `📤 *From:* ${fromName} \`<${user.smtp.user}>\`\n` +
    `📧 *To (${recipientEmails.length}):* \`${recipientEmails.join(", ")}\`\n` +
    `👔 *Role:* ${safeRoleName}\n` +
    roleDetailsText +
    `📎 *Attachment:* \`${selectedResume.fileName}\`\n` +
    `📌 *Subject:* ${safeSubject}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    strippedBody +
    `\n━━━━━━━━━━━━━━━━━━━━━━`;

  const confirmKeyboard = new InlineKeyboard()
    .text(
      `🚀 Send to ${recipientEmails.length} Recipient${recipientEmails.length > 1 ? "s" : ""}`,
      "mail_confirm_send",
    )
    .row()
    .text("❌ Cancel", "mail_cancel");

  await ctx.reply(preview, {
    parse_mode: "Markdown",
    reply_markup: confirmKeyboard,
  });

  // ── Step 7: Confirmation & Batch Send ─────────────────────────────────────
  const confirmCb = await conversation.waitFor("callback_query:data");
  const action = confirmCb.callbackQuery.data;
  await confirmCb.answerCallbackQuery();

  if (action !== "mail_confirm_send") {
    await ctx.reply("❌ Application cancelled. No emails were sent.");
    return;
  }

  const sendingMsg = await ctx.reply(
    `📨 Sending applications to *${recipientEmails.length}* recipient(s)...`,
    { parse_mode: "Markdown" },
  );

  const successes: string[] = [];
  const failures: { email: string; error: string }[] = [];

  for (const email of recipientEmails) {
    try {
      await conversation.external(() =>
        sendApplicationEmail({
          to: email,
          subject: application.subject,
          htmlBody: application.body,
          userSmtp: user.smtp!,
          resumeFileId: selectedResume.fileId,
          resumeFileName: selectedResume.fileName,
          botToken,
        }),
      );
      successes.push(email);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      failures.push({ email, error: msg });
    }
  }

  await ctx.api
    .deleteMessage(ctx.chat!.id, sendingMsg.message_id)
    .catch(() => {});

  let summary = `📊 *Application Dispatch Summary*\n\n`;
  summary += `👔 *Role Applied:* ${safeRoleName}\n`;
  summary += `📎 *Attached Resume:* \`${selectedResume.fileName}\`\n`;
  summary += `✅ *Sent:* ${successes.length}/${recipientEmails.length}\n`;

  if (successes.length > 0) {
    summary +=
      `\n*Delivered to:*\n` + successes.map((e) => `• \`${e}\``).join("\n");
  }

  if (failures.length > 0) {
    summary +=
      `\n\n*Failed:*\n` +
      failures.map((f) => `• \`${f.email}\`: \`${f.error}\``).join("\n");
  }

  await ctx.reply(summary, { parse_mode: "Markdown" });
}
