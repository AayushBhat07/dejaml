import { useState } from "react";

import { FileDrop } from "../components/FileDrop";
import { checkPaper, formatBytes, type PaperCheck } from "../lib/paper";

type Accepted = Extract<PaperCheck, { ok: true }>;

export function NewStudy({ onStart }: { onStart: (paper: File) => Promise<void> }) {
  const [paper, setPaper] = useState<Accepted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);

  const choose = async (file: File) => {
    setChecking(true);
    setError(null);
    setPaper(null);
    const result = await checkPaper(file);
    setChecking(false);
    if (result.ok) setPaper(result);
    else setError(result.reason);
  };

  const start = async () => {
    if (!paper) return;
    setStarting(true);
    setError(null);
    try {
      await onStart(paper.file);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The study could not be started.");
      setStarting(false);
    }
  };

  return (
    <section className="hero" aria-labelledby="new-study-title">
      <div className="stack">
        <h1 id="new-study-title">Rerun one claim from a paper.</h1>
        <p className="hero-lede">
          Upload a machine-learning paper. DéjàML finds its code, picks one reported number, runs the experiment in a
          disposable lab, and shows how the new result compares, with evidence for every step.
        </p>
        <ul className="scope-list">
          <li>Text-readable PDFs up to 20 MB. Scanned papers are not supported.</li>
          <li>The paper must link a public GitHub repository.</li>
          <li>This demo runs one reviewed case: the Urban Land Cover Random Forest result.</li>
          <li>Unsupported papers end as Inconclusive rather than guessing.</li>
        </ul>
      </div>

      <div className="card stack">
        <h2>New study</h2>
        <FileDrop onFile={choose} disabled={starting} />
        {checking ? <p className="muted small">Checking the file…</p> : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {paper ? (
          <dl className="file-summary" aria-label="Selected paper">
            <dt>File</dt>
            <dd>{paper.file.name}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(paper.bytes)}</dd>
            <dt>SHA-256</dt>
            <dd className="mono">{paper.sha256}</dd>
          </dl>
        ) : null}
        <div className="row">
          <button className="button" type="button" disabled={!paper || starting} onClick={start}>
            {starting ? "Starting…" : "Start study"}
          </button>
          {paper && !starting ? (
            <button className="button secondary" type="button" onClick={() => setPaper(null)}>
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
