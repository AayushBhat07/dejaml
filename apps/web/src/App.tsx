import type { RunEvent } from "@dejaml/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { Shell } from "./components/Shell";
import { appendEvents, EMPTY_LOG, type EventLog } from "./lib/event-log";
import { buildReport } from "./lib/lab";
import {
  defaultRunClient,
  type ConnectionState,
  type ReportSummary,
  type RunClient,
  type RunInfo,
  type ServerConfig,
  type StudyOptions,
} from "./lib/run-client";
import { LiveRun } from "./screens/LiveRun";
import { NewStudy } from "./screens/NewStudy";

/** Events that arrive together are applied together, so a burst of output renders once. */
const FLUSH_MS = 40;

export function App({ client: provided }: { client?: RunClient }) {
  const client = useMemo(() => provided ?? defaultRunClient(), [provided]);
  // Live runs keep their ID in the URL so a refresh resumes the same study from its first event.
  const [runId, setRunId] = useState<string | null>(() =>
    client.mode === "live" ? new URLSearchParams(window.location.search).get("run") : null,
  );
  const [log, setLog] = useState<EventLog>(EMPTY_LOG);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const pending = useRef<RunEvent[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!runId) return;
    setLog(EMPTY_LOG);
    setFinished(false);
    pending.current = [];
    let unsubscribe: (() => void) | null = null;
    let ended = false;
    const flush = () => {
      flushTimer.current = null;
      const batch = pending.current;
      pending.current = [];
      if (batch.length) setLog((current) => appendEvents(current, batch));
    };
    unsubscribe = client.subscribe(runId, 0, {
      onEvent: (event) => {
        setConnectionError(null);
        pending.current.push(event);
        if (!flushTimer.current) flushTimer.current = setTimeout(flush, FLUSH_MS);
        if (event.type === "run_finished" && !ended) {
          // The run is over: nothing more will stream, so the page stops listening (and never reconnects).
          ended = true;
          setFinished(true);
          setTimeout(() => {
            flush();
            unsubscribe?.();
          }, 0);
        }
      },
      onError: setConnectionError,
      onStatus: (state) => {
        setConnection(state);
        if (state === "live") setConnectionError(null);
      },
    });
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      unsubscribe?.();
    };
  }, [client, runId]);

  const [config, setConfig] = useState<ServerConfig | null>(null);
  useEffect(() => {
    let current = true;
    void client.config?.().then((value) => {
      if (current) setConfig(value);
    });
    return () => {
      current = false;
    };
  }, [client]);

  const [info, setInfo] = useState<RunInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!runId || !client.runInfo) return;
    let current = true;
    void client.runInfo(runId).then((value) => {
      if (current) setInfo(value);
    });
    return () => {
      current = false;
    };
  }, [client, runId]);

  const [report, setReport] = useState<ReportSummary | null>(null);
  useEffect(() => {
    setReport(null);
    if (!runId || !finished || !client.reportSummary) return;
    let current = true;
    void client.reportSummary(runId).then((value) => {
      if (current) setReport(value);
    });
    return () => {
      current = false;
    };
  }, [client, runId, finished]);

  const start = async (paper: File, options: StudyOptions) => {
    const run = await client.createRun(paper, options);
    setLog(EMPTY_LOG);
    setRunId(run.runId);
    if (client.mode === "live") window.history.replaceState(null, "", `?run=${encodeURIComponent(run.runId)}`);
  };

  const reset = () => {
    setRunId(null);
    setLog(EMPTY_LOG);
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  };

  const replay = client.mode === "replay" ? (client.replaySource ?? { kind: "prepared" as const }) : null;
  const download = () => {
    if (!runId) return;
    const built = buildReport(runId, log.events, replay);
    const url = URL.createObjectURL(new Blob([JSON.stringify(built, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `dejaml-report-${runId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Older recordings end with their lab's cleanup; agent studies end with their result.
  const native = log.events.some((event) => event.type === "agent_started" || event.type === "study_team");
  const ended = finished || log.events.some((event) => event.type === "study_result" || (!native && event.type === "lab_cleanup"));
  return (
    <Shell replay={replay} wide={Boolean(runId)}>
      {connectionError && !finished ? (
        <p className="error" role="alert">
          {connectionError}
        </p>
      ) : null}
      {!runId ? (
        <NewStudy key={config ? "configured" : "default"} onStart={start} config={client.mode === "live" ? config : null} />
      ) : (
        <LiveRun
          runId={runId}
          log={log}
          connection={connection}
          info={info}
          reviewedCases={config?.reviewedCases ?? []}
          report={report}
          replay={client.mode === "replay"}
          reportHref={client.reportUrl(runId)}
          onDownload={download}
          onCancel={() => void client.cancel(runId)}
          onNewStudy={ended ? reset : undefined}
        />
      )}
    </Shell>
  );
}
