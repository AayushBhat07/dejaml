import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  OpenClawGatewayStructuredClient,
  OpenClawStructuredClient,
} from "./openclaw-client.js";

describe("OpenClaw structured client", () => {
  it("uses agent exec with a forced minimal tool policy and parses the JSON envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "dejaml-openclaw-client-test-"));
    const binary = join(root, "fake-openclaw.mjs");
    await writeFile(
      binary,
      `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const configPath = args[args.indexOf("--config") + 1];
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (args[0] !== "agent" || args[1] !== "exec") process.exit(11);
if (config.tools.profile !== "minimal") process.exit(12);
if (JSON.stringify(config.tools.allow) !== JSON.stringify(["session_status"])) process.exit(13);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (!prompt.includes("Paper Analyst")) process.exit(14);
process.stdout.write(JSON.stringify({
  ok: true,
  status: "ok",
  final: JSON.stringify({ answer: "bounded" }),
  provider: "fake",
  model: "fake-model",
  usage: { input: 10, output: 2, total: 12 }
}));
`,
    );
    await chmod(binary, 0o755);
    try {
      const client = new OpenClawStructuredClient({ binaryPath: binary, model: "fake/model" });
      const result = await client.complete({
        sessionId: "run:test:paper",
        role: "paper_analyst",
        systemPrompt: "You are the Paper Analyst.",
        prompt: "Return the bounded result.",
        schema: z.object({ answer: z.literal("bounded") }),
      });
      expect(result).toEqual({
        value: { answer: "bounded" },
        provider: "fake",
        model: "fake-model",
        usage: { input: 10, output: 2, total: 12 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes each role to its dedicated Gateway agent and isolated session", async () => {
    const root = await mkdtemp(join(tmpdir(), "dejaml-openclaw-gateway-test-"));
    const binary = join(root, "fake-openclaw.mjs");
    await writeFile(
      binary,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "agent") process.exit(21);
if (args[args.indexOf("--agent") + 1] !== "dejaml-paper") process.exit(22);
if (!args[args.indexOf("--session-key") + 1].startsWith("agent:dejaml-paper:")) process.exit(23);
if (args[args.indexOf("--message-file") + 1] === "-") process.exit(24);
process.stdout.write(JSON.stringify({
  payloads: [{ text: JSON.stringify({ answer: "gateway" }) }],
  meta: { agentMeta: { provider: "openai", model: "test", usage: { total: 9 } } }
}));
`,
    );
    await chmod(binary, 0o755);
    try {
      const client = new OpenClawGatewayStructuredClient({
        binaryPath: binary,
        analystAgents: {
          paper_analyst: "dejaml-paper",
          code_analyst: "dejaml-code",
        },
      });
      const result = await client.complete({
        sessionId: "run_1:paper_analyst",
        role: "paper_analyst",
        systemPrompt: "Paper Analyst",
        prompt: "Return JSON",
        schema: z.object({ answer: z.literal("gateway") }),
      });
      expect(result).toEqual({
        value: { answer: "gateway" },
        provider: "openai",
        model: "test",
        usage: { total: 9 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
