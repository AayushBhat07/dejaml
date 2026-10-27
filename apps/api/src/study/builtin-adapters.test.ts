import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_ADAPTER_FILES, BuiltinAdapterError, builtinAdapterView, loadBuiltinAdapters } from "./builtin-adapters.js";
import { riggedAdapter } from "./blinding.js";
import { AdapterSchema } from "./roles.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("built-in adapters", () => {
  it("loads each project file at its pinned hash, as a valid adapter that is not rigged", async () => {
    const adapters = await loadBuiltinAdapters(repoRoot);
    expect(adapters.map((adapter) => adapter.id)).toEqual(BUILTIN_ADAPTER_FILES.map((file) => file.id));
    for (const adapter of adapters) {
      expect(AdapterSchema.safeParse(adapter).success).toBe(true);
      expect(riggedAdapter(adapter.content)).toBeNull();
      // The Planner sees how to use it, never more than the Reviewer will.
      expect(builtinAdapterView(adapter)).toMatchObject({ id: adapter.id, path: adapter.path, usage: adapter.usage });
    }
  });

  it("refuses a built-in adapter whose file changed after its hash was pinned", async () => {
    const root = await mkdtemp(join(tmpdir(), "dejaml-builtin-"));
    roots.push(root);
    await cp(join(repoRoot, "config"), join(root, "config"), { recursive: true });
    await writeFile(join(root, BUILTIN_ADAPTER_FILES[0]!.file), "print('changed')\n", { flag: "a" });
    await expect(loadBuiltinAdapters(root)).rejects.toBeInstanceOf(BuiltinAdapterError);
  });
});
