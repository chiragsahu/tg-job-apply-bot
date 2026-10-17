import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// pdf-parse is a CJS module; resolve callable function supporting default export interop
const rawPdfParse = require("pdf-parse");
const pdfParse = (
  typeof rawPdfParse === "function" ? rawPdfParse : rawPdfParse?.default
) as (buffer: Buffer) => Promise<{ text: string; numpages: number }>;

export const MAX_RESUME_SIZE_BYTES = 3 * 1024 * 1024; // 3 MB

/**
 * Validates that an uploaded document is a PDF and does not exceed 3 MB.
 */
export function validateResumeDocument(doc: {
  mime_type?: string | undefined;
  file_name?: string | undefined;
  file_size?: number | undefined;
}): { valid: boolean; error?: string } {
  const isPdf =
    doc.mime_type === "application/pdf" ||
    (doc.file_name?.toLowerCase().endsWith(".pdf") ?? false);

  if (!isPdf) {
    return {
      valid: false,
      error: "❌ Invalid file format. Only PDF files (.pdf) are supported.",
    };
  }

  if (doc.file_size && doc.file_size > MAX_RESUME_SIZE_BYTES) {
    const sizeMb = (doc.file_size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `❌ File is too large (${sizeMb} MB). Resumes must be 3 MB or smaller.`,
    };
  }

  return { valid: true };
}


/**
 * Downloads a file from Telegram's CDN using the permanent file_id.
 *
 * Important:
 * - file_id is permanent — store this, not the URL.
 * - The download URL is temporary (~1 hr TTL). Always generate it fresh at use time.
 */
export async function downloadTelegramFile(
  fileId: string,
  botToken: string
): Promise<Buffer> {
  // Step 1: Resolve file_id → file_path
  const metaUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) {
    throw new Error(`Failed to get file metadata: ${metaRes.status} ${metaRes.statusText}`);
  }

  const meta = (await metaRes.json()) as {
    ok: boolean;
    result?: { file_path?: string };
  };

  if (!meta.ok || !meta.result?.file_path) {
    throw new Error("Telegram API returned an invalid file response.");
  }

  // Step 2: Download the actual bytes
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`Failed to download file: ${fileRes.status} ${fileRes.statusText}`);
  }

  return Buffer.from(await fileRes.arrayBuffer());
}

/**
 * Extracts plain text from a PDF buffer using pdf-parse.
 * Throws a user-friendly error for image-only / scanned PDFs.
 */
export async function extractResumeText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  const text = data.text.trim();

  if (!text || text.length < 50) {
    throw new Error(
      "Could not extract text from your PDF. It may be a scanned or image-based PDF. " +
        "Please upload a text-based PDF (e.g. exported from Word or Google Docs)."
    );
  }

  return text;
}
