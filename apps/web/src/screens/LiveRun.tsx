import type { RunEvent } from "@dejaml/contracts";
import { useMemo, useState } from "react";

import { ActivityStream } from "../components/live/ActivityStream";
import { AgentRoster } from "../components/live/AgentRoster";
import { Completion } from "../components/live/Completion";
import { useNow } from "../components/live/format";
import { LabPanel } from "../components/live/LabPanel";
import { RunHeader } from "../components/live/RunHeader";
import type { EventLog } from "../lib/event-log";
import { findingsFor } from "../lib/lab";
import { analyzeRun } from "../lib/live-run";
import type { ConnectionState, ReportSummary, ReviewedCase, RunInfo } from "../lib/run-client";

/** Older recordings carry their comparison in a Result Verifier event instead of a server report. */
function recordedSummary(events: readonly RunEvent[]): ReportSummary | null {
  const findings = findingsFor(events);
  if (!findings) return null;
  const { assessment } = findings;
  return {
    paperValue: assessment.paperValue,
    observedValue: assessment.observedValue,
    signedDifference: assessment.signedDifference,
    tolerance: assessment.tolerance,
    unit: findings.unit,
    verdict: assessment.verdict,
    checks: assessment.checks,
    hypotheses: assessment.discrepancyHypotheses,
    reviews: [],
  };
}

/**
 * The Live Run Dashboard: one persistent screen from the moment a study is
 * created until it ends. Earlier agents, evidence, and labs stay visible as
 * later stages begin; nothing is replaced when the study moves on.
 */
export function LiveRun({
  runId,
  log,
  connection,
  info = null,
  reviewedCases = [],
  report = null,
  replay = false,
  reportHref,
  onDownload,
  onCancel,
  onNewStudy,
}: {
  runId: string;
  log: EventLog;
  connection: ConnectionState;
  info?: RunInfo | null;
  reviewedCases?: readonly ReviewedCase[];
  report?: ReportSummary | null;
  replay?: boolean;
  reportHref: string | null;
  onDownload: () => void;
  onCancel?: () => void;
  onNewStudy?: (() => void) | undefined;
}) {
  const view = useMemo(() => analyzeRun(log.events), [log.events]);
  const legacy = useMemo(() => (view.native ? null : recordedSummary(log.events)), [view.native, log.events]);
  const summary = report ?? legacy;
  const ended = view.finished || view.result !== null;
  const now = useNow(!ended);
  const [following, setFollowing] = useState(true);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [chosenLab, setChosenLab] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);

  const reviewed = reviewedCases.find((item) => item.caseId === view.caseId) ?? null;
  const fileName = info?.fileName ?? view.paperFileName;
  const title = reviewed?.paperTitle ?? fileName ?? "New study";
  const claim = view.claim;
  const subtitle = claim
    ? `Claim under test: ${claim.method} on ${claim.dataset}, ${claim.metric} ${claim.reportedValue ?? "?"}${claim.unit === "percent" ? "%" : ""}${claim.page ? ` (page ${claim.page})` : ""}${view.caseId ? ` · reviewed case ${view.caseId}` : ""}`
    : fileName && fileName !== title
      ? fileName
      : null;

  const engineerWaiting = view.cards.find((card) => card.role === "lab_engineer" && card.placeholder)?.waitingReason;
  const labWaiting =
    engineerWaiting ?? "No lab yet. Labs are created after the plan is approved and the lab image and dependencies are prepared.";
  const cancel = onCancel
    ? () => {
        setCancelRequested(true);
        onCancel();
      }
    : undefined;
  const reviewers = view.cards.filter((card) => card.role === "independent_reviewer" && !card.placeholder);
  const showCompletion = ended || summary !== null;

  return (
    <div className="live-run stack" data-mode={replay ? "replay" : "live"} data-last-sequence={log.lastSequence} data-testid="live-run">
      <RunHeader
        runId={runId}
        title={title}
        subtitle={subtitle}
        view={view}
        connection={replay ? "replay" : view.finished && connection === "closed" ? "complete" : connection}
        now={now}
        following={following}
        onToggleFollow={() => setFollowing((current) => !current)}
        onCancel={cancel}
        cancelling={cancelRequested || view.cancelling}
      />
      {showCompletion ? (
        <Completion
          view={view}
          report={summary}
          reportHref={reportHref}
          onDownload={onDownload}
          onNewStudy={onNewStudy}
          reviewers={reviewers}
        />
      ) : null}
      <div className="dashboard-grid">
        <AgentRoster
          cards={view.cards}
          debuggerNote={view.debuggerNote}
          now={now}
          selectedKey={agentFilter}
          onSelect={(key) => setAgentFilter((current) => (current === key ? null : key))}
        />
        <ActivityStream
          items={view.stream}
          cards={view.cards}
          agentFilter={agentFilter}
          onAgentFilter={setAgentFilter}
          following={following}
          onFollowChange={setFollowing}
          onShowInLab={(labId, reference) => {
            setChosenLab(labId);
            setHighlight(reference);
          }}
        />
        <LabPanel
          labs={view.labs}
          now={now}
          selectedLabId={chosenLab}
          onSelectLab={(labId) => {
            setChosenLab(labId);
            setHighlight(null);
          }}
          droppedOutputLines={log.droppedOutputLines}
          highlight={highlight}
          preparation={view.preparation}
          waitingText={labWaiting}
          onCancel={cancel}
          cancellable={!ended && !cancelRequested && view.labs.some((lab) => lab.state !== "removed" && lab.state !== "cleanup_failed")}
        />
      </div>
    </div>
  );
}
