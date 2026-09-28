import { STAGES, type StageId } from "../lib/stages";

export function Stepper({ current }: { current: StageId }) {
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);
  return (
    <ol className="stepper" aria-label="Study progress">
      {STAGES.map((stage, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        return (
          <li key={stage.id} className="step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="step-index" aria-hidden="true">{state === "done" ? "✓" : index + 1}</span>
            <span className="step-label">{stage.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
