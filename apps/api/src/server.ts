import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

import { MAX_PDF_BYTES } from "@dejaml/paper-intake";

import { runStudy, type PipelineDependencies, type StudyReport } from "./pipeline.js";

const MAX_UPLOAD_BYTES = MAX_PDF_BYTES + 64 * 1024;
const HEARTBEAT_MS = 15_000;
const RUN_ID_PATTERN = /^run_[a-f0-9-]{36}$/u;
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export type ApiOptions = PipelineDependencies & {
  /** Built web app to serve at `/`, if present. */
  webRoot?: string;
};

export type ApiServer = {
  server: Server;
  /** Resolves when the active study, if any, has finished. */
  idle(): Promise<void>;
  close(): Promise<void>;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > limit) throw new HttpError(413, "The paper is larger than the 20 MB limit.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new HttpError(413, "The paper is larger than the 20 MB limit.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Extracts the `paper` file from a multipart upload using the platform's form parser. */
async function readPaper(request: IncomingMessage): Promise<{ fileName: string; data: Uint8Array }> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new HttpError(415, "Upload the paper as multipart/form-data with a 'paper' field.");
  }
  const body = await readBody(request, MAX_UPLOAD_BYTES);
  let form: FormData;
  try {
    form = await new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    throw new HttpError(400, "The upload could not be read.");
  }
  const paper = form.get("paper");
  if (!paper || typeof paper === "string") throw new HttpError(400, "No paper file was uploaded.");
  return { fileName: paper.name || "paper.pdf", data: new Uint8Array(await paper.arrayBuffer()) };
}

export function createApiServer(options: ApiOptions): ApiServer {
  const { store } = options;
  const controllers = new Map<string, AbortController>();
  const reports = new Map<string, StudyReport>();
  let active: Promise<void> | null = null;

  const startRun = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // One lab at a time (ARCHITECTURE.md §17: no parallel labs).
    if (active) throw new HttpError(409, "Another study is still running. Try again when it finishes.");
    const paper = await readPaper(request);
    const runId = `run_${randomUUID()}`;
    store.createRun({ fileName: paper.fileName, bytes: paper.data.byteLength }, runId);
    const controller = new AbortController();
    controllers.set(runId, controller);
    active = runStudy({ runId, ...paper, signal: controller.signal }, options)
      .then((report) => {
        reports.set(runId, report);
      })
      .catch(() => undefined)
      .finally(() => {
        controllers.delete(runId);
        active = null;
      });
    sendJson(response, 202, { runId });
  };

  const streamEvents = (request: IncomingMessage, response: ServerResponse, runId: string, url: URL): void => {
    const lastEventId = Number(request.headers["last-event-id"] ?? Number.NaN);
    const after = Number.isInteger(lastEventId) ? lastEventId : Number(url.searchParams.get("after") ?? "0");
    let cursor = Number.isInteger(after) && after >= 0 ? after : 0;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: { sequence: number }): void => {
      if (event.sequence <= cursor) return;
      cursor = event.sequence;
      response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Subscribe before replaying so nothing appended in between is lost; `send` drops duplicates.
    const buffered: Array<{ sequence: number }> = [];
    let replaying = true;
    const unsubscribe = store.subscribe(runId, (event) => (replaying ? buffered.push(event) : send(event)));
    for (const event of store.listEvents(runId, cursor)) send(event);
    replaying = false;
    for (const event of buffered) send(event);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), HEARTBEAT_MS);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  };

  const serveStatic = async (response: ServerResponse, pathname: string): Promise<boolean> => {
    if (!options.webRoot) return false;
    const root = resolve(options.webRoot);
    const relativePath = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/u, "");
    let file = resolve(root, relativePath);
    if (file !== root && !file.startsWith(`${root}${sep}`)) return false;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) file = join(root, "index.html");
    const content = await readFile(file).catch(() => null);
    if (!content) return false;
    response.writeHead(200, {
      "content-type": STATIC_TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": content.length,
      "x-content-type-options": "nosniff",
    });
    response.end(content);
    return true;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    if (url.pathname === "/api/runs" && method === "POST") return startRun(request, response);

    const match = /^\/api\/runs\/([^/]+)(?:\/(events|cancel|report))?$/u.exec(url.pathname);
    if (match) {
      const runId = match[1] ?? "";
      if (!RUN_ID_PATTERN.test(runId)) throw new HttpError(404, "Run not found.");
      let snapshot;
      try {
        snapshot = store.getRun(runId);
      } catch {
        throw new HttpError(404, "Run not found.");
      }
      const action = match[2];
      if (!action && method === "GET") return sendJson(response, 200, snapshot);
      if (action === "events" && method === "GET") return streamEvents(request, response, runId, url);
      if (action === "cancel" && method === "POST") {
        const controller = controllers.get(runId);
        if (!controller) throw new HttpError(409, "This study has already finished.");
        controller.abort();
        return sendJson(response, 202, { runId, cancelling: true });
      }
      if (action === "report" && method === "GET") {
        const report =
          reports.get(runId) ??
          (JSON.parse(
            await readFile(join(options.workRoot, "reports", `${runId}.json`), "utf8").catch(() => "null"),
          ) as StudyReport | null);
        if (!report) throw new HttpError(409, "The report is written when the study finishes.");
        const text = JSON.stringify(report, null, 2);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="dejaml-report-${runId}.json"`,
          "content-length": Buffer.byteLength(text),
        });
        response.end(text);
        return;
      }
      throw new HttpError(405, "Method not allowed.");
    }
    if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
    if (method === "GET" && (await serveStatic(response, url.pathname))) return;
    throw new HttpError(404, "Not found.");
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError) sendJson(response, error.status, { error: error.message });
      else sendJson(response, 500, { error: "Internal server error." });
    });
  });

  return {
    server,
    idle: async () => {
      await active;
    },
    close: async () => {
      for (const controller of controllers.values()) controller.abort();
      await active;
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

/**
 * Restart recovery (ARCHITECTURE.md §13): remove orphan labs and mark runs
 * that were mid-flight as failed. An interrupted attempt is never resumed.
 */
export async function recoverAfterRestart(options: Pick<ApiOptions, "store" | "labs">): Promise<{
  interruptedRuns: string[];
  orphanLabs: number;
}> {
  const receipts = await options.labs.cleanupOrphans();
  const interrupted = options.store.listActiveRuns();
  for (const run of interrupted) {
    options.store.appendEvent({
      runId: run.id,
      actor: "system",
      type: "run_interrupted",
      status: "failed",
      summary: `The service restarted while this study was ${run.status.replaceAll("_", " ")}; it was stopped, not resumed`,
      evidence: [],
      publicPayload: { previousStatus: run.status },
    });
    options.store.transitionRun(run.id, "failed");
  }
  return { interruptedRuns: interrupted.map((run) => run.id), orphanLabs: receipts.length };
}
