import { useState } from "react";

import { Badge } from "../components/Badge";
import { FileDrop } from "../components/FileDrop";
import { checkPaper, formatBytes, type PaperCheck } from "../lib/paper";
import type { ReviewedCase, ServerConfig, StudyOptions } from "../lib/run-client";

type Accepted = Extract<PaperCheck, { ok: true }>;

/**
 * The claim a reviewed case tests, as the server publishes it: method, dataset,
 * split and metric. Never the paper's value, page or location (sealed until the
 * run's observation and blind review are locked) and never an observed value.
 */
function ClaimSummary({ item }: { item: ReviewedCase }) {
  return (
    <div className="claim-summary stack-tight" data-testid="reviewed-claim">
      <p className="small">
        <strong>Claim that will be tested:</strong> {item.claim.method} on {item.claim.dataset} ({item.claim.split}), measured as{" "}
        <strong>{item.claim.metric.name}</strong> ({item.claim.metric.unit}).
      </p>
      <p className="small" data-testid="claim-sealed">
        The paper's value is sealed until the run's observation and blind review are locked.
      </p>
      <dl className="file-summary">
        <dt>Paper</dt>
        <dd>{item.paperTitle}</dd>
        <dt>Metric</dt>
        <dd>
          {item.claim.metric.name} ({item.claim.metric.unit})
        </dd>
        <dt>Repository</dt>
        <dd className="mono">
          {item.repository.url.replace(/^https:\/\//u, "")} @ {item.repository.commitSha.slice(0, 12)}
        </dd>
        <dt>Paper SHA-256</dt>
        <dd className="mono">{item.paperSha256}</dd>
      </dl>
      <p className="muted small">
        The agents still read the paper and the code, the plan still passes policy review, the official command still runs in a sealed lab,
        and an Independent Reviewer still judges the evidence. The case decides only which claim is studied.
      </p>
    </div>
  );
}

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
  const cases = config?.reviewedCases ?? [];
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const provider = providers.find((item) => item.id === providerId) ?? providers[0] ?? null;
  const [modelName, setModelName] = useState(provider?.models[0] ?? "");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [caseId, setCaseId] = useState("");
  const [caseChosenByHash, setCaseChosenByHash] = useState(false);

  const live = config !== null;
  const modelReady = !live || (provider !== null && provider.models.includes(modelName));
  const chosen = cases.find((item) => item.caseId === caseId) ?? null;
  const matched = paper ? (cases.find((item) => item.paperSha256 === paper.sha256) ?? null) : null;

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
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setPaper(result);
    // The browser's SHA-256 of the PDF finds its reviewed case; the server checks the hash again.
    const match = cases.find((item) => item.paperSha256 === result.sha256 && item.available);
    if (match) {
      setCaseId(match.caseId);
      setCaseChosenByHash(true);
    } else if (caseChosenByHash) {
      setCaseId("");
      setCaseChosenByHash(false);
    }
  };

  const start = async () => {
    if (!paper || !modelReady) return;
    setStarting(true);
    setError(null);
    try {
      await onStart(paper.file, {
        ...(live && provider ? { model: { providerId: provider.id, model: modelName } } : {}),
        ...(live && chosen
          ? { reviewedCaseId: chosen.caseId }
          : !chosen && repositoryUrl.trim()
            ? { repositoryUrl: repositoryUrl.trim() }
            : {}),
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
            Reviewed cases name the claim to study. Every paper goes to a team of separate agents: analysts, a planner, independent
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
          <fieldset className="stack model-settings" disabled={starting}>
            <legend>Reviewed case</legend>
            {cases.length === 0 ? (
              <p className="muted small">This server has no reviewed cases. The agents will choose the claim to study.</p>
            ) : (
              <>
                {paper && matched ? (
                  <p className="small" role="status" data-testid="case-match">
                    <Badge tone="positive">Matched</Badge> This PDF is the paper reviewed for <strong>{matched.title}</strong> (SHA-256
                    match).
                  </p>
                ) : null}
                {paper && !matched ? (
                  <p className="notice small" role="status" data-testid="case-no-match">
                    This PDF does not match any reviewed case on this server: its SHA-256 differs from every reviewed paper. You can start
                    an open study where the agents choose the claim. A reviewed case runs only with the exact PDF it was reviewed against.
                  </p>
                ) : null}
                <label className="field">
                  <span>Case</span>
                  <select
                    value={caseId}
                    onChange={(event) => {
                      setCaseId(event.target.value);
                      setCaseChosenByHash(false);
                    }}
                  >
                    <option value="">None: the agents choose the claim</option>
                    {cases.map((item) => (
                      <option key={item.caseId} value={item.caseId} disabled={!item.available}>
                        {item.title} ({item.caseId}){item.available ? "" : " — not available"}
                      </option>
                    ))}
                  </select>
                </label>
                {chosen ? <ClaimSummary item={chosen} /> : null}
                {chosen && paper && paper.sha256 !== chosen.paperSha256 ? (
                  <p className="error small" role="alert" data-testid="case-hash-mismatch">
                    This PDF is not the paper reviewed for {chosen.caseId}; the server will refuse to start this case with it.
                  </p>
                ) : null}
              </>
            )}
          </fieldset>
        ) : null}
        {live && !chosen ? (
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
            {starting ? "Starting…" : chosen ? "Start reviewed study" : "Start study"}
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
