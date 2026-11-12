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

export interface ParsedJobInfo {
  /** Recruiter / HR / contact emails found on the page */
  emails: string[];
  /** Job title / role name */
  title?: string;
  /** Company name */
  company?: string;
}

export interface TailoredApplication {
  subject: string;
  body: string; // HTML string using <p>, <strong>, <ul><li> only
}

export function formatCandidateDetails(
  profile?: CandidateProfile,
  role?: UserRole
): string {
  if (!profile && !role) return "";
  const lines: string[] = [];

  // 1. Total / Relevant Experience
  const totalExp = profile?.totalExperience;
  const relExp = role?.relevantExperience;
  if (totalExp && relExp) {
    lines.push(`Total / Relevant Experience: ${totalExp} / ${relExp}`);
  } else if (totalExp) {
    lines.push(`Total Experience: ${totalExp}`);
  } else if (relExp) {
    lines.push(`Relevant Experience: ${relExp}`);
  }

  // 2. Current Organization
  if (profile?.currentCompany) {
    lines.push(`Current Organization: ${profile.currentCompany}`);
  }

  // 3. Notice Period
  if (profile?.noticePeriod) {
    lines.push(`Notice Period: ${profile.noticePeriod}`);
  }

  // 4. Current / Expected CTC
  const currentCtc = profile?.currentCtc;
  const expectedCtc = role?.expectedCtc ?? profile?.expectedCtc;
  if (currentCtc && expectedCtc) {
    lines.push(`Current / Expected CTC: ${currentCtc} / ${expectedCtc}`);
  } else if (currentCtc) {
    lines.push(`Current CTC: ${currentCtc}`);
  } else if (expectedCtc) {
    lines.push(`Expected CTC: ${expectedCtc}`);
  }

  // 5. Current / Preferred Location
  const curLoc = profile?.currentLocation;
  const prefLoc = profile?.preferredLocation;
  if (curLoc && prefLoc) {
    lines.push(`Current / Preferred Location: ${curLoc} / ${prefLoc}`);
  } else if (curLoc) {
    lines.push(`Current Location: ${curLoc}`);
  } else if (prefLoc) {
    lines.push(`Preferred Location: ${prefLoc}`);
  }

  // 6. Education (College/University)
  if (profile?.education) {
    lines.push(`Education (College/University): ${profile.education}`);
  }

  // 7. Reason for Job Change
  if (profile?.reasonForChange) {
    lines.push(`Reason for Job Change: ${profile.reasonForChange}`);
  }

  // 8. Role-specific additional application details
  if (role?.holdingOffer) {
    lines.push(`Holding Offer: ${role.holdingOffer}`);
  }

  // 9. Candidate identification details if present
  if (profile?.officialName) lines.push(`Official Name: ${profile.officialName}`);
  if (profile?.emailId) lines.push(`Email: ${profile.emailId}`);
  if (profile?.mobile) lines.push(`Mobile: ${profile.mobile}`);
  if (profile?.dob) lines.push(`DOB: ${profile.dob}`);

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
  const candidateName = profile?.officialName || "[Candidate Name]";
  const candidateMobile = profile?.mobile;

  const signOffExample = candidateMobile
    ? `<p>Best regards,<br>${candidateName}<br>${candidateMobile}</p>`
    : `<p>Best regards,<br>${candidateName}</p>`;

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
- Keyword & Skill Alignment: Carefully analyze the Job Description to extract its core requirements, technical keywords, tools, and responsibilities. Cross-reference them with the candidate's Resume and skills. You MUST explicitly mention these matching relevant keywords and skills in the email content, directly aligning the candidate's hands-on experience and achievements with the employer's needs.
- Technical Skills Formatting: Make key technical skills, tools, frameworks, and technologies (such as CI/CD, Docker, Kubernetes, AWS, languages/frameworks, and matching JD keywords) bold using <strong> tags (e.g. <strong>CI/CD</strong>, <strong>Docker</strong>) throughout the email body so they stand out boldly in black formatting.
- Section Name: If candidate screening details/relevant info are provided, title this section strictly as "Relevant Info" (e.g., <p><strong>Relevant Info:</strong></p>). Do NOT name it "Candidate Screening Details".
- Bold Values in Relevant Info: Present the Relevant Info as a bulleted list (<ul><li>). For every item, bold the value using <strong> (e.g., <li>Total / Relevant Experience: <strong>5 Years / 3.5 Years</strong></li>, <li>Current Organization: <strong>Acme Tech Pvt Ltd</strong></li>, <li>Notice Period: <strong>30 Days</strong></li>, <li>Current / Expected CTC: <strong>14 LPA / 20 LPA</strong></li>, <li>Current / Preferred Location: <strong>Bengaluru / Remote</strong></li>, <li>Education (College/University): <strong>B.Tech in CSE, XYZ University</strong></li>, <li>Reason for Job Change: <strong>Career Growth</strong></li>).
- Strictly No Generic Interview Call-to-Action: Do NOT generate filler or boilerplate closing interview-request paragraphs after the content (such as "I would welcome the opportunity to discuss how my expertise aligns with your requirements. Please let me know a convenient time for an interview." or similar variants).
- Sign-off: Conclude directly with a polite sign-off:
  ${signOffExample}
  CRITICAL: If a contact number (${candidateMobile || "none"}) is available, you MUST place it directly on the line below the candidate's name.
- Subject must reference the specific role or company if identifiable from the JD.
- Respond ONLY with the JSON object. No markdown fences, no commentary.`;
}

export function cleanApplicationBody(body: string, candidateName?: string, mobile?: string): string {
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

  // 4. Ensure contact number is placed below the candidate name in the sign-off if available
  if (mobile && mobile.trim()) {
    const trimmedMobile = mobile.trim();
    if (!cleaned.includes(trimmedMobile)) {
      cleaned = cleaned.replace(
        /(<p>\s*(?:Best regards|Warm regards|Regards|Sincerely|Thank you|Thanks & regards)[\s\S]*?)(<\/p>)/i,
        (match, p1, p2) => {
          if (p1.includes(trimmedMobile)) return match;
          return `${p1}<br>${trimmedMobile}${p2}`;
        }
      );
    }
  }

  // 5. If official candidate name is provided, replace generic placeholders
  if (candidateName && candidateName.trim()) {
    cleaned = cleaned.replace(/\[(?:Candidate Name|Your Name|Candidate's Name|Name)\]/gi, candidateName.trim());
  }

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
    parsed.body = cleanApplicationBody(parsed.body, profile?.officialName, profile?.mobile);
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
    parsed.body = cleanApplicationBody(parsed.body, profile?.officialName, profile?.mobile);
    return parsed;
  }
}
/**
 * Uses OpenAI function-calling (tool use) to extract structured info from a
 * job page's text content: recruiter/HR emails + job title + company.
 *
 * Falls back to empty results if the model cannot extract anything useful.
 */
export async function parseJobPageWithAI(
  pageContent: string,
  pageUrl?: string
): Promise<ParsedJobInfo> {
  const model = process.env["OPENROUTER_MODEL"] ?? "openai/gpt-4o-mini";

  // Truncate to avoid blowing token limits; 6000 chars gives ample context
  const truncated =
    pageContent.length > 6000
      ? pageContent.slice(0, 6000) + "\n...[truncated]"
      : pageContent;

  const systemPrompt = [
    "You are a job page parser. Your ONLY task is to call the extract_job_info tool with information found in the given job posting text.",
    "For emails: only include actual recruiter, HR, or hiring-contact emails. Ignore placeholder, example, noreply, and generic marketing emails.",
    "If you cannot find an email, return an empty array for emails.",
    "If you cannot find a title or company, omit those fields.",
  ].join(" ");

  const userMessage = [
    pageUrl ? `URL: ${pageUrl}` : "",
    "---",
    "JOB PAGE CONTENT:",
    truncated,
  ]
    .filter(Boolean)
    .join("\n");

  const extractTool: OpenAI.Chat.ChatCompletionTool = {
    type: "function",
    function: {
      name: "extract_job_info",
      description:
        "Extract recruiter/HR contact emails, the job title, and the company name from a job posting page.",
      parameters: {
        type: "object",
        properties: {
          emails: {
            type: "array",
            items: { type: "string" },
            description:
              "List of recruiter, HR, or hiring-contact email addresses found on the page. Exclude placeholder, noreply, or generic marketing emails.",
          },
          title: {
            type: "string",
            description: "The job title or role name advertised in this posting.",
          },
          company: {
            type: "string",
            description: "The name of the hiring company or organisation.",
          },
        },
        required: ["emails"],
      },
    },
  };

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      tools: [extractTool],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool_choice: { type: "function", function: { name: "extract_job_info" } } as any,
    });

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];
    // Narrow to the standard function-call variant (has a .function property)
    if (
      !rawToolCall ||
      !("function" in rawToolCall) ||
      (rawToolCall as { function?: { name: string } }).function?.name !==
        "extract_job_info"
    ) {
      return { emails: [] };
    }

    const fnCall = rawToolCall as {
      function: { name: string; arguments: string };
    };

    const args = JSON.parse(fnCall.function.arguments) as {
      emails?: unknown;
      title?: unknown;
      company?: unknown;
    };

    const emails = Array.isArray(args.emails)
      ? (args.emails as string[]).filter(
          (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
        )
      : [];

    const result: ParsedJobInfo = { emails };
    if (typeof args.title === "string" && args.title) result.title = args.title;
    if (typeof args.company === "string" && args.company)
      result.company = args.company;

    return result;
  } catch {
    // Non-fatal: caller will fall back to regex-extracted data
    return { emails: [] };
  }
}
