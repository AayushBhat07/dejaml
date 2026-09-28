import type { ReactNode } from "react";

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
  replay: boolean;
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
          Recorded replay: the backend is not connected, so studies replay a stored run of the curated paper.
          Nothing is executed.
        </div>
      ) : null}
      <main className="content">{children}</main>
    </div>
  );
}
