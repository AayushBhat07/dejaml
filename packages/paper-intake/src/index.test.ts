import { createHash } from "node:crypto";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  ingestPdf,
  MAX_PDF_BYTES,
  PaperIntakeError,
} from "./index.js";

async function createTextPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([612, 792]);
  first.drawText(
    "Urban Land Cover classification reports Random Forest test accuracy of 81.66 percent.",
    { x: 50, y: 730, size: 12, font },
  );
  const second = pdf.addPage([612, 792]);
  second.drawText(
    "Source code is available at https://github.com/mtesha/tdl-vs-ml-urbanlandcover for reproducibility.",
    { x: 50, y: 730, size: 12, font },
  );
  return pdf.save();
}

describe("ingestPdf", () => {
  it("extracts page-anchored text and a source digest", async () => {
    const data = await createTextPdf();
    const document = await ingestPdf({ fileName: "../uploaded-paper.pdf", data });

    expect(document.file.originalName).toBe("uploaded-paper.pdf");
    expect(document.file.sha256).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
    expect(document.pageCount).toBe(2);
    expect(document.pages[0]?.text).toContain("81.66 percent");
    expect(document.pages[1]?.text).toContain("github.com/mtesha");
  });

  it("rejects a non-PDF payload", async () => {
    await expect(
      ingestPdf({ fileName: "paper.pdf", data: new TextEncoder().encode("not pdf") }),
    ).rejects.toMatchObject<Partial<PaperIntakeError>>({ code: "invalid_pdf" });
  });

  it("rejects an oversized payload before parsing", async () => {
    const data = new Uint8Array(MAX_PDF_BYTES + 1);
    data.set(new TextEncoder().encode("%PDF-"));
    await expect(ingestPdf({ fileName: "large.pdf", data })).rejects.toMatchObject<
      Partial<PaperIntakeError>
    >({ code: "pdf_too_large" });
  });

  it("rejects image-only or empty-text PDFs", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const data = await pdf.save();
    await expect(ingestPdf({ fileName: "scan.pdf", data })).rejects.toMatchObject<
      Partial<PaperIntakeError>
    >({ code: "text_unavailable" });
  });
});

