import "dotenv/config";
import { Bot, InlineKeyboard, session } from "grammy";
import {
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import { MongoDBAdapter } from "@grammyjs/storage-mongodb";

import { getDb, closeDb } from "./services/db.js";
import {
  getOrCreateUser,
  getUser,
  updateResume,
  deleteResume,
  deleteSmtp,
  deleteTemplate,
  deleteUser,
  getCandidateProfile,
  getRoles,
  getRole,
  addRole,
  deleteRole,
  attachResumeToRole,
  deleteRoleResume,
} from "./services/user.js";
import {
  downloadTelegramFile,
  extractResumeText,
  validateResumeDocument,
} from "./services/pdf.js";

import { setupFlow } from "./conversations/setup.js";
import { templateFlow } from "./conversations/template.js";
import { applyFlow } from "./conversations/apply.js";
import { profileFlow } from "./conversations/profile.js";
import { mailFlow } from "./conversations/mail.js";
import { addRoleFlow } from "./conversations/role.js";

import type { BotContext, MyContext, SessionData } from "./types.js";

// ── Validate required env vars at startup ──────────────────────────────────
const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
if (!process.env["MONGODB_URI"]) throw new Error("MONGODB_URI is not set in .env");
if (!process.env["ENCRYPTION_KEY"]) throw new Error("ENCRYPTION_KEY is not set in .env");
if (!process.env["OPEN_AI_KEY"]) throw new Error("OPEN_AI_KEY is not set in .env");

// ── Bot initialisation ─────────────────────────────────────────────────────
const bot = new Bot<MyContext>(BOT_TOKEN);

async function main(): Promise<void> {
  // 1. Connect to MongoDB first
  const db = await getDb();

  // 2. Session middleware (must be first)
  bot.use(
    session<SessionData, MyContext>({
      initial: (): SessionData => ({}),
      storage: new MongoDBAdapter<SessionData>({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        collection: db.collection("sessions") as any,
      }),
    })
  );

  // 3. Conversations plugin (must be after session)
  bot.use(conversations<MyContext, BotContext>());
  bot.use(createConversation<MyContext, BotContext>(setupFlow, "setupFlow"));
  bot.use(createConversation<MyContext, BotContext>(templateFlow, "templateFlow"));
  bot.use(createConversation<MyContext, BotContext>(applyFlow, "applyFlow"));
  bot.use(createConversation<MyContext, BotContext>(profileFlow, "profileFlow"));
  bot.use(createConversation<MyContext, BotContext>(mailFlow, "mailFlow"));
  bot.use(createConversation<MyContext, BotContext>(addRoleFlow, "addRoleFlow"));

  // 4. Auto-upsert user on every interaction
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    }
    return next();
  });

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    const user = await getUser(ctx.from!.id);
    const s = (v: boolean) => (v ? "✅" : "❌");
    const roleCount = user?.roles?.length ?? 0;

    await ctx.reply(
      `👋 *Welcome to Resume Bot!*\n\n` +
        `I send tailored job application emails — directly from *your* email address.\n\n` +
        `*Your setup status:*\n` +
        `${s(!!user?.smtp)} Email (SMTP) configured\n` +
        `${s(!!user?.resume || roleCount > 0)} Resume / Roles (${roleCount} roles configured)\n` +
        `${s(!!user?.profile?.officialName)} Candidate screening profile\n` +
        `${s(!!user?.templates.default)} Cover letter template\n\n` +
        `Use /help to see all commands.`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /help ──────────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `📖 *Commands*\n\n` +
        `*📧 Email Setup*\n` +
        `/setup — Configure your SMTP email account\n` +
        `/delete_smtp — Remove your saved email config\n\n` +
        `*🎯 Job Roles & Resumes (1:1)*\n` +
        `/roles — View and manage your job roles\n` +
        `/add_role — Create a new job role (e.g. /add_role Backend Engineer)\n` +
        `_(Upload a PDF at any time to attach to a role)_\n\n` +
        `*👤 Candidate Profile*\n` +
        `/candidate_profile — View screening details (DOB, CTC, Notice Period, etc.)\n` +
        `/edit_profile — Setup or update your screening profile\n\n` +
        `*📝 Templates*\n` +
        `/set_template — Create or update cover letter tone\n` +
        `/view_template — View your full saved template\n` +
        `/delete_template — Remove your saved template\n\n` +
        `*🚀 Apply & Bulk Mail*\n` +
        `/mail — Apply to 1 or more HRs with role selection (/mail hr@co.com, recruiter@co.com)\n` +
        `/apply — Quick single application using default resume\n\n` +
        `*⚙️ Account*\n` +
        `/profile — Overview of all your saved settings\n` +
        `/resume — View default resume info\n` +
        `/reset — Delete all your data (irreversible)\n` +
        `/cancel — Stop the current action`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /profile ───────────────────────────────────────────────────────────────
  bot.command("profile", async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user) {
      await ctx.reply("No profile found. Send any message to get started.");
      return;
    }

    const lines: string[] = ["👤 *Your Account Profile*\n"];

    // SMTP
    if (user.smtp) {
      lines.push(
        `📤 *Email:* \`${user.smtp.user}\`\n` +
          `🌐 *SMTP:* \`${user.smtp.host}:${user.smtp.port}\`\n` +
          `👤 *From name:* ${user.smtp.senderName ?? "—"}`
      );
    } else {
      lines.push("📤 *Email:* ❌ Not configured — /setup");
    }

    lines.push("");

    // Roles
    const roles = user.roles ?? [];
    if (roles.length > 0) {
      const rolesSummary = roles
        .map(
          (r) =>
            `• *${r.name}:* ${r.resume ? `\`${r.resume.fileName}\`` : "⚠️ No resume"}`
        )
        .join("\n");
      lines.push(`🎯 *Roles (${roles.length}):*\n${rolesSummary}\n_/roles to manage_`);
    } else {
      lines.push("🎯 *Roles:* ❌ None created — /add_role or /roles");
    }

    lines.push("");

    // Candidate Profile
    if (user.profile?.officialName || user.profile?.totalExperience) {
      lines.push(
        `👤 *Screening Profile:* ✅ Configured\n` +
          `• Name: ${user.profile.officialName || "—"}\n` +
          `• Exp: ${user.profile.totalExperience || "—"} | Notice: ${user.profile.noticePeriod || "—"}\n` +
          `_/candidate_profile for full details_`
      );
    } else {
      lines.push("👤 *Screening Profile:* ❌ Not setup — /edit_profile");
    }

    lines.push("");

    // Default Resume
    if (user.resume) {
      const uploaded = user.resume.uploadedAt.toLocaleDateString();
      const wordCount = user.resume.text.split(/\s+/).length;
      lines.push(
        `📄 *Default Resume:* \`${user.resume.fileName}\`\n` +
          `🗓 *Uploaded:* ${uploaded} · ~${wordCount} words`
      );
    }

    lines.push("");

    // Template
    if (user.templates.default) {
      const preview = user.templates.default.slice(0, 100);
      lines.push(
        `📝 *Template:* ✅\n_${preview}${user.templates.default.length > 100 ? "…" : ""}_\n` +
          `_/view_template · /set_template_`
      );
    } else {
      lines.push("📝 *Template:* ❌ Not set — /set_template");
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  // ── Candidate Profile Commands ─────────────────────────────────────────────

  bot.command("candidate_profile", async (ctx) => {
    const profile = await getCandidateProfile(ctx.from!.id);
    const keyboard = new InlineKeyboard()
      .text("✏️ Edit Profile", "edit_profile_btn")
      .text("❌ Close", "cancel_delete");

    if (!profile) {
      await ctx.reply(
        "👤 *Candidate Global Profile*\n\n" +
          "No screening details saved yet.\n" +
          "Set up your details (Official Name, DOB, Total Exp, CTC, Notice Period, etc.) so AI can automatically include recruiter screening data in your applications:\n\n" +
          "_Role-specific details (Relevant Experience, Expected CTC, Holding Offer) are configured per role under /roles._",
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    const lines: string[] = [
      "👤 *Candidate Global Screening Profile*\n",
      `*Official Name:* ${profile.officialName || "—"}`,
      `*Mobile:* ${profile.mobile || "—"}`,
      `*Email:* ${profile.emailId || "—"}`,
      `*DOB:* ${profile.dob || "—"}`,
      `*Total Experience:* ${profile.totalExperience || "—"}`,
      `*Current Company:* ${profile.currentCompany || "—"}`,
      `*Current Location:* ${profile.currentLocation || "—"}`,
      `*Preferred Location:* ${profile.preferredLocation || "—"}`,
      `*Current CTC:* ${profile.currentCtc || "—"}`,
      `*Notice Period / LWD:* ${profile.noticePeriod || "—"}\n`,
      `_💡 Note: Role-specific details (Relevant Experience, Expected CTC, Holding Offer) are configured per role under /roles._`,
    ];

    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  });

  bot.command("edit_profile", async (ctx) => {
    await ctx.conversation.enter("profileFlow");
  });

  // ── Role Management Commands ───────────────────────────────────────────────

  bot.command("roles", async (ctx) => {
    const roles = await getRoles(ctx.from!.id);
    const keyboard = new InlineKeyboard();

    if (roles.length === 0) {
      keyboard.text("➕ Add New Role", "add_new_role").row();
      keyboard.text("❌ Close", "cancel_delete");
      await ctx.reply(
        "👔 *Job Roles*\n\n" +
          "You haven't created any roles yet.\n\n" +
          "Roles allow you to attach different tailored resumes (1-to-1) and set role-specific screening metrics (Relevant Experience, Expected CTC, Holding Offer).\n\n" +
          "Click below or run /add_role to create your first role!",
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      return;
    }

    let msg = "👔 *Your Job Roles & Resumes*\n\n";
    roles.forEach((r, idx) => {
      const resumeInfo = r.resume
        ? `📄 Resume: \`${r.resume.fileName}\` (~${r.resume.text.split(/\s+/).length} words)`
        : `⚠️ Resume: _Not attached yet (upload a PDF to attach)_`;

      const details: string[] = [];
      if (r.relevantExperience) details.push(`Exp: ${r.relevantExperience}`);
      if (r.expectedCtc) details.push(`Expected CTC: ${r.expectedCtc}`);
      if (r.holdingOffer) details.push(`Offer: ${r.holdingOffer}`);
      const detailsLine = details.length > 0 ? `   🎯 _${details.join(" | ")}_\n` : "";

      msg += `${idx + 1}. *${r.name}*\n   ${resumeInfo}\n${detailsLine}\n`;
      keyboard.text(`🗑 Delete "${r.name.slice(0, 18)}"`, `delete_role:${r.id}`).row();
    });

    keyboard.text("➕ Add New Role", "add_new_role").row();
    keyboard.text("❌ Close", "cancel_delete");

    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  });


  bot.command("add_role", async (ctx) => {
    const name = ctx.message?.text?.replace(/^\/add_role(@\w+)?/i, "").trim();
    if (name && name.length >= 2) {
      const role = await addRole(ctx.from!.id, name);
      await ctx.reply(
        `✅ *Role Created!*\n\n👔 *Role:* ${role.name}\n\nSend a PDF resume file to attach to this role!`,
        { parse_mode: "Markdown" }
      );
    } else {
      await ctx.conversation.enter("addRoleFlow");
    }
  });

  // ── /mail Command ──────────────────────────────────────────────────────────

  bot.command("mail", async (ctx) => {
    await ctx.conversation.enter("mailFlow");
  });


  // ── SMTP Commands ──────────────────────────────────────────────────────────

  bot.command("setup", async (ctx) => {
    await ctx.conversation.enter("setupFlow");
  });

  bot.command("delete_smtp", async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.smtp) {
      await ctx.reply("ℹ️ No SMTP configuration found. Nothing to delete.");
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("🗑 Yes, remove it", "confirm_delete_smtp")
      .text("❌ Cancel", "cancel_delete");

    await ctx.reply(
      `⚠️ *Remove SMTP config?*\n\n` +
        `This will delete your saved email account:\n\`${user.smtp.user}\`\n\n` +
        `You will need to run /setup again before sending applications.`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  // ── Resume Commands ────────────────────────────────────────────────────────

  bot.command("resume", async (ctx) => {
    const user = await getUser(ctx.from!.id);

    if (!user?.resume) {
      await ctx.reply(
        "📄 No resume saved yet.\n\nSend a PDF file to upload your resume."
      );
      return;
    }

    const uploaded = user.resume.uploadedAt.toLocaleDateString();
    const wordCount = user.resume.text.split(/\s+/).length;

    const keyboard = new InlineKeyboard()
      .text("🗑 Delete Resume", "confirm_delete_resume")
      .text("❌ Close", "cancel_delete");

    await ctx.reply(
      `📄 *Saved Resume*\n\n` +
        `*File:* \`${user.resume.fileName}\`\n` +
        `*Uploaded:* ${uploaded}\n` +
        `*Size:* ~${wordCount} words extracted\n\n` +
        `Send a new PDF at any time to replace it.`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  bot.command("delete_resume", async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.resume) {
      await ctx.reply("ℹ️ No resume found. Nothing to delete.");
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("🗑 Yes, delete it", "confirm_delete_resume")
      .text("❌ Cancel", "cancel_delete");

    await ctx.reply(
      `⚠️ *Delete resume?*\n\n` +
        `\`${user.resume.fileName}\` will be removed from your profile.\n\n` +
        `Note: The file itself stays on Telegram — only your saved reference is deleted.`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  // ── Template Commands ──────────────────────────────────────────────────────

  bot.command("set_template", async (ctx) => {
    await ctx.conversation.enter("templateFlow");
  });

  bot.command("view_template", async (ctx) => {
    const user = await getUser(ctx.from!.id);

    if (!user?.templates.default) {
      await ctx.reply(
        "📝 No template saved yet.\n\nRun /set_template to add one."
      );
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("✏️ Edit", "edit_template")
      .text("🗑 Delete", "confirm_delete_template")
      .text("❌ Close", "cancel_delete");

    // Telegram messages max 4096 chars — safe to send full template
    await ctx.reply(
      `📝 *Your Cover Letter Template*\n\n${user.templates.default}`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  bot.command("delete_template", async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.templates.default) {
      await ctx.reply("ℹ️ No template found. Nothing to delete.");
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("🗑 Yes, delete it", "confirm_delete_template")
      .text("❌ Cancel", "cancel_delete");

    await ctx.reply(
      "⚠️ *Delete your cover letter template?*\n\nAI will use generic defaults for future applications.",
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  // ── Account Commands ───────────────────────────────────────────────────────

  bot.command("reset", async (ctx) => {
    const keyboard = new InlineKeyboard()
      .text("💣 Yes, delete everything", "confirm_reset")
      .row()
      .text("❌ Cancel", "cancel_delete");

    await ctx.reply(
      "⚠️ *Reset your account?*\n\n" +
        "This will permanently delete:\n" +
        "• Your SMTP configuration\n" +
        "• Your saved resume reference\n" +
        "• Your cover letter template\n\n" +
        "*This cannot be undone.*",
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  bot.command("cancel", async (ctx) => {
    await ctx.reply(
      "✅ Action cancelled. Use /help to see available commands."
    );
  });

  // ── Callback Query Handlers (confirmations) ───────────────────────────────
  bot.callbackQuery("confirm_delete_smtp", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deleteSmtp(ctx.from.id);
    await ctx.editMessageText(
      "🗑 *SMTP configuration deleted.*\n\nRun /setup to configure a new email account.",
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("confirm_delete_resume", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deleteResume(ctx.from.id);
    await ctx.editMessageText(
      "🗑 *Resume deleted.*\n\nSend a PDF to upload a new one.",
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("confirm_delete_template", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deleteTemplate(ctx.from.id);
    await ctx.editMessageText(
      "🗑 *Template deleted.*\n\nRun /set_template to create a new one.",
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("edit_template", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    await ctx.conversation.enter("templateFlow");
  });

  bot.callbackQuery("confirm_reset", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deleteUser(ctx.from.id);
    await ctx.editMessageText(
      "💣 *Account reset.*\n\nAll your data has been deleted. Send /start to begin again.",
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("cancel_delete", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  });

  bot.callbackQuery("add_new_role", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("addRoleFlow");
  });

  bot.callbackQuery("edit_profile_btn", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("profileFlow");
  });

  bot.callbackQuery(/^delete_role:(.+)$/, async (ctx) => {
    const roleId = ctx.match[1];
    await ctx.answerCallbackQuery();
    if (!roleId) return;

    const role = await getRole(ctx.from.id, roleId);
    if (!role) {
      await ctx.reply("Role not found or already deleted.");
      return;
    }

    await deleteRole(ctx.from.id, roleId);
    await ctx.editMessageText(
      `🗑 *Role "${role.name}" deleted.*\n\nUse /roles to view your remaining roles.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery(/^attach_to_role:(.+)$/, async (ctx) => {
    const roleId = ctx.match[1];
    await ctx.answerCallbackQuery();
    if (!roleId) return;

    const pending = ctx.session.pendingResume;
    if (!pending) {
      await ctx.editMessageText("⚠️ No pending resume found. Please upload the PDF again.");
      return;
    }

    const role = await getRole(ctx.from.id, roleId);
    if (!role) {
      await ctx.editMessageText("⚠️ Role not found.");
      return;
    }

    await attachResumeToRole(ctx.from.id, roleId, pending);
    ctx.session.pendingResume = undefined;

    await ctx.editMessageText(
      `✅ *Resume attached to role: "${role.name}"!*\n\n` +
        `📄 File: \`${pending.fileName}\`\n\n` +
        `When you run /mail, you can select *${role.name}* to apply with this resume.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("attach_create_role", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    await ctx.conversation.enter("addRoleFlow");
  });

  bot.callbackQuery("attach_as_default", async (ctx) => {
    await ctx.answerCallbackQuery();
    const pending = ctx.session.pendingResume;
    if (!pending) {
      await ctx.editMessageText("⚠️ No pending resume found. Please upload the PDF again.");
      return;
    }

    await updateResume(ctx.from.id, pending);
    ctx.session.pendingResume = undefined;

    await ctx.editMessageText(
      `✅ *Saved as your default resume!*\n\n` +
        `📄 File: \`${pending.fileName}\`\n\n` +
        `You can use /apply or /mail anytime to send applications.`,
      { parse_mode: "Markdown" }
    );
  });

  // ── Auto-handle PDF uploads anywhere in the chat ──────────────────────────
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const validation = validateResumeDocument(doc);
    if (!validation.valid) {
      await ctx.reply(validation.error!);
      return;
    }

    await ctx.reply("⏳ Processing your resume...");


    try {
      const buffer = await downloadTelegramFile(doc.file_id, BOT_TOKEN!);
      const text = await extractResumeText(buffer);

      const resumeData = {
        fileId: doc.file_id,
        fileName: doc.file_name ?? "Resume.pdf",
        text,
        uploadedAt: new Date(),
      };

      // Store in session so user can pick where to attach
      ctx.session.pendingResume = resumeData;

      const roles = await getRoles(ctx.from.id);
      const wordCount = text.split(/\s+/).length;

      const keyboard = new InlineKeyboard();

      if (roles.length > 0) {
        roles.forEach((r) => {
          keyboard.text(`👔 Attach to "${r.name.slice(0, 20)}"`, `attach_to_role:${r.id}`).row();
        });
      }

      keyboard.text("➕ Create New Role & Attach", "attach_create_role").row();
      keyboard.text("📄 Save as Default Resume", "attach_as_default").row();
      keyboard.text("❌ Cancel", "cancel_delete");

      await ctx.reply(
        `📄 *Resume Processed!*\n\n` +
          `*File:* \`${doc.file_name ?? "Resume.pdf"}\`\n` +
          `*Extracted:* ~${wordCount} words\n\n` +
          `Choose where you would like to attach this resume:`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await ctx.reply(`❌ ${msg}`);
    }
  });


  // ── Global error handler ──────────────────────────────────────────────────
  bot.catch((err) => {
    console.error("❌ Bot error:", err.error);
    err.ctx
      .reply("⚠️ Something went wrong. Please try again or run /cancel.")
      .catch(() => {});
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    console.log("\n🛑 Shutting down...");
    bot.stop();
    await closeDb();
    process.exit(0);
  };

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });

  // ── Start polling ─────────────────────────────────────────────────────────
  console.log("🤖 Resume Bot is starting...");
  await bot.start({
    onStart: (info) => {
      console.log(`✅ Bot @${info.username} is running!`);
    },
  });
}

main().catch((err: unknown) => {
  console.error("❌ Fatal startup error:", err);
  process.exit(1);
});
