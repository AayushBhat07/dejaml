import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { safeDownload } from "@dejaml/net-guard";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PrepError } from "./errors.js";
import {
  checkBuilt,
  chmodTree,
  dependencyNames,
  parseDcf,
  rBinaryRepository,
  resolveRPackages,
  RPackagePreparer,
  rSatisfies,
} from "./r-packages.js";

const INDEX = `Package: alpha
Version: 1.2.0
Depends: R (>= 4.1.0), beta
Imports: stats, gamma (>= 0.3),
  Matrix
LinkingTo: Rcpp

Package: beta
Version: 0.9
NeedsCompilation: no

Package: gamma
Version: 0.3.1
Imports: beta

Package: future
Version: 2.0
Depends: R (>= 4.6.0)
`;

const BUILT = "R 4.5.1; x86_64-pc-linux-gnu; 2026-09-30 10:00:00 UTC; unix";

function indexOf(text: string) {
  const map = new Map<string, { name: string; version: string; depends: string[]; imports: string[]; minR: string | null }>();
  for (const record of parseDcf(text)) {
    const depends = dependencyNames(record.Depends);
    map.set(record.Package as string, {
      name: record.Package as string,
      version: record.Version as string,
      depends: depends.filter((item) => item.name !== "R").map((item) => item.name),
      imports: dependencyNames(record.Imports).map((item) => item.name),
      minR: depends.find((item) => item.name === "R")?.requirement ?? null,
    });
  }
  return map;
}

describe("R package index", () => {
  it("parses DCF records with continuation lines and dependency fields", () => {
    const records = parseDcf(INDEX);
    expect(records).toHaveLength(4);
    expect(records[0]?.Imports).toBe("stats, gamma (>= 0.3), Matrix");
    expect(dependencyNames(records[0]?.Depends)).toEqual([
      { name: "R", requirement: ">= 4.1.0" },
      { name: "beta", requirement: null },
    ]);
  });

  it("compares R versions", () => {
    expect(rSatisfies("4.5.3", ">= 4.1.0")).toBe(true);
    expect(rSatisfies("4.5.3", ">= 4.6.0")).toBe(false);
    expect(rSatisfies("4.5.3", null)).toBe(true);
  });

  it("orders dependencies first and leaves base and recommended packages to the image", () => {
    const { order, provided } = resolveRPackages(["alpha"], indexOf(INDEX), "4.5.3");
    expect(order.map((item) => item.name)).toEqual(["beta", "gamma", "alpha"]);
    expect(provided).toEqual(["Matrix", "stats"]);
  });

  it("refuses a package missing from the snapshot or needing a newer R", () => {
    expect(() => resolveRPackages(["nope"], indexOf(INDEX), "4.5.3")).toThrow(/not in the snapshot/u);
    expect(() => resolveRPackages(["future"], indexOf(INDEX), "4.5.3")).toThrow(/needs R >= 4.6.0/u);
  });

  it("accepts only binaries built for this R minor and architecture", () => {
    expect(checkBuilt(`Package: a\nBuilt: ${BUILT}\n`, "4.5", "linux/amd64")).toEqual({ ok: true, built: BUILT });
    expect(checkBuilt("Package: a\nBuilt: R 4.5.0; ; 2026-09-30; unix\n", "4.5", "linux/arm64")).toMatchObject({ ok: true });
    expect(checkBuilt("Package: a\nPackaged: 2026-09-30\n", "4.5", "linux/amd64")).toMatchObject({ ok: false });
    expect(checkBuilt(`Package: a\nBuilt: ${BUILT}\n`, "4.5", "linux/arm64")).toMatchObject({ ok: false });
    expect(checkBuilt("Package: a\nBuilt: R 4.4.2; ; 2025; unix\n", "4.5", "linux/amd64")).toMatchObject({ ok: false });
  });

  it("names the Posit snapshot path for Ubuntu 24.04", () => {
    expect(rBinaryRepository("2026-10-01", "4.5", "linux/arm64")).toBe(
      "https://packagemanager.posit.co/cran/2026-10-01/bin/linux/noble-aarch64/4.5/src/contrib",
    );
  });
});

describe("RPackagePreparer", () => {
  let work: string;
  let fixtures: string;
  let fetched: string[];

  async function binary(name: string, version: string, built: string | null): Promise<string> {
    const root = join(fixtures, `${name}-src`);
    await mkdir(join(root, name, "Meta"), { recursive: true });
    await writeFile(
      join(root, name, "DESCRIPTION"),
      `Package: ${name}\nVersion: ${version}\n${built ? `Built: ${built}\n` : "Packaged: 2026-09-30\n"}`,
    );
    if (built) await writeFile(join(root, name, "Meta", "package.rds"), "rds");
    const archive = join(fixtures, `${name}_${version}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", root, name]);
    return archive;
  }

  function fakeDownload(files: Record<string, string>): typeof safeDownload {
    return (async (options) => {
      fetched.push(options.url);
      const name = options.url.slice(options.url.lastIndexOf("/") + 1);
      const source = files[name];
      if (!source) throw new PrepError("no_compatible_binary", `HTTP 404 for ${name}`);
      await copyFile(source, options.destinationFile);
      const { createHash } = await import("node:crypto");
      const data = await readFile(source);
      return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length } as Awaited<ReturnType<typeof safeDownload>>;
    }) as typeof safeDownload;
  }

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "r-packages-"));
    fixtures = join(work, "fixtures");
    await mkdir(fixtures);
    fetched = [];
  });
  afterEach(async () => {
    await chmodTree(work);
    await rm(work, { recursive: true, force: true });
  });

  it("downloads binaries once, unpacks them into a sealed library, and records a manifest", async () => {
    const index = join(fixtures, "PACKAGES");
    await writeFile(index, "Package: beta\nVersion: 0.9\n\nPackage: gamma\nVersion: 0.3.1\nImports: beta, stats\n");
    const files = {
      PACKAGES: index,
      "beta_0.9.tar.gz": await binary("beta", "0.9", BUILT),
      "gamma_0.3.1.tar.gz": await binary("gamma", "0.3.1", "R 4.5.1; ; 2026-09-30 10:00:00 UTC; unix"),
    };
    const preparer = new RPackagePreparer({
      cacheDir: join(work, "cache"),
      libraryRoot: join(work, "libs"),
      download: fakeDownload(files),
    });
    const input = { runId: "run_1", packages: ["gamma"], r: "4.5" as const, rVersion: "4.5.3", platform: "linux/amd64" as const };
    const prepared = await preparer.prepare(input);
    expect(prepared.manifest.packages.map((item) => [item.name, item.requested])).toEqual([
      ["beta", false],
      ["gamma", true],
    ]);
    expect(prepared.manifest.provided).toEqual(["stats"]);
    expect((await readdir(prepared.libraryDir)).sort()).toEqual(["beta", "gamma"]);
    expect(await readFile(join(prepared.libraryDir, "gamma", "DESCRIPTION"), "utf8")).toContain("Version: 0.3.1");

    // The snapshot is immutable, so a second preparation reuses the verified cache.
    await preparer.prepare({ ...input, runId: "run_2" });
    expect(fetched.filter((url) => url.endsWith(".tar.gz"))).toHaveLength(2);
  });

  it("refuses a source package and leaves no library behind", async () => {
    const index = join(fixtures, "PACKAGES");
    await writeFile(index, "Package: beta\nVersion: 0.9\n");
    const files = { PACKAGES: index, "beta_0.9.tar.gz": await binary("beta", "0.9", null) };
    const preparer = new RPackagePreparer({
      cacheDir: join(work, "cache"),
      libraryRoot: join(work, "libs"),
      download: fakeDownload(files),
    });
    await expect(
      preparer.prepare({ runId: "run_1", packages: ["beta"], r: "4.5", rVersion: "4.5.3", platform: "linux/amd64" }),
    ).rejects.toMatchObject({ code: "no_compatible_binary", message: expect.stringContaining("source package") });
    expect(existsSync(join(work, "libs", "run_1-r4.5-linux-amd64"))).toBe(false);
  });

  it("refuses names that are not CRAN package names before fetching anything", async () => {
    const preparer = new RPackagePreparer({ cacheDir: join(work, "cache"), libraryRoot: join(work, "libs"), download: fakeDownload({}) });
    await expect(
      preparer.prepare({ runId: "run_1", packages: ["../evil"], r: "4.5", rVersion: "4.5.3", platform: "linux/amd64" }),
    ).rejects.toMatchObject({ code: "invalid_requirement" });
    expect(fetched).toEqual([]);
  });
});
