/**
 * LangGraph-powered unified application pipeline.
 *
 * Replaces the old separate apply / mail flows with a single intelligent graph:
 *
 *   scrapeAndParse → matchResume → evaluateScreeningNeeds → generateEmail
 *       → (human preview interrupt) → dispatchEmails → END
 *
 * Each node is a modular "tool" that reads/writes shared ApplyState.
 */

import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type {
  CandidateProfile,
  UserRole,
  UserResume,
  UserSmtp,
} from "../models/User.js";
import { fetchJobPage, extractUrl, isUrl } from "./scraper.js";
import { sendApplicationEmail } from "./mailer.js";
import {
  tailorApplication,
  cleanApplicationBody,
} from "./ai.js";

// ── LLM instance (same OpenRouter endpoint the rest of the bot uses) ────────

function getLLM() {
  return new ChatOpenAI({
    modelName: process.env["OPENROUTER_MODEL"] ?? "openai/gpt-4o-mini",
    openAIApiKey: process.env["OPEN_AI_KEY"] || "dummy-key",
    configuration: {
      baseURL:
        process.env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "tg-resume-bot",
        "X-Title": "Telegram Resume Bot",
      },
    },
  });
}

// ── State definition ────────────────────────────────────────────────────────

export const ApplyAnnotation = Annotation.Root({
  // Inputs (set by the conversation before invoking the graph)
  telegramId: Annotation<number>,
  rawInput: Annotation<string>,               // URL, JD text, or role title
  recipientEmails: Annotation<string[]>,       // comma-separated, deduped
  botToken: Annotation<string>,
  userSmtp: Annotation<UserSmtp | undefined>,
  template: Annotation<string>,
  allRoles: Annotation<UserRole[]>,
  defaultResume: Annotation<UserResume | undefined>,
  candidateProfile: Annotation<CandidateProfile | undefined>,

  // Populated by graph nodes
  jobDescription: Annotation<string>,
  jobTitle: Annotation<string>,
  company: Annotation<string>,
  scrapedEmails: Annotation<string[]>,         // emails found from URL scraping
  selectedRole: Annotation<UserRole | undefined>,
  selectedResume: Annotation<UserResume | undefined>,
  matchReasoning: Annotation<string>,
  requestedMetrics: Annotation<string[]>,      // which screening fields JD asks for
  draftSubject: Annotation<string>,
  draftBody: Annotation<string>,               // HTML
  sendResults: Annotation<{ sent: string[]; failed: { email: string; error: string }[] }>,
  status: Annotation<string>,                  // tracks current phase
  error: Annotation<string>,
});

export type ApplyState = typeof ApplyAnnotation.State;

// ── Node 1: Scrape & Parse ──────────────────────────────────────────────────

async function scrapeAndParse(state: ApplyState): Promise<Partial<ApplyState>> {
  const input = state.rawInput.trim();

  // If input looks like a URL, scrape it
  const url = extractUrl(input);
  if (url && isUrl(input)) {
    try {
      const page = await fetchJobPage(url);
      return {
        jobDescription: page.description,
        jobTitle: page.title ?? "",
        company: page.company ?? "",
        scrapedEmails: page.emails,
        status: "scraped",
      };
    } catch (err) {
      // Scraping failed — treat as raw text
      return {
        jobDescription: input,
        jobTitle: "",
        company: "",
        scrapedEmails: [],
        status: "scraped",
      };
    }
  }

  // Otherwise it's raw JD text or a role/profile title
  return {
    jobDescription: input,
    jobTitle: "",
    company: "",
    scrapedEmails: [],
    status: "scraped",
  };
}

// ── Node 2: Match Resume ────────────────────────────────────────────────────

async function matchResume(state: ApplyState): Promise<Partial<ApplyState>> {
  const roles = state.allRoles;
  const rolesWithResume = roles.filter((r) => !!r.resume);

  // If only one option (or none), use it directly — no AI needed
  if (rolesWithResume.length === 0) {
    if (state.defaultResume) {
      return {
        selectedRole: undefined,
        selectedResume: state.defaultResume,
        matchReasoning: "Only default resume available — selected automatically.",
        status: "matched",
      };
    }
    return {
      error: "No resumes found. Please upload a resume or create a role with a resume first.",
      status: "error",
    };
  }

  if (rolesWithResume.length === 1 && !state.defaultResume) {
    const only = rolesWithResume[0]!;
    return {
      selectedRole: only,
      selectedResume: only.resume,
      matchReasoning: `Only one role with resume ("${only.name}") — selected automatically.`,
      status: "matched",
    };
  }

  // Multiple roles — use AI to pick the best match
  const jd = state.jobDescription || state.rawInput;

  const roleSummaries = rolesWithResume.map((r, i) => {
    const resumeSnippet = r.resume!.text.slice(0, 800);
    return `Role ${i + 1}: "${r.name}"\nResume snippet: ${resumeSnippet}\n`;
  });

  if (state.defaultResume) {
    const snippet = state.defaultResume.text.slice(0, 800);
    roleSummaries.push(`Role ${rolesWithResume.length + 1}: "Default Resume"\nResume snippet: ${snippet}\n`);
  }

  const prompt = `You are a resume-matching assistant. Given a Job Description and multiple candidate roles (each with a resume), pick the BEST matching role.

JOB DESCRIPTION:
${jd.slice(0, 3000)}

AVAILABLE ROLES:
${roleSummaries.join("\n---\n")}

Respond ONLY with a JSON object:
{
  "bestRoleIndex": <1-based index of the best role>,
  "matchScore": <0.0-1.0>,
  "reasoning": "<one sentence explaining why>"
}`;

  try {
    const llm = getLLM();
    const response = await llm.invoke([{ role: "user", content: prompt }], {
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content)
    ) as { bestRoleIndex: number; matchScore: number; reasoning: string };

    const idx = parsed.bestRoleIndex - 1;

    // Check if AI selected default resume (last index when default exists)
    if (state.defaultResume && idx === rolesWithResume.length) {
      return {
        selectedRole: undefined,
        selectedResume: state.defaultResume,
        matchReasoning: parsed.reasoning,
        status: "matched",
      };
    }

    const bestRole = rolesWithResume[idx] ?? rolesWithResume[0]!;
    return {
      selectedRole: bestRole,
      selectedResume: bestRole.resume,
      matchReasoning: parsed.reasoning,
      status: "matched",
    };
  } catch {
    // Fallback: pick first role
    const fallback = rolesWithResume[0]!;
    return {
      selectedRole: fallback,
      selectedResume: fallback.resume,
      matchReasoning: "AI matching failed — selected first available role.",
      status: "matched",
    };
  }
}

// ── Node 3: Evaluate Screening Needs ────────────────────────────────────────

const ALL_METRIC_FIELDS = [
  "officialName",
  "dob",
  "mobile",
  "emailId",
  "totalExperience",
  "currentCompany",
  "currentLocation",
  "preferredLocation",
  "currentCtc",
  "noticePeriod",
  "relevantExperience",
  "expectedCtc",
  "holdingOffer",
] as const;

async function evaluateScreeningNeeds(
  state: ApplyState,
): Promise<Partial<ApplyState>> {
  const jd = state.jobDescription || state.rawInput;

  if (!jd || jd.length < 30) {
    // No meaningful JD — don't include any screening metrics
    return { requestedMetrics: [], status: "screening_done" };
  }

  const prompt = `You are an HR screening analyst. Given a Job Description, determine which candidate screening fields the recruiter is likely to ask for or would benefit from receiving upfront.

JOB DESCRIPTION:
${jd.slice(0, 3000)}

AVAILABLE FIELDS:
${ALL_METRIC_FIELDS.join(", ")}

Field descriptions:
- officialName: Full legal name
- dob: Date of birth
- mobile: Contact phone number
- emailId: Contact email
- totalExperience: Overall years of work experience
- currentCompany: Current employer
- currentLocation: Current city/location
- preferredLocation: Preferred work locations
- currentCtc: Current compensation/CTC
- noticePeriod: Notice period or last working day
- relevantExperience: Experience relevant to the specific role
- expectedCtc: Expected/desired compensation
- holdingOffer: Whether candidate is holding another offer

Respond ONLY with a JSON object:
{
  "requestedFields": ["field1", "field2", ...],
  "reasoning": "brief explanation"
}

Rules:
- Only include fields the JD explicitly or strongly implies are needed
- Always include totalExperience and relevantExperience if the JD mentions experience requirements
- Include currentCtc/expectedCtc only if the JD discusses compensation/salary
- Include noticePeriod if JD mentions urgency, immediate joining, or notice period
- Include currentLocation/preferredLocation if JD mentions location or remote/onsite
- Do NOT include dob, mobile, emailId, officialName unless the JD specifically asks
- If the JD is vague/general, return only ["totalExperience", "relevantExperience"]`;

  try {
    const llm = getLLM();
    const response = await llm.invoke([{ role: "user", content: prompt }], {
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content)
    ) as { requestedFields: string[]; reasoning: string };

    // Validate field names
    const valid = parsed.requestedFields.filter((f) =>
      (ALL_METRIC_FIELDS as readonly string[]).includes(f),
    );

    return { requestedMetrics: valid, status: "screening_done" };
  } catch {
    // Fallback: include common fields
    return {
      requestedMetrics: ["totalExperience", "relevantExperience", "noticePeriod"],
      status: "screening_done",
    };
  }
}

// ── Node 4: Generate Email ──────────────────────────────────────────────────

/**
 * Builds a partial CandidateProfile + role containing only the requested
 * screening metrics, so the email generator only includes relevant info.
 */
function filterProfileByMetrics(
  profile: CandidateProfile | undefined,
  role: UserRole | undefined,
  requestedMetrics: string[],
): { filteredProfile?: CandidateProfile | undefined; filteredRole?: UserRole | undefined } {
  if (requestedMetrics.length === 0) {
    return {};
  }

  const profileFields = new Set([
    "officialName", "dob", "mobile", "emailId",
    "totalExperience", "currentCompany", "currentLocation",
    "preferredLocation", "currentCtc", "noticePeriod",
  ]);
  const roleFields = new Set(["relevantExperience", "expectedCtc", "holdingOffer"]);

  let filteredProfile: CandidateProfile | undefined;
  let filteredRole: UserRole | undefined;

  if (profile) {
    filteredProfile = {} as CandidateProfile;
    for (const field of requestedMetrics) {
      if (profileFields.has(field) && profile[field as keyof CandidateProfile]) {
        (filteredProfile as Record<string, unknown>)[field] =
          profile[field as keyof CandidateProfile];
      }
    }
    // If nothing was actually populated, don't pass it
    if (Object.keys(filteredProfile).length === 0) filteredProfile = undefined;
  }

  if (role) {
    filteredRole = { ...role };
    // Remove role screening fields not requested
    for (const field of ["relevantExperience", "expectedCtc", "holdingOffer"] as const) {
      if (!requestedMetrics.includes(field)) {
        filteredRole[field] = undefined;
      }
    }
  }

  return { filteredProfile, filteredRole };
}

async function generateEmail(
  state: ApplyState,
): Promise<Partial<ApplyState>> {
  const resumeText = state.selectedResume?.text ?? "";
  const jd = state.jobDescription || state.rawInput;

  const { filteredProfile, filteredRole } = filterProfileByMetrics(
    state.candidateProfile,
    state.selectedRole,
    state.requestedMetrics ?? [],
  );

  try {
    const application = await tailorApplication(
      resumeText,
      jd,
      state.template ?? "",
      filteredProfile,
      filteredRole,
    );

    return {
      draftSubject: application.subject,
      draftBody: application.body,
      status: "preview",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown AI error";
    return { error: `AI generation failed: ${msg}`, status: "error" };
  }
}

// ── Node 5: Dispatch Emails ─────────────────────────────────────────────────

async function dispatchEmails(
  state: ApplyState,
): Promise<Partial<ApplyState>> {
  const emails = state.recipientEmails;
  const sent: string[] = [];
  const failed: { email: string; error: string }[] = [];

  for (const email of emails) {
    try {
      await sendApplicationEmail({
        to: email,
        subject: state.draftSubject,
        htmlBody: state.draftBody,
        userSmtp: state.userSmtp!,
        resumeFileId: state.selectedResume!.fileId,
        resumeFileName: state.selectedResume!.fileName,
        botToken: state.botToken,
      });
      sent.push(email);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      failed.push({ email, error: msg });
    }
  }

  return {
    sendResults: { sent, failed },
    status: "done",
  };
}

// ── Graph Construction ──────────────────────────────────────────────────────

/**
 * Builds and compiles the LangGraph application graph.
 *
 * The graph runs: scrape → match → evaluate screening → generate email → END
 *
 * The conversation layer handles the human-in-the-loop preview step between
 * generateEmail and dispatchEmails by running the graph in two stages:
 *   1. graph.invoke(state) — runs up to generateEmail, returns state with preview
 *   2. After user confirms, call dispatchEmailsDirect(state) to send
 *
 * This avoids LangGraph interrupt complexity and keeps Telegram interaction
 * cleanly separated from the pipeline logic.
 */
export function buildApplyGraph() {
  const graph = new StateGraph(ApplyAnnotation)
    .addNode("scrapeAndParse", scrapeAndParse)
    .addNode("matchResume", matchResume)
    .addNode("evaluateScreeningNeeds", evaluateScreeningNeeds)
    .addNode("generateEmail", generateEmail)
    // Edges: linear pipeline
    .addEdge("__start__", "scrapeAndParse")
    .addEdge("scrapeAndParse", "matchResume")
    .addEdge("matchResume", "evaluateScreeningNeeds")
    .addEdge("evaluateScreeningNeeds", "generateEmail")
    .addEdge("generateEmail", "__end__");

  return graph.compile();
}

/**
 * Runs the dispatch step directly (called after human preview confirmation).
 * Kept as a standalone function instead of going through the graph to avoid
 * needing LangGraph interrupts for the Telegram human-in-the-loop pattern.
 */
export async function dispatchEmailsDirect(
  state: ApplyState,
): Promise<{ sent: string[]; failed: { email: string; error: string }[] }> {
  const result = await dispatchEmails(state);
  return result.sendResults!;
}

