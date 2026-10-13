import type { Context, SessionFlavor } from "grammy";
import type { ConversationFlavor, Conversation } from "@grammyjs/conversations";

/**
 * Session data — kept minimal. All persistent user data lives in MongoDB `users` collection.
 * grammY uses this only for active conversation flow state.
 */
export interface SessionData {
  // Intentionally empty — grammY conversations v2 manages its own state externally
  [key: string]: unknown;
}

/**
 * The bot's outer context type (used for bot.command, bot.on, etc.)
 */
export type BotContext = Context & SessionFlavor<SessionData>;

/**
 * The context type inside conversations — includes ConversationFlavor.
 * ConversationFlavor<C> wraps the outer context type.
 */
export type MyContext = ConversationFlavor<BotContext>;

/**
 * Conversation type — uses the full flavored context inside conversation functions.
 */
export type MyConversation = Conversation<BotContext, BotContext>;
