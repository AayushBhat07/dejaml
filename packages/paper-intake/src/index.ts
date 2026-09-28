import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  type PaperDocument,
  PaperDocumentSchema,
  type PaperPage,
} from "@dejaml/contracts";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 80;
export const MAX_PAGE_TEXT_CHARS = 100_000;
export const MAX_TOTAL_TEXT_CHARS = 2_000_000;
export const MIN_TOTAL_TEXT_CHARS = 100;

export class PaperIntakeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_pdf"
      | "pdf_too_large"
      | "too_many_pages"
      | "text_too_large"
      | "text_unavailable",
  ) {
    super(message);
    this.name = "PaperIntakeError";
  }
}

function safeOriginalName(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  const result = basename(normalized).trim();
  return result.length > 0 ? result : "paper.pdf";
}

function hasPdfMagic(data: Uint8Array): boolean {
  return (
    data.length >= 5 &&
    data[0] === 0x25 &&
    data[1] === 0x50 &&
    data[2] === 0x44 &&
    data[3] === 0x46 &&
    data[4] === 0x2d
  );
}

function normalizePageText(parts: string[]): string {
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export async function ingestPdf(input: {
  fileName: string;
  data: Uint8Array;
}): Promise<PaperDocument> {
  if (!hasPdfMagic(input.data)) {
    throw new PaperIntakeError("file does not have a valid PDF header", "invalid_pdf");
  }
  if (input.data.byteLength > MAX_PDF_BYTES) {
    throw new PaperIntakeError(
      `PDF exceeds the ${MAX_PDF_BYTES} byte limit`,
      "pdf_too_large",
    );
  }

  const sourceBytes = input.data.byteLength;
  const sourceSha256 = createHash("sha256").update(input.data).digest("hex");

  const loadingTask = getDocument({
    // PDF.js may transfer/detach its input buffer. Give it a copy so callers
    // retain the immutable source bytes used for hashing and persistence.
    data: input.data.slice(),
    disableFontFace: true,
    stopAtErrors: true,
    useSystemFonts: true,
    useWorkerFetch: false,
    verbosity: 0,
  });

  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new PaperIntakeError(
        `PDF has ${pdf.numPages} pages; limit is ${MAX_PDF_PAGES}`,
        "too_many_pages",
      );
    }

    const pages: PaperPage[] = [];
    let totalTextChars = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizePageText(
        content.items.flatMap((item) => ("str" in item ? [item.str] : [])),
      );
      if (text.length > MAX_PAGE_TEXT_CHARS) {
        throw new PaperIntakeError(
          `page ${pageNumber} exceeds the extracted text limit`,
          "text_too_large",
        );
      }
      totalTextChars += text.length;
      if (totalTextChars > MAX_TOTAL_TEXT_CHARS) {
        throw new PaperIntakeError(
          "PDF exceeds the total extracted text limit",
          "text_too_large",
        );
      }
      pages.push({ pageNumber, text, charCount: text.length });
      page.cleanup();
    }

    if (totalTextChars < MIN_TOTAL_TEXT_CHARS) {
      throw new PaperIntakeError(
        "PDF contains too little extractable text; scanned PDFs are not supported in the demo",
        "text_unavailable",
      );
    }

    return PaperDocumentSchema.parse({
      schemaVersion: 1,
      file: {
        originalName: safeOriginalName(input.fileName),
        bytes: sourceBytes,
        sha256: sourceSha256,
      },
      pageCount: pdf.numPages,
      pages,
      totalTextChars,
      warnings: [],
    });
  } catch (error) {
    if (error instanceof PaperIntakeError) {
      throw error;
    }
    throw new PaperIntakeError(
      `unable to parse PDF: ${error instanceof Error ? error.message : String(error)}`,
      "invalid_pdf",
    );
  } finally {
    await loadingTask.destroy();
  }
}
