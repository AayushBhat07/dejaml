import { STAGES, type StageId } from "../lib/stages";

/**
 * `current` is how far the run has progressed; `viewing` is the screen shown.
 * Stages the run has reached (other than New Study) can be revisited.
 */
export function Stepper({
  current,
  viewing = current,
  onSelect,
}: {
  current: StageId;
  viewing?: StageId;
  onSelect?: (stage: StageId) => void;
}) {
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);
  return (
    <ol className="stepper" aria-label="Study progress">
      {STAGES.map((stage, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        const selectable = Boolean(onSelect) && index > 0 && index <= currentIndex;
        return (
          <li key={stage.id}>
            <button
              type="button"
              className="step"
              aria-label={stage.label}
              data-state={state}
              data-viewing={stage.id === viewing}
              aria-current={state === "current" ? "step" : undefined}
              aria-pressed={selectable ? stage.id === viewing : undefined}
              disabled={!selectable}
              onClick={() => onSelect?.(stage.id)}
            >
              <span className="step-index" aria-hidden="true">
                {state === "done" ? "✓" : index + 1}
              </span>
              <span className="step-label">{stage.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
