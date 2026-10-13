import OpenAI from "openai";

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

function buildPrompt(
  resumeText: string,
  jobDesc: string,
  template: string
): string {
  return `You are a professional job application assistant.

Given the following inputs, generate a tailored job application email.

---
RESUME:
${resumeText}

---
JOB DESCRIPTION:
${jobDesc}

---
TONE / TEMPLATE NOTES (from the candidate):
${template || "Professional and concise. Highlight relevant technical skills."}

---
Output ONLY a valid JSON object with exactly these two keys:
{
  "subject": "A compelling, specific email subject line (not generic)",
  "body": "Full email body as HTML. Use only <p>, <strong>, <ul>, <li> tags. No inline styles. No <html>/<body>/<head> tags. Structure: greeting → opening hook matching the role → 2-3 key skills aligned to the JD → closing call-to-action → sign-off."
}

Rules:
- Keep body under 350 words.
- Extract only skills and experiences that genuinely appear in the resume.
- Do NOT invent or hallucinate qualifications.
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
  template: string
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
    raw = await callAI(buildPrompt(resumeText, jobDesc, template));
    const parsed = JSON.parse(raw) as TailoredApplication;
    if (!parsed.subject || !parsed.body) throw new Error("Missing keys");
    return parsed;
  } catch {
    // Retry once with an even more explicit instruction
    const retryPrompt =
      buildPrompt(resumeText, jobDesc, template) +
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
