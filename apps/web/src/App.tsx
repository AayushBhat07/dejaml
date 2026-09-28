import type { RunEvent } from "@dejaml/contracts";
import { useEffect, useMemo, useState } from "react";

import { Shell } from "./components/Shell";
import { defaultRunClient, type RunClient } from "./lib/run-client";
import { stageForEvents } from "./lib/stages";
import { NewStudy } from "./screens/NewStudy";
import { RunActivity } from "./screens/RunActivity";

export function App({ client: provided }: { client?: RunClient }) {
  const client = useMemo(() => provided ?? defaultRunClient(), [provided]);
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
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
    setRunId(run.runId);
  };

  const stage = runId ? stageForEvents(events) : "new_study";
  return (
    <Shell stage={stage} replay={client.mode === "replay"}>
      {runId ? (
        <section className="card stack" aria-labelledby="activity-title">
          <div className="row">
            <h2 id="activity-title">Study activity</h2>
          </div>
          {connectionError ? <p className="error">{connectionError}</p> : null}
          <RunActivity events={events} />
        </section>
      ) : (
        <NewStudy onStart={start} />
      )}
    </Shell>
  );
}
