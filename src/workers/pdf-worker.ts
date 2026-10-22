import { parentPort, workerData } from "node:worker_threads";
import { PDFParse } from "pdf-parse";

async function run() {
  const buffer = Buffer.from(workerData.buffer as ArrayBuffer);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();
  return result.text.trim();
}

run()
  .then((text) => parentPort?.postMessage({ ok: true, text }))
  .catch((err: unknown) =>
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }),
  );
