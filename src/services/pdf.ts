import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// pdf-parse is a CJS module; use require for reliable interop
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pdfParse: (buffer: Buffer) => Promise<{ text: string; numpages: number }> = require("pdf-parse");


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
