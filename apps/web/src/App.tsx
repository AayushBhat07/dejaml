import type { RunEvent } from "@dejaml/contracts";
import { useEffect, useMemo, useState } from "react";

import { Shell } from "./components/Shell";
import { defaultRunClient, type RunClient } from "./lib/run-client";
import { stageForEvents, type StageId } from "./lib/stages";
import { buildReport } from "./lib/lab";
import { Findings } from "./screens/Findings";
import { NewStudy } from "./screens/NewStudy";
import { ResearchTeam } from "./screens/ResearchTeam";
import { VirtualLab } from "./screens/VirtualLab";

export function App({ client: provided }: { client?: RunClient }) {
  const client = useMemo(() => provided ?? defaultRunClient(), [provided]);
  // Live runs keep their ID in the URL so a refresh resumes the same study.
  const [runId, setRunId] = useState<string | null>(() =>
    client.mode === "live" ? new URLSearchParams(window.location.search).get("run") : null,
  );
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [pinned, setPinned] = useState<StageId | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    return client.subscribe(runId, 0, {
      onEvent: (event) => {
        setConnectionError(null);
        setEvents((current) =>
          current.some((existing) => existing.sequence >= event.sequence) ? current : [...current, event],
        );
      },
      onError: setConnectionError,
    });
  }, [client, runId]);

  const start = async (paper: File) => {
    const run = await client.createRun(paper);
    setEvents([]);
    setPinned(null);
    setRunId(run.runId);
    if (client.mode === "live") window.history.replaceState(null, "", `?run=${encodeURIComponent(run.runId)}`);
  };

  const stage: StageId = runId ? stageForEvents(events) : "new_study";
  // Follow the run unless the viewer chose an earlier screen; clicking the live stage resumes following.
  const viewing = pinned ?? stage;
  const select = (next: StageId) => setPinned(next === stage ? null : next);

  const reset = () => {
    setRunId(null);
    setEvents([]);
    setPinned(null);
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  };

  const download = () => {
    if (!runId) return;
    const report = buildReport(runId, events, client.mode === "replay" ? (client.replaySource ?? { kind: "prepared" }) : null);
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `dejaml-report-${runId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Shell stage={stage} viewing={viewing} onSelectStage={select} replay={client.mode === "replay" ? (client.replaySource ?? { kind: "prepared" }) : null}>
      {connectionError ? <p className="error">{connectionError}</p> : null}
      {!runId ? (
        <NewStudy onStart={start} />
      ) : viewing === "research_team" ? (
        <ResearchTeam events={events} />
      ) : viewing === "virtual_lab" ? (
        <VirtualLab events={events} onCancel={() => void client.cancel(runId)} />
      ) : (
        <Findings
          events={events}
          onDownload={download}
          reportHref={client.reportUrl(runId)}
          onNewStudy={events.some((event) => event.type === "run_finished" || event.type === "lab_cleanup") ? reset : undefined}
        />
      )}
    </Shell>
  );
}
