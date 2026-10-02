import { type RunStore, sha256Hex } from "@dejaml/run-store";

import { compareRevealed, lockObservation, type Observation, revealTarget, type SealedTarget, valueForms } from "./blinding.js";
import type { MultiAgentReport } from "./study.js";
import { DOWNGRADES } from "./verdict.js";

/**
 * Re-checks, from the stored ledger, events and agent histories alone, that a
 * finished study was blinded: an acceptance run passes only if every check
 * holds. Nothing here trusts the study's own flags; each commitment is
 * recomputed and each history is scanned again.
 */
export type BlindingProofCheck = { name: string; pass: boolean; info: string };

export const BLINDING_ORDER = [
  "target_sealed",
  "agents_started",
  "execution_completed",
  "observation_locked",
  "blind_review_locked",
  "target_revealed",
  "deterministic_comparison",
  "final_status",
] as const;

/** Keys that only the paper's target carries. A blind agent must never receive one. */
const TARGET_KEYS = /"(reportedValue|paperReference|paperValue)"\s*:\s*(?!null)/u;
/** Events that carry what the lab measured, which may legitimately equal the paper's value. */
const OBSERVED_EVENTS = new Set(["lab_output", "agent_command", "observation_locked", "metric_parsed"]);
const SEALED_EVENT_KEYS = ["caseId", "commitment", "metric", "sealedAt"];

export function proveBlinding(input: { store: RunStore; runId: string; report: MultiAgentReport }): BlindingProofCheck[] {
  const { store, runId, report } = input;
  const blinding = report.blinding;
  const records = blinding.records;
  const checks: BlindingProofCheck[] = [];
  const check = (name: string, pass: boolean, info: string): void => {
    checks.push({ name, pass, info });
  };
  const first = (phase: string) => records.find((item) => item.phase === phase) ?? null;
  const sealedRecord = first("target_sealed");
  const revealRecord = first("target_revealed");
  const agents = store.ledger.listAgents(runId);
  const events = store.listEvents(runId);

  // 1. Sealed before any agent existed, and publicly announced with four fields only.
  const sealedEvent = events.find((item) => item.type === "target_sealed") ?? null;
  const sealedKeys = sealedEvent ? Object.keys(sealedEvent.publicPayload).sort() : [];
  check(
    "target sealed before any agent existed",
    sealedRecord !== null &&
      records[0]?.phase === "target_sealed" &&
      agents.length > 0 &&
      agents.every((agent) => agent.createdAt >= sealedRecord.at) &&
      JSON.stringify(sealedKeys) === JSON.stringify(SEALED_EVENT_KEYS),
    `sealed ${sealedRecord?.at ?? "never"}; first agent ${agents.map((agent) => agent.createdAt).sort()[0] ?? "none"}; public fields ${sealedKeys.join(", ")}`,
  );

  // 2. The phases in the one allowed order, each first occurrence after the previous one.
  const firsts = BLINDING_ORDER.map((phase) => first(phase)?.sequence ?? -1);
  const inOrder = firsts.every((sequence, index) => sequence > 0 && (index === 0 || sequence > firsts[index - 1]!));
  const lastObservation = Math.max(
    ...records.filter((item) => item.phase === "observation_locked" || item.phase === "blind_review_locked").map((item) => item.sequence),
  );
  check(
    "commitments recorded in the required order",
    inOrder &&
      revealRecord !== null &&
      revealRecord.sequence > lastObservation &&
      records.filter((item) => item.phase === "target_revealed").length === 1 &&
      records.at(-1)?.phase === "final_status",
    records.map((item) => `${item.sequence}:${item.phase}${item.round ? `#${item.round}` : ""}`).join(" "),
  );

  // 3. The sealed commitment, recomputed from the revealed payload.
  let target: SealedTarget | null = null;
  let revealProblem = "not revealed";
  if (blinding.reveal && blinding.commitment) {
    try {
      target = revealTarget({ canonical: blinding.reveal.canonical, commitment: blinding.commitment });
      revealProblem = "";
    } catch (error) {
      revealProblem = error instanceof Error ? error.message : String(error);
    }
  }
  check(
    "sealed commitment verified at the reveal",
    target !== null &&
      sha256Hex(blinding.reveal!.canonical) === blinding.commitment &&
      blinding.reveal!.verified &&
      /^[a-f0-9]{64}$/u.test(target.nonce),
    target ? `sha256(canonical) = ${blinding.commitment}; nonce of ${target.nonce.length / 2} bytes` : revealProblem,
  );

  // 4. Every locked observation still matches its commitment.
  const observationRecords = records.filter((item) => item.phase === "observation_locked");
  const observations = observationRecords.map((item) => (item.record as { observation?: Observation }).observation ?? null);
  check(
    "observation locked and its commitment recomputes",
    observationRecords.length > 0 &&
      observationRecords.every(
        (item, index) => observations[index] !== null && lockObservation(observations[index]!).commitment === item.commitment,
      ) &&
      blinding.reveal?.observationVerified === true,
    observationRecords
      .map(
        (item, index) =>
          `round ${item.round}: ${item.commitment} observed ${observations[index]?.engineers.map((engineer) => engineer.observedValue).join(", ")}`,
      )
      .join("; "),
  );

  // 5. Blind roles never held the paper tool.
  const blindAgents = agents.filter((agent) => agent.role !== "paper_analyst");
  const paperReaders = blindAgents.filter((agent) => agent.grants.includes("paper_read_page") || agent.grants.includes("paper_search"));
  check(
    "only the Paper Analyst could read the paper",
    blindAgents.length > 0 && paperReaders.length === 0,
    paperReaders.length
      ? `granted: ${paperReaders.map((agent) => agent.role).join(", ")}`
      : `${blindAgents.length} blind agents without paper tools`,
  );

  // 6. What every blind agent was told before the reveal.
  const forms = target ? valueForms(target.reportedValue, target.metric.unit) : [];
  const leaks: string[] = [];
  const revealAt = revealRecord?.at ?? "9999";
  const scan = (where: string, value: unknown, withForms: boolean): void => {
    const text = JSON.stringify(value);
    if (TARGET_KEYS.test(text)) leaks.push(`${where}: a target field`);
    if (!withForms) return;
    for (const form of forms) {
      if (new RegExp(`(?<![\\d.])${form.replaceAll(".", "\\.")}(?![\\d]|\\.\\d)`, "u").test(text)) {
        leaks.push(`${where}: ${form}`);
        break;
      }
    }
  };
  let scanned = 0;
  for (const agent of blindAgents) {
    if (agent.createdAt >= revealAt) continue;
    scan(`${agent.role} task`, agent.task, true);
    for (const turn of store.ledger.listTurns(agent.id)) {
      const role = (turn.message as { role?: string }).role;
      if (role === "assistant" || turn.createdAt >= revealAt) continue;
      scanned += 1;
      // A tool result may carry what the lab measured, which can equal the paper's value.
      scan(`${agent.role} turn ${turn.sequence}`, turn.message, role !== "tool");
    }
  }
  check(
    "no blind agent received the paper's value or tolerance before the reveal",
    target !== null && scanned > 0 && leaks.length === 0,
    `${scanned} received messages scanned; ${
      forms.length ? `forms ${forms.join(", ")}` : "the value has no distinctive written form, so only target fields were scanned"
    }${leaks.length ? `; leaks: ${leaks.join("; ")}` : ""}`,
  );

  // 7. What the browser received before the reveal.
  const revealIndex = events.findIndex((item) => item.type === "target_revealed");
  const before = revealIndex < 0 ? events : events.slice(0, revealIndex);
  const eventLeaks = leaks.length;
  for (const item of before)
    scan(`event ${item.sequence} ${item.type}`, { summary: item.summary, payload: item.publicPayload }, !OBSERVED_EVENTS.has(item.type));
  check(
    "no event before the reveal carried the paper's value",
    revealIndex > 0 && leaks.length === eventLeaks,
    `${before.length} events before the reveal${leaks.length > eventLeaks ? `; leaks: ${leaks.slice(eventLeaks).join("; ")}` : ""}`,
  );

  // 8. The execution projection.
  check(
    "agents and labs saw the execution projection",
    blinding.projection !== null && /^[a-f0-9]{64}$/u.test(blinding.projection.sha256),
    blinding.projection
      ? `projection ${blinding.projection.sha256} of manifest ${blinding.projection.originalManifestSha256}; notebooks stripped: ${
          blinding.projection.notebooksStripped.map((item) => `${item.path} (${item.outputsRemoved} outputs)`).join(", ") ||
          "none in the repository"
        }; documents withheld: ${blinding.projection.documentsWithheld}`
      : "no projection",
  );

  // 9. The comparison, recomputed in code from the revealed value and the locked observation.
  const comparison = blinding.comparison;
  const lockedValues = observations.flatMap((item) => item?.engineers.map((engineer) => engineer.observedValue) ?? []);
  const recomputed = target && comparison ? compareRevealed(target, comparison.observed) : null;
  check(
    "comparison recomputes from the revealed target and the locked observation",
    recomputed !== null &&
      comparison !== null &&
      lockedValues.includes(comparison.observed) &&
      recomputed.absoluteDelta === comparison.absoluteDelta &&
      recomputed.withinTolerance === comparison.withinTolerance &&
      recomputed.reported === report.result.paperValue &&
      recomputed.tolerance === report.result.tolerance,
    comparison
      ? `|${comparison.observed} − ${comparison.reported}| = ${comparison.absoluteDelta}, tolerance ${comparison.tolerance}, within: ${comparison.withinTolerance}`
      : "no comparison",
  );

  // 10. The blind verdicts were locked first, and nothing raised the status.
  const finalRecord = first("final_status");
  const finalStatus = (finalRecord?.record as { status?: string } | undefined)?.status;
  const computed = report.result.computedStatus;
  check(
    "blind verdicts locked before the reveal; the status was only ever lowered",
    (comparison?.blindVerdicts.length ?? 0) > 0 &&
      finalStatus === report.result.status &&
      (report.result.status === computed || DOWNGRADES[computed].includes(report.result.status)),
    `blind verdicts ${comparison?.blindVerdicts.join(", ")}; computed ${computed}; final ${report.result.status}`,
  );
  return checks;
}
