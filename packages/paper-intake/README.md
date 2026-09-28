# DéjàML Paper Intake

Validates a bounded PDF input, records its SHA-256 digest, and extracts text by page for evidence-backed analysis.

## Demo limits

- maximum PDF size: 20 MiB;
- maximum pages: 80;
- maximum extracted text per page: 100,000 characters;
- maximum total extracted text: 2,000,000 characters;
- minimum extractable text: 100 characters;
- scanned/image-only PDFs are rejected rather than silently OCR'd.

The returned document preserves each page number so later claims can cite exact paper pages.

