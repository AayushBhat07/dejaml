import { describe, expect, it } from "vitest";

import { logicalLines, normalizePackageName, parseRequirementLine } from "./requirements.js";

const HASH = "a".repeat(64);

describe("parseRequirementLine", () => {
  const rejected: [string, RegExp][] = [
    ["-r other.txt", /nested requirement files/u],
    ["--requirement=other.txt", /nested requirement files/u],
    ["-c constraints.txt", /constraint file/u],
    ["--index-url https://evil.example/simple", /index overrides/u],
    ["-i https://evil.example/simple", /index overrides/u],
    ["--extra-index-url https://evil.example/simple", /extra indexes/u],
    ["-e .", /editable/u],
    ["-e git+https://github.com/x/y.git#egg=y", /editable/u],
    ["-f https://evil.example/wheels", /find-links/u],
    ["--find-links=/tmp/wheels", /find-links/u],
    ["--trusted-host x", /trusted-host/u],
    ["--pre", /--pre/u],
    [`--hash=sha256:${HASH}`, /--hash must trail/u],
    ["git+https://github.com/x/y.git", /VCS/u],
    ["pkg @ https://x/y.whl", /URLs|direct references/u],
    ["pkg@git+https://x/y", /VCS/u],
    ["https://x/y-1.0-py3-none-any.whl", /URLs/u],
    ["./local", /local paths/u],
    ["../sibling", /local paths/u],
    ["/abs/path/pkg.whl", /local paths/u],
    ["file:///tmp/pkg.whl", /local paths/u],
    ["~/pkg", /local paths/u],
    ["numpy --index-url https://evil", /embedded option/u],
    ["numpy==1.0 -i https://evil", /embedded option/u],
    ["numpy\u0000==1.0", /control characters/u],
    ["numpy\u001b[31m", /control characters/u],
    ["-numpy", /pip options/u],
    ["numpy>=1.0 --hash=sha256:" + HASH, /only on pinned/u],
    ["numpy==1.0 --hash=md5:abcd", /only --hash=sha256/u],
    ["numpy==1.0; os.system('x') or $(id)", /disallowed characters/u],
    ["numpy==1.0;", /empty environment marker/u],
    ["numpy==1.0,>=1,>=1,>=1,>=1,>=1,>=1,>=1,>=1", /too many/u],
    ["numpy=1.0", /invalid version specifier/u],
    [`${"a".repeat(101)}==1`, /invalid package name/u],
    ["numpy[ex tra]==1", /invalid extra/u],
  ];

  it.each(rejected)("rejects %j", (line, reason) => {
    const result = parseRequirementLine(line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("accepts an exact pin", () => {
    const result = parseRequirementLine("numpy==1.19.5");
    expect(result).toMatchObject({ ok: true, requirement: { name: "numpy", pinned: true, spec: "numpy==1.19.5" } });
  });

  it("accepts ranges with an environment marker", () => {
    const result = parseRequirementLine('numpy>=1.20,<2; python_version >= "3.8"');
    expect(result.ok).toBe(true);
    if (!result.ok || !result.requirement) throw new Error("expected a requirement");
    expect(result.requirement.specifiers).toEqual([
      { op: ">=", version: "1.20" },
      { op: "<", version: "2" },
    ]);
    expect(result.requirement.marker).toBe('python_version >= "3.8"');
    expect(result.requirement.pinned).toBe(false);
    expect(result.requirement.spec).toBe('numpy>=1.20,<2; python_version >= "3.8"');
  });

  it("normalizes names per PEP 503", () => {
    const result = parseRequirementLine("Keras-Preprocessing==1.1.2");
    expect(result).toMatchObject({
      ok: true,
      requirement: { name: "keras-preprocessing", rawName: "Keras-Preprocessing", spec: "keras-preprocessing==1.1.2" },
    });
    expect(normalizePackageName("Foo__Bar..baz-_Qux")).toBe("foo-bar-baz-qux");
  });

  it("keeps trailing sha256 hashes on pinned lines", () => {
    const result = parseRequirementLine(`name==1.0 --hash=sha256:${HASH} --hash=sha256:${"B".repeat(64)}`);
    expect(result).toMatchObject({ ok: true, requirement: { name: "name", hashes: [HASH, "b".repeat(64)], spec: "name==1.0" } });
  });

  it("accepts extras, bare names and comments", () => {
    expect(parseRequirementLine("requests[socks, security]>=2 # http")).toMatchObject({
      ok: true,
      requirement: { name: "requests", extras: ["socks", "security"], spec: "requests[socks,security]>=2" },
    });
    expect(parseRequirementLine("torch")).toMatchObject({ ok: true, requirement: { name: "torch", specifiers: [] } });
    expect(parseRequirementLine("   # just a comment")).toEqual({ ok: true, requirement: null });
    expect(parseRequirementLine("")).toEqual({ ok: true, requirement: null });
    expect(parseRequirementLine("pkg~=1.4.2")).toMatchObject({ ok: true, requirement: { specifiers: [{ op: "~=", version: "1.4.2" }] } });
    expect(parseRequirementLine("pkg===1.0-legacy")).toMatchObject({ ok: true, requirement: { pinned: true } });
    expect(parseRequirementLine("pkg==1.*")).toMatchObject({ ok: true, requirement: { pinned: false } });
  });

  it("joins line continuations but not inside comments", () => {
    expect(logicalLines("numpy==1.0 \\\n  --hash=sha256:" + HASH + "\n# c \\\nscipy\n")).toEqual([
      { line: 1, text: `numpy==1.0    --hash=sha256:${HASH}` },
      { line: 3, text: "# c \\" },
      { line: 4, text: "scipy" },
      { line: 5, text: "" },
    ]);
  });
});
