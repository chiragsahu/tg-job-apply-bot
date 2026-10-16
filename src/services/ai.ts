import OpenAI from "openai";
import type { CandidateProfile, UserRole } from "../models/User.js";

const client = new OpenAI({
  apiKey: process.env["OPEN_AI_KEY"],
  baseURL: process.env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "tg-resume-bot",
    "X-Title": "Telegram Resume Bot",
  },
});

export interface TailoredApplication {
  subject: string;
  body: string; // HTML string using <p>, <strong>, <ul><li> only
}

function formatCandidateDetails(
  profile?: CandidateProfile,
  role?: UserRole
): string {
  if (!profile && !role) return "";
  const lines: string[] = [];

  // Global candidate profile details
  if (profile?.officialName) lines.push(`Official Name (as per Govt ID): ${profile.officialName}`);
  if (profile?.emailId) lines.push(`Email: ${profile.emailId}`);
  if (profile?.mobile) lines.push(`Mobile: ${profile.mobile}`);
  if (profile?.dob) lines.push(`DOB: ${profile.dob}`);
  if (profile?.totalExperience) lines.push(`Total Experience: ${profile.totalExperience}`);
  if (profile?.currentCompany) lines.push(`Current Company: ${profile.currentCompany}`);
  if (profile?.currentLocation) lines.push(`Current Location: ${profile.currentLocation}`);
  if (profile?.preferredLocation) lines.push(`Preferred Location: ${profile.preferredLocation}`);
  if (profile?.currentCtc) lines.push(`Current CTC: ${profile.currentCtc}`);
  if (profile?.noticePeriod) lines.push(`Notice Period / LWD: ${profile.noticePeriod}`);

  // Role-specific application details
  if (role) {
    if (role.relevantExperience) {
      lines.push(`Relevant Experience for ${role.name}: ${role.relevantExperience}`);
    }
    if (role.expectedCtc) {
      lines.push(`Expected CTC (for ${role.name}): ${role.expectedCtc}`);
    }
    if (role.holdingOffer) {
      lines.push(`Holding Offer: ${role.holdingOffer}`);
    }
  }

  if (lines.length === 0) return "";

  return `\n---\nCANDIDATE SCREENING DETAILS:\n` + lines.join("\n") + "\n";
}

function buildPrompt(
  resumeText: string,
  jobDesc: string,
  template: string,
  profile?: CandidateProfile,
  role?: UserRole
): string {
  const candidateDetailsBlock = formatCandidateDetails(profile, role);

  return `You are a professional job application assistant.

Given the following inputs, generate a tailored job application email.

---
RESUME:
${resumeText}
${candidateDetailsBlock}
---
JOB DESCRIPTION:
${jobDesc || "General application matching candidate's qualifications."}

---
TONE / TEMPLATE NOTES (from the candidate):
${template || "Professional and concise. Highlight relevant technical skills."}

---
Output ONLY a valid JSON object with exactly these two keys:
{
  "subject": "A compelling, specific email subject line (not generic)",
  "body": "Full email body as HTML. Use only <p>, <strong>, <ul>, <li> tags. No inline styles. No <html>/<body>/<head> tags. Structure: greeting → opening hook matching the role → 2-3 key skills aligned to the JD → candidate screening summary block if screening details provided (e.g. Total Exp, Relevant Exp, Notice Period, Current/Pref Location, CTC) → closing call-to-action → sign-off."
}

Rules:
- Keep body under 380 words.
- Extract only skills and experiences that genuinely appear in the resume or candidate details.
- Do NOT invent or hallucinate qualifications.
- If candidate screening details are provided, present them neatly in a bulleted list (<ul><li>) so recruiters can immediately review key metrics.
- Subject must reference the specific role or company if identifiable from the JD.
- Respond ONLY with the JSON object. No markdown fences, no commentary.`;
}

/**
 * Calls OpenRouter to generate a tailored job application email.
 * Returns { subject, body } where body is light HTML.
 *
 * Retries once with a stricter prompt if JSON parsing fails.
 */
export async function tailorApplication(
  resumeText: string,
  jobDesc: string,
  template: string,
  profile?: CandidateProfile,
  role?: UserRole
): Promise<TailoredApplication> {
  const model =
    process.env["OPENROUTER_MODEL"] ?? "openai/gpt-4o-mini";

  const callAI = async (prompt: string): Promise<string> => {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("AI returned an empty response.");
    return content;
  };

  let raw: string;
  try {
    raw = await callAI(buildPrompt(resumeText, jobDesc, template, profile, role));
    const parsed = JSON.parse(raw) as TailoredApplication;
    if (!parsed.subject || !parsed.body) throw new Error("Missing keys");
    return parsed;
  } catch {
    // Retry once with an even more explicit instruction
    const retryPrompt =
      buildPrompt(resumeText, jobDesc, template, profile, role) +
      "\n\nIMPORTANT: Your previous response failed JSON parsing. Respond ONLY with a raw JSON object, nothing else.";

    raw = await callAI(retryPrompt);
    const parsed = JSON.parse(raw) as TailoredApplication;
    if (!parsed.subject || !parsed.body) {
      throw new Error(
        "AI failed to produce a valid application after two attempts. Please try again."
      );
    }
    return parsed;
  }
}


