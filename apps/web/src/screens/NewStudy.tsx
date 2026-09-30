import { useState } from "react";

import { FileDrop } from "../components/FileDrop";
import { checkPaper, formatBytes, type PaperCheck } from "../lib/paper";
import type { ServerConfig, StudyOptions } from "../lib/run-client";

type Accepted = Extract<PaperCheck, { ok: true }>;

export function NewStudy({
  onStart,
  config = null,
}: {
  onStart: (paper: File, options: StudyOptions) => Promise<void>;
  /** Live server settings; null in replay mode, where no model is called. */
  config?: ServerConfig | null;
}) {
  const [paper, setPaper] = useState<Accepted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const providers = config?.providers ?? [];
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const provider = providers.find((item) => item.id === providerId) ?? providers[0] ?? null;
  const [modelName, setModelName] = useState(provider?.models[0] ?? "");
  const [repositoryUrl, setRepositoryUrl] = useState("");

  const live = config !== null;
  const modelReady = !live || (provider !== null && provider.models.includes(modelName));

  const chooseProvider = (id: string) => {
    setProviderId(id);
    setModelName(providers.find((item) => item.id === id)?.models[0] ?? "");
  };

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
    if (!paper || !modelReady) return;
    setStarting(true);
    setError(null);
    try {
      await onStart(paper.file, {
        ...(live && provider ? { model: { providerId: provider.id, model: modelName } } : {}),
        ...(repositoryUrl.trim() ? { repositoryUrl: repositoryUrl.trim() } : {}),
      });
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
          Upload a machine-learning paper. DéjàML finds its code, picks one reported number, runs the experiment in a disposable lab, and
          shows how the new result compares, with evidence for every step.
        </p>
        <ul className="scope-list">
          <li>Text-readable PDFs up to 20 MB. Scanned papers are not supported.</li>
          <li>The paper must link a public GitHub repository, or you can name one below.</li>
          <li>
            Reviewed cases run their checked adapter. Other papers go to a team of separate agents: analysts, a planner, independent
            engineers in their own offline labs, and reviewers who never see the engineers' reasoning.
          </li>
          <li>Unsupported papers end as Inconclusive rather than guessing.</li>
        </ul>
      </div>

      <div className="card stack">
        <h2>New study</h2>
        {live ? (
          <fieldset className="stack model-settings" disabled={starting}>
            <legend>Model for the agents</legend>
            {providers.length === 0 ? (
              <p className="error small">This server has no model provider configured. Ask its administrator to add one.</p>
            ) : (
              <>
                <label className="field">
                  <span>Provider</span>
                  <select value={provider?.id ?? ""} onChange={(event) => chooseProvider(event.target.value)}>
                    {providers.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Model</span>
                  <select value={modelName} onChange={(event) => setModelName(event.target.value)}>
                    {(provider?.models ?? []).map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted small">
                  Providers, models and their API keys are set by this server's administrator. Keys stay on the server and are never sent to
                  the browser, saved with a study, shown in reports, or passed into a lab.
                </p>
              </>
            )}
          </fieldset>
        ) : null}
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
        {live ? (
          <label className="field">
            <span>Code repository (optional)</span>
            <input
              type="url"
              inputMode="url"
              placeholder="https://github.com/owner/repository"
              value={repositoryUrl}
              disabled={starting}
              onChange={(event) => setRepositoryUrl(event.target.value)}
            />
          </label>
        ) : null}
        <div className="row">
          <button className="button" type="button" disabled={!paper || !modelReady || starting} onClick={start}>
            {starting ? "Starting…" : "Start study"}
          </button>
          {paper && !starting ? (
            <button className="button secondary" type="button" onClick={() => setPaper(null)}>
              Clear
            </button>
          ) : null}
        </div>
        {paper && !modelReady ? <p className="muted small">Choose a model to start.</p> : null}
      </div>
    </section>
  );
}
