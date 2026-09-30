import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";
import recordedRun from "../../../fixtures/events/urban-land-cover-success.json";
import { ReplayRunClient, replaySourceFrom } from "./lib/run-client";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("App shell", () => {
  it("labels a recorded replay with its recording date", () => {
    render(
      <App
        client={new ReplayRunClient(5, recordedRun, { kind: "recorded", runId: "run_real", recordedAt: "2026-09-29T10:00:00Z" })}
      />,
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

  it("labels replay mode and starts a study from a valid PDF", async () => {
    render(<App client={new ReplayRunClient(5)} />);

    expect(screen.getByRole("note").textContent).toContain("Example replay");
    expect(screen.getByText("New Study").closest("button")?.getAttribute("aria-current")).toBe("step");
    const start = screen.getByRole("button", { name: "Start study" });
    expect((start as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByTestId("paper-input");
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(["%PDF-1.7\nbody"], "urban.pdf", { type: "application/pdf" })] },
      });
    });
    await screen.findByText("urban.pdf");
    expect((start as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(start);
    });
    await screen.findByText("Research Team", { selector: "h2" });
    await waitFor(() => expect(screen.getByText("Different result")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Findings" }).getAttribute("aria-current")).toBe("step");

    // Completed stages can be revisited from the stepper.
    fireEvent.click(screen.getByRole("button", { name: /Research Team/u }));
    expect(screen.getByRole("heading", { name: "Research Team" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New Study/u }).hasAttribute("disabled")).toBe(true);
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
  it("resumes the run named in the URL and offers a new study when it ends", async () => {
    const replay = new ReplayRunClient(1);
    const client = {
      mode: "live" as const,
      createRun: replay.createRun.bind(replay),
      subscribe: replay.subscribe.bind(replay),
      cancel: replay.cancel.bind(replay),
      reportUrl: (runId: string) => `/api/runs/${runId}/report`,
    };
    window.history.replaceState(null, "", "/?run=run_resumed");
    render(<App client={client} />);
    expect(screen.queryByRole("note")).toBeNull();
    await waitFor(() => expect(screen.getByText("Different result")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Download report" }).getAttribute("href")).toBe("/api/runs/run_resumed/report");

    fireEvent.click(screen.getByRole("button", { name: "New study" }));
    expect(screen.getByRole("heading", { name: "New study" })).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("offers only the server's providers and models, and sends the key only with the upload", async () => {
    const replay = new ReplayRunClient(1);
    const calls: Array<{ name: string; options: unknown }> = [];
    const client = {
      mode: "live" as const,
      config: async () => ({
        providers: [
          { id: "anthropic", label: "Anthropic", models: ["claude-opus-5-5", "claude-sonnet-5-5"], keySource: "uploader" as const },
          { id: "custom", label: "Lab model", models: ["llama"], keySource: "server" as const },
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
    window.history.replaceState(null, "", "/");
    const { unmount } = render(<App client={client} />);
    const key = await screen.findByLabelText("API key");
    await act(async () => {
      fireEvent.change(screen.getByTestId("paper-input"), {
        target: { files: [new File(["%PDF-1.7\nbody"], "paper.pdf", { type: "application/pdf" })] },
      });
    });
    await screen.findByText("paper.pdf");
    const start = screen.getByRole("button", { name: "Start study" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText("Choose a model and enter the API key to start.")).toBeTruthy();
    expect(screen.queryByLabelText("API base URL")).toBeNull();

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5-5" } });
    fireEvent.change(key, { target: { value: "sk-secret" } });
    fireEvent.change(screen.getByLabelText("Code repository (optional)"), {
      target: { value: "https://github.com/example/new-paper" },
    });
    expect(start.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(start);
    });
    expect(calls).toEqual([
      {
        name: "paper.pdf",
        options: {
          model: { providerId: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-secret" },
          repositoryUrl: "https://github.com/example/new-paper",
        },
      },
    ]);
    expect(JSON.stringify(window.localStorage)).not.toContain("sk-secret");
    expect(window.location.href).not.toContain("sk-secret");
    unmount();
    window.history.replaceState(null, "", "/");
  });
});
