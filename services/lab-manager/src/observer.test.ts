import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactWatcher, DEFAULT_OBSERVE_OPTIONS, OutputBatcher, parseDockerStats, parseSize, sanitizeLine } from "./observer.js";

describe("sanitizeLine", () => {
  it("strips terminal escapes and control characters and keeps the last carriage-return frame", () => {
    expect(sanitizeLine("\u001b[31mred\u001b[0m text\u0007", 100)).toEqual({ text: "red text", truncated: false });
    expect(sanitizeLine("10%\r50%\r100%", 100).text).toBe("100%");
    expect(sanitizeLine("\u001b]0;title\u0007shown", 100).text).toBe("shown");
    expect(sanitizeLine("x".repeat(20), 5)).toEqual({ text: "xxxxx…", truncated: true });
  });
});

describe("OutputBatcher", () => {
  it("joins chunks into lines, batches per stream, and releases the trailing line at the end", () => {
    const batcher = new OutputBatcher({ ...DEFAULT_OBSERVE_OPTIONS, maxLinesPerEvent: 2 });
    batcher.push("stdout", "epo");
    batcher.push("stdout", "ch 1\nepoch 2\nepoch 3\npart");
    batcher.push("stderr", "warn\n");

    expect(batcher.drain()).toEqual([
      { stream: "stdout", lines: ["epoch 1", "epoch 2"], truncatedLines: 0 },
      { stream: "stdout", lines: ["epoch 3"], truncatedLines: 0 },
      { stream: "stderr", lines: ["warn"], truncatedLines: 0 },
    ]);
    expect(batcher.drain(true)).toEqual([{ stream: "stdout", lines: ["part"], truncatedLines: 0 }]);
  });

  it("stops publishing at the character budget and counts dropped lines", () => {
    const batcher = new OutputBatcher({ ...DEFAULT_OBSERVE_OPTIONS, maxPublishedChars: 10 });
    batcher.push("stdout", "12345\n67890\nabc\ndef\n");
    expect(batcher.drain().flatMap((batch) => batch.lines)).toEqual(["12345", "67890"]);
    expect(batcher.limitReached).toBe(true);
    expect(batcher.droppedLines).toBe(2);
  });

  it("splits a runaway line that never ends", () => {
    const batcher = new OutputBatcher({ ...DEFAULT_OBSERVE_OPTIONS, maxLineChars: 10 });
    batcher.push("stdout", "y".repeat(100));
    const [batch] = batcher.drain();
    expect(batch?.lines).toEqual(["yyyyyyyyyy…"]);
    expect(batch?.truncatedLines).toBe(1);
  });
});

describe("parseDockerStats", () => {
  it("parses docker stats JSON", () => {
    expect(parseDockerStats('{"CPUPerc":"187.25%","MemPerc":"6.10%","MemUsage":"124.9MiB / 2GiB","PIDs":"7","Name":"x"}')).toEqual({
      cpuPercent: 187.25,
      memoryBytes: Math.round(124.9 * 1024 ** 2),
      memoryLimitBytes: 2 * 1024 ** 3,
      memoryPercent: 6.1,
      pids: 7,
    });
    expect(parseDockerStats('{"CPUPerc":"--","MemPerc":"--","MemUsage":"-- / --","PIDs":"--"}')).toBeNull();
    expect(parseDockerStats("not json")).toBeNull();
    expect(parseSize("1.5kB")).toBe(1500);
    expect(parseSize("12 parsecs")).toBeNull();
  });
});

describe("ArtifactWatcher", () => {
  it("reports created and modified files once each and ignores symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "dejaml-watch-"));
    try {
      const watcher = new ArtifactWatcher(root, "artifacts", 10);
      expect(await watcher.sample()).toEqual([]);
      await writeFile(join(root, "result.json"), "{}");
      await symlink("/etc/passwd", join(root, "link"));
      expect(await watcher.sample()).toEqual([{ path: "artifacts/result.json", bytes: 2, change: "created" }]);
      expect(await watcher.sample()).toEqual([]);
      await writeFile(join(root, "result.json"), '{"a":1}');
      expect(await watcher.sample()).toEqual([{ path: "artifacts/result.json", bytes: 7, change: "modified" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
