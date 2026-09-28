import type { RunEvent } from "@dejaml/contracts";
import { useEffect, useMemo, useState } from "react";

import { Shell } from "./components/Shell";
import { defaultRunClient, type RunClient } from "./lib/run-client";
import { stageForEvents, type StageId } from "./lib/stages";
import { NewStudy } from "./screens/NewStudy";
import { ResearchTeam } from "./screens/ResearchTeam";
import { RunActivity } from "./screens/RunActivity";

export function App({ client: provided }: { client?: RunClient }) {
  const client = useMemo(() => provided ?? defaultRunClient(), [provided]);
  const [runId, setRunId] = useState<string | null>(null);
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
  };

  const stage: StageId = runId ? stageForEvents(events) : "new_study";
  // Follow the run unless the viewer chose an earlier screen; clicking the live stage resumes following.
  const viewing = pinned ?? stage;
  const select = (next: StageId) => setPinned(next === stage ? null : next);

  return (
    <Shell stage={stage} viewing={viewing} onSelectStage={select} replay={client.mode === "replay"}>
      {connectionError ? <p className="error">{connectionError}</p> : null}
      {!runId ? (
        <NewStudy onStart={start} />
      ) : viewing === "research_team" ? (
        <ResearchTeam events={events} />
      ) : (
        <section className="card stack" aria-labelledby="activity-title">
          <h2 id="activity-title">Study activity</h2>
          <RunActivity events={events} />
        </section>
      )}
    </Shell>
  );
}
