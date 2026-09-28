import { describe, expect, it } from "vitest";

import { MAX_PAPER_BYTES, checkPaper, formatBytes } from "./paper";

const pdf = (body = "%PDF-1.7\n%test\n", name = "paper.pdf") => new File([body], name, { type: "application/pdf" });

describe("checkPaper", () => {
  it("accepts a PDF and fingerprints it with SHA-256", async () => {
    const result = await checkPaper(pdf("%PDF-1.7\nhello"));
    expect(result).toMatchObject({ ok: true, bytes: 14 });
    if (result.ok) expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects empty, oversized, and non-PDF files", async () => {
    expect(await checkPaper(pdf(""))).toEqual({ ok: false, reason: "This file is empty." });
    expect(await checkPaper(pdf("hello world", "notes.pdf"))).toEqual({ ok: false, reason: "This file is not a PDF." });
    const huge = new File([new Uint8Array(MAX_PAPER_BYTES + 1)], "huge.pdf");
    expect(await checkPaper(huge)).toMatchObject({ ok: false, reason: expect.stringContaining("The limit is 20.0 MB") });
  });

  it("formats sizes for people", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(144_090)).toBe("140.7 KB");
  });
});
