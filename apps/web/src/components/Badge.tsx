import type { ReactNode } from "react";

export type Tone = "neutral" | "positive" | "warning" | "negative" | "accent";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}
