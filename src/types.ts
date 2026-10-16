import type { Context, SessionFlavor } from "grammy";
import type { ConversationFlavor, Conversation } from "@grammyjs/conversations";
import type { UserResume } from "./models/User.js";

/**
 * Session data — kept minimal. All persistent user data lives in MongoDB `users` collection.
 * grammY uses this for active conversation state and transient flow data.
 */
export interface SessionData {
  pendingResume?: UserResume | undefined;
  pendingRoleId?: string | undefined;
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
