/**
 * Unified Apply Conversation — merges the old /apply and /mail flows
 * into a single intelligent pipeline powered by LangGraph.
 *
 * Steps:
 * 1. Guard: verify SMTP configured, at least one resume exists
 * 2. Collect job input & recruiter email in one prompt (only prompt for email if not found)
 * 3. Run LangGraph pipeline (scrape → match resume → evaluate screening → generate email)
 * 4. Interactive preview & refinement loop:
 *    - 🚀 Send
 *    - ✏️ Regenerate (with optional user revision feedback / change requests)
 *    - 🔄 Change Role
 *    - ❌ Cancel
 * 5. On confirm → dispatch emails → single acknowledgment
 *
 * Register as: bot.use(createConversation(unifiedApplyFlow, "unifiedApplyFlow"))
 */

import { InlineKeyboard } from "grammy";
import type { BotContext, MyConversation } from "../types.js";
import {
  getUser,
  getRoles,
  getCandidateProfile,
  recordApplicationSent,
  saveLastSentEmail,
} from "../services/user.js";
import type { UserRole, UserResume } from "../models/User.js";
import { escapeMarkdown, htmlToTelegramMarkdown } from "../services/format.js";
import {
  extractUrl,
  fetchJobPage,
  extractEmailsFromContent,
} from "../services/scraper.js";
import { handleBack, HOME_KEYBOARD, BACK_KEYBOARD } from "../nav.js";
import {
  buildApplyGraph,
  dispatchEmailsDirect,
  type ApplyState,
} from "../services/apply-graph.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmails(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => EMAIL_REGEX.test(e));
}

export async function unifiedApplyFlow(
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
        "Tap 👤 Profile → ⚙️ Setup SMTP to connect your email account first.",
      { reply_markup: HOME_KEYBOARD },
    );
    return;
  }

  const roles = await conversation.external(() => getRoles(telegramId));
  const rolesWithResume = roles.filter((r) => !!r.resume);

  if (rolesWithResume.length === 0 && !user.resume) {
    await ctx.reply(
      "📄 *No Resumes Found!*\n\n" +
        "You need a resume to apply. Either:\n" +
        "• Use 📄 Resume to upload a default resume\n" +
        "• Use 👔 Roles to create a role and attach a resume PDF",
      { parse_mode: "Markdown", reply_markup: HOME_KEYBOARD },
    );
    return;
  }

  // ── Check if initial command has inline args ────────────────────────────

  const initialText = ctx.message?.text ?? "";
  const matchAfterCommand = initialText
    .replace(/^\/(apply|mail)(@\w+)?/i, "")
    .trim();

  let prefilledDesc = "";
  let prefilledTitle = "";
  let prefilledCompany = "";
  let detectedEmails: string[] = [];
  let prefilledRecipients: string[] = [];

  if (matchAfterCommand) {
    // Extract any emails passed directly in initial command
    const directEmails = extractEmailsFromContent(matchAfterCommand);
    if (directEmails.length > 0) {
      prefilledRecipients.push(...directEmails);
    }

    const urlInCommand = extractUrl(matchAfterCommand);
    if (urlInCommand) {
      const waitMsg = await ctx.reply(
        "🌐 *Fetching Job Link...*\n\nReading job description and searching for recruiter email...",
        { parse_mode: "Markdown" },
      );
      try {
        const page = await conversation.external(() =>
          fetchJobPage(urlInCommand),
        );
        prefilledDesc = page.description;
        prefilledTitle = page.title || "";
        prefilledCompany = page.company || "";
        if (page.emails.length > 0) {
          detectedEmails.push(...page.emails);
        }

        await ctx.api
          .deleteMessage(ctx.chat!.id, waitMsg.message_id)
          .catch(() => {});

        let linkFeedback = `🌐 *Job Link Processed:*\n`;
        if (prefilledTitle)
          linkFeedback += `📌 *Position:* ${escapeMarkdown(prefilledTitle)}\n`;
        if (prefilledCompany)
          linkFeedback += `🏢 *Company:* ${escapeMarkdown(prefilledCompany)}\n`;
        linkFeedback += `📋 *Description:* Extracted (${prefilledDesc.length} characters)\n`;
        const allFoundEmails = Array.from(new Set([...prefilledRecipients, ...detectedEmails]));
        if (allFoundEmails.length > 0) {
          linkFeedback += `📧 *Found Recruiter Email:* \`${allFoundEmails.join(", ")}\`\n`;
        }
        await ctx.reply(linkFeedback, { parse_mode: "Markdown" });
      } catch (err) {
        await ctx.api
          .deleteMessage(ctx.chat!.id, waitMsg.message_id)
          .catch(() => {});
        const msg = err instanceof Error ? err.message : "Failed to load link";
        await ctx.reply(`⚠️ Could not process link: ${msg}`);
      }
    } else if (directEmails.length === 0) {
      // It's a text JD or role title
      prefilledDesc = matchAfterCommand;
    }
  }

  // ── Step 2: Collect Job Details & Recruiter Email ────────────────────────

  let jobInput = prefilledDesc;
  let recipientEmails = Array.from(
    new Set([...prefilledRecipients, ...detectedEmails]),
  );

  if (jobInput) {
    let msg = "📋 *Step 1 — Job Details & Recruiter Email*\n\n";
    msg += "✅ *Job description already extracted!*\n";
    if (prefilledTitle)
      msg += `📌 *Position:* ${escapeMarkdown(prefilledTitle)}\n`;
    if (prefilledCompany)
      msg += `🏢 *Company:* ${escapeMarkdown(prefilledCompany)}\n`;
    if (recipientEmails.length > 0) {
      msg += `📧 *Recruiter Email:* \`${recipientEmails.join(", ")}\`\n`;
    }
    msg +=
      "\nSend /skip to use this description, or paste new job text / link / email below:\n\n_Send /cancel to abort._";
    await ctx.reply(msg, { parse_mode: "Markdown" });

    const jdCtx = await conversation.waitFor("message:text");
    const jdText = jdCtx.message.text.trim();

    if (jdText === "/cancel") {
      await ctx.reply("❌ Cancelled.", { reply_markup: HOME_KEYBOARD });
      return;
    }
    if (await handleBack(jdText, ctx)) return;

    if (jdText !== "/skip") {
      // Extract any emails typed directly in input
      const typedEmails = extractEmailsFromContent(jdText);
      if (typedEmails.length > 0) {
        recipientEmails.push(...typedEmails);
      }

      const url = extractUrl(jdText);
      if (url) {
        const waitMsg = await ctx.reply("🌐 *Fetching Job Link...*", {
          parse_mode: "Markdown",
        });
        try {
          const page = await conversation.external(() => fetchJobPage(url));
          jobInput = page.description;
          if (page.emails.length > 0) {
            recipientEmails.push(...page.emails);
          }
          if (page.title) prefilledTitle = page.title;
          if (page.company) prefilledCompany = page.company;
          await ctx.api
            .deleteMessage(ctx.chat!.id, waitMsg.message_id)
            .catch(() => {});
          await ctx.reply(
            `🌐 Extracted ${page.description.length} characters from link.`,
          );
        } catch {
          await ctx.api
            .deleteMessage(ctx.chat!.id, waitMsg.message_id)
            .catch(() => {});
          jobInput = jdText;
        }
      } else {
        jobInput = jdText;
      }
    }
  } else {
    await ctx.reply(
      "📋 *Step 1 — Job Details & Recruiter Email*\n\n" +
        "Paste the job posting, job link, or target role title — along with the recruiter email(s) if you have them:\n" +
        "_e.g. hr@company.com https://company.com/job/123_\n" +
        "_or paste the full job posting with the recruiter email inside_\n\n" +
        "_Send /cancel to abort._",
      { parse_mode: "Markdown" },
    );

    const jdCtx = await conversation.waitFor("message:text");
    const jdText = jdCtx.message.text.trim();

    if (jdText === "/cancel") {
      await ctx.reply("❌ Cancelled.", { reply_markup: HOME_KEYBOARD });
      return;
    }
    if (await handleBack(jdText, ctx)) return;

    // 1. Extract any emails typed directly in input
    const typedEmails = extractEmailsFromContent(jdText);
    if (typedEmails.length > 0) {
      recipientEmails.push(...typedEmails);
    }

    // 2. Check for URL
    const url = extractUrl(jdText);
    if (url) {
      const waitMsg = await ctx.reply(
        "🌐 *Fetching Job Link...*\n\nReading job description and searching for recruiter email...",
        { parse_mode: "Markdown" },
      );
      try {
        const page = await conversation.external(() => fetchJobPage(url));
        jobInput = page.description;
        if (page.emails.length > 0) {
          recipientEmails.push(...page.emails);
        }
        prefilledTitle = page.title || "";
        prefilledCompany = page.company || "";

        await ctx.api
          .deleteMessage(ctx.chat!.id, waitMsg.message_id)
          .catch(() => {});

        let feedback = `🌐 *Job Details Extracted!*\n`;
        if (page.title)
          feedback += `📌 *Position:* ${escapeMarkdown(page.title)}\n`;
        if (page.company)
          feedback += `🏢 *Company:* ${escapeMarkdown(page.company)}\n`;
        feedback += `📋 ${page.description.length} characters loaded.\n`;
        if (recipientEmails.length > 0) {
          feedback += `📧 *Found Recruiter Email:* \`${Array.from(new Set(recipientEmails)).join(", ")}\`\n`;
        }
        await ctx.reply(feedback, { parse_mode: "Markdown" });
      } catch (err) {
        await ctx.api
          .deleteMessage(ctx.chat!.id, waitMsg.message_id)
          .catch(() => {});
        const msg = err instanceof Error ? err.message : "Failed to load link";
        await ctx.reply(
          `⚠️ Could not process link: ${msg}\nUsing input as plain text.`,
        );
        jobInput = jdText;
      }
    } else {
      jobInput = jdText;
    }
  }

  // Deduplicate emails found so far
  recipientEmails = Array.from(new Set(recipientEmails));

  // ── Step 3: Recruiter Email (ONLY prompt if not already found) ───────────

  if (recipientEmails.length === 0) {
    await ctx.reply(
      "📧 *Step 2 — Recruiter Email Needed*\n\n" +
        "Job details loaded, but no recruiter email was found in your text or link.\n\n" +
        "Please enter one or more recruiter/HR email addresses (comma-separated):\n" +
        "_e.g. hr@company.com, recruiter@firm.com_\n\n" +
        "_Send /cancel to abort._",
      { parse_mode: "Markdown" },
    );

    while (recipientEmails.length === 0) {
      const emailCtx = await conversation.waitFor("message:text");
      const input = emailCtx.message.text.trim();

      if (input === "/cancel") {
        await ctx.reply("❌ Cancelled.", { reply_markup: HOME_KEYBOARD });
        return;
      }
      if (await handleBack(input, ctx)) return;

      const urlInInput = extractUrl(input);
      if (urlInInput) {
        const waitMsg = await ctx.reply(
          "🌐 *Fetching link for recruiter email...*",
          { parse_mode: "Markdown" },
        );
        try {
          const page = await conversation.external(() =>
            fetchJobPage(urlInInput),
          );
          await ctx.api
            .deleteMessage(ctx.chat!.id, waitMsg.message_id)
            .catch(() => {});
          if (page.emails.length > 0) {
            recipientEmails = Array.from(
              new Set([...recipientEmails, ...page.emails]),
            );
            await ctx.reply(
              `✅ Found: \`${page.emails.join(", ")}\``,
              { parse_mode: "Markdown" },
            );
            break;
          } else {
            await ctx.reply(
              "⚠️ No recruiter email found in that link. Please enter email addresses:",
            );
            continue;
          }
        } catch {
          await ctx.api
            .deleteMessage(ctx.chat!.id, waitMsg.message_id)
            .catch(() => {});
          await ctx.reply(
            "⚠️ Could not load link. Please enter email addresses:",
          );
          continue;
        }
      }

      const parsed = parseEmails(input);
      if (parsed.length > 0) {
        recipientEmails = Array.from(new Set([...recipientEmails, ...parsed]));
        break;
      }

      await ctx.reply(
        "⚠️ No valid email addresses found. Please enter comma-separated emails:",
      );
    }
  } else {
    await ctx.reply(
      `📧 *Recruiter Email Detected:* \`${recipientEmails.join(", ")}\`\n_Proceeding to AI drafting..._`,
      { parse_mode: "Markdown" },
    );
  }

  if (recipientEmails.length === 0) {
    await ctx.reply("❌ No recipient emails provided.", {
      reply_markup: HOME_KEYBOARD,
    });
    return;
  }

  // ── Step 4: Run LangGraph Pipeline ──────────────────────────────────────

  const candidateProfile = await conversation.external(() =>
    getCandidateProfile(telegramId),
  );

  const thinkingMsg = await ctx.reply(
    "🤖 *AI Pipeline Running...*\n\n" +
      "⏳ _Please note: This may take 15–30 seconds as AI analyzes your resume, matches roles, and crafts a formal, to-the-point application..._\n\n" +
      "🔍 Matching best resume → 📋 Evaluating screening needs → ✍️ Drafting email...",
    { parse_mode: "Markdown" },
  );

  let graphResult: ApplyState;
  try {
    const graph = buildApplyGraph();
    graphResult = (await conversation.external(() =>
      graph.invoke({
        telegramId,
        rawInput: jobInput,
        recipientEmails,
        botToken,
        userSmtp: user.smtp,
        template: user.templates.default ?? "",
        allRoles: roles,
        defaultResume: user.resume ?? undefined,
        candidateProfile: candidateProfile ?? undefined,
        userLastSentEmail: user.lastSentEmail,
        forceFresh: false,
        jobDescription: "",
        jobTitle: prefilledTitle,
        company: prefilledCompany,
        scrapedEmails: [],
        matchReasoning: "",
        requestedMetrics: [],
        draftSubject: "",
        draftBody: "",
        isCachedDraft: false,
        sendResults: { sent: [], failed: [] },
        status: "input",
        error: "",
        feedback: undefined,
      }),
    )) as ApplyState;
  } catch (err) {
    await ctx.api
      .deleteMessage(ctx.chat!.id, thinkingMsg.message_id)
      .catch(() => {});
    const msg = err instanceof Error ? err.message : "Unknown error";
    await ctx.reply(`❌ Pipeline failed: ${msg}\n\nPlease try again.`, {
      reply_markup: HOME_KEYBOARD,
    });
    return;
  }

  await ctx.api
    .deleteMessage(ctx.chat!.id, thinkingMsg.message_id)
    .catch(() => {});

  if (graphResult.status === "error" || graphResult.error) {
    await ctx.reply(`❌ ${graphResult.error || "Something went wrong."}`, {
      reply_markup: HOME_KEYBOARD,
    });
    return;
  }

  if (!graphResult.draftSubject || !graphResult.draftBody) {
    await ctx.reply(
      "❌ AI could not generate an application email. Please try again.",
      { reply_markup: HOME_KEYBOARD },
    );
    return;
  }

  // ── Step 5: Interactive Preview & Refinement Loop ───────────────────────

  while (true) {
    const selectedRoleName = graphResult.selectedRole?.name ?? "Default Resume";
    const selectedResume = graphResult.selectedResume!;
    const fromName = escapeMarkdown(user.smtp.senderName ?? user.smtp.user);
    const safeSubject = escapeMarkdown(graphResult.draftSubject);
    const strippedBody = htmlToTelegramMarkdown(graphResult.draftBody);
    const emailListDisplay = recipientEmails.map((e) => `\`${e}\``).join(", ");

    let preview =
      `📬 *Application Preview*\n\n` +
      `📤 *From:* ${fromName} \`<${user.smtp.user}>\`\n` +
      `📧 *To (${recipientEmails.length}):* ${emailListDisplay}\n` +
      `👔 *Role:* ${escapeMarkdown(selectedRoleName)}`;

    if (graphResult.isCachedDraft) {
      preview += ` _(⚡ Using last sent email)_`;
    } else if (graphResult.matchReasoning) {
      preview += ` _(AI matched)_`;
    }
    preview += `\n`;

    if (graphResult.requestedMetrics && graphResult.requestedMetrics.length > 0) {
      preview += `📋 *Screening fields:* ${graphResult.requestedMetrics.join(", ")}\n`;
    }

    preview +=
      `📎 *Attachment:* \`${selectedResume.fileName}\`\n` +
      `📌 *Subject:* ${safeSubject}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      strippedBody +
      `\n━━━━━━━━━━━━━━━━━━━━━━`;

    const keyboard = new InlineKeyboard()
      .text(
        `🚀 Send to ${recipientEmails.length} Recipient${recipientEmails.length > 1 ? "s" : ""}`,
        "apply_confirm_send",
      )
      .row();

    if (rolesWithResume.length > 1 || (rolesWithResume.length >= 1 && user.resume)) {
      keyboard.text("🔄 Change Role", "apply_change_role");
    }

    keyboard
      .text("✏️ Regenerate", "apply_regenerate")
      .row()
      .text("❌ Cancel", "apply_cancel");

    await ctx.reply(preview, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    const actionCtx = await conversation.waitFor([
      "callback_query:data",
      "message:text",
    ]);

    if (actionCtx.message?.text) {
      const text = actionCtx.message.text.trim();
      if (text === "/cancel") {
        await ctx.reply("❌ Application cancelled.", {
          reply_markup: HOME_KEYBOARD,
        });
        return;
      }
      if (await handleBack(text, ctx)) return;
    }

    const action = actionCtx.callbackQuery?.data;
    if (actionCtx.callbackQuery) {
      await actionCtx.answerCallbackQuery();
    }

    if (action === "apply_cancel") {
      await ctx.reply("❌ Application cancelled.", {
        reply_markup: HOME_KEYBOARD,
      });
      return;
    }

    if (action === "apply_confirm_send") {
      // Exit loop and proceed to dispatch
      break;
    }

    // ── Regenerate with Optional Feedback ─────────────────────────────────
    if (action === "apply_regenerate") {
      await ctx.reply(
        "✏️ *Regenerate Application*\n\n" +
          "What changes or adjustments would you like to make?\n" +
          "_e.g. 'Change company to Uber', 'Make it shorter', 'Emphasize Kafka & Go experience'_\n\n" +
          "Send your tweak comments, or send /skip to generate a fresh draft from scratch:\n\n" +
          "_Send /cancel to abort._",
        { parse_mode: "Markdown" },
      );

      const feedbackCtx = await conversation.waitFor("message:text");
      const feedbackInput = feedbackCtx.message.text.trim();

      if (feedbackInput === "/cancel") {
        await ctx.reply("❌ Cancelled.", { reply_markup: HOME_KEYBOARD });
        return;
      }
      if (await handleBack(feedbackInput, ctx)) return;

      const isSkip = feedbackInput === "/skip";
      const userFeedback = isSkip ? undefined : feedbackInput;

      const regenMsg = await ctx.reply(
        "🤖 *Regenerating Application...*\n\n" +
          "⏳ _Please note: This may take 15–30 seconds as AI incorporates your revision notes and refines the draft..._",
        { parse_mode: "Markdown" },
      );

      try {
        const graph = buildApplyGraph();
        const newResult = (await conversation.external(() =>
          graph.invoke({
            ...graphResult,
            feedback: userFeedback,
            forceFresh: isSkip,
            draftSubject: isSkip ? "" : graphResult.draftSubject,
            draftBody: isSkip ? "" : graphResult.draftBody,
            status: "input",
          }),
        )) as ApplyState;

        await ctx.api
          .deleteMessage(ctx.chat!.id, regenMsg.message_id)
          .catch(() => {});

        if (!newResult.draftSubject || !newResult.draftBody) {
          await ctx.reply("❌ Regeneration failed. Keeping previous draft.");
        } else {
          graphResult = newResult;
        }
      } catch (err) {
        await ctx.api
          .deleteMessage(ctx.chat!.id, regenMsg.message_id)
          .catch(() => {});
        const msg = err instanceof Error ? err.message : "Unknown error";
        await ctx.reply(`⚠️ Regeneration error: ${msg}. Keeping previous draft.`);
      }

      // Loop continues and displays updated preview
      continue;
    }

    // ── Change Role ───────────────────────────────────────────────────────
    if (action === "apply_change_role") {
      const roleKeyboard = new InlineKeyboard();
      rolesWithResume.forEach((r) => {
        roleKeyboard
          .text(
            `👔 ${r.name} (${r.resume?.fileName ?? "Resume.pdf"})`,
            `role_pick:${r.id}`,
          )
          .row();
      });
      if (user.resume) {
        roleKeyboard
          .text(
            `📄 Default Resume (${user.resume.fileName})`,
            "role_pick:default",
          )
          .row();
      }
      roleKeyboard.text("❌ Cancel", "apply_cancel");

      await ctx.reply("🎯 *Select a different role:*", {
        parse_mode: "Markdown",
        reply_markup: roleKeyboard,
      });

      const roleCtx = await conversation.waitFor([
        "callback_query:data",
        "message:text",
      ]);

      if (roleCtx.message?.text) {
        const text = roleCtx.message.text.trim();
        if (text === "/cancel" || (await handleBack(text, ctx))) {
          await ctx.reply("❌ Cancelled.", { reply_markup: HOME_KEYBOARD });
          return;
        }
      }

      const roleAction = roleCtx.callbackQuery?.data;
      if (roleCtx.callbackQuery) {
        await roleCtx.answerCallbackQuery();
      }

      if (roleAction === "apply_cancel" || !roleAction?.startsWith("role_pick:")) {
        await ctx.reply("❌ Cancelled.", { reply_markup: HOME_KEYBOARD });
        return;
      }

      const chosenRoleId = roleAction.replace("role_pick:", "");
      let chosenRoleName: string;
      let chosenResume: UserResume | undefined;
      let chosenRole: UserRole | undefined;

      if (chosenRoleId === "default") {
        chosenRoleName = "Default Resume";
        chosenResume = user.resume;
      } else {
        const found = rolesWithResume.find((r) => r.id === chosenRoleId);
        if (found?.resume) {
          chosenRoleName = found.name;
          chosenResume = found.resume;
          chosenRole = found;
        } else {
          await ctx.reply("❌ Role not found.");
          continue;
        }
      }

      if (!chosenResume) {
        await ctx.reply("❌ No resume for selected role.");
        continue;
      }

      const switchMsg = await ctx.reply(
        `🤖 Re-tailoring application for *${escapeMarkdown(chosenRoleName!)}*...\n\n` +
          "⏳ _Please note: This may take 15–30 seconds..._",
        { parse_mode: "Markdown" },
      );

      try {
        const graph = buildApplyGraph();
        const newResult = (await conversation.external(() =>
          graph.invoke({
            ...graphResult,
            selectedRole: chosenRole,
            selectedResume: chosenResume,
            allRoles: roles,
            draftSubject: "",
            draftBody: "",
            feedback: undefined,
            forceFresh: false,
            status: "input",
          }),
        )) as ApplyState;

        await ctx.api
          .deleteMessage(ctx.chat!.id, switchMsg.message_id)
          .catch(() => {});

        if (newResult.draftSubject && newResult.draftBody) {
          graphResult = newResult;
          graphResult.selectedRole = chosenRole;
          graphResult.selectedResume = chosenResume;
        }
      } catch (err) {
        await ctx.api
          .deleteMessage(ctx.chat!.id, switchMsg.message_id)
          .catch(() => {});
        const msg = err instanceof Error ? err.message : "Unknown error";
        await ctx.reply(`⚠️ Switching role error: ${msg}. Keeping previous draft.`);
      }

      // Loop continues and displays updated preview
      continue;
    }
  }

  // ── Step 6: Dispatch Emails ─────────────────────────────────────────────

  const sendingMsg = await ctx.reply(
    `📨 Sending to *${recipientEmails.length}* recipient${recipientEmails.length > 1 ? "s" : ""}...`,
    { parse_mode: "Markdown" },
  );

  try {
    const results = await conversation.external(() =>
      dispatchEmailsDirect(graphResult),
    );

    let userStats = undefined;
    if (results.sent.length > 0) {
      userStats = await conversation.external(async () => {
        const stats = await recordApplicationSent(
          user.telegramId,
          results.sent.length,
        );
        await saveLastSentEmail(
          user.telegramId,
          {
            subject: graphResult.draftSubject,
            body: graphResult.draftBody,
          },
          graphResult.selectedRole?.id,
        );
        return stats;
      });
    }

    await ctx.api
      .deleteMessage(ctx.chat!.id, sendingMsg.message_id)
      .catch(() => {});

    const roleName = graphResult.selectedRole?.name ?? "Default Resume";
    const resumeName = graphResult.selectedResume?.fileName ?? "Resume.pdf";

    let summary = `✅ *Application Sent!*\n\n`;
    summary += `👔 *Role:* ${escapeMarkdown(roleName)}\n`;
    summary += `📎 *Resume:* \`${resumeName}\`\n`;
    summary += `📌 *Subject:* ${escapeMarkdown(graphResult.draftSubject)}\n`;
    summary += `📧 *Delivered:* ${results.sent.length}/${recipientEmails.length}\n`;

    if (results.sent.length > 0) {
      summary += `\n✅ ${results.sent.map((e) => `\`${e}\``).join(", ")}`;
    }

    if (userStats) {
      const jobNoun = userStats.jobsApplied === 1 ? "job" : "jobs";
      const emailNoun = userStats.emailsSent === 1 ? "email" : "emails";
      summary += `\n\n📊 *Your Stats:* ${userStats.jobsApplied} ${jobNoun} applied · ${userStats.emailsSent} ${emailNoun} sent`;
    }

    if (results.failed.length > 0) {
      summary +=
        `\n\n❌ *Failed:*\n` +
        results.failed
          .map((f) => `• \`${f.email}\`: ${f.error}`)
          .join("\n");
    }

    await ctx.reply(summary, {
      parse_mode: "Markdown",
      reply_markup: HOME_KEYBOARD,
    });
  } catch (err) {
    await ctx.api
      .deleteMessage(ctx.chat!.id, sendingMsg.message_id)
      .catch(() => {});
    const msg = err instanceof Error ? err.message : "Unknown error";
    await ctx.reply(
      `❌ *Failed to send:* ${msg}\n\nCheck SMTP settings in 👤 Profile.`,
      { parse_mode: "Markdown", reply_markup: HOME_KEYBOARD },
    );
  }
}
