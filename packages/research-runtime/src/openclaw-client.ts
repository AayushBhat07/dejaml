import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  parseStructuredJson,
  type StructuredCompletion,
  type StructuredCompletionRequest,
  type StructuredModelClient,
} from "./model.js";

const AgentExecEnvelopeSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["ok", "error", "timeout"]),
  final: z.string().optional(),
  error: z.object({ message: z.string(), kind: z.string().optional() }).optional(),
  usage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
});

const GatewayAgentEnvelopeSchema = z.object({
  payloads: z.array(z.object({ text: z.string().optional() })).optional(),
  result: z
    .object({
      payloads: z.array(z.object({ text: z.string().optional() })).optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const PINNED_OPENCLAW_VERSION = "2026.9.5";
export const MAX_OPENCLAW_OUTPUT_BYTES = 2 * 1024 * 1024;

export type OpenClawClientOptions = {
  binaryPath: string;
  model: string;
  timeoutSeconds?: number;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  config?: Record<string, unknown>;
};

export type OpenClawGatewayClientOptions = {
  binaryPath: string;
  analystAgents: Record<"paper_analyst" | "code_analyst", string> &
    Partial<Record<"lead_researcher", string>>;
  model?: string;
  timeoutSeconds?: number;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};

function mergeRestrictedConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ...(config ?? {}),
    tools: {
      profile: "minimal",
      allow: ["session_status"],
    },
  };
}

async function runProcess(input: {
  binaryPath: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.binaryPath, input.args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let terminationError: Error | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, output?: string): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(output ?? "");
    };
    const requestStop = (error: Error): void => {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000);
      forceKillTimer.unref();
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MAX_OPENCLAW_OUTPUT_BYTES) {
        requestStop(new Error("OpenClaw output exceeded the configured limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        finish(new Error(errorText || `OpenClaw exited with status ${String(code)}`));
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8"));
    });
    const onAbort = (): void => {
      requestStop(new Error("OpenClaw analyst run was cancelled"));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(() => {
      requestStop(new Error("OpenClaw analyst process exceeded its host deadline"));
    }, input.timeoutMs);
    child.stdin.end(input.stdin);
  });
}

function safeGatewaySessionSuffix(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 120);
  if (!sanitized) throw new Error("analyst session id did not contain a safe identifier");
  return sanitized;
}

export class OpenClawStructuredClient implements StructuredModelClient {
  readonly #options: Required<Pick<OpenClawClientOptions, "timeoutSeconds" | "thinking">> &
    Omit<OpenClawClientOptions, "timeoutSeconds" | "thinking">;

  constructor(options: OpenClawClientOptions) {
    this.#options = {
      ...options,
      timeoutSeconds: options.timeoutSeconds ?? 120,
      thinking: options.thinking ?? "low",
    };
  }

  async complete<T>(request: StructuredCompletionRequest<T>): Promise<StructuredCompletion<T>> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "dejaml-openclaw-"));
    const workspace = join(temporaryRoot, "workspace");
    const configPath = join(temporaryRoot, "openclaw.json");
    await mkdir(workspace, { recursive: true });
    await writeFile(configPath, JSON.stringify(mergeRestrictedConfig(this.#options.config)), {
      encoding: "utf8",
      mode: 0o600,
    });
    const combinedPrompt = `${request.systemPrompt}\n\n${request.prompt}`;
    try {
      const output = await runProcess({
        binaryPath: this.#options.binaryPath,
        args: [
          "agent",
          "exec",
          "--message-file",
          "-",
          "--cwd",
          workspace,
          "--config",
          configPath,
          "--model",
          this.#options.model,
          "--code-mode",
          "direct",
          "--thinking",
          this.#options.thinking,
          "--timeout",
          String(this.#options.timeoutSeconds),
          "--json",
        ],
        stdin: combinedPrompt,
        timeoutMs: (this.#options.timeoutSeconds + 15) * 1000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const envelope = AgentExecEnvelopeSchema.parse(JSON.parse(output));
      if (!envelope.ok || envelope.status !== "ok" || !envelope.final) {
        throw new Error(envelope.error?.message ?? `OpenClaw analyst status was ${envelope.status}`);
      }
      const usage: NonNullable<StructuredCompletion<T>["usage"]> = {};
      if (typeof envelope.usage?.input === "number") usage.input = envelope.usage.input;
      if (typeof envelope.usage?.output === "number") usage.output = envelope.usage.output;
      if (typeof envelope.usage?.total === "number") usage.total = envelope.usage.total;
      return {
        value: parseStructuredJson(envelope.final, request.schema),
        ...(envelope.provider ? { provider: envelope.provider } : {}),
        ...(envelope.model ? { model: envelope.model } : {}),
        ...(envelope.usage ? { usage } : {}),
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function readGatewayAgentMeta(meta: Record<string, unknown> | undefined): {
  provider?: string;
  model?: string;
  usage?: NonNullable<StructuredCompletion<unknown>["usage"]>;
} {
  const agentMeta = meta?.agentMeta;
  if (!agentMeta || typeof agentMeta !== "object") return {};
  const record = agentMeta as Record<string, unknown>;
  const usageRecord =
    record.usage && typeof record.usage === "object"
      ? (record.usage as Record<string, unknown>)
      : undefined;
  const usage: NonNullable<StructuredCompletion<unknown>["usage"]> = {};
  if (typeof usageRecord?.input === "number") usage.input = usageRecord.input;
  if (typeof usageRecord?.output === "number") usage.output = usageRecord.output;
  if (typeof usageRecord?.total === "number") usage.total = usageRecord.total;
  return {
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(usageRecord ? { usage } : {}),
  };
}

/**
 * Uses dedicated, preconfigured OpenClaw Gateway agents. Their configured tool
 * policy is the security boundary; DéjàML never targets a user's general agent.
 */
export class OpenClawGatewayStructuredClient implements StructuredModelClient {
  readonly #options: Required<Pick<OpenClawGatewayClientOptions, "timeoutSeconds" | "thinking">> &
    Omit<OpenClawGatewayClientOptions, "timeoutSeconds" | "thinking">;

  constructor(options: OpenClawGatewayClientOptions) {
    this.#options = {
      ...options,
      timeoutSeconds: options.timeoutSeconds ?? 120,
      thinking: options.thinking ?? "low",
    };
  }

  async complete<T>(request: StructuredCompletionRequest<T>): Promise<StructuredCompletion<T>> {
    const agentId = this.#options.analystAgents[request.role];
    if (!agentId) throw new Error(`no dedicated OpenClaw agent configured for ${request.role}`);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "dejaml-gateway-prompt-"));
    const promptPath = join(temporaryRoot, "prompt.txt");
    await writeFile(promptPath, `${request.systemPrompt}\n\n${request.prompt}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const args = [
      "agent",
      "--agent",
      agentId,
      "--session-key",
      `agent:${agentId}:${safeGatewaySessionSuffix(request.sessionId)}`,
      "--message-file",
      promptPath,
      "--thinking",
      this.#options.thinking,
      "--timeout",
      String(this.#options.timeoutSeconds),
      "--json",
    ];
    if (this.#options.model) args.splice(args.length - 1, 0, "--model", this.#options.model);
    try {
      const output = await runProcess({
        binaryPath: this.#options.binaryPath,
        args,
        stdin: "",
        timeoutMs: (this.#options.timeoutSeconds + 15) * 1000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const envelope = GatewayAgentEnvelopeSchema.parse(JSON.parse(output));
      const payloads = envelope.payloads ?? envelope.result?.payloads ?? [];
      const final = payloads
        .map((payload) => payload.text)
        .filter((text): text is string => typeof text === "string")
        .join("\n")
        .trim();
      if (!final) throw new Error("OpenClaw Gateway analyst returned no text payload");
      const metadata = readGatewayAgentMeta(envelope.meta ?? envelope.result?.meta);
      return {
        value: parseStructuredJson(final, request.schema),
        ...metadata,
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
