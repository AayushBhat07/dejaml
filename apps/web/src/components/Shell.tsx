import type { ReactNode } from "react";

import type { ReplaySource } from "../lib/run-client";

export function Shell({ replay, wide = false, children }: { replay: ReplaySource | null; wide?: boolean; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">DéjàML</span>
          <span className="brand-tagline">Same claim. One more run.</span>
        </div>
      </header>
      {replay ? (
        <div className="banner" role="note">
          {replay.kind === "recorded"
            ? `Recorded replay: no backend is connected, so studies replay a real run of the curated paper recorded on ${replay.recordedAt.slice(0, 10)}. Nothing is executed now.`
            : "Example replay: no backend is connected, so studies replay a prepared run of the curated paper built from the verified Phase 3 results. Nothing is executed."}
        </div>
      ) : null}
      <main className="content" data-wide={wide}>
        {children}
      </main>
    </div>
  );
}
