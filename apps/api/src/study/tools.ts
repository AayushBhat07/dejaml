import { chmod, lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";

import {
  type AgentRole,
  type BoardKind,
  BOARD_KINDS,
  defineTool,
  type ToolContext,
  type ToolDefinition,
  ToolDenied,
} from "@dejaml/agent-runtime";
import { discoverDependencies } from "@dejaml/prep";
import { z } from "zod";

import type { StudyContext } from "./context.js";
import { labTools } from "./lab-tools.js";
import { projectRepository } from "./projection.js";
import { MAX_READ_BYTES, MAX_SEARCH_MATCHES, ok, RelativePathInput } from "./tool-helpers.js";

/**
 * The concrete tools behind each role's grants. Every tool enforces its own
 * boundary: repository reads stay inside the pinned checkout on the host,
 * lab tools run inside the agent's own sealed lab, and network access exists
 * only in the acquisition, dependency, and dataset zones.
 */

const MAX_LIST_ENTRIES = 400;
const SKIP_DIRS = new Set([".git"]);

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

/** The execution projection agents read (notebook outputs stripped), never the original checkout. */
function requireRepository(ctx: StudyContext): { dir: string } {
  if (!ctx.repository || !ctx.projection) throw new ToolDenied("the repository has not been acquired yet");
  return { dir: ctx.projection.dir };
}

// ---------------------------------------------------------------------------
// Tools.

export function buildStudyTools(
  ctx: StudyContext,
  agent: { agentId: string; role: AgentRole; grants: readonly string[] },
): ToolDefinition[] {
  const all: ToolDefinition[] = [boardRead(ctx), ...paperTools(ctx), ...repositoryTools(ctx), dependencyDiscover(ctx), ...labTools(ctx)];
  const granted = new Set(agent.grants);
  return all.filter((tool) => granted.has(tool.name));
}

/**
 * Acquires the repository into this study's private directory, pinned by
 * commit. On resume the pinned commit is fetched again, never a newer one.
 */
export async function acquireRepository(ctx: StudyContext, repositoryUrl: string, signal: AbortSignal): Promise<void> {
  const root = join(ctx.workDir, "checkouts");
  const receipt = await ctx.acquire({
    repositoryUrl,
    destinationRoot: root,
    signal,
    ...(ctx.pinnedCommit ? { commitSha: ctx.pinnedCommit } : {}),
  });
  // The lab user (another UID) reads the checkout through a read-only mount.
  await chmod(receipt.destination, 0o755);
  ctx.repository = { receipt, dir: await realpath(receipt.destination), root };
  ctx.pinnedCommit = receipt.commitSha;
  await refreshProjection(ctx);
}

/** (Re)builds the execution projection from the pinned checkout, withholding the sealed value when one is known. */
export async function refreshProjection(ctx: StudyContext): Promise<void> {
  if (!ctx.repository) return;
  const destinationDir = join(ctx.workDir, "projections", `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(join(ctx.workDir, "projections"), { recursive: true, mode: 0o711 });
  const projection = await projectRepository({ sourceDir: ctx.repository.dir, destinationDir, sealed: ctx.sealedForScan });
  ctx.projection = { ...projection, dir: await realpath(projection.dir) };
}

function boardRead(_ctx: StudyContext): ToolDefinition {
  return defineTool({
    name: "board_read",
    description:
      "Read entries on the shared evidence board that your role may see. Entries are typed (paper_claim, repository_receipt, plan, command_receipt, submission, …) and name their author.",
    input: z.object({
      kinds: z.array(z.enum(BOARD_KINDS)).max(16).optional().describe("Only these kinds; omit for everything you may see."),
      key: z.string().max(100).optional().describe("Only entries with this key, such as an engineer's agent id."),
    }),
    async run(input, context: ToolContext) {
      const entries = context.board.visibleTo(
        context.role,
        input.kinds as BoardKind[] | undefined,
        input.key === undefined ? {} : { key: input.key },
      );
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
        return ok(
          `Listed ${pages.length} pages`,
          pages.map((page) => ({
            page: page.pageNumber,
            chars: page.charCount,
            firstLine: page.text.trim().split("\n")[0]?.slice(0, 160) ?? "",
          })),
        );
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
        const more =
          offset + text.length < page.text.length
            ? `\n[… ${page.text.length - offset - text.length} more characters; read again with offset]`
            : "";
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
        "Clone one of the paper's candidate repositories (GitHub HTTPS only) at its current default-branch commit, pinned by SHA, with size, file-count, and symlink checks. No hooks or code run. Returns the receipt.",
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
        await acquireRepository(ctx, input.repositoryUrl, context.signal);
        const receipt = ctx.repository!.receipt;
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
        return ok(
          `Listed ${listing.entries.length} entries under ${input.path}`,
          listing.entries.join("\n") + (listing.truncated ? "\n[truncated]" : ""),
        );
      },
    }),
    defineTool({
      name: "repo_read",
      description: "Read a text file from the pinned repository checkout.",
      input: z.object({
        path: RelativePathInput,
        offset: z.number().int().nonnegative().default(0),
        maxBytes: z.number().int().positive().max(MAX_READ_BYTES).default(MAX_READ_BYTES),
      }),
      async run(input) {
        const repo = requireRepository(ctx);
        const file = await resolveInside(repo.dir, input.path);
        const result = await readBounded(file, input.offset, input.maxBytes);
        if (result.binary) return ok(`${input.path} is binary`, `${input.path} is a binary file of ${result.size} bytes.`);
        const end = input.offset + Buffer.byteLength(result.text);
        return ok(
          `Read ${input.path}`,
          `${input.path} (${result.size} bytes${end < result.size ? `, showing ${input.offset}-${end}` : ""}):\n${result.text}`,
        );
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
        return ok(
          `Found ${found.matches.length} matches for "${input.query}"`,
          found.matches.length ? found.matches.join("\n") + (found.truncated ? "\n[truncated]" : "") : "No matches.",
        );
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

function dependencyDiscover(ctx: StudyContext): ToolDefinition {
  return defineTool({
    name: "dependency_discover",
    description:
      "Find dependency files in the repository (requirements, constraints, pyproject, lockfiles) and parse the Python requirements. Reads files only; nothing is executed.",
    input: z.object({}),
    async run(_input, context) {
      const repo = requireRepository(ctx);
      const discovery = await discoverDependencies(repo.dir);
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
  });
}
