import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

import {
  type ChatProvider,
  createChatProvider,
  type LoadedProviderConfig,
  ProviderConfigError,
  ProviderSelectionError,
  publicProviders,
} from "@dejaml/agent-runtime";
import { MAX_PDF_BYTES } from "@dejaml/paper-intake";
import { canonicalizeGithubRepositoryUrl } from "@dejaml/repository-intake";
import type { StructuredModelClient } from "@dejaml/research-runtime";

import { runStudy, type PipelineDependencies, type StudyReport } from "./pipeline.js";
import { ChatStructuredClient } from "./structured.js";
import { removeStaleStudyDirs } from "./study/index.js";

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

export type ApiOptions = Omit<PipelineDependencies, "model"> & {
  /** Providers and models the administrator configured; the browser may pick only among these. */
  providers: LoadedProviderConfig;
  /**
   * Builds the chat provider for one study. The key (the server's, or the
   * uploader's) lives only inside that object, in memory, for the study.
   */
  providerFactory?: (providerId: string, model: string, uploaderKey?: string) => ChatProvider;
  /** The curated path's structured-JSON client over the chosen provider (tests substitute a stand-in). */
  structuredModel?: (provider: ChatProvider, model: string) => StructuredModelClient;
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

type Upload = {
  fileName: string;
  data: Uint8Array;
  field(name: string): string | null;
};

/** Extracts the `paper` file and text fields from a multipart upload using the platform's form parser. */
async function readUpload(request: IncomingMessage): Promise<Upload> {
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
  return {
    fileName: paper.name || "paper.pdf",
    data: new Uint8Array(await paper.arrayBuffer()),
    field: (name) => {
      const value = form.get(name);
      return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    },
  };
}

type Selection = { providerId: string; model: string; uploaderKey?: string };

/**
 * Reads the provider choice. Only configured provider ids and models are
 * accepted; a base URL from the browser is refused, and the key is never echoed.
 */
function parseSelection(upload: Upload, config: LoadedProviderConfig): Selection {
  if (upload.field("modelBaseUrl")) {
    throw new HttpError(400, "Model endpoints are configured by the server administrator; choose one of the listed providers.");
  }
  const available = publicProviders(config);
  const providerId = upload.field("providerId") ?? available[0]?.id ?? null;
  if (!providerId) throw new HttpError(400, "No model provider is configured on this server.");
  const provider = available.find((item) => item.id === providerId);
  if (!provider) throw new HttpError(400, "Choose one of the configured model providers.");
  const model = upload.field("modelName") ?? provider.models[0] ?? "";
  if (!provider.models.includes(model)) throw new HttpError(400, "Choose one of the models listed for this provider.");
  const apiKey = upload.field("apiKey");
  if (!apiKey && provider.keySource === "uploader") throw new HttpError(400, `Enter an API key for ${provider.label} before starting a study.`);
  return { providerId, model, ...(apiKey ? { uploaderKey: apiKey } : {}) };
}

export function createApiServer(options: ApiOptions): ApiServer {
  const { store } = options;
  const providerFactory =
    options.providerFactory ??
    ((providerId: string, model: string, uploaderKey?: string) =>
      createChatProvider(options.providers, providerId, model, uploaderKey === undefined ? {} : { uploaderKey }));
  const controllers = new Map<string, AbortController>();
  const reports = new Map<string, StudyReport>();
  let active: Promise<void> | null = null;

  const startRun = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // One lab at a time (ARCHITECTURE.md §17: no parallel labs).
    if (active) throw new HttpError(409, "Another study is still running. Try again when it finishes.");
    const upload = await readUpload(request);
    const selection = parseSelection(upload, options.providers);
    const rawRepository = upload.field("repositoryUrl");
    let repositoryUrl: string | undefined;
    if (rawRepository) {
      try {
        repositoryUrl = canonicalizeGithubRepositoryUrl(rawRepository).repositoryUrl;
      } catch {
        throw new HttpError(400, "The repository must be a public GitHub repository URL.");
      }
    }
    let provider: ChatProvider;
    try {
      provider = providerFactory(selection.providerId, selection.model, selection.uploaderKey);
    } catch (error) {
      if (error instanceof ProviderSelectionError || error instanceof ProviderConfigError) throw new HttpError(400, error.message);
      throw error;
    }
    const model = options.structuredModel ? options.structuredModel(provider, selection.model) : new ChatStructuredClient(provider, selection.model);
    const runId = `run_${randomUUID()}`;
    // Only the file's name and size are stored; the model key is never written anywhere.
    store.createRun({ fileName: upload.fileName, bytes: upload.data.byteLength }, runId);
    const controller = new AbortController();
    controllers.set(runId, controller);
    active = runStudy(
      {
        runId,
        fileName: upload.fileName,
        data: upload.data,
        signal: controller.signal,
        ...(repositoryUrl ? { repositoryUrl } : {}),
        modelSource: selection.uploaderKey ? "uploader" : "server",
        agents: { provider, selection: { id: selection.providerId, model: selection.model } },
      },
      { ...options, model },
    )
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
    if (url.pathname === "/api/config" && method === "GET") {
      return sendJson(response, 200, { providers: publicProviders(options.providers) });
    }

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
 * Restart recovery (ARCHITECTURE.md §13): remove orphan labs and any repository
 * checkouts left in `workRoot`, and mark runs that were mid-flight as failed.
 * An interrupted attempt is never resumed.
 */
export async function recoverAfterRestart(
  options: Pick<ApiOptions, "store" | "labs"> & { workRoot?: string },
): Promise<{
  interruptedRuns: string[];
  orphanLabs: number;
  staleCheckouts: number;
}> {
  const receipts = await options.labs.cleanupOrphans();
  let staleCheckouts = 0;
  if (options.workRoot) {
    for (const entry of await readdir(options.workRoot).catch(() => [] as string[])) {
      if (!entry.startsWith("checkouts-")) continue;
      await rm(join(options.workRoot, entry), { recursive: true, force: true });
      staleCheckouts += 1;
    }
  }
  if (options.workRoot) staleCheckouts += await removeStaleStudyDirs(options.workRoot);
  // Agents that were mid-loop are recorded as interrupted; a run is never resumed after a restart.
  for (const agent of options.store.ledger.listUnfinishedAgents()) {
    options.store.ledger.updateAgent(agent.id, { status: "interrupted", failure: "the service restarted" });
  }
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
  return { interruptedRuns: interrupted.map((run) => run.id), orphanLabs: receipts.length, staleCheckouts };
}

/**
 * Maps the earlier single-model settings (DEJAML_MODEL_BASE_URL, DEJAML_MODEL,
 * DEJAML_MODEL_API_KEY) onto the provider settings, so an existing server
 * setup keeps working. New settings win when both are present.
 */
export function legacyModelEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const model = env.DEJAML_MODEL?.trim();
  if (!model) return env;
  const baseUrl = env.DEJAML_MODEL_BASE_URL?.trim() || "https://api.openai.com/v1";
  const mapped = { ...env };
  if (/^https:\/\/api\.openai\.com\/v1\/?$/u.test(baseUrl)) {
    mapped.DEJAML_OPENAI_MODELS ??= model;
    if (env.DEJAML_MODEL_API_KEY) mapped.DEJAML_OPENAI_API_KEY ??= env.DEJAML_MODEL_API_KEY;
  } else if (!env.DEJAML_CUSTOM_BASE_URL) {
    mapped.DEJAML_CUSTOM_BASE_URL = baseUrl;
    mapped.DEJAML_CUSTOM_MODELS ??= model;
    if (env.DEJAML_MODEL_API_KEY) mapped.DEJAML_CUSTOM_API_KEY ??= env.DEJAML_MODEL_API_KEY;
    if (/^http:\/\/(localhost|127\.0\.0\.1)[:/]/u.test(baseUrl)) mapped.DEJAML_CUSTOM_ALLOW_LOCAL_HTTP ??= "1";
  }
  return mapped;
}
