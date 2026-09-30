import type { AgentLedger, BoardEntry } from "@dejaml/run-store";
import { z } from "zod";

import type { AgentRole } from "./tools.js";

/**
 * The shared, append-only evidence board. Agents coordinate only through
 * typed entries here and through explicit messages; nobody reads another
 * agent's conversation. Every entry names its author.
 */
export const BOARD_KINDS = [
  "paper_claim",
  "repository_receipt",
  "repository_mapping",
  "dependency_report",
  "dependency_manifest",
  "dataset_receipt",
  "plan",
  "command_receipt",
  "artifact",
  "adapter_record",
  "submission",
  "diagnosis",
  "review",
  "policy_block",
  "status_decision",
  "note",
  "claim_contract",
  "dependency_request",
  "supervisor_decision",
  "metric",
  "stage",
] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

const Loose = z.record(z.string(), z.unknown());

/** Minimal shape checks per kind; the producing tool builds the full payload. */
const PAYLOAD_SCHEMAS: Record<BoardKind, z.ZodType<Record<string, unknown>>> = {
  paper_claim: Loose.and(z.object({ claim: z.unknown() })),
  repository_receipt: Loose.and(z.object({ repositoryUrl: z.string(), commitSha: z.string().regex(/^[a-f0-9]{40}$/u) })),
  repository_mapping: Loose,
  dependency_report: Loose,
  dependency_manifest: Loose.and(z.object({ manifestSha256: z.string() })),
  dataset_receipt: Loose.and(z.object({ sha256: z.string(), finalUrl: z.string() })),
  plan: Loose,
  command_receipt: Loose.and(z.object({ receiptId: z.string(), exitCode: z.number().nullable() })),
  artifact: Loose.and(z.object({ path: z.string(), sha256: z.string() })),
  adapter_record: Loose.and(z.object({ path: z.string(), why: z.string() })),
  submission: Loose,
  diagnosis: Loose,
  review: Loose.and(z.object({ verdict: z.string() })),
  policy_block: Loose.and(z.object({ reason: z.string() })),
  status_decision: Loose.and(z.object({ status: z.string() })),
  note: Loose,
  claim_contract: Loose.and(z.object({ planDigest: z.string().regex(/^[a-f0-9]{64}$/u), contract: z.record(z.string(), z.unknown()) })),
  dependency_request: Loose.and(z.object({ requirements: z.array(z.string()), reason: z.string() })),
  supervisor_decision: Loose.and(z.object({ checkpoint: z.string(), action: z.string() })),
  metric: Loose.and(z.object({ value: z.number().nullable(), receiptId: z.string().nullable() })),
  stage: Loose.and(z.object({ stage: z.string(), status: z.string() })),
};

/**
 * What each role may read. The Independent Reviewer sees the paper, the
 * repository, the declared plan, and receipts and artifacts: never the
 * Engineer's diagnoses or notes, which carry the Engineer's reasoning.
 */
export const BOARD_VISIBILITY: Record<AgentRole, readonly BoardKind[] | "all"> = {
  // The analysts work independently and concurrently: neither reads the other's findings.
  paper_analyst: ["repository_receipt"],
  repository_analyst: ["repository_receipt"],
  reproduction_planner: "all",
  lab_engineer: [
    "paper_claim",
    "repository_receipt",
    "repository_mapping",
    "dependency_report",
    "dependency_manifest",
    "dataset_receipt",
    "plan",
    "claim_contract",
    "policy_block",
  ],
  debugger: ["paper_claim", "repository_mapping", "dependency_manifest", "dataset_receipt", "plan", "claim_contract", "command_receipt"],
  independent_reviewer: [
    "paper_claim",
    "repository_receipt",
    "dependency_manifest",
    "dataset_receipt",
    "plan",
    "command_receipt",
    "artifact",
    "adapter_record",
    "submission",
    "claim_contract",
    "metric",
  ],
  supervisor: "all",
};

/**
 * Fields a role must not see even inside entries it may read. A submission's
 * free-text summary and failure reason are the Engineer's own words about
 * its work; the Reviewer judges the evidence (receipts, artifacts, declared
 * adapters and deviations, the parsed metric) without them.
 */
export const BOARD_REDACTIONS: Partial<Record<AgentRole, Partial<Record<BoardKind, readonly string[]>>>> = {
  independent_reviewer: { submission: ["summary", "failureReason", "reasoning", "notes"] },
};

function redact(role: AgentRole, entry: BoardEntry): BoardEntry {
  const fields = BOARD_REDACTIONS[role]?.[entry.kind as BoardKind];
  if (!fields) return entry;
  return { ...entry, payload: stripFields(entry.payload, new Set(fields)) as Record<string, unknown> };
}

function stripFields(value: unknown, fields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => stripFields(item, fields));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !fields.has(key))
        .map(([key, item]) => [key, stripFields(item, fields)]),
    );
  }
  return value;
}

export class EvidenceBoard {
  readonly #ledger: AgentLedger;
  readonly #runId: string;
  readonly #listeners = new Set<(entry: BoardEntry) => void>();

  constructor(ledger: AgentLedger, runId: string) {
    this.#ledger = ledger;
    this.#runId = runId;
  }

  get runId(): string {
    return this.#runId;
  }

  post(input: {
    kind: BoardKind;
    authorAgentId: string | null;
    authorRole: string;
    key?: string;
    payload: Record<string, unknown>;
  }): BoardEntry {
    const payload = PAYLOAD_SCHEMAS[input.kind].parse(input.payload);
    const entry = this.#ledger.postBoard({
      runId: this.#runId,
      authorAgentId: input.authorAgentId,
      authorRole: input.authorRole,
      kind: input.kind,
      key: input.key ?? null,
      payload,
    });
    for (const listener of this.#listeners) listener(entry);
    return entry;
  }

  list(kinds?: readonly BoardKind[], options: { key?: string } = {}): BoardEntry[] {
    return this.#ledger.listBoard(this.#runId, kinds).filter((entry) => options.key === undefined || entry.key === options.key);
  }

  /** Entries a role is allowed to read, optionally narrowed further. */
  visibleTo(role: AgentRole, kinds?: readonly BoardKind[], options: { key?: string } = {}): BoardEntry[] {
    const allowed = BOARD_VISIBILITY[role];
    const permitted = allowed === "all" ? [...BOARD_KINDS] : allowed;
    const requested = kinds ? kinds.filter((kind) => permitted.includes(kind)) : permitted;
    return this.list(requested, options).map((entry) => redact(role, entry));
  }

  latest(kind: BoardKind, key?: string): BoardEntry | null {
    return this.list([kind], key === undefined ? {} : { key }).at(-1) ?? null;
  }

  subscribe(listener: (entry: BoardEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
