import type { BotContext, MyConversation } from "../types.js";
import { getCandidateProfile, updateCandidateProfile } from "../services/user.js";
import type { CandidateProfile } from "../models/User.js";

/**
 * Conversation: Candidate Profile Setup & Update Flow
 *
 * Prompts user sequentially for global candidate screening fields.
 * (Role-specific fields like relevant experience, expected CTC, and holding offers
 * are managed per role via /roles).
 *
 * User can type /skip to keep existing or skip, or /cancel to abort.
 */
export async function profileFlow(
  conversation: MyConversation,
  ctx: BotContext
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const current = (await conversation.external(() => getCandidateProfile(telegramId))) ?? {};

  await ctx.reply(
    "📝 *Candidate Global Profile Setup*\n\n" +
      "I'll help you configure your global screening profile.\n" +
      "These details apply across your applications, while role-specific details (relevant experience, expected CTC, holding offer) are configured per role under /roles.\n\n" +
      "_Tip: Send /skip to keep the existing value or leave blank, or /cancel to abort at any time._",
    { parse_mode: "Markdown" }
  );

  const promptField = async (
    fieldTitle: string,
    fieldKey: keyof CandidateProfile,
    example: string
  ): Promise<string | undefined> => {
    const existingVal = current[fieldKey] ? ` (Current: _${current[fieldKey]}_)` : "";
    await ctx.reply(
      `👉 *${fieldTitle}*${existingVal}\n_e.g. ${example}_\nSend your value or /skip:`,
      { parse_mode: "Markdown" }
    );

    const reply = await conversation.waitFor("message:text");
    const text = reply.message.text.trim();

    if (text === "/cancel") {
      throw new Error("CANCELLED");
    }

    if (text === "/skip") {
      return (current[fieldKey] as string | undefined);
    }

    return text;
  };

  try {
    const officialName = await promptField(
      "1. Official Name (as per Govt ID proof / Passport)",
      "officialName",
      "John Doe"
    );

    const mobile = await promptField(
      "2. Mobile Number",
      "mobile",
      "+91 9876543210"
    );

    const emailId = await promptField(
      "3. Candidate Contact Email ID",
      "emailId",
      "john.doe@gmail.com"
    );

    const dob = await promptField(
      "4. Date of Birth",
      "dob",
      "15/08/1995"
    );

    const totalExperience = await promptField(
      "5. Total Work Experience",
      "totalExperience",
      "5.5 Years"
    );

    const currentCompany = await promptField(
      "6. Current Company",
      "currentCompany",
      "Acme Tech Pvt Ltd"
    );

    const currentLocation = await promptField(
      "7. Current Location",
      "currentLocation",
      "Bangalore"
    );

    const preferredLocation = await promptField(
      "8. Preferred Location",
      "preferredLocation",
      "Remote / Bangalore / Hyderabad"
    );

    const currentCtc = await promptField(
      "9. Current CTC",
      "currentCtc",
      "14 LPA"
    );

    const noticePeriod = await promptField(
      "10. Notice Period / If Serving, LWD",
      "noticePeriod",
      "30 Days (Serving notice, LWD: 30th Nov)"
    );

    const profileData: Partial<CandidateProfile> = {
      officialName,
      mobile,
      emailId,
      dob,
      totalExperience,
      currentCompany,
      currentLocation,
      preferredLocation,
      currentCtc,
      noticePeriod,
    };

    await conversation.external(() =>
      updateCandidateProfile(telegramId, profileData)
    );

    await ctx.reply(
      "✅ *Candidate Profile saved successfully!*\n\n" +
        `👤 *Official Name:* ${officialName || "—"}\n` +
        `📱 *Mobile:* ${mobile || "—"}\n` +
        `📧 *Email:* ${emailId || "—"}\n` +
        `🎂 *DOB:* ${dob || "—"}\n` +
        `💼 *Total Exp:* ${totalExperience || "—"}\n` +
        `🏢 *Current Co:* ${currentCompany || "—"}\n` +
        `📍 *Location:* ${currentLocation || "—"} → ${preferredLocation || "—"}\n` +
        `💰 *Current CTC:* ${currentCtc || "—"}\n` +
        `⏳ *Notice Period:* ${noticePeriod || "—"}\n\n` +
        "_💡 Note: Role-specific details (Relevant Experience, Expected CTC, Holding Offer) are configured per role under /roles._\n\n" +
        "You can view your profile with /candidate_profile or edit with /edit_profile.",
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    if (err instanceof Error && err.message === "CANCELLED") {
      await ctx.reply("❌ Profile setup cancelled. No changes were made.");
    } else {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await ctx.reply(`⚠️ Profile setup encountered an error: ${msg}`);
    }
  }
}
