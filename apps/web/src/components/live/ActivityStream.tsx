import type { RunEvent } from "@dejaml/contracts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { CATEGORY_LABELS, roleLabel, shortAgentId, type AgentCard, type Category, type StreamItem } from "../../lib/live-run";
import { redact } from "../../lib/redact";
import { formatClock } from "./format";

type Evidence = RunEvent["evidence"][number];

const KIND_LABELS: Record<Evidence["kind"], string> = {
  paper_page: "Paper",
  repository_file: "Code",
  log_line: "Log",
  artifact: "Artifact",
};

/** Distance from the bottom, in pixels, that still counts as "at the latest event". */
const STICKY_PX = 48;

function actorName(item: StreamItem, cards: ReadonlyMap<string, AgentCard>): { role: string; instance: string | null } {
  const card = item.agentKey ? cards.get(item.agentKey) : undefined;
  if (card) return { role: roleLabel(card.role), instance: card.label ?? (card.agentId ? shortAgentId(card.agentId) : null) };
  if (item.event.actor === "lab_engineer" && item.labId) return { role: "Lab Manager", instance: null };
  return { role: item.event.actor === "system" ? "Orchestrator" : roleLabel(item.event.actor), instance: null };
}

export type EvidenceFocus = { eventId: string; index: number; evidence: Evidence; labId: string | null };

function EvidenceDetail({
  focus,
  onShowInLab,
}: {
  focus: EvidenceFocus;
  onShowInLab?: ((labId: string, reference: string) => void) | undefined;
}) {
  const [reference, digest] = focus.evidence.reference.split("#sha256=");
  return (
    <div className="evidence-detail small" role="region" aria-label="Evidence detail">
      <dl className="facts">
        <dt>Kind</dt>
        <dd>{KIND_LABELS[focus.evidence.kind]}</dd>
        <dt>Reference</dt>
        <dd className="mono">{redact(reference ?? focus.evidence.reference, 400)}</dd>
        {digest ? (
          <>
            <dt>SHA-256</dt>
            <dd className="mono">{digest}</dd>
          </>
        ) : null}
        {focus.evidence.excerpt ? (
          <>
            <dt>Excerpt</dt>
            <dd>
              <q>{redact(focus.evidence.excerpt, 600)}</q>
            </dd>
          </>
        ) : null}
      </dl>
      {focus.labId && onShowInLab && (focus.evidence.kind === "artifact" || focus.evidence.kind === "log_line") ? (
        <button type="button" className="link-button" onClick={() => onShowInLab(focus.labId!, focus.evidence.reference)}>
          Show in the Virtual Lab
        </button>
      ) : null}
    </div>
  );
}

export function ActivityStream({
  items,
  cards,
  agentFilter,
  onAgentFilter,
  following,
  onFollowChange,
  onShowInLab,
}: {
  items: readonly StreamItem[];
  cards: readonly AgentCard[];
  agentFilter: string | null;
  onAgentFilter: (key: string | null) => void;
  following: boolean;
  onFollowChange: (following: boolean) => void;
  onShowInLab?: (labId: string, reference: string) => void;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<Category>>(new Set());
  const [focus, setFocus] = useState<EvidenceFocus | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const seenCount = useRef(0);
  const [unseen, setUnseen] = useState(0);
  const byKey = useMemo(() => new Map(cards.map((card) => [card.key, card])), [cards]);

  const counts = useMemo(() => {
    const result = new Map<Category, number>();
    for (const item of items) result.set(item.category, (result.get(item.category) ?? 0) + 1);
    return result;
  }, [items]);
  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          !hidden.has(item.category) &&
          (agentFilter === null || (agentFilter === "system" ? item.agentKey === null : item.agentKey === agentFilter)),
      ),
    [items, hidden, agentFilter],
  );

  // Follow live: stay at the newest event. Scrolling up pauses following and never snaps back.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (following) {
      element.scrollTop = element.scrollHeight;
      seenCount.current = visible.length;
      setUnseen(0);
    } else {
      setUnseen(Math.max(0, visible.length - seenCount.current));
    }
  }, [visible.length, following]);

  const onScroll = () => {
    const element = list.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= STICKY_PX;
    if (atBottom !== following) onFollowChange(atBottom);
  };

  const toggle = (category: Category) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });

  const agents = cards.filter((card) => !card.placeholder);
  const categories = (Object.keys(CATEGORY_LABELS) as Category[]).filter((category) => counts.has(category));

  return (
    <section className="panel stream" aria-labelledby="stream-title">
      <header className="panel-head">
        <h2 id="stream-title">Live activity and evidence</h2>
        <span className="muted small" aria-live="polite">
          {visible.length} of {items.length} events
        </span>
      </header>
      <div className="stream-toolbar">
        <label className="field compact">
          <span>Agent</span>
          <select value={agentFilter ?? ""} onChange={(event) => onAgentFilter(event.target.value === "" ? null : event.target.value)}>
            <option value="">All agents</option>
            {agents.map((card) => (
              <option key={card.key} value={card.key}>
                {roleLabel(card.role)}
                {card.label ? ` · ${card.label}` : ""}
                {card.agentId ? ` · ${shortAgentId(card.agentId)}` : ""}
              </option>
            ))}
            <option value="system">Orchestrator and labs (no agent)</option>
          </select>
        </label>
        <div className="chip-row" role="group" aria-label="Event types">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              className="chip"
              aria-pressed={!hidden.has(category)}
              onClick={() => toggle(category)}
              title={hidden.has(category) ? "Show these events" : "Hide these events"}
            >
              {CATEGORY_LABELS[category]} <span className="chip-count">{counts.get(category)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="stream-body">
        <ol ref={list} className="stream-list" aria-label="Run events" onScroll={onScroll} data-testid="stream-list">
          {visible.length === 0 ? <li className="muted small stream-empty">No events match these filters yet.</li> : null}
          {visible.map((item) => {
            const actor = actorName(item, byKey);
            return (
              <li key={item.event.sequence} className="stream-row" data-status={item.event.status} data-category={item.category}>
                <time className="stream-time mono" dateTime={item.event.timestamp} title={item.event.timestamp}>
                  {formatClock(item.event.timestamp)}
                </time>
                <div className="stream-main">
                  <div className="stream-line">
                    <span className="stream-actor">
                      {actor.role}
                      {actor.instance ? <span className="mono muted"> {actor.instance}</span> : null}
                    </span>
                    <span className="stream-tag">{CATEGORY_LABELS[item.category]}</span>
                  </div>
                  <p className="stream-text">{item.text}</p>
                  {item.detail ? <p className="stream-detail mono small">{item.detail}</p> : null}
                  {item.event.evidence.length > 0 ? (
                    <ul className="evidence-chips" aria-label="Evidence">
                      {item.event.evidence.map((evidence, index) => {
                        const active = focus?.eventId === item.event.id && focus.index === index;
                        const shown = redact(evidence.reference.split("#sha256=")[0] ?? evidence.reference, 90);
                        return (
                          <li key={`${evidence.reference}:${index}`}>
                            <button
                              type="button"
                              className="evidence-chip"
                              aria-label={`${KIND_LABELS[evidence.kind]} ${shown}`}
                              aria-expanded={active}
                              onClick={() => setFocus(active ? null : { eventId: item.event.id, index, evidence, labId: item.labId })}
                            >
                              <span className="evidence-kind">{KIND_LABELS[evidence.kind]}</span>
                              <span className="mono">{shown}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {focus?.eventId === item.event.id ? <EvidenceDetail focus={focus} onShowInLab={onShowInLab} /> : null}
                </div>
              </li>
            );
          })}
        </ol>
        {!following ? (
          <button type="button" className="jump-latest" onClick={() => onFollowChange(true)}>
            {unseen > 0 ? `${unseen} new event${unseen === 1 ? "" : "s"} · ` : ""}Jump to latest
          </button>
        ) : null}
      </div>
    </section>
  );
}
