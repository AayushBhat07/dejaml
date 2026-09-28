# DéjàML Run Store

The run store persists run state and append-only public activity events in SQLite.

## Why it exists

The future Research Team screen needs to show Paper Analyst and Code Analyst working concurrently. Every visible update is therefore a structured event with:

- research role;
- timestamp and per-run sequence;
- started/progress/completed/warning/failed status;
- concise public summary;
- evidence pointers;
- safe public payload.

The store supports:

- replay after page refresh with `listEvents(runId, afterSequence)`;
- immediate delivery with `subscribe(runId, listener)`;
- valid run-state transitions;
- persistence across backend restarts when a SQLite filename is supplied.

It does not store or expose private model reasoning.

## Intended SSE flow

1. Browser connects with its last received sequence.
2. API calls `listEvents` to replay anything missed.
3. API calls `subscribe` to receive new events.
4. Each SSE message uses the event sequence as its ID.
5. On reconnect, the browser sends the last event ID and resumes without losing the timeline.

