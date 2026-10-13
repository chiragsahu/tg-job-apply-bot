import "dotenv/config";
import { Bot, session } from "grammy";
import {
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import { MongoDBAdapter } from "@grammyjs/storage-mongodb";

import { getDb, closeDb } from "./services/db.js";
import { getOrCreateUser, getUser, updateResume } from "./services/user.js";
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
// Bot is typed with BotContext (outer context); MyContext (ConversationFlavor<BotContext>)
// is used inside conversation handlers only.
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
  // OC = outer context (MyContext with ConversationFlavor), C = inner context (BotContext)
  bot.use(conversations<MyContext, BotContext>());
  bot.use(createConversation<MyContext, BotContext>(setupFlow, "setupFlow"));
  bot.use(createConversation<MyContext, BotContext>(templateFlow, "templateFlow"));
  bot.use(createConversation<MyContext, BotContext>(applyFlow, "applyFlow"));

  // 4. Auto-upsert user on every interaction
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await getOrCreateUser(
        ctx.from.id,
        ctx.from.username,
        ctx.from.first_name
      );
    }
    return next();
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  bot.command("start", async (ctx) => {
    const user = await getUser(ctx.from!.id);
    const hasResume = !!user?.resume;
    const hasSmtp = !!user?.smtp;
    const hasTemplate = !!user?.templates.default;

    await ctx.reply(
      `👋 *Welcome to Resume Bot!*\n\n` +
        `I send tailored job application emails — directly from *your* email address.\n\n` +
        `*Your setup status:*\n` +
        `${hasSmtp ? "✅" : "❌"} Email (SMTP) configured\n` +
        `${hasResume ? "✅" : "❌"} Resume uploaded\n` +
        `${hasTemplate ? "✅" : "❌"} Cover letter template\n\n` +
        `*Commands:*\n` +
        `/setup — Configure your email account\n` +
        `/resume — Upload or replace your resume PDF\n` +
        `/set_template — Save your cover letter tone\n` +
        `/profile — View your current settings\n` +
        `/apply — Send a job application\n` +
        `/cancel — Cancel the current action`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("profile", async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user) {
      await ctx.reply("No profile found. Send any message to get started.");
      return;
    }

    const lines: string[] = ["👤 *Your Profile*\n"];

    if (user.smtp) {
      lines.push(
        `📤 *Email:* \`${user.smtp.user}\`\n` +
          `🌐 *SMTP:* \`${user.smtp.host}:${user.smtp.port}\`\n` +
          `👤 *From name:* ${user.smtp.senderName ?? "—"}`
      );
    } else {
      lines.push("📤 *Email:* ❌ Not configured — run /setup");
    }

    lines.push("");

    if (user.resume) {
      const uploaded = user.resume.uploadedAt.toLocaleDateString();
      lines.push(
        `📄 *Resume:* \`${user.resume.fileName}\`\n` +
          `🗓 *Uploaded:* ${uploaded}`
      );
    } else {
      lines.push("📄 *Resume:* ❌ Not uploaded — send a PDF to upload");
    }

    lines.push("");

    if (user.templates.default) {
      const preview = user.templates.default.slice(0, 150);
      lines.push(
        `📝 *Template:* ✅\n_${preview}${user.templates.default.length > 150 ? "…" : ""}_`
      );
    } else {
      lines.push("📝 *Template:* ❌ Not set — run /set\\_template");
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command("setup", async (ctx) => {
    await ctx.conversation.enter("setupFlow");
  });

  bot.command("set_template", async (ctx) => {
    await ctx.conversation.enter("templateFlow");
  });

  bot.command("resume", async (ctx) => {
    await ctx.reply(
      "📄 Send your resume PDF now to upload or replace the current one."
    );
  });

  bot.command("apply", async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.smtp) {
      await ctx.reply(
        "⚠️ Please configure your email first.\n\nRun /setup to connect your SMTP account."
      );
      return;
    }
    await ctx.conversation.enter("applyFlow");
  });

  bot.command("cancel", async (ctx) => {
    await ctx.reply("✅ Any active action has been stopped. What would you like to do?");
  });

  // ── Auto-handle PDF uploads anywhere in the chat ──────────────────────────
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;

    // Only handle PDFs (ignore other document types)
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

      await ctx.reply(
        `✅ *Resume saved!*\n\n` +
          `📄 *File:* \`${doc.file_name ?? "Resume.pdf"}\`\n\n` +
          `You can now run /apply to send a job application.`,
        { parse_mode: "Markdown" }
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
      .catch(() => {}); // Suppress reply errors (e.g. if chat was deleted)
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
