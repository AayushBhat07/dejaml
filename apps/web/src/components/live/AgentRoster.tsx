import { Badge } from "../Badge";
import { elapsedBetween, formatElapsed, roleLabel, shortAgentId, TERMINAL_AGENT_STATUSES, type AgentCard } from "../../lib/live-run";
import { AGENT_STATUS, formatClock, formatNumber } from "./format";

const ACTIVE = new Set(["running", "using_tool", "reviewing"]);

function AgentInstance({
  card,
  now,
  selected,
  onSelect,
}: {
  card: AgentCard;
  now: number;
  selected: boolean;
  onSelect?: ((key: string) => void) | undefined;
}) {
  const status = AGENT_STATUS[card.status];
  const elapsed = elapsedBetween(card.startedAt, card.endedAt, now);
  const title = roleLabel(card.role);
  const headingId = `agent-${card.key.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const waiting = card.status === "waiting" || card.status === "blocked";
  return (
    <li>
      <article
        className="agent-card"
        data-status={card.status}
        data-role={card.role}
        data-selected={selected}
        aria-labelledby={headingId}
        data-testid="agent-card"
      >
        <header className="agent-card-head">
          <span className="agent-dot" data-status={card.status} aria-hidden="true" />
          <h3 id={headingId} className="agent-role">
            {title}
          </h3>
          <Badge tone={status.tone}>{status.label}</Badge>
        </header>
        <p className="agent-ids small">
          {card.label ? <span className="mono">{card.label}</span> : null}
          {card.agentId ? (
            <span className="mono muted" title={card.agentId}>
              {shortAgentId(card.agentId)}
            </span>
          ) : card.placeholder ? (
            <span className="muted">{card.label ? "agent not started" : "no instance yet"}</span>
          ) : null}
        </p>
        {waiting && card.waitingReason ? (
          <p className="agent-waiting small" data-testid="waiting-reason">
            {card.waitingReason}
          </p>
        ) : card.activity ? (
          <p className="agent-activity small">{card.activity}</p>
        ) : null}
        {card.failureReason ? <p className="agent-failure small">{card.failureReason}</p> : null}
        {card.startedAt || card.toolCalls !== null ? (
          <dl className="agent-meta small">
            {card.startedAt ? (
              <>
                <dt>Started</dt>
                <dd>
                  <time dateTime={card.startedAt}>{formatClock(card.startedAt)}</time>
                </dd>
                <dt>{TERMINAL_AGENT_STATUSES.has(card.status) ? "Took" : "Elapsed"}</dt>
                <dd className="mono">{elapsed === null ? "–" : formatElapsed(elapsed)}</dd>
              </>
            ) : null}
            {card.toolCalls !== null && !card.placeholder ? (
              <>
                <dt>Tool calls</dt>
                <dd className="mono">{card.toolCalls}</dd>
              </>
            ) : null}
            {card.tokens ? (
              <>
                <dt>Tokens</dt>
                <dd className="mono" title="input / output tokens">
                  {formatNumber(card.tokens.input)} / {formatNumber(card.tokens.output)}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {card.warnings > 0 || card.failures > 0 ? (
          <p className="row-tight">
            {card.failures > 0 ? (
              <Badge tone="negative">
                {card.failures} failure{card.failures === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {card.warnings > 0 ? (
              <Badge tone="warning">
                {card.warnings} warning{card.warnings === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </p>
        ) : null}
        {onSelect && !card.placeholder ? (
          <button
            type="button"
            className="link-button small"
            aria-pressed={selected}
            onClick={() => onSelect(card.key)}
            aria-label={`Show only ${title}${card.label ? ` ${card.label}` : ""} activity`}
          >
            {selected ? "Showing only this agent" : "Show its activity"}
          </button>
        ) : null}
      </article>
    </li>
  );
}

export function AgentRoster({
  cards,
  debuggerNote,
  now,
  selectedKey,
  onSelect,
}: {
  cards: readonly AgentCard[];
  debuggerNote: string | null;
  now: number;
  selectedKey: string | null;
  onSelect?: (key: string) => void;
}) {
  const instances = cards.filter((card) => !card.placeholder || card.label).length;
  const active = cards.filter((card) => ACTIVE.has(card.status)).length;
  return (
    <section className="panel roster" aria-labelledby="roster-title">
      <header className="panel-head">
        <h2 id="roster-title">Agents</h2>
        <span className="muted small">
          {instances} instance{instances === 1 ? "" : "s"} · {active} working
        </span>
      </header>
      <ol className="agent-list" aria-label="Agent instances">
        {cards.map((card) => (
          <AgentInstance key={card.key} card={card} now={now} selected={selectedKey === card.key} onSelect={onSelect} />
        ))}
      </ol>
      {debuggerNote ? (
        <p className="muted small debugger-note" data-testid="debugger-note">
          {debuggerNote}
        </p>
      ) : null}
    </section>
  );
}
