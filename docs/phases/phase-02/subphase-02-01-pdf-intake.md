# Sub-phase 2.1 — PDF Intake

**Status:** `DONE`  
**Completed:** `2026-09-28`  
**Commit:** `resolve with git log for PDF intake`  
**Owner:** `Codex`

## Objective

Accept a bounded, text-readable paper PDF and turn it into immutable, page-anchored evidence for later research analysis.

## Delivered

- Added a dedicated `@dejaml/paper-intake` package.
- Validated the PDF file signature before parsing.
- Enforced a 20 MiB upload limit, 80-page limit, per-page text limit, and total extracted-text limit.
- Calculated the SHA-256 source digest before PDF.js receives a copy of the bytes.
- Sanitized the supplied filename down to its basename.
- Extracted normalized text with the original one-based page number retained.
- Rejected image-only or effectively empty PDFs with an explicit `text_unavailable` result rather than pretending OCR succeeded.
- Added shared schemas for the extracted document and its pages.
- Documented the live-lab observer boundary: terminal telemetry by default and read-only noVNC only for genuine GUI work.

## Files added or changed

- `packages/paper-intake/src/index.ts`
- `packages/paper-intake/src/index.test.ts`
- `packages/paper-intake/README.md`
- `packages/paper-intake/package.json`
- `packages/paper-intake/tsconfig.json`
- `packages/contracts/src/index.ts`
- `docs/decisions/0005-honest-live-lab-observer.md`
- `ARCHITECTURE.md`
- `ROADMAP.md`
- `README.md`
- root dependency lockfile

## Decisions and deviations

- OCR is deferred for the overnight demo. A scanned paper fails clearly instead of producing weak or uncitable extraction.
- PDF.js receives a byte copy because it may transfer and detach its input buffer. The caller retains the original bytes used for hashing and storage.
- Page text is whitespace-normalized, but the page boundary is never discarded.
- The live observer is not a fake animated desktop. Most ML reproduction work is command-line activity and will be shown as such.

## Verification

```bash
npm run check
npm audit --audit-level=moderate
git diff --check
```

Expected behaviors:

- a two-page text PDF produces two page-anchored records and the correct SHA-256 digest;
- a non-PDF payload is rejected;
- an upload over 20 MiB is rejected before parsing;
- a page without extractable text is rejected as unsupported for this demo;
- contracts, intake, and run-store tests all pass.

## Known limitations

- No OCR for scanned/image-only papers.
- No encrypted-PDF password flow.
- Extraction preserves page-level evidence but not paragraphs, reading order metadata, tables, or figures.
- The package is not yet exposed through an HTTP upload endpoint or persisted into the run store.

## Restore procedure

1. Use Node.js 24 or newer.
2. Run `npm install`.
3. Run `npm run check`.
4. Run `npm audit --audit-level=moderate` and require zero findings.
5. Confirm `packages/paper-intake/src/index.test.ts` passes all four intake cases.
6. Confirm an ingested paper retains its original caller-owned byte array after extraction.

## Remaining work

- Find GitHub URLs in the page-anchored paper text.
- Validate repository targets against the acquisition policy.
- Acquire and pin the selected public repository.
- Persist the paper document and repository metadata as run evidence.

## Next sub-phase

`2.2 — Repository discovery and acquisition`
