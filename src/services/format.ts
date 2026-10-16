/**
 * Escapes reserved characters in Telegram legacy Markdown (parse_mode: 'Markdown'):
 * _, *, `, [
 */
export function escapeMarkdown(text: string): string {
  if (!text) return "";
  return text.replace(/([_*`\[])/g, "\\$1");
}
