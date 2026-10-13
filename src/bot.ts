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
} from "./services/user.js";
import { downloadTelegramFile, extractResumeText } from "./services/pdf.js";

import { setupFlow } from "./conversations/setup.js";
import { templateFlow } from "./conversations/template.js";
import { applyFlow } from "./conversations/apply.js";

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

    await ctx.reply(
      `👋 *Welcome to Resume Bot\\!*\n\n` +
        `I send tailored job application emails — directly from *your* email address\\.\n\n` +
        `*Your setup status:*\n` +
        `${s(!!user?.smtp)} Email \\(SMTP\\) configured\n` +
        `${s(!!user?.resume)} Resume uploaded\n` +
        `${s(!!user?.templates.default)} Cover letter template\n\n` +
        `Use /help to see all commands\\.`,
      { parse_mode: "MarkdownV2" }
    );
  });

  // ── /help ──────────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `📖 *Commands*\n\n` +
        `*📧 Email Setup*\n` +
        `/setup — Configure your SMTP email account\n` +
        `/delete\\_smtp — Remove your saved email config\n\n` +
        `*📄 Resume*\n` +
        `/resume — View current resume info\n` +
        `/delete\\_resume — Remove your saved resume\n` +
        `_(Upload a PDF at any time to save/replace it)_\n\n` +
        `*📝 Templates*\n` +
        `/set\\_template — Create or update cover letter tone\n` +
        `/view\\_template — View your full saved template\n` +
        `/delete\\_template — Remove your saved template\n\n` +
        `*🚀 Apply*\n` +
        `/apply — Send a tailored job application\n\n` +
        `*⚙️ Account*\n` +
        `/profile — View all your saved settings\n` +
        `/reset — Delete all your data \\(irreversible\\)\n` +
        `/cancel — Stop the current action`,
      { parse_mode: "MarkdownV2" }
    );
  });

  // ── /profile ───────────────────────────────────────────────────────────────
  bot.command("profile", async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user) {
      await ctx.reply("No profile found. Send any message to get started.");
      return;
    }

    const lines: string[] = ["👤 *Your Profile*\n"];

    // SMTP
    if (user.smtp) {
      lines.push(
        `📤 *Email:* \`${user.smtp.user}\`\n` +
          `🌐 *SMTP:* \`${user.smtp.host}:${user.smtp.port}\`\n` +
          `👤 *From name:* ${user.smtp.senderName ?? "—"}\n` +
          `_/delete\\_smtp to remove_`
      );
    } else {
      lines.push("📤 *Email:* ❌ Not configured — /setup");
    }

    lines.push("");

    // Resume
    if (user.resume) {
      const uploaded = user.resume.uploadedAt.toLocaleDateString();
      const wordCount = user.resume.text.split(/\s+/).length;
      lines.push(
        `📄 *Resume:* \`${user.resume.fileName}\`\n` +
          `🗓 *Uploaded:* ${uploaded} · ~${wordCount} words\n` +
          `_/delete\\_resume to remove_`
      );
    } else {
      lines.push("📄 *Resume:* ❌ Not uploaded — send a PDF");
    }

    lines.push("");

    // Template
    if (user.templates.default) {
      const preview = user.templates.default.slice(0, 120);
      lines.push(
        `📝 *Template:* ✅\n_${preview}${user.templates.default.length > 120 ? "…" : ""}_\n` +
          `_/view\\_template · /set\\_template · /delete\\_template_`
      );
    } else {
      lines.push("📝 *Template:* ❌ Not set — /set\\_template");
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
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


  // ── Auto-handle PDF uploads anywhere in the chat ──────────────────────────
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (doc.mime_type !== "application/pdf") return;

    await ctx.reply("⏳ Processing your resume...");

    try {
      const buffer = await downloadTelegramFile(doc.file_id, BOT_TOKEN!);
      const text = await extractResumeText(buffer);

      await updateResume(ctx.from.id, {
        fileId: doc.file_id,
        fileName: doc.file_name ?? "Resume.pdf",
        text,
        uploadedAt: new Date(),
      });

      const wordCount = text.split(/\s+/).length;
      await ctx.reply(
        `✅ *Resume saved\\!*\n\n` +
          `📄 *File:* \`${doc.file_name ?? "Resume.pdf"}\`\n` +
          `📊 *Extracted:* ~${wordCount} words\n\n` +
          `Run /apply to send a job application\\.`,
        { parse_mode: "MarkdownV2" }
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
