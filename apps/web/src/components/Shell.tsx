import type { ReactNode } from "react";

import type { ReplaySource } from "../lib/run-client";
import type { StageId } from "../lib/stages";
import { Stepper } from "./Stepper";

export function Shell({
  stage,
  viewing,
  onSelectStage,
  replay,
  children,
}: {
  stage: StageId;
  viewing?: StageId;
  onSelectStage?: (stage: StageId) => void;
  replay: ReplaySource | null;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">DéjàML</span>
          <span className="brand-tagline">Same claim. One more run.</span>
        </div>
        <Stepper current={stage} viewing={viewing ?? stage} {...(onSelectStage ? { onSelect: onSelectStage } : {})} />
      </header>
      {replay ? (
        <div className="banner" role="note">
          {replay.kind === "recorded"
            ? `Recorded replay: no backend is connected, so studies replay a real run of the curated paper recorded on ${replay.recordedAt.slice(0, 10)}. Nothing is executed now.`
            : "Example replay: no backend is connected, so studies replay a prepared run of the curated paper built from the verified Phase 3 results. Nothing is executed."}
        </div>
      ) : null}
      <main className="content">{children}</main>
    </div>
  );
}
