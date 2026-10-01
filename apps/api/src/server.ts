import { createHash, randomUUID } from "node:crypto";
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
import type { PaperDocument, RepositoryCandidate } from "@dejaml/contracts";
import { MAX_PDF_BYTES } from "@dejaml/paper-intake";
import { canonicalizeGithubRepositoryUrl } from "@dejaml/repository-intake";
import type { StructuredModelClient } from "@dejaml/research-runtime";

import { InProcessJobDispatcher, type JobDispatcher } from "./boundaries.js";
import { runStudy, type PipelineDependencies, type StudyReport } from "./pipeline.js";
import { ChatStructuredClient } from "./structured.js";
import { CASE_ID, type ClaimTarget, removeStaleStudyDirs } from "./study/index.js";

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
   * Builds the chat provider for one study. Keys come only from the server's
   * environment and live only inside that object; the browser never sends one.
   */
  providerFactory?: (providerId: string, model: string) => ChatProvider;
  /** The curated path's structured-JSON client over the chosen provider (tests substitute a stand-in). */
  structuredModel?: (provider: ChatProvider, model: string) => StructuredModelClient;
  /** Built web app to serve at `/`, if present. */
  webRoot?: string;
  /** Runs studies; one at a time in this process unless a deployment supplies a queue-backed dispatcher. */
  jobs?: JobDispatcher;
  /** Internal diagnostics (image readiness, platform) served at /api/health to loopback clients only. */
  health?: () => Record<string, unknown>;
  /** The server-owned registry of reviewed claim targets; an upload may name one by id and nothing else. */
  reviewedTargets?: ReadonlyMap<string, ClaimTarget>;
};

export type ApiServer = {
  server: Server;
  /** Resolves when the active study, if any, has finished. */
  idle(): Promise<void>;
  /** Resumes studies that were running when the service stopped, one at a time, from their saved stages. */
  resume(runIds: string[]): Promise<void>;
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
  /** Names of every form field sent, including empty ones. */
  names: string[];
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
    names: [...new Set(form.keys())],
    field: (name) => {
      const value = form.get(name);
      return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    },
  };
}

type Selection = { providerId: string; model: string };

/** The only fields a study upload may carry. The model is chosen by provider id and model name alone. */
const UPLOAD_FIELDS: ReadonlySet<string> = new Set(["paper", "providerId", "modelName", "repositoryUrl", "reviewedCaseId"]);
const KEY_FIELD = /key|token|secret|password|credential|auth/iu;
const ENDPOINT_FIELD = /url|endpoint|host|base/iu;
/** Request headers that would carry a provider key; never accepted from a browser. */
const KEY_HEADERS = ["x-api-key", "api-key", "openai-api-key", "anthropic-api-key", "x-openai-api-key", "x-anthropic-api-key"];

/**
 * Reads the provider choice. Provider keys and endpoints are server
 * configuration only: an upload carrying a key, a base URL, header fields or
 * any other field outside `UPLOAD_FIELDS` is refused with 400 before anything
 * else happens, and no submitted value is ever echoed. Only configured
 * provider ids and their listed models are accepted.
 */
function parseSelection(upload: Upload, config: LoadedProviderConfig, request: IncomingMessage): Selection {
  if (KEY_HEADERS.some((name) => request.headers[name] !== undefined)) {
    throw new HttpError(400, "API keys are configured on the server; do not send one with a study.");
  }
  for (const name of upload.names) {
    if (UPLOAD_FIELDS.has(name)) continue;
    if (KEY_FIELD.test(name)) throw new HttpError(400, "API keys are configured on the server; do not send one with a study.");
    if (ENDPOINT_FIELD.test(name)) {
      throw new HttpError(400, "Model endpoints are configured by the server administrator; choose one of the listed providers.");
    }
    throw new HttpError(
      400,
      /^[A-Za-z0-9_.-]{1,64}$/u.test(name) ? `The upload has an unexpected field "${name}".` : "The upload has an unexpected field.",
    );
  }
  const available = publicProviders(config);
  const providerId = upload.field("providerId") ?? available[0]?.id ?? null;
  if (!providerId) throw new HttpError(400, "No model provider is configured on this server.");
  const provider = available.find((item) => item.id === providerId);
  if (!provider) throw new HttpError(400, "Choose one of the configured model providers.");
  const model = upload.field("modelName") ?? provider.models[0] ?? "";
  if (!provider.models.includes(model)) throw new HttpError(400, "Choose one of the models listed for this provider.");
  return { providerId, model };
}

/** A reviewed case as the browser may see it: which paper and claim, never how the case is run or judged. */
export type PublicReviewedCase = {
  caseId: string;
  title: string;
  paperTitle: string;
  paperSha256: string;
  claim: {
    page: number;
    location: string;
    method: string;
    dataset: string;
    split: string;
    metric: { name: string; unit: "fraction" | "percent" | "score" };
    reportedValue: number;
  };
  repository: { url: string; commitSha: string };
  available: boolean;
};

/**
 * The reviewed cases a person can start, for the New Study page. Each field is
 * copied explicitly, so nothing else in a target (its excerpt, adapter,
 * requirements, metric parser, tolerance, or most favourable verdict) can reach
 * the browser. A case holds no observed value; the reported value is the
 * paper's own number, the claim under test.
 */
export function publicReviewedCases(targets: ReadonlyMap<string, ClaimTarget> | undefined): PublicReviewedCase[] {
  return [...(targets?.values() ?? [])]
    .map((target) => ({
      caseId: target.caseId,
      title: target.paper.title,
      paperTitle: target.paper.title,
      paperSha256: target.paper.sha256,
      claim: {
        page: target.claim.page,
        location: target.claim.location,
        method: target.claim.method,
        dataset: target.claim.dataset,
        split: target.claim.split,
        metric: { name: target.claim.metric.name, unit: target.claim.metric.unit },
        reportedValue: target.claim.reportedValue,
      },
      repository: { url: target.repository.url, commitSha: target.repository.commitSha },
      // Every loaded target passed validation (and its adapter's hash check) when the registry loaded.
      available: true,
    }))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
}

export function createApiServer(options: ApiOptions): ApiServer {
  const { store } = options;
  const providerFactory =
    options.providerFactory ?? ((providerId: string, model: string) => createChatProvider(options.providers, providerId, model));
  const jobs = options.jobs ?? new InProcessJobDispatcher();
  const reports = new Map<string, StudyReport>();
  let busy = false;

  const startRun = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // One lab at a time (ARCHITECTURE.md §17: no parallel labs); the dispatcher decides.
    if (busy) throw new HttpError(409, "Another study is still running. Try again when it finishes.");
    const upload = await readUpload(request);
    const selection = parseSelection(upload, options.providers, request);
    const rawRepository = upload.field("repositoryUrl");
    let repositoryUrl: string | undefined;
    if (rawRepository) {
      try {
        repositoryUrl = canonicalizeGithubRepositoryUrl(rawRepository).repositoryUrl;
      } catch {
        throw new HttpError(400, "The repository must be a public GitHub repository URL.");
      }
    }
    // A reviewed claim target is chosen by id only; its contents come from the server's registry, never the request.
    const caseId = upload.field("reviewedCaseId");
    let target: ClaimTarget | undefined;
    if (caseId !== null) {
      target = CASE_ID.test(caseId) ? options.reviewedTargets?.get(caseId) : undefined;
      if (!target) throw new HttpError(400, "There is no reviewed case with that id on this server.");
      if (createHash("sha256").update(upload.data).digest("hex") !== target.paper.sha256)
        throw new HttpError(400, "The uploaded paper is not the paper reviewed for this case.");
      if (repositoryUrl && repositoryUrl !== target.repository.url)
        throw new HttpError(400, "A reviewed case names its own repository; leave the repository empty or use that one.");
    }
    let provider: ChatProvider;
    try {
      provider = providerFactory(selection.providerId, selection.model);
    } catch (error) {
      if (error instanceof ProviderSelectionError || error instanceof ProviderConfigError) throw new HttpError(400, error.message);
      throw error;
    }
    const model = options.structuredModel
      ? options.structuredModel(provider, selection.model)
      : new ChatStructuredClient(provider, selection.model);
    const runId = `run_${randomUUID()}`;
    // Only the file's name and size are stored; the model key is never written anywhere.
    store.createRun({ fileName: upload.fileName, bytes: upload.data.byteLength }, runId);
    const accepted = jobs.submit({
      runId,
      kind: "study",
      run: async (signal) => {
        busy = true;
        try {
          const report = await runStudy(
            {
              runId,
              fileName: upload.fileName,
              data: upload.data,
              signal,
              ...(repositoryUrl ? { repositoryUrl } : {}),
              ...(target ? { target } : {}),
              modelSource: "server",
              agents: { provider, selection: { id: selection.providerId, model: selection.model } },
            },
            { ...options, model },
          );
          reports.set(runId, report);
        } finally {
          busy = false;
        }
      },
    });
    if (!accepted) {
      store.appendEvent({
        runId,
        actor: "system",
        type: "run_rejected",
        status: "failed",
        summary: "No worker was free to run the study",
        evidence: [],
        publicPayload: {},
      });
      store.transitionRun(runId, "failed");
      throw new HttpError(409, "Another study is still running. Try again when it finishes.");
    }
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
    if (url.pathname === "/api/health" && method === "GET") {
      // Internal diagnostics: never secrets; answered only on the loopback interface.
      const remote = request.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) throw new HttpError(404, "Not found.");
      return sendJson(response, 200, { ok: true, ...(options.health?.() ?? {}) });
    }
    if (url.pathname === "/api/config" && method === "GET") {
      // Only providers with a server-held key (or the keyless custom endpoint) are listed: ids, labels, models.
      return sendJson(response, 200, {
        providers: publicProviders(options.providers),
        reviewedCases: publicReviewedCases(options.reviewedTargets),
      });
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
        if (!jobs.cancel(runId)) throw new HttpError(409, "This study has already finished.");
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

  const resumeOne = async (runId: string, signal: AbortSignal): Promise<void> => {
    const state = store.stages.state(runId);
    const inputs = (state?.inputs ?? {}) as {
      paperDocument?: PaperDocument;
      candidates?: RepositoryCandidate[];
      provider?: { id: string; model: string };
      reviewedTarget?: ClaimTarget | null;
    };
    const fail = (summary: string): void => {
      store.appendEvent({ runId, actor: "system", type: "run_resume_failed", status: "failed", summary, evidence: [], publicPayload: {} });
      if (!store.stages.state(runId)?.terminal) store.stages.finish(runId, "failed", "failed");
      if (!store.isTerminal(runId)) store.transitionRun(runId, "failed");
    };
    if (!state || state.terminal || !inputs.paperDocument || !inputs.candidates || !inputs.provider)
      return fail("The study's saved inputs are incomplete, so it cannot resume");
    let provider: ChatProvider;
    try {
      provider = providerFactory(inputs.provider.id, inputs.provider.model);
    } catch {
      return fail("The study's model provider is no longer configured on this server, so it cannot resume");
    }
    const model = options.structuredModel
      ? options.structuredModel(provider, inputs.provider.model)
      : new ChatStructuredClient(provider, inputs.provider.model);
    try {
      const report = await runStudy(
        {
          runId,
          fileName: inputs.paperDocument.file.originalName,
          data: new Uint8Array(),
          signal,
          modelSource: "server",
          agents: { provider, selection: inputs.provider },
          resume: { paper: inputs.paperDocument, candidates: inputs.candidates, target: inputs.reviewedTarget ?? null },
        },
        { ...options, model },
      );
      reports.set(runId, report);
    } catch {
      // runStudy records its own failure.
    }
  };

  return {
    server,
    idle: () => jobs.idle(),
    resume: async (runIds) => {
      for (const runId of runIds) {
        await jobs.enqueue({
          runId,
          kind: "resume",
          run: async (signal) => {
            busy = true;
            try {
              await resumeOne(runId, signal);
            } finally {
              busy = false;
            }
          },
        });
      }
    },
    close: async () => {
      await jobs.close();
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
  options: Pick<ApiOptions, "store" | "labs"> & { workRoot?: string; resumeStudies?: boolean },
): Promise<{
  interruptedRuns: string[];
  /** Studies with saved stages, to hand to `ApiServer.resume`. */
  resumableRuns: string[];
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
  // Agents that were mid-loop are recorded as interrupted; their saved conversations can be resumed.
  for (const agent of options.store.ledger.listUnfinishedAgents()) {
    options.store.ledger.updateAgent(agent.id, { status: "interrupted", failure: "the service restarted" });
  }
  const interrupted: string[] = [];
  const resumable: string[] = [];
  for (const run of options.store.listActiveRuns()) {
    const study = options.store.stages.state(run.id);
    if (study && !study.terminal && options.resumeStudies !== false) {
      // A persisted study resumes from its stages: running stages become failed with reason process_restart.
      options.store.stages.recoverAfterRestart(run.id);
      options.store.appendEvent({
        runId: run.id,
        actor: "system",
        type: "run_interrupted",
        status: "warning",
        summary: `The service restarted while this study was ${run.status.replaceAll("_", " ")}; it will resume from its saved stages`,
        evidence: [],
        publicPayload: { previousStatus: run.status, resumable: true },
      });
      resumable.push(run.id);
      continue;
    }
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
    interrupted.push(run.id);
  }
  return { interruptedRuns: interrupted, resumableRuns: resumable, orphanLabs: receipts.length, staleCheckouts };
}
