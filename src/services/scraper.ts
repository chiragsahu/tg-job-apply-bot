import * as cheerio from "cheerio";
import { parseJobPageWithAI } from "./ai.js";

export interface JobPageResult {
  url: string;
  title?: string | undefined;
  company?: string | undefined;
  description: string;
  emails: string[];
}

const URL_REGEX = /https?:\/\/[^\s<>"'{}|\\^`]+|www\.[^\s<>"'{}|\\^`]+/i;

const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// Ignored extensions and common placeholder domains/emails
const IGNORED_EMAIL_EXTENSIONS = /\.(png|jpg|jpeg|webp|gif|svg|bmp|tiff|pdf|ico)$/i;
const IGNORED_EMAILS = new Set([
  "example@example.com",
  "user@example.com",
  "email@domain.com",
  "name@email.com",
  "your@email.com",
  "test@test.com",
  "you@company.com",
  "info@example.com",
]);

/**
 * Detects if a string contains or is a URL.
 */
export function extractUrl(text: string): string | null {
  if (!text) return null;
  const match = text.match(URL_REGEX);
  if (!match) return null;
  let url = match[0];
  if (url.toLowerCase().startsWith("www.")) {
    url = "https://" + url;
  }
  return url;
}

/**
 * Checks whether the input string is predominantly a URL.
 */
export function isUrl(text: string): boolean {
  const url = extractUrl(text);
  if (!url) return false;
  // If the URL constitutes most of the text (allowing surrounding whitespace/punctuation)
  const trimmed = text.trim();
  return trimmed === url || trimmed.length <= url.length + 10;
}

/**
 * Extracts and sanitizes valid email addresses from text and html.
 */
export function extractEmailsFromContent(content: string): string[] {
  if (!content) return [];
  const matches = content.match(EMAIL_REGEX) || [];
  const validEmails = new Set<string>();

  for (const raw of matches) {
    const email = raw.toLowerCase().trim();
    if (IGNORED_EMAIL_EXTENSIONS.test(email)) continue;
    if (IGNORED_EMAILS.has(email)) continue;
    if (email.endsWith("@sentry.io") || email.endsWith("@wixpress.com")) continue;
    validEmails.add(email);
  }

  return Array.from(validEmails);
}

/**
 * Fetches a job link, extracts the job description text, page title, company,
 * and any recruiter/contact email addresses found in the page.
 */
export async function fetchJobPage(rawUrl: string): Promise<JobPageResult> {
  let targetUrl = rawUrl.trim();
  if (targetUrl.toLowerCase().startsWith("www.")) {
    targetUrl = "https://" + targetUrl;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("timeout")) {
      throw new Error("Request timed out while fetching the job page (15s limit).");
    }
    throw new Error(`Failed to fetch job link: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `Job link returned HTTP ${response.status} (${response.statusText || "Error"}).`
    );
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // 1. Collect emails from mailto: links first (highest fidelity)
  const foundEmails: string[] = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const mailtoVal = href.replace(/^mailto:/i, "").split("?")[0]?.trim();
    if (mailtoVal) {
      foundEmails.push(...extractEmailsFromContent(mailtoVal));
    }
  });

  // 2. Collect emails from page text and full HTML
  foundEmails.push(...extractEmailsFromContent(html));
  const uniqueEmails = Array.from(new Set(foundEmails));

  // 3. Try to extract structured JobPosting JSON-LD
  let title = "";
  let company = "";
  let ldDescription = "";

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const rawText = $(el).text();
      if (!rawText) return;
      const json = JSON.parse(rawText);
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (
          item &&
          (item["@type"] === "JobPosting" ||
            (Array.isArray(item["@type"]) && item["@type"].includes("JobPosting")))
        ) {
          if (item.title && typeof item.title === "string") title = item.title;
          if (item.hiringOrganization?.name && typeof item.hiringOrganization.name === "string") {
            company = item.hiringOrganization.name;
          }
          if (item.description && typeof item.description === "string") {
            // Load and strip HTML from ldDescription
            const $desc = cheerio.load(item.description);
            ldDescription = $desc.text().trim();
          }
        }
      }
    } catch {
      // ignore invalid json-ld
    }
  });

  // Fallbacks for title and company
  if (!title) {
    title =
      $('meta[property="og:title"]').attr("content") ||
      $("title").text().trim() ||
      $("h1").first().text().trim() ||
      "";
  }

  if (!company) {
    company =
      $('meta[property="og:site_name"]').attr("content") ||
      $('meta[name="author"]').attr("content") ||
      "";
  }

  // 4. Extract Job Description content
  let description = ldDescription;

  if (!description || description.length < 150) {
    // Strip non-content elements
    $(
      "script, style, noscript, svg, nav, footer, header, iframe, button, form, input, select, textarea, [role='navigation'], [role='banner'], [role='contentinfo']"
    ).remove();

    // Look for common job container selectors
    const selectors = [
      '[class*="job-description" i]',
      '[class*="jobDescription" i]',
      '[id*="job-description" i]',
      '[id*="jobDescription" i]',
      '[class*="job-detail" i]',
      '[class*="jobDetail" i]',
      '[class*="description" i]',
      "article",
      "main",
      '[role="main"]',
    ];

    for (const selector of selectors) {
      const el = $(selector).first();
      if (el.length) {
        const text = el.text().trim();
        if (text.length > 200) {
          description = text;
          break;
        }
      }
    }

    if (!description || description.length < 150) {
      description = $("body").text().trim();
    }
  }

  // Clean excessive whitespace
  description = description
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  // Prefix with Title and Company if available to give rich context to AI
  let fullDescription = "";
  if (title) fullDescription += `Job Title: ${title}\n`;
  if (company) fullDescription += `Company: ${company}\n`;
  if (fullDescription) fullDescription += "\n" + description;
  else fullDescription = description;

  // Cap length to ~7,000 characters to keep it well within model limits while preserving full requirements
  if (fullDescription.length > 7000) {
    fullDescription = fullDescription.slice(0, 7000) + "\n...[truncated]";
  }

  // ── AI parsing: use function-calling to extract emails + title + company ────
  // This runs over the extracted description text (not raw HTML), giving the AI
  // clean, meaningful content to reason over.
  try {
    const aiResult = await parseJobPageWithAI(fullDescription, targetUrl);

    // AI title/company override regex-based heuristics when available
    if (aiResult.title) title = aiResult.title;
    if (aiResult.company) company = aiResult.company;

    // Merge AI-found emails with regex-found ones (AI takes priority, dedup)
    const mergedEmails = Array.from(
      new Set([...aiResult.emails, ...uniqueEmails])
    );
    uniqueEmails.length = 0;
    uniqueEmails.push(...mergedEmails);
  } catch {
    // AI parsing failed — keep regex-extracted data as-is
  }

  return {
    url: targetUrl,
    title: title || undefined,
    company: company || undefined,
    description: fullDescription,
    emails: uniqueEmails,
  };
}
