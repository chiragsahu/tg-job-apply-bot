/**
 * Escapes reserved characters in Telegram legacy Markdown (parse_mode: 'Markdown'):
 * _, *, `, [
 */
export function escapeMarkdown(text: string): string {
  if (!text) return "";
  return text.replace(/([_*`\[])/g, "\\$1");
}

/**
 * Converts HTML body (from AI email generation) to Telegram legacy Markdown,
 * preserving bold formatting (*...*) and bullet points.
 */
export function htmlToTelegramMarkdown(html: string): string {
  if (!html) return "";

  // 1. Convert line breaks and list items
  let text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/ul>/gi, "\n");

  // 2. Extract bold elements and replace with safe placeholders
  const boldMatches: string[] = [];
  text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, content) => {
    const cleanContent = content.replace(/<[^>]+>/g, "").trim();
    if (!cleanContent) return "";
    const token = `@@@BOLDTOKEN${boldMatches.length}@@@`;
    boldMatches.push(cleanContent);
    return token;
  });

  // 3. Strip any other HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // 4. Decode HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // 5. Escape markdown in the plain text
  text = escapeMarkdown(text);

  // 6. Restore bold elements with Telegram markdown syntax (*...*)
  boldMatches.forEach((content, idx) => {
    const token = `@@@BOLDTOKEN${idx}@@@`;
    text = text.replace(token, `*${escapeMarkdown(content)}*`);
  });

  return text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);
}

