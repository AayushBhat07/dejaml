import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";
import { ReplayRunClient } from "./lib/run-client";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("App shell", () => {
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
