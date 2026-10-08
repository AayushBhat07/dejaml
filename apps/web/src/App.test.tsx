import type { RunEvent } from "@dejaml/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import recordedRun from "../../../fixtures/events/urban-land-cover-success.json";
import { analyzeRun } from "./lib/live-run";
import { sha256Hex } from "./lib/paper";
import {
  HttpRunClient,
  ReplayRunClient,
  replaySourceFrom,
  type ReportSummary,
  type ReviewedCase,
  type RunClient,
  type RunSubscription,
} from "./lib/run-client";
import { blindedStream, SENTINEL_TEXT, studyEvents } from "./test/stream";

// These tests read the classic dashboard; the campus layout has its own tests (src/components/campus).
beforeEach(() => {
  window.localStorage.setItem("dejaml.liveRunLayout", "dashboard");
});

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

const pdf = (body: string, name = "paper.pdf") => new File([`%PDF-1.7\n${body}`], name, { type: "application/pdf" });
const choosePaper = async (file: File) => {
  await act(async () => {
    fireEvent.change(screen.getByTestId("paper-input"), { target: { files: [file] } });
  });
  await screen.findByText(file.name);
};
const cards = (role: string) => screen.getAllByTestId("agent-card").filter((card) => card.getAttribute("data-role") === role);

/** A live client whose stream the test controls: it records every subscription. */
function scriptedLiveClient(overrides: Partial<RunClient> = {}) {
  const subscriptions: Array<{ runId: string; after: number; subscription: RunSubscription; closed: boolean }> = [];
  const client: RunClient = {
    mode: "live",
    createRun: async () => ({ runId: "run_created" }),
    subscribe: (runId, after, subscription) => {
      const entry = { runId, after, subscription, closed: false };
      subscriptions.push(entry);
      subscription.onStatus?.("live");
      return () => {
        entry.closed = true;
      };
    },
    cancel: vi.fn(async () => undefined),
    reportUrl: (runId) => `/api/runs/${runId}/report`,
    ...overrides,
  };
  const emit = (events: readonly RunEvent[], index = subscriptions.length - 1) =>
    act(async () => {
      for (const event of events) subscriptions[index]!.subscription.onEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  return { client, subscriptions, emit };
}

describe("App shell", () => {
  it("labels a recorded replay with its recording date", () => {
    render(
      <App client={new ReplayRunClient(5, recordedRun, { kind: "recorded", runId: "run_real", recordedAt: "2026-09-29T10:00:00Z" })} />,
    );
    const note = screen.getByRole("note").textContent ?? "";
    expect(note).toContain("Recorded replay");
    expect(note).toContain("2026-09-29");
    expect(note).toContain("Nothing is executed now.");
  });

  it("reads the replay source from fixture metadata", () => {
    expect(replaySourceFrom({ source: "prepared" })).toEqual({ kind: "prepared" });
    expect(replaySourceFrom({ source: "recorded", runId: "run_real", recordedAt: "2026-09-29T10:00:00Z" })).toEqual({
      kind: "recorded",
      runId: "run_real",
      recordedAt: "2026-09-29T10:00:00Z",
    });
    expect(replaySourceFrom({ source: "recorded" })).toEqual({ kind: "prepared" });
  });

  it("labels replay mode and follows a replayed study on one persistent dashboard", async () => {
    render(<App client={new ReplayRunClient(2)} />);
    expect(screen.getByRole("note").textContent).toContain("Example replay");
    const start = screen.getByRole("button", { name: "Start study" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await choosePaper(pdf("body", "urban.pdf"));
    expect(start.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(start);
    });
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByTestId("live-run").getAttribute("data-mode")).toBe("replay");
    expect(screen.getByTestId("connection-status").textContent).toBe("Replay");
    await waitFor(() => expect(screen.getByText("Different result")).toBeTruthy(), { timeout: 3000 });
    // The verdict arrives before the lab's cleanup receipt; wait for the end of the replay.
    await waitFor(() => expect(screen.getByTestId("cleanup-verification")).toBeTruthy(), { timeout: 5000 });

    // Earlier roles, the lab, and the findings are all on the same screen at the end.
    expect(within(cards("paper_analyst")[0]!).getByText("Done")).toBeTruthy();
    expect(within(cards("code_analyst")[0]!).getByText("1 warning")).toBeTruthy();
    expect(within(cards("lead_researcher")[0]!).getByText("Approved one deterministic CPU experiment with seed 42")).toBeTruthy();
    expect(within(screen.getByTestId("lab-detail")).getByText(/python runner\.py --training data\/training\.csv/u)).toBeTruthy();
    expect(screen.getByTestId("network-state").textContent).toContain("Off");
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Memory" })).toBeTruthy();
    expect(screen.getByText(/sha256 [a-f0-9]{12}…/u)).toBeTruthy();
    expect(screen.getByTestId("paper-value").textContent).toBe("81.66%");
    expect(screen.getByTestId("observed-value").textContent).toBe("79.88%");
    expect(screen.getByTestId("delta-value").textContent).toBe("-1.78 points");
    expect(screen.getAllByText("Hypothesis")).toHaveLength(5);
    expect(within(screen.getByTestId("cleanup-verification")).getByText("Lab removed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download report" })).toBeTruthy();
  });

  it("explains why a file was refused", async () => {
    render(<App client={new ReplayRunClient(5)} />);
    await act(async () => {
      fireEvent.change(screen.getByTestId("paper-input"), {
        target: { files: [new File(["not a pdf"], "notes.txt")] },
      });
    });
    expect((await screen.findByRole("alert")).textContent).toBe("This file is not a PDF.");
  });
});

describe("live mode", () => {
  it("restores the run from the URL after a refresh and replays it from the first event", async () => {
    window.history.replaceState(null, "", `/?run=${studyEvents[0]!.runId}`);
    const first = scriptedLiveClient({ runInfo: async () => ({ fileName: "stand-in-paper.pdf" }) });
    const { unmount } = render(<App client={first.client} />);
    expect(first.subscriptions.map(({ runId, after }) => ({ runId, after }))).toEqual([{ runId: studyEvents[0]!.runId, after: 0 }]);
    await first.emit(studyEvents.slice(0, 60));
    expect(cards("lab_engineer")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "stand-in-paper.pdf", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    unmount();

    // A refresh: a new page, the same URL. The run is subscribed again from the start and rebuilt.
    const second = scriptedLiveClient();
    render(<App client={second.client} />);
    expect(second.subscriptions[0]).toMatchObject({ runId: studyEvents[0]!.runId, after: 0 });
    await second.emit(studyEvents.slice(0, 60));
    expect(cards("lab_engineer")).toHaveLength(2);
    expect(within(cards("paper_analyst")[0]!).getByText("Done")).toBeTruthy();
  });

  it("deduplicates replayed events, stops listening when the run finishes, then shows the report and a new study", async () => {
    window.history.replaceState(null, "", `/?run=${studyEvents[0]!.runId}`);
    const report: ReportSummary = {
      revealed: true,
      blinding: {
        sealed: true,
        revealed: true,
        commitment: "5".repeat(64),
        sealedAt: "2026-10-01T15:17:52.000Z",
        verified: true,
        observationVerified: true,
        comparison: null,
        errors: [],
      },
      paperValue: 81.66,
      observedValue: 79.88,
      signedDifference: -1.78,
      tolerance: 2,
      unit: "percent",
      verdict: "reproduced_within_tolerance",
      checks: [],
      hypotheses: [],
      reviews: [{ engineer: "engineer-1", verdict: "approve", equivalence: "equivalent", summary: null, concerns: [] }],
    };
    const reportSummary = vi.fn(async () => report);
    const live = scriptedLiveClient({ reportSummary });
    render(<App client={live.client} />);
    await live.emit(studyEvents.slice(0, 50));
    // A reconnect that replays from an older cursor: duplicates, out of order.
    await live.emit([...studyEvents.slice(40, 55)].reverse());
    await live.emit(studyEvents.slice(50));
    // Every event once, in sequence order.
    const rows = [...screen.getByTestId("stream-list").querySelectorAll(".stream-row")];
    expect(rows).toHaveLength(analyzeRun(studyEvents).stream.length);
    const times = rows.map((row) => row.querySelector("time")?.getAttribute("datetime") ?? "");
    expect(times).toEqual([...times].sort());
    expect(within(screen.getByTestId("stream-list")).getAllByText("engineer-1 ran the approved command: exit 0")).toHaveLength(1);

    await waitFor(() => expect(live.subscriptions[0]!.closed).toBe(true));
    await waitFor(() => expect(screen.getByTestId("observed-value").textContent).toBe("79.88%"));
    expect(reportSummary).toHaveBeenCalledWith(studyEvents[0]!.runId);
    expect(screen.getByTestId("connection-status").textContent).toBe("Connected");
    expect(screen.getByRole("link", { name: "Download report" }).getAttribute("href")).toBe(`/api/runs/${studyEvents[0]!.runId}/report`);

    fireEvent.click(screen.getByRole("button", { name: "New study" }));
    expect(screen.getByRole("heading", { name: "New study" })).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("keeps the paper target sealed across a reload and a replayed reconnect, and shows it only after the reveal", async () => {
    window.history.replaceState(null, "", `/?run=${studyEvents[0]!.runId}`);
    const blinded = blindedStream();
    const revealAt = blinded.findIndex((event) => event.type === "target_revealed");
    const first = scriptedLiveClient();
    const { unmount } = render(<App client={first.client} />);
    await first.emit(blinded.slice(0, 50));
    await first.emit([...blinded.slice(30, revealAt)].reverse());
    expect(screen.getByTestId("value-hidden")).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(SENTINEL_TEXT);
    const sealedHtml = screen.getByTestId("blinding-panel").outerHTML;
    unmount();

    const second = scriptedLiveClient();
    render(<App client={second.client} />);
    await second.emit(blinded.slice(0, revealAt));
    expect(screen.getByTestId("blinding-panel").outerHTML).toBe(sealedHtml);
    expect(document.body.innerHTML).not.toMatch(SENTINEL_TEXT);
    await second.emit(blinded.slice(revealAt, revealAt + 1));
    expect(screen.getByTestId("blinding-paper-value").textContent).toBe("0.3142");
  });

  it("shows a reconnecting stream in the header", async () => {
    window.history.replaceState(null, "", `/?run=${studyEvents[0]!.runId}`);
    const live = scriptedLiveClient();
    render(<App client={live.client} />);
    await live.emit(studyEvents.slice(0, 20));
    act(() => live.subscriptions[0]!.subscription.onStatus?.("reconnecting"));
    expect(screen.getByTestId("connection-status").textContent).toBe("Reconnecting…");
    act(() => live.subscriptions[0]!.subscription.onStatus?.("live"));
    expect(screen.getByTestId("connection-status").textContent).toBe("Connected");
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel study" })[0]!);
    expect(live.client.cancel).toHaveBeenCalledWith(studyEvents[0]!.runId);
  });

  it("offers only the server's providers and models, and never asks for or sends an API key", async () => {
    const replay = new ReplayRunClient(1);
    const calls: Array<{ name: string; options: unknown }> = [];
    const client = {
      mode: "live" as const,
      config: async () => ({
        providers: [
          { id: "anthropic", label: "Anthropic", models: ["claude-opus-5-5", "claude-sonnet-5-5"] },
          { id: "custom", label: "Lab model", models: ["llama"] },
        ],
      }),
      createRun: async (paper: File, options?: unknown) => {
        calls.push({ name: paper.name, options });
        return replay.createRun(paper);
      },
      subscribe: replay.subscribe.bind(replay),
      cancel: replay.cancel.bind(replay),
      reportUrl: () => null,
    };
    const { unmount } = render(<App client={client} />);
    await screen.findByLabelText("Provider");
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByLabelText("API base URL")).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByText("This server has no reviewed cases. The agents will choose the claim to study.")).toBeTruthy();
    await choosePaper(pdf("body"));
    const start = screen.getByRole("button", { name: "Start study" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5-5" } });
    fireEvent.change(screen.getByLabelText("Code repository (optional)"), {
      target: { value: "https://github.com/example/new-paper" },
    });
    await act(async () => {
      fireEvent.click(start);
    });
    expect(calls).toEqual([
      {
        name: "paper.pdf",
        options: {
          model: { providerId: "anthropic", model: "claude-sonnet-5-5" },
          repositoryUrl: "https://github.com/example/new-paper",
        },
      },
    ]);
    unmount();
  });

  it("uploads only the provider id and model name with a study, or the reviewed case id alone", async () => {
    const sent: FormData[] = [];
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(init?.body as FormData);
      return new Response(JSON.stringify({ runId: "run_x" }), { status: 201, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const client = new HttpRunClient("/api");
      await client.createRun(pdf(""), { model: { providerId: "openai", model: "gpt-x" } });
      await client.createRun(pdf(""), {
        model: { providerId: "openai", model: "gpt-x" },
        reviewedCaseId: "pyts-boss-gunpoint",
        repositoryUrl: "https://github.com/example/ignored",
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(2);
    expect([...sent[0]!.keys()].sort()).toEqual(["modelName", "paper", "providerId"]);
    expect([...sent[1]!.keys()].sort()).toEqual(["modelName", "paper", "providerId", "reviewedCaseId"]);
    expect(sent[1]!.get("reviewedCaseId")).toBe("pyts-boss-gunpoint");
  });
});

describe("reviewed cases", () => {
  const reviewedPaper = pdf("the reviewed BOSS paper", "boss.pdf");
  const reviewedCase = (caseId: string, paperSha256: string, overrides: Partial<ReviewedCase> = {}): ReviewedCase => ({
    caseId,
    title: caseId === "pyts-boss-gunpoint" ? "BOSS on GunPoint" : "Urban land cover",
    paperTitle:
      caseId === "pyts-boss-gunpoint" ? "The BOSS is concerned with time series classification" : "Urban land cover classification",
    paperSha256,
    claim: {
      method: caseId === "pyts-boss-gunpoint" ? "BOSS" : "Random Forest",
      dataset: caseId === "pyts-boss-gunpoint" ? "GunPoint" : "UCI Urban Land Cover",
      split: "official test split",
      metric: { name: "accuracy", unit: "percent" },
    },
    repository: { url: "https://github.com/example/repository", commitSha: "0123456789abcdef0123456789abcdef01234567" },
    available: true,
    ...overrides,
  });

  async function renderWithCases(createRun: RunClient["createRun"]) {
    const hash = await sha256Hex(await reviewedPaper.arrayBuffer());
    const cases = [reviewedCase("pyts-boss-gunpoint", hash), reviewedCase("urban-land-cover-random-forest", "b".repeat(64))];
    const live = scriptedLiveClient({
      config: async () => ({ providers: [{ id: "openai", label: "OpenAI", models: ["gpt-x"] }], reviewedCases: cases }),
      createRun,
    });
    render(<App client={live.client} />);
    await screen.findByLabelText("Case");
    return live;
  }

  it("matches the uploaded PDF to its reviewed case by SHA-256, shows the claim, and sends only the case id", async () => {
    const createRun = vi.fn<RunClient["createRun"]>(async () => ({ runId: "run_created" }));
    await renderWithCases(createRun);
    await choosePaper(reviewedPaper);
    expect(screen.getByTestId("case-match").textContent).toContain("BOSS on GunPoint");
    expect((screen.getByLabelText("Case") as HTMLSelectElement).value).toBe("pyts-boss-gunpoint");
    const claim = screen.getByTestId("reviewed-claim");
    expect(claim.textContent).toContain(
      "Claim that will be tested: BOSS on GunPoint (official test split), measured as accuracy (percent).",
    );
    expect(claim.textContent).toContain("The paper's value is sealed until the run's observation and blind review are locked.");
    // The reported value, page and location are not published before the run, so none is shown.
    expect(claim.textContent).not.toMatch(/100%|Page \d|Table 2/u);
    // The repository comes from the case; the browser cannot name another.
    expect(screen.queryByLabelText("Code repository (optional)")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start reviewed study" }));
    });
    expect(createRun).toHaveBeenCalledOnce();
    expect(createRun.mock.calls[0]![1]).toEqual({ model: { providerId: "openai", model: "gpt-x" }, reviewedCaseId: "pyts-boss-gunpoint" });
  });

  it("says clearly when the PDF matches no reviewed case, and starts an open study by default", async () => {
    const createRun = vi.fn<RunClient["createRun"]>(async () => ({ runId: "run_created" }));
    await renderWithCases(createRun);
    await choosePaper(pdf("some other paper", "other.pdf"));
    expect(screen.getByTestId("case-no-match").textContent).toContain("This PDF does not match any reviewed case on this server");
    expect((screen.getByLabelText("Case") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByTestId("reviewed-claim")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start study" }));
    });
    expect(createRun.mock.calls[0]![1]).toEqual({ model: { providerId: "openai", model: "gpt-x" } });
  });

  it("lets a person pick a reviewed case by hand and shows the server's refusal of a different paper", async () => {
    const createRun = vi.fn<RunClient["createRun"]>(async () => {
      throw new Error("The uploaded paper is not the paper reviewed for this case.");
    });
    await renderWithCases(createRun);
    fireEvent.change(screen.getByLabelText("Case"), { target: { value: "urban-land-cover-random-forest" } });
    expect(screen.getByTestId("reviewed-claim").textContent).toContain("Random Forest on UCI Urban Land Cover");
    await choosePaper(pdf("a different file", "urban.pdf"));
    // A manual choice survives a non-matching upload, with a warning; the server stays the judge.
    expect((screen.getByLabelText("Case") as HTMLSelectElement).value).toBe("urban-land-cover-random-forest");
    expect(screen.getByTestId("case-hash-mismatch").textContent).toContain("the server will refuse");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start reviewed study" }));
    });
    expect(createRun.mock.calls[0]![1]).toEqual({
      model: { providerId: "openai", model: "gpt-x" },
      reviewedCaseId: "urban-land-cover-random-forest",
    });
    const alerts = screen.getAllByRole("alert").map((alert) => alert.textContent);
    expect(alerts).toContain("The uploaded paper is not the paper reviewed for this case.");
  });
});
