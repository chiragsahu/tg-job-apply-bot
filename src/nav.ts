/**
 * Shared navigation constants and helpers used by both bot.ts and all conversations.
 * Keeping keyboards here avoids circular imports.
 */
import { Keyboard } from "grammy";
import type { BotContext } from "./types.js";

export const BACK_TEXT = "⬅️ Back";

/** Persistent 3×3 home grid shown at the start / after Back is pressed. */
export const HOME_KEYBOARD = new Keyboard()
  .text("🚀 Apply")
  .text("📧 Bulk Mail")
  .text("👔 Roles")
  .row()
  .text("👤 Profile")
  .text("📄 Resume")
  .text("📝 Template")
  .row()
  .text("⚙️ Setup")
  .text("❓ Help")
  .resized()
  .persistent();

/** Single back-button keyboard shown while inside a page / flow. */
export const BACK_KEYBOARD = new Keyboard()
  .text(BACK_TEXT)
  .resized()
  .persistent();

/**
 * Call this after every `conversation.waitFor("message:text")`.
 * Returns true (and sends HOME_KEYBOARD) if the user pressed ⬅️ Back.
 *
 * Usage:
 *   const textCtx = await conversation.waitFor("message:text");
 *   if (await handleBack(textCtx.message.text, ctx)) return;
 */
export async function handleBack(
  text: string,
  ctx: BotContext,
): Promise<boolean> {
  const trimmed = text.trim();
  if (
    trimmed === BACK_TEXT ||
    trimmed.toLowerCase() === "back" ||
    trimmed.toLowerCase() === "/back"
  ) {
    await ctx.reply("🏠 Main Menu", { reply_markup: HOME_KEYBOARD });
    return true;
  }
  return false;
}
