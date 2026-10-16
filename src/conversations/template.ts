import type { BotContext, MyConversation } from "../types.js";
import { getUser, updateTemplate } from "../services/user.js";
import { escapeMarkdown } from "../services/format.js";

/**
 * Conversation: Template / Tone Manager
 *
 * Lets the user save their preferred email tone and style notes.
 * These notes are injected into the AI prompt on every /apply call
 * to personalise the generated cover letter.
 *
 * Register as: bot.use(createConversation(templateFlow, "templateFlow"))
 */
export async function templateFlow(
  conversation: MyConversation,
  ctx: BotContext
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await conversation.external(() => getUser(telegramId));

  // Show existing template if any
  if (user?.templates.default) {
    await ctx.reply(
      "📝 *Your current template:*\n\n" +
        `_${escapeMarkdown(user.templates.default)}_\n\n` +
        "Send a new template below to replace it, or /cancel to keep the current one.",
      { parse_mode: "Markdown" }
    );
  } else {
    await ctx.reply(
      "📝 *Cover Letter Template Setup*\n\n" +
        "Describe your preferred email tone and any key points to highlight.\n\n" +
        "*Examples:*\n" +
        "• _Professional and concise. Highlight my 5 years in backend development and open source contributions._\n" +
        "• _Enthusiastic and personable. Mention my passion for design systems and cross-functional collaboration._\n\n" +
        "Type your template notes below (or /cancel):",
      { parse_mode: "Markdown" }
    );
  }

  const templateCtx = await conversation.waitFor("message:text");
  const input = templateCtx.message.text.trim();

  if (input === "/cancel") {
    await ctx.reply("❌ No changes made.");
    return;
  }

  if (input.length < 10) {
    await ctx.reply(
      "⚠️ Template is too short. Please write at least a sentence describing your tone and key points."
    );
    return;
  }

  await conversation.external(() => updateTemplate(telegramId, input));

  const safePreview = escapeMarkdown(
    `${input.slice(0, 200)}${input.length > 200 ? "…" : ""}`
  );

  await ctx.reply(
    "✅ *Template saved!*\n\n" +
      "Your tone notes will be used in all future /apply calls.\n\n" +
      `_Preview:_\n${safePreview}`,
    { parse_mode: "Markdown" }
  );
}
