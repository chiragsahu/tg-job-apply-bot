import OpenAI from "openai";
import type { CandidateProfile, UserRole } from "../models/User.js";

const client = new OpenAI({
  apiKey: process.env["OPEN_AI_KEY"] || "dummy-key",
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

  return `\n---\nRELEVANT INFO:\n` + lines.join("\n") + "\n";
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
  "body": "Full email body as HTML. Use only <p>, <strong>, <ul>, <li> tags. No inline styles. No <html>/<body>/<head> tags. Structure: greeting → opening hook matching the role → 2-3 key technical skills aligned to the JD → 'Relevant Info' section (if screening details are provided) → sign-off."
}

Rules:
- Keep body under 380 words.
- Extract only skills and experiences that genuinely appear in the resume or candidate details.
- Do NOT invent or hallucinate qualifications.
- Technical Skills Formatting: Make key technical skills, tools, frameworks, and technologies (such as CI/CD, Docker, Kubernetes, AWS, languages/frameworks) bold using <strong> tags (e.g. <strong>CI/CD</strong>, <strong>Docker</strong>) throughout the email body so they stand out boldly in black formatting.
- Section Name: If candidate screening details/relevant info are provided, title this section strictly as "Relevant Info" (e.g., <p><strong>Relevant Info:</strong></p>). Do NOT name it "Candidate Screening Details".
- Bold Values in Relevant Info: Present the Relevant Info as a bulleted list (<ul><li>). For every item, bold the value using <strong> (e.g., <li>Total Experience: <strong>5 Years</strong></li>, <li>Relevant Experience: <strong>3+ Years</strong></li>, <li>Notice Period / LWD: <strong>15 Days</strong></li>, <li>Current Location: <strong>Bengaluru</strong></li>, <li>Expected CTC: <strong>Negotiable</strong></li>).
- Strictly No Generic Interview Call-to-Action: Do NOT generate filler or boilerplate closing interview-request paragraphs after the content (such as "I would welcome the opportunity to discuss how my expertise aligns with your requirements. Please let me know a convenient time for an interview." or similar variants). Conclude directly with a polite sign-off (e.g., <p>Best regards,<br>[Candidate Name]</p>).
- Subject must reference the specific role or company if identifiable from the JD.
- Respond ONLY with the JSON object. No markdown fences, no commentary.`;
}

export function cleanApplicationBody(body: string): string {
  let cleaned = body;

  // 1. Remove unwanted boilerplate closing sentences / paragraphs
  // e.g. "I would welcome the opportunity to discuss how my expertise aligns with your requirements. Please let me know a convenient time for an interview."
  cleaned = cleaned
    .replace(/<p>\s*I would welcome the opportunity to discuss[\s\S]*?(?:interview|convenient time)\.?\s*<\/p>/gi, "")
    .replace(/<p>\s*Please let me know a convenient time for an interview\.?\s*<\/p>/gi, "")
    .replace(/<p>\s*I look forward to discussing how my (?:skills|expertise|experience)[\s\S]*?interview\.?\s*<\/p>/gi, "")
    .replace(/I would welcome the opportunity to discuss how my (?:skills|expertise|experience) aligns? with your requirements\.?\s*/gi, "")
    .replace(/Please let me know a convenient time for an interview\.?\s*/gi, "")
    .replace(/<p>\s*<\/p>/gi, "");

  // 2. Ensure section title is "Relevant Info" if AI used "Candidate Screening Details" or similar
  cleaned = cleaned.replace(
    /(?:<p>\s*)?<strong>\s*(?:Candidate\s+Screening\s+(?:Details|Summary)|Screening\s+Details)\s*:?\s*<\/strong>(?:\s*<\/p>)?/gi,
    "<p><strong>Relevant Info:</strong></p>"
  );

  // 3. Ensure list items have values bolded if AI left them plain
  cleaned = cleaned.replace(/<li>([^:<]+:\s*)([^<]+)<\/li>/gi, (_, prefix, val) => {
    return `<li>${prefix}<strong>${val.trim()}</strong></li>`;
  });
  cleaned = cleaned.replace(/<li>(<strong>.*?<\/strong>:?\s*)([^<]+)<\/li>/gi, (_, prefix, val) => {
    return `<li>${prefix}<strong>${val.trim()}</strong></li>`;
  });

  return cleaned.trim();
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
    parsed.body = cleanApplicationBody(parsed.body);
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
    parsed.body = cleanApplicationBody(parsed.body);
    return parsed;
  }
}


