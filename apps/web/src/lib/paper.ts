/** Mirrors the server-side limit in @dejaml/paper-intake; the server stays authoritative. */
export const MAX_PAPER_BYTES = 20 * 1024 * 1024;

export type PaperCheck =
  | { ok: true; file: File; bytes: number; sha256: string }
  | { ok: false; reason: string };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function readBytes(file: Blob): Promise<ArrayBuffer> {
  // jsdom's File lacks arrayBuffer(); FileReader works everywhere.
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsArrayBuffer(file);
  });
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Quick checks before upload so obvious mistakes are caught immediately.
 * Page count, text extraction, and repository discovery happen on the server.
 */
export async function checkPaper(file: File): Promise<PaperCheck> {
  if (file.size === 0) return { ok: false, reason: "This file is empty." };
  if (file.size > MAX_PAPER_BYTES) {
    return { ok: false, reason: `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_PAPER_BYTES)}.` };
  }
  const data = await readBytes(file);
  const head = new Uint8Array(data.slice(0, 1024));
  const magicAt = head.findIndex((_, index) => PDF_MAGIC.every((byte, offset) => head[index + offset] === byte));
  if (magicAt < 0) return { ok: false, reason: "This file is not a PDF." };
  return { ok: true, file, bytes: file.size, sha256: await sha256Hex(data) };
}
