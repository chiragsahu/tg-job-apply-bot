import type { BotContext, MyConversation } from "../types.js";
import { addRole, attachResumeToRole } from "../services/user.js";
import { escapeMarkdown } from "../services/format.js";

/**
 * Conversation: Create Role Flow
 *
 * Prompts user for:
 * 1. Role title (e.g. "Senior Backend Engineer")
 * 2. Role-specific Relevant Experience (e.g. "4 Years in Node.js")
 * 3. Role-specific Expected CTC (e.g. "22 LPA")
 * 4. Role-specific Holding Offer status
 *
 * If a pending uploaded resume exists in session, attaches it immediately.
 */
export async function addRoleFlow(
  conversation: MyConversation,
  ctx: BotContext
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  await ctx.reply(
    "👔 *Create a New Job Role*\n\n" +
      "Step 1/4: Enter a title for this role:\n" +
      "_e.g. Senior Backend Engineer, Full Stack Developer, DevOps Lead_\n\n" +
      "Send /cancel to abort.",
    { parse_mode: "Markdown" }
  );

  const nameCtx = await conversation.waitFor("message:text");
  const roleName = nameCtx.message.text.trim();

  if (roleName === "/cancel") {
    await ctx.reply("❌ Cancelled role creation.");
    return;
  }

  if (roleName.length < 2) {
    await ctx.reply("⚠️ Role name is too short. Please try /add\\_role again.");
    return;
  }

  const safeRoleName = roleName.replace(/[*_`]/g, "");

  // Step 2: Relevant experience for this role
  await ctx.reply(
    `🎯 *Relevant Experience for ${safeRoleName}*\n\n` +
      `Enter your relevant experience for this specific role:\n` +
      `_e.g. 4 Years in Node.js / TypeScript, or 3 Years in AWS / Terraform_\n\n` +
      `Send /skip to leave blank or /cancel to abort:`,
    { parse_mode: "Markdown" }
  );
  const relExpCtx = await conversation.waitFor("message:text");
  const relExpText = relExpCtx.message.text.trim();
  if (relExpText === "/cancel") { await ctx.reply("❌ Cancelled role creation."); return; }
  const relevantExperience = relExpText === "/skip" ? undefined : relExpText;

  // Step 3: Expected CTC for this role
  await ctx.reply(
    `💰 *Expected CTC for ${safeRoleName}*\n\n` +
      `Enter your expected CTC for this position:\n` +
      `_e.g. 20 LPA, 25 LPA_\n\n` +
      `Send /skip to leave blank or /cancel to abort:`,
    { parse_mode: "Markdown" }
  );

  const expCtcCtx = await conversation.waitFor("message:text");
  const expCtcText = expCtcCtx.message.text.trim();
  if (expCtcText === "/cancel") { await ctx.reply("❌ Cancelled role creation."); return; }
  const expectedCtc = expCtcText === "/skip" ? undefined : expCtcText;

  // Step 4: Holding offer for this role
  await ctx.reply(
    `📄 *Holding Offer (If Any)*\n\n` +
      `Do you hold any offers currently for this role?\n` +
      `_e.g. Yes - 18 LPA, None_\n\n` +
      `Send /skip to leave blank or /cancel to abort:`,
    { parse_mode: "Markdown" }
  );
  const offerCtx = await conversation.waitFor("message:text");
  const offerText = offerCtx.message.text.trim();
  if (offerText === "/cancel") { await ctx.reply("❌ Cancelled role creation."); return; }
  const holdingOffer = offerText === "/skip" ? undefined : offerText;

  const newRole = await conversation.external(() =>
    addRole(telegramId, roleName, {
      relevantExperience,
      expectedCtc,
      holdingOffer,
    })
  );

  // Check if there was an unattached resume waiting from a recent upload
  const session = await conversation.external(() => ctx.session);
  if (session?.pendingResume) {
    const resume = session.pendingResume;
    session.pendingResume = undefined;

    await conversation.external(() =>
      attachResumeToRole(telegramId, newRole.id, resume)
    );

    const safeExp = escapeMarkdown(relevantExperience || "—");
    const safeCtc = escapeMarkdown(expectedCtc || "—");
    const safeOffer = escapeMarkdown(holdingOffer || "—");

    await ctx.reply(
      `✅ *Role Created & Resume Attached!*\n\n` +
        `👔 *Role:* ${safeRoleName}\n` +
        `🎯 *Relevant Exp:* ${safeExp}\n` +
        `💰 *Expected CTC:* ${safeCtc}\n` +
        `📄 *Holding Offer:* ${safeOffer}\n` +
        `📎 *Attached Resume:* \`${resume.fileName}\`\n\n` +
        `You can now use /mail to apply for jobs targeting this role!`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const safeExp = escapeMarkdown(relevantExperience || "—");
  const safeCtc = escapeMarkdown(expectedCtc || "—");
  const safeOffer = escapeMarkdown(holdingOffer || "—");

  await ctx.reply(
    `✅ *Role Created!*\n\n` +
      `👔 *Role:* ${safeRoleName}\n` +
      `🎯 *Relevant Exp:* ${safeExp}\n` +
      `💰 *Expected CTC:* ${safeCtc}\n` +
      `📄 *Holding Offer:* ${safeOffer}\n` +
      `📄 *Resume:* Not attached yet\n\n` +
      `Send a PDF resume file to attach a tailored resume to this role, or run /roles to manage all roles.`,
    { parse_mode: "Markdown" }
  );

}
