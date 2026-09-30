import { chmod, lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";

import {
  type AgentRole,
  type BoardKind,
  BOARD_KINDS,
  defineTool,
  sha256,
  type ToolContext,
  type ToolDefinition,
  ToolDenied,
  type ToolResult,
} from "@dejaml/agent-runtime";
import { type CommandOutcome, LabError } from "@dejaml/lab-manager";
import { acquireDataset, NetGuardError } from "@dejaml/net-guard";
import {
  discoverDependencies,
  inspectEnvironmentCommand,
  offlineInstallCommands,
  parseRequirementLine,
  PrepError,
} from "@dejaml/prep";
import { z } from "zod";

import { type CommandRecord, type EngineerLab, LAB_LAYOUT, type StageName, type StudyContext } from "./context.js";
import { DiagnosisSchema, INSTRUCTIONS, RESULT_DESCRIPTIONS, ROLE_LIMITS } from "./roles.js";

/**
 * The concrete tools behind each role's grants. Every tool enforces its own
 * boundary: repository reads stay inside the pinned checkout on the host,
 * lab tools run inside the agent's own sealed lab, and network access exists
 * only in the acquisition, dependency, and dataset zones.
 */

const MAX_READ_BYTES = 24_000;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_MATCHES = 60;
const EXCERPT_BYTES = 4_000;
const SKIP_DIRS = new Set([".git"]);

const RelativePathInput = z
  .string()
  .max(300)
  .describe("Path relative to the root, such as `.` or `src/train.py`.");

function ok(summary: string, content: unknown, output?: Record<string, unknown>): ToolResult {
  return {
    summary,
    content: typeof content === "string" ? content : JSON.stringify(content, null, 1),
    ...(output ? { output } : {}),
  };
}

function failed(summary: string, content: unknown, output?: Record<string, unknown>): ToolResult {
  return { ...ok(summary, content, output), isError: true, status: "error" };
}

function tail(text: string, bytes = EXCERPT_BYTES): string {
  return text.length <= bytes ? text : `…${text.slice(-bytes)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Host-side, read-only access to the pinned checkout.

async function resolveInside(root: string, requested: string): Promise<string> {
  const cleaned = requested.trim() === "" ? "." : requested.trim();
  if (cleaned.includes("\0") || posix.isAbsolute(cleaned) || cleaned.split(/[\\/]/u).includes("..")) {
    throw new ToolDenied("paths must be relative to the repository root and must not contain '..'");
  }
  const target = resolve(root, cleaned);
  const real = await realpath(target).catch(() => {
    throw new ToolDenied(`${cleaned} does not exist`);
  });
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new ToolDenied(`${cleaned} resolves outside the repository`);
  }
  return real;
}

async function listTree(root: string, start: string, depth: number): Promise<{ entries: string[]; truncated: boolean }> {
  const entries: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      if (SKIP_DIRS.has(item.name)) continue;
      const full = join(dir, item.name);
      const rel = relative(root, full).split(sep).join("/");
      if (item.isSymbolicLink()) {
        entries.push(`${rel} (symlink, not followed)`);
      } else if (item.isDirectory()) {
        entries.push(`${rel}/`);
        if (level < depth) await walk(full, level + 1);
      } else if (item.isFile()) {
        const stats = await lstat(full);
        entries.push(`${rel} (${stats.size} bytes)`);
      }
    }
  };
  await walk(start, 1);
  return { entries, truncated: entries.length >= MAX_LIST_ENTRIES };
}

async function readBounded(path: string, offset: number, maxBytes: number): Promise<{ text: string; size: number; binary: boolean }> {
  const stats = await lstat(path);
  if (!stats.isFile()) throw new ToolDenied("not a regular file");
  const handle = await open(path, "r");
  try {
    const length = Math.max(0, Math.min(maxBytes, MAX_READ_BYTES, stats.size - offset));
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const binary = buffer.subarray(0, 1024).includes(0);
    return { text: binary ? "" : buffer.toString("utf8"), size: stats.size, binary };
  } finally {
    await handle.close();
  }
}

async function searchTree(root: string, start: string, needle: string): Promise<{ matches: string[]; truncated: boolean }> {
  const matches: string[] = [];
  const lowered = needle.toLowerCase();
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (matches.length >= MAX_SEARCH_MATCHES || files > 3_000) return;
      if (SKIP_DIRS.has(item.name) || item.isSymbolicLink()) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        files += 1;
        const stats = await lstat(full);
        if (stats.size > 2 * 1024 * 1024) continue;
        const content = await readFile(full);
        if (content.subarray(0, 1024).includes(0)) continue;
        const lines = content.toString("utf8").split("\n");
        lines.forEach((line, index) => {
          if (matches.length < MAX_SEARCH_MATCHES && line.toLowerCase().includes(lowered)) {
            matches.push(`${relative(root, full).split(sep).join("/")}:${index + 1}: ${line.trim().slice(0, 240)}`);
          }
        });
      }
    }
  };
  const stats = await lstat(start);
  if (stats.isFile()) {
    const content = (await readFile(start)).toString("utf8").split("\n");
    content.forEach((line, index) => {
      if (matches.length < MAX_SEARCH_MATCHES && line.toLowerCase().includes(lowered)) {
        matches.push(`${relative(root, start).split(sep).join("/")}:${index + 1}: ${line.trim().slice(0, 240)}`);
      }
    });
  } else {
    await walk(start);
  }
  return { matches, truncated: matches.length >= MAX_SEARCH_MATCHES };
}

function requireRepository(ctx: StudyContext): { dir: string; root: string } {
  if (!ctx.repository) throw new ToolDenied("the repository has not been acquired yet");
  return ctx.repository;
}

// ---------------------------------------------------------------------------
// Tools.

export function buildStudyTools(ctx: StudyContext, agent: { agentId: string; role: AgentRole; grants: readonly string[] }): ToolDefinition[] {
  const all: ToolDefinition[] = [
    boardRead(ctx),
    ...paperTools(ctx),
    ...repositoryTools(ctx),
    ...dependencyZoneTools(ctx),
    datasetFetch(ctx),
    ...labTools(ctx),
    requestDebugging(ctx),
    artifactRead(ctx),
    delegate(ctx),
  ];
  const granted = new Set(agent.grants);
  return all.filter((tool) => granted.has(tool.name));
}

function boardRead(ctx: StudyContext): ToolDefinition {
  return defineTool({
    name: "board_read",
    description:
      "Read entries on the shared evidence board that your role may see. Entries are typed (paper_claim, repository_receipt, plan, command_receipt, submission, …) and name their author.",
    input: z.object({
      kinds: z.array(z.enum(BOARD_KINDS)).max(16).optional().describe("Only these kinds; omit for everything you may see."),
      key: z.string().max(100).optional().describe("Only entries with this key, such as an engineer's agent id."),
    }),
    async run(input, context: ToolContext) {
      const entries = context.board.visibleTo(context.role, input.kinds as BoardKind[] | undefined, input.key === undefined ? {} : { key: input.key });
      const view = entries.slice(-60).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        key: entry.key,
        author: `${entry.authorRole}${entry.authorAgentId ? ` ${entry.authorAgentId}` : ""}`,
        payload: entry.payload,
      }));
      return ok(`Read ${view.length} board entries`, view.length ? view : "No entries yet.");
    },
  });
}

function paperTools(ctx: StudyContext): ToolDefinition[] {
  const pages = ctx.paper.pages;
  return [
    defineTool({
      name: "paper_list_pages",
      description: "List the paper's pages with their length and first line.",
      input: z.object({}),
      async run() {
        return ok(`Listed ${pages.length} pages`, pages.map((page) => ({
          page: page.pageNumber,
          chars: page.charCount,
          firstLine: page.text.trim().split("\n")[0]?.slice(0, 160) ?? "",
        })));
      },
    }),
    defineTool({
      name: "paper_read_page",
      description: "Read the extracted text of one page of the paper.",
      input: z.object({ page: z.number().int().positive(), offset: z.number().int().nonnegative().optional() }),
      async run(input) {
        const page = pages.find((item) => item.pageNumber === input.page);
        if (!page) throw new ToolDenied(`the paper has pages 1 to ${pages.length}`);
        const offset = input.offset ?? 0;
        const text = page.text.slice(offset, offset + MAX_READ_BYTES);
        const more = offset + text.length < page.text.length ? `\n[… ${page.text.length - offset - text.length} more characters; read again with offset]` : "";
        return ok(`Read page ${input.page}`, `page ${input.page}:\n${text}${more}`);
      },
    }),
    defineTool({
      name: "paper_search",
      description: "Search the paper's text (case-insensitive, literal) and get matching lines with page numbers.",
      input: z.object({ query: z.string().min(2).max(200) }),
      async run(input) {
        const needle = input.query.toLowerCase();
        const matches: string[] = [];
        for (const page of pages) {
          for (const line of page.text.split("\n")) {
            if (matches.length < MAX_SEARCH_MATCHES && line.toLowerCase().includes(needle)) {
              matches.push(`page ${page.pageNumber}: ${line.trim().slice(0, 240)}`);
            }
          }
        }
        return ok(`Found ${matches.length} matches for "${input.query}"`, matches.length ? matches.join("\n") : "No matches.");
      },
    }),
  ];
}

function repositoryTools(ctx: StudyContext): ToolDefinition[] {
  return [
    defineTool({
      name: "repo_acquire",
      description:
        "Clone one of the paper's candidate repositories (GitHub HTTPS only) at its current default-branch commit, pinned by SHA, with size and file limits. Nothing in it is executed. Returns the receipt.",
      input: z.object({ repositoryUrl: z.string().max(300) }),
      async run(input, context) {
        const allowed = ctx.candidates.map((candidate) => candidate.repositoryUrl);
        if (!allowed.includes(input.repositoryUrl)) {
          throw new ToolDenied(`only the candidate repositories may be acquired: ${allowed.join(", ")}`);
        }
        if (ctx.repository) {
          if (ctx.repository.receipt.repositoryUrl === input.repositoryUrl) {
            return ok("Repository already acquired", receiptView(ctx));
          }
          throw new ToolDenied("a repository was already acquired for this study");
        }
        const root = join(ctx.workDir, "checkouts");
        const receipt = await ctx.acquire({ repositoryUrl: input.repositoryUrl, destinationRoot: root, signal: context.signal });
        // The lab user (another UID) reads the checkout through a read-only mount.
        await chmod(receipt.destination, 0o755);
        ctx.repository = { receipt, dir: await realpath(receipt.destination), root };
        const payload = {
          repositoryUrl: receipt.repositoryUrl,
          commitSha: receipt.commitSha,
          defaultBranch: receipt.defaultBranch,
          acquiredAt: receipt.acquiredAt,
          fileCount: receipt.fileCount,
          totalBytes: receipt.totalBytes,
          manifestSha256: receipt.manifestSha256,
          metadataSource: receipt.metadataSource,
        };
        context.board.post({ kind: "repository_receipt", authorAgentId: context.agentId, authorRole: context.role, payload });
        ctx.event("repository_acquired", "completed", `Pinned ${receipt.repositoryUrl} at ${receipt.commitSha.slice(0, 12)}`, payload);
        return ok(`Acquired ${receipt.repositoryUrl}@${receipt.commitSha.slice(0, 12)}`, receiptView(ctx), payload);
      },
    }),
    defineTool({
      name: "repo_list",
      description: "List files in the pinned repository checkout (read-only; symlinks are shown, never followed).",
      input: z.object({ path: RelativePathInput.default("."), depth: z.number().int().min(1).max(6).default(3) }),
      async run(input) {
        const repo = requireRepository(ctx);
        const start = await resolveInside(repo.dir, input.path);
        const listing = await listTree(repo.dir, start, input.depth);
        return ok(`Listed ${listing.entries.length} entries under ${input.path}`, listing.entries.join("\n") + (listing.truncated ? "\n[truncated]" : ""));
      },
    }),
    defineTool({
      name: "repo_read",
      description: "Read a text file from the pinned repository checkout.",
      input: z.object({ path: RelativePathInput, offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().positive().max(MAX_READ_BYTES).default(MAX_READ_BYTES) }),
      async run(input) {
        const repo = requireRepository(ctx);
        const file = await resolveInside(repo.dir, input.path);
        const result = await readBounded(file, input.offset, input.maxBytes);
        if (result.binary) return ok(`${input.path} is binary`, `${input.path} is a binary file of ${result.size} bytes.`);
        const end = input.offset + Buffer.byteLength(result.text);
        return ok(`Read ${input.path}`, `${input.path} (${result.size} bytes${end < result.size ? `, showing ${input.offset}-${end}` : ""}):\n${result.text}`);
      },
    }),
    defineTool({
      name: "repo_search",
      description: "Search the repository for a literal string (case-insensitive).",
      input: z.object({ query: z.string().min(2).max(200), path: RelativePathInput.default(".") }),
      async run(input) {
        const repo = requireRepository(ctx);
        const start = await resolveInside(repo.dir, input.path);
        const found = await searchTree(repo.dir, start, input.query);
        return ok(`Found ${found.matches.length} matches for "${input.query}"`, found.matches.length ? found.matches.join("\n") + (found.truncated ? "\n[truncated]" : "") : "No matches.");
      },
    }),
  ];
}

function receiptView(ctx: StudyContext): Record<string, unknown> {
  const receipt = ctx.repository!.receipt;
  return {
    repositoryUrl: receipt.repositoryUrl,
    commitSha: receipt.commitSha,
    fileCount: receipt.fileCount,
    totalBytes: receipt.totalBytes,
    manifestSha256: receipt.manifestSha256,
    files: receipt.manifest.slice(0, 200).map((entry) => `${entry.path} (${entry.bytes} bytes)`),
  };
}

function dependencyZoneTools(ctx: StudyContext): ToolDefinition[] {
  const requirePrep = () => {
    if (!ctx.prep) throw new ToolDenied("dependency preparation is not enabled on this server");
    return ctx.prep;
  };
  const prepFailure = (error: unknown): ToolResult => {
    if (error instanceof PrepError) {
      ctx.dependencies.failures.push({ code: error.code, message: error.message, requirement: error.requirement ?? null });
      return failed(`Dependency preparation failed: ${error.code}`, {
        code: error.code,
        message: error.message,
        requirement: error.requirement ?? null,
        detail: error.detail ? tail(error.detail, 3_000) : null,
      }, { code: error.code, requirement: error.requirement ?? null });
    }
    throw error;
  };
  return [
    defineTool({
      name: "dependency_discover",
      description:
        "Find dependency files in the repository (requirements, constraints, pyproject, lockfiles) and parse the Python requirements. Reads files only.",
      input: z.object({}),
      async run(_input, context) {
        const repo = requireRepository(ctx);
        const discovery = await discoverDependencies(repo.dir);
        ctx.dependencies.discovery = discovery;
        const payload = {
          ecosystem: discovery.ecosystem,
          files: discovery.files,
          lockfile: discovery.lockfile,
          requirements: discovery.requirements.map((item) => item.spec),
          rejected: discovery.rejected,
          unsupported: discovery.unsupported,
          truncated: discovery.truncated,
        };
        context.board.post({ kind: "dependency_report", authorAgentId: context.agentId, authorRole: context.role, payload });
        return ok(`Found ${discovery.files.length} dependency files (${discovery.ecosystem})`, payload, payload);
      },
    }),
    defineTool({
      name: "dependency_resolvePython",
      description:
        "Resolve Python requirements to exact binary wheels for the lab's Python (3.13, Linux x86-64) in a short-lived container that can reach only the package index. Nothing is built from source. A requirement without a compatible wheel fails with code no_compatible_wheel naming it.",
      input: z.object({
        requirements: z.array(z.string().min(1).max(200)).min(1).max(100).describe("Requirement specifiers such as `numpy>=1.26` or `pandas==2.2.3`. No options, URLs, or paths."),
      }),
      async run(input, context) {
        const prep = requirePrep();
        const invalid = input.requirements.flatMap((line) => {
          const parsed = parseRequirementLine(line);
          return parsed.ok ? [] : [`${line}: ${parsed.reason}`];
        });
        if (invalid.length) throw new ToolDenied(`invalid requirements: ${invalid.join("; ")}`);
        try {
          const resolution = await prep.resolvePython({ runId: ctx.runId, requirements: input.requirements, includeInstaller: true, signal: context.signal });
          ctx.dependencies.resolution = resolution;
          const view = {
            resolutionId: resolution.resolutionId,
            python: resolution.pythonVersion,
            platform: resolution.platform,
            packages: resolution.packages.map((item) => `${item.name}==${item.version}`),
            installer: resolution.installer ? `${resolution.installer.name}==${resolution.installer.version}` : null,
          };
          ctx.event("dependencies_resolved", "completed", `Resolved ${resolution.packages.length} Python packages to binary wheels`, view);
          return ok(`Resolved ${resolution.packages.length} packages`, view, view);
        } catch (error) {
          return prepFailure(error);
        }
      },
    }),
    defineTool({
      name: "dependency_downloadWheels",
      description:
        "Download the wheels of the last resolution into a verified, hash-pinned wheelhouse for the offline lab. Returns the dependency manifest (exact versions and SHA-256 of every wheel).",
      input: z.object({}),
      async run(_input, context) {
        const prep = requirePrep();
        if (!ctx.dependencies.resolution) throw new ToolDenied("call dependency_resolvePython first");
        try {
          const manifest = await prep.downloadWheels(ctx.dependencies.resolution, { signal: context.signal });
          const { wheelhouseDir: _dir, ...recorded } = manifest;
          const manifestSha256 = sha256(JSON.stringify(recorded));
          ctx.dependencies.manifest = manifest;
          ctx.dependencies.manifestSha256 = manifestSha256;
          const payload = {
            manifestSha256,
            prepId: manifest.prepId,
            python: manifest.pythonVersion,
            image: manifest.image,
            imageId: manifest.imageId,
            totalBytes: manifest.totalBytes,
            packages: manifest.packages.map((item) => ({ name: item.name, version: item.version, filename: item.filename, sha256: item.sha256, bytes: item.bytes })),
            installer: manifest.installer ? { name: manifest.installer.name, version: manifest.installer.version, filename: manifest.installer.filename, sha256: manifest.installer.sha256 } : null,
            requested: manifest.requested,
            cleanup: manifest.cleanup,
          };
          context.board.post({ kind: "dependency_manifest", authorAgentId: context.agentId, authorRole: context.role, payload });
          ctx.event("dependencies_downloaded", "completed", `Prepared ${manifest.packages.length} verified wheels (${Math.round(manifest.totalBytes / 1024 / 1024)} MB) for the offline lab`, {
            manifestSha256,
            packages: manifest.packages.length,
            totalBytes: manifest.totalBytes,
          });
          return ok(`Downloaded ${manifest.packages.length} wheels`, { manifestSha256, packages: payload.packages.map((item) => `${item.name}==${item.version}`), totalBytes: manifest.totalBytes }, { manifestSha256 });
        } catch (error) {
          return prepFailure(error);
        }
      },
    }),
    defineTool({
      name: "dependency_installOffline",
      description:
        "Install the prepared wheelhouse into a private virtual environment at /workspace/case/work/.venv inside your lab, with no network (--no-index, --only-binary=:all:, --require-hashes).",
      input: z.object({}),
      async run(_input, context) {
        const lab = requireLab(ctx, context.agentId);
        const manifest = ctx.dependencies.manifest;
        if (!manifest?.installer) throw new ToolDenied("no wheelhouse was prepared for this study");
        const commands = offlineInstallCommands({
          wheelhouse: `${LAB_LAYOUT.workdir}/${LAB_LAYOUT.wheelsDir}`,
          venv: LAB_LAYOUT.venv,
          installerWheel: manifest.installer.filename,
        });
        const results: Array<Record<string, unknown>> = [];
        for (const argv of commands) {
          const record = await runInLab(ctx, lab, context, argv, LAB_LAYOUT.workdir, {}, 600);
          results.push({ argv: record.argv, exitCode: record.exitCode, stderr: record.stderrTail.slice(-1500), stdout: record.stdoutTail.slice(-1500) });
          if (record.exitCode !== 0) return failed("Offline install failed", results, { exitCode: record.exitCode });
        }
        return ok("Installed the wheelhouse into work/.venv", results);
      },
    }),
    defineTool({
      name: "dependency_inspectEnvironment",
      description: "List the Python version and installed distributions of the lab's virtual environment.",
      input: z.object({}),
      async run(_input, context) {
        const lab = requireLab(ctx, context.agentId);
        const record = await runInLab(ctx, lab, context, inspectEnvironmentCommand(LAB_LAYOUT.venv), LAB_LAYOUT.workdir, {}, 60);
        if (record.exitCode !== 0) return failed("Environment inspection failed", record.stderrTail);
        try {
          const parsed = JSON.parse(record.stdoutTail) as { python: string; distributions: Array<{ name: string; version: string }> };
          lab.environment = { python: parsed.python, distributions: parsed.distributions };
          return ok(`Python ${parsed.python} with ${parsed.distributions.length} distributions`, parsed);
        } catch {
          return failed("Environment inspection returned unreadable output", record.stdoutTail);
        }
      },
    }),
  ];
}

async function makeReadable(dir: string): Promise<void> {
  // The lab user (a different UID) must read mounted inputs; nothing is writable through the mount.
  await chmod(dir, 0o755);
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isFile()) await chmod(join(dir, item.name), 0o444);
  }
}

function datasetFetch(ctx: StudyContext): ToolDefinition {
  return defineTool({
    name: "dataset_fetch",
    description:
      "Download one dataset file over HTTPS from an administrator-allowed host (every redirect is revalidated; private and metadata addresses are refused) with an optional expected SHA-256. It is mounted read-only in the labs under data/.",
    input: z.object({
      name: z.string().min(1).max(100),
      url: z.string().min(1).max(2_000),
      fileName: z.string().min(1).max(100),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    }),
    async run(input, context) {
      if (ctx.config.datasetPolicy.allowedHosts.length === 0) {
        context.board.post({ kind: "policy_block", authorAgentId: context.agentId, authorRole: context.role, payload: { reason: "dataset downloads are disabled on this server", url: input.url.slice(0, 300) } });
        return { ...failed("Dataset downloads are disabled", "No dataset hosts are allowed on this server; plan with data shipped in the repository, or report the plan as blocked."), status: "denied" };
      }
      try {
        const receipt = await acquireDataset({
          url: input.url,
          ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
          policy: ctx.config.datasetPolicy,
          destinationDir: join(ctx.workDir, "datasets"),
          fileName: input.fileName,
          signal: context.signal,
        });
        await makeReadable(join(ctx.workDir, "datasets"));
        ctx.datasets.push({ ...receipt, name: input.name });
        const payload = {
          name: input.name,
          sourceUrl: receipt.sourceUrl,
          finalUrl: receipt.finalUrl,
          sha256: receipt.sha256,
          bytes: receipt.bytes,
          mimeType: receipt.mimeType,
          fetchedAt: receipt.fetchedAt,
          checksumVerified: receipt.checksumVerified,
          labPath: `${LAB_LAYOUT.dataDir}/${receipt.fileName}`,
        };
        context.board.post({ kind: "dataset_receipt", authorAgentId: context.agentId, authorRole: context.role, payload });
        ctx.event("dataset_acquired", "completed", `Downloaded dataset ${input.name} (${receipt.bytes} bytes)`, payload);
        return ok(`Downloaded ${input.name}`, payload, payload);
      } catch (error) {
        if (error instanceof NetGuardError) {
          context.board.post({ kind: "policy_block", authorAgentId: context.agentId, authorRole: context.role, payload: { reason: `dataset refused: ${error.code}`, url: input.url.slice(0, 300) } });
          return { ...failed(`Dataset refused: ${error.code}`, { code: error.code, message: error.message }), status: "denied" };
        }
        throw error;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// The engineer's sealed lab.

function requireLab(ctx: StudyContext, agentId: string): EngineerLab {
  const own = ctx.labsByAgent.get(agentId);
  if (own) {
    if (own.destroyed) throw new ToolDenied("your lab has been destroyed");
    return own;
  }
  // A Debugger reads the lab of the Engineer that asked for help.
  const parent = ctx.store.ledger.getAgent(agentId).parentId;
  const lab = parent ? ctx.labsByAgent.get(parent) : undefined;
  if (!lab || lab.destroyed) throw new ToolDenied("you have no lab");
  return lab;
}

function labCwd(requested: string | undefined): string {
  const cwd = requested?.trim() || ".";
  if (cwd.includes("\0") || posix.isAbsolute(cwd) || cwd.split("/").includes("..")) {
    throw new ToolDenied("cwd must be relative to /workspace/case and must not contain '..'");
  }
  return cwd === "." ? LAB_LAYOUT.workdir : posix.join(LAB_LAYOUT.workdir, posix.normalize(cwd));
}

async function runInLab(
  ctx: StudyContext,
  lab: EngineerLab,
  context: ToolContext,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number,
): Promise<CommandRecord> {
  const [first, ...rest] = argv;
  if (!first) throw new ToolDenied("argv must name a program");
  // The lab accepts bare program names; an absolute path (such as the venv's
  // python) is run through env, which is itself a bare name.
  const command = first.startsWith("/") ? { executable: "env", args: ["--", first, ...rest] } : { executable: first, args: rest };
  let outcome: CommandOutcome;
  try {
    outcome = await ctx.labs.runCommand(
      lab.labId,
      { ...command, cwd, env },
      { timeoutSeconds: Math.min(timeoutSeconds, ctx.config.commandTimeoutSeconds), step: lab.commands.length + 1, observe: true, agent: lab.label },
    );
  } catch (error) {
    if (error instanceof LabError && error.code === "command_rejected") throw new ToolDenied(error.message);
    throw error;
  }
  for (const artifact of outcome.artifacts) lab.artifacts.set(artifact.path, artifact);
  const record: CommandRecord = {
    receiptId: context.receiptId,
    agentId: context.agentId,
    argv,
    cwd,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: Math.max(0, Math.round(outcome.durationMs)),
    stdoutSha256: sha256(outcome.stdout.text),
    stderrSha256: sha256(outcome.stderr.text),
    stdoutExcerpt: tail(outcome.stdout.text, 1_500),
    stderrExcerpt: tail(outcome.stderr.text, 1_500),
    artifacts: outcome.artifacts.map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
    stdoutTail: tail(outcome.stdout.text, 16_000),
    stderrTail: tail(outcome.stderr.text, 16_000),
  };
  lab.commands.push(record);
  const { stdoutTail: _out, stderrTail: _err, ...receipt } = record;
  context.board.post({
    kind: "command_receipt",
    authorAgentId: context.agentId,
    authorRole: context.role,
    key: lab.agentId,
    payload: { ...receipt, lab: lab.label, strayProcessesStopped: outcome.strayProcesses, stdoutTruncated: outcome.stdout.truncated, stderrTruncated: outcome.stderr.truncated },
  });
  return record;
}

function labTools(ctx: StudyContext): ToolDefinition[] {
  const inspect = async (agentId: string, request: Parameters<StudyContext["labs"]["inspectFiles"]>[1]) => {
    const lab = requireLab(ctx, agentId);
    try {
      return await ctx.labs.inspectFiles(lab.labId, request);
    } catch (error) {
      if (error instanceof LabError) throw new ToolDenied(error.message);
      throw error;
    }
  };
  return [
    defineTool({
      name: "lab_list",
      description: "List files in the lab, relative to /workspace/case (repo/, wheels/, data/, work/, artifacts/).",
      input: z.object({ path: RelativePathInput.default("."), depth: z.number().int().min(1).max(5).default(2) }),
      async run(input, context) {
        const result = await inspect(context.agentId, { op: "list", path: input.path, depth: input.depth });
        return ok(`Listed ${input.path}`, result);
      },
    }),
    defineTool({
      name: "lab_read",
      description: "Read a file in the lab, relative to /workspace/case.",
      input: z.object({ path: RelativePathInput, offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().positive().max(MAX_READ_BYTES).default(MAX_READ_BYTES) }),
      async run(input, context) {
        const result = await inspect(context.agentId, { op: "read", path: input.path, offset: input.offset, maxBytes: input.maxBytes });
        return ok(`Read ${input.path}`, result);
      },
    }),
    defineTool({
      name: "lab_search",
      description: "Search files in the lab for a regular expression, relative to /workspace/case.",
      input: z.object({ path: RelativePathInput.default("."), pattern: z.string().min(1).max(200) }),
      async run(input, context) {
        const result = await inspect(context.agentId, { op: "search", path: input.path, pattern: input.pattern, maxMatches: MAX_SEARCH_MATCHES });
        return ok(`Searched ${input.path} for ${input.pattern}`, result);
      },
    }),
    defineTool({
      name: "lab_run",
      description:
        "Run one command in your sealed lab (no network, non-root, read-only system). argv is the program and its arguments, not a shell string; use [\"bash\", \"-c\", \"…\"] when you need a shell. cwd is relative to /workspace/case. Background processes are stopped when the command returns. Returns the exit code, the tail of stdout and stderr, and changed artifacts.",
      input: z.object({
        argv: z.array(z.string().max(20_000)).min(1).max(200),
        cwd: z.string().max(300).optional(),
        env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u), z.string().max(1_000)).optional().describe("Extra environment variables (PATH, HOME, PYTHONPATH and LD_* are not allowed)."),
        timeoutSeconds: z.number().int().min(1).max(3_600).default(300),
      }),
      async run(input, context) {
        const lab = requireLab(ctx, context.agentId);
        const record = await runInLab(ctx, lab, context, input.argv, labCwd(input.cwd), input.env ?? {}, input.timeoutSeconds);
        const view = {
          receiptId: record.receiptId,
          exitCode: record.exitCode,
          timedOut: record.timedOut,
          durationMs: record.durationMs,
          stdout: tail(record.stdoutTail, 6_000),
          stderr: tail(record.stderrTail, 6_000),
          artifacts: record.artifacts,
        };
        const summary = `exit ${String(record.exitCode)}${record.timedOut ? " (timed out)" : ""}: ${input.argv.join(" ").slice(0, 160)}`;
        return record.exitCode === 0 ? ok(summary, view, { exitCode: record.exitCode }) : failed(summary, view, { exitCode: record.exitCode });
      },
    }),
    defineTool({
      name: "lab_write_file",
      description:
        "Write a small text file (up to 64 KB) under work/ in your lab, such as an adapter script. Every file you write is recorded and must be declared as an adapter if it changes or wraps the computation.",
      input: z.object({ path: z.string().min(1).max(300).describe("Relative to /workspace/case; must start with work/."), content: z.string().max(64 * 1024) }),
      async run(input, context) {
        const lab = requireLab(ctx, context.agentId);
        if (ctx.labsByAgent.get(context.agentId) !== lab) throw new ToolDenied("only the lab's engineer may write files");
        try {
          const summary = await ctx.labs.writeScratchFile(lab.labId, input.path, input.content, lab.commands.length + 1);
          lab.written.set(summary.path, { sha256: summary.sha256, content: input.content });
          return ok(`Wrote ${summary.path}`, summary, { path: summary.path, sha256: summary.sha256, bytes: summary.bytes });
        } catch (error) {
          if (error instanceof LabError) throw new ToolDenied(error.message);
          throw error;
        }
      },
    }),
  ];
}

function requestDebugging(ctx: StudyContext): ToolDefinition {
  return defineTool({
    name: "request_debugging",
    description:
      "Ask an independent Debugger agent to diagnose a failure. It reads your plan, your command receipts, and your lab's files (read-only) and returns a diagnosis and the smallest faithful fix. It cannot change your lab.",
    input: z.object({ question: z.string().min(1).max(2_000), receiptIds: z.array(z.string().max(100)).max(10).default([]) }),
    async run(input, context) {
      const lab = requireLab(ctx, context.agentId);
      const record = ctx.store.ledger.getAgent(context.agentId);
      const debugger_ = await ctx.runtime.startAgent({
        runId: ctx.runId,
        role: "debugger",
        parentAgentId: context.agentId,
        label: `${lab.label}-debugger-${ctx.store.ledger.listAgents(ctx.runId).filter((item) => item.parentId === context.agentId).length + 1}`,
        instructions: INSTRUCTIONS.debugger,
        objective: `Diagnose this failure in ${lab.label}'s lab: ${input.question}`,
        inputs: {
          question: input.question,
          failingReceiptIds: input.receiptIds,
          engineer: lab.label,
          boardKey: lab.agentId,
          hint: "Read command_receipt entries with key equal to boardKey; the lab is at /workspace/case.",
        },
        grants: ["board_read", "lab_list", "lab_read", "lab_search"],
        limits: ROLE_LIMITS.debugger,
        result: { schema: DiagnosisSchema, description: RESULT_DESCRIPTIONS.debugger },
        provider: { id: record.provider, model: record.model },
      });
      const outcome = await debugger_.done;
      if (outcome.status !== "completed" || !outcome.result) {
        return failed(`The Debugger did not finish (${outcome.status})`, outcome.reason ?? outcome.status);
      }
      context.board.post({ kind: "diagnosis", authorAgentId: debugger_.agentId, authorRole: "debugger", key: lab.agentId, payload: outcome.result });
      return ok(`Diagnosis from ${debugger_.agentId}`, outcome.result, { debuggerAgentId: debugger_.agentId });
    },
  });
}

function artifactRead(ctx: StudyContext): ToolDefinition {
  return defineTool({
    name: "artifact_read",
    description: "Read an artifact exported from a finished engineer's lab (after the lab was frozen). Give the engineer's agent id (the submission key) and the artifact path.",
    input: z.object({ engineerAgentId: z.string().min(1).max(100), path: z.string().min(1).max(300) }),
    async run(input) {
      const exported = ctx.exports.get(input.engineerAgentId);
      if (!exported) throw new ToolDenied("no exported artifacts for that engineer");
      const item = exported.find((artifact) => artifact.path === input.path);
      if (!item) throw new ToolDenied(`not exported; available: ${exported.map((artifact) => artifact.path).join(", ") || "none"}`);
      if (item.text === null) return ok(`${item.path} is binary`, { path: item.path, sha256: item.sha256, bytes: item.bytes, binary: true });
      return ok(`Read ${item.path}`, { path: item.path, sha256: item.sha256, bytes: item.bytes, content: item.text.slice(0, MAX_READ_BYTES) });
    },
  });
}

const STAGES: readonly StageName[] = ["analysis", "plan", "engineering", "review"];
const STAGE_CAPS: Record<StageName, number> = { analysis: 2, plan: 3, engineering: 2, review: 2 };

function delegate(ctx: StudyContext): ToolDefinition {
  return defineTool({
    name: "delegate",
    description: [
      "Run one stage of the study with fresh specialist agents and wait for it. Stages:",
      "analysis: Paper Analyst and Repository Analyst in parallel (independent of each other).",
      "plan: the Reproduction Planner (needs a claim and a repository), which also prepares dependencies.",
      "engineering: independent Lab Engineers, each in its own sealed lab (needs a ready plan).",
      "review: one Independent Reviewer per engineer submission.",
      "Returns what happened; details are on the evidence board.",
    ].join("\n"),
    input: z.object({
      stage: z.enum(STAGES),
      objective: z.string().min(1).max(2_000).describe("What this stage must achieve; on a retry, what to do differently and why."),
    }),
    async run(input, context) {
      if (ctx.delegations.total >= ctx.config.maxDelegations) throw new ToolDenied(`the delegation limit (${ctx.config.maxDelegations}) is reached; finish now`);
      if (ctx.delegations.byStage[input.stage] >= STAGE_CAPS[input.stage]) {
        throw new ToolDenied(`the ${input.stage} stage already ran ${STAGE_CAPS[input.stage]} times; finish with the evidence you have`);
      }
      ctx.delegations.total += 1;
      ctx.delegations.byStage[input.stage] += 1;
      const summary = await ctx.runStage(input.stage, input.objective, context.agentId, context.signal);
      return ok(`${input.stage} stage finished`, summary);
    },
  });
}
