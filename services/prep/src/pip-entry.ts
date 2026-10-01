import { wheelMachine, type PlatformSpec } from "@dejaml/contracts";

import { ACCELERATOR_PATTERN_SOURCES, acceleratorReason, type AcceleratorFinding } from "./accelerator.js";
import { normalizePackageName } from "./requirements.js";
import type { ResolverMode } from "./target.js";

/** The line the in-container guard prints (then exits 3) when it refuses accelerator packages. */
export const ACCELERATOR_GUARD_MARKER = "DEJAML_ACCELERATOR_REFUSED";
export const ACCELERATOR_GUARD_EXIT_CODE = 3;

/**
 * The Python entry point every pip run in zone 2 starts from (`python -I -c <this> <pip args>`).
 *
 * 1. CPU-only download guard. `pip install --dry-run --report` resolves from metadata only
 *    (PEP 658), but then downloads every wheel of the final set before it writes the report, and a
 *    wheel without published metadata is downloaded during resolution. The guard refuses before
 *    any accelerator wheel is fetched: it checks the final set when pip is about to download it
 *    (`RequirementPreparer.prepare_linked_requirements_more`), and, as a backstop, every wheel
 *    request on pip's HTTP session. It prints `DEJAML_ACCELERATOR_REFUSED <json>` and exits 3.
 *    If pip's internals are not what it expects, it refuses to run (fail closed).
 * 2. Cross mode only: pip's `--platform` options select wheel tags, but pip evaluates environment
 *    markers against the interpreter it runs on, so an arm64 resolver would drop amd64-only
 *    dependencies (`platform_machine == "x86_64"`, such as torch's `nvidia-*`). The entry point
 *    makes `platform.machine()` report the target machine before pip starts.
 */
export function pipEntryCode(mode: ResolverMode, platform: PlatformSpec): string {
  const rules = JSON.stringify({
    names: ACCELERATOR_PATTERN_SOURCES.names.map(([source]) => source),
    local: ACCELERATOR_PATTERN_SOURCES.localVersion,
  });
  return [
    "import json, os, platform, re, runpy, sys",
    ...(mode === "cross" ? [`platform.machine = lambda: ${JSON.stringify(wheelMachine(platform.architecture))}`] : []),
    `RULES = json.loads(${JSON.stringify(rules)})`,
    "NAMES = [re.compile(source) for source in RULES['names']]",
    "LOCAL = re.compile(RULES['local'], re.I)",
    "def accelerator(name, version=''):",
    "    normalized = re.sub(r'[-_.]+', '-', name or '').lower()",
    "    return any(pattern.search(normalized) for pattern in NAMES) or bool(LOCAL.search(version or ''))",
    "def refuse(packages):",
    `    sys.stderr.write('${ACCELERATOR_GUARD_MARKER} ' + json.dumps({'packages': packages[:50]}) + '\\n')`,
    "    sys.stderr.flush()",
    `    os._exit(${ACCELERATOR_GUARD_EXIT_CODE})`,
    "def wheel(filename):",
    "    parts = filename.split('-')",
    "    return {'name': parts[0], 'version': parts[1] if len(parts) > 1 else '', 'filename': filename}",
    "try:",
    "    from pip._internal.operations.prepare import RequirementPreparer",
    "    from pip._vendor.requests.sessions import Session",
    "    original_more = RequirementPreparer.prepare_linked_requirements_more",
    "    original_request = Session.request",
    "except Exception as error:",
    "    sys.stderr.write('DEJAML_PIP_UNSUPPORTED ' + type(error).__name__ + '\\n')",
    "    os._exit(4)",
    "def prepare_more(self, reqs, *args, **kwargs):",
    "    reqs = list(reqs)",
    "    found = []",
    "    for req in reqs:",
    "        link = getattr(req, 'link', None)",
    "        info = wheel(link.filename) if link is not None and link.filename.endswith('.whl') else {'name': req.name or '', 'version': '', 'filename': ''}",
    "        if accelerator(req.name or info['name'], info['version']):",
    "            found.append(info)",
    "    if found:",
    "        refuse(found)",
    "    return original_more(self, reqs, *args, **kwargs)",
    "def request(self, method, url, *args, **kwargs):",
    "    filename = str(url).split('?', 1)[0].split('#', 1)[0].rsplit('/', 1)[-1]",
    "    if filename.endswith('.whl'):",
    "        info = wheel(filename)",
    "        if accelerator(info['name'], info['version']):",
    "            refuse([info])",
    "    return original_request(self, method, url, *args, **kwargs)",
    "RequirementPreparer.prepare_linked_requirements_more = prepare_more",
    "Session.request = request",
    "sys.argv[0] = 'pip'",
    "runpy.run_module('pip', run_name='__main__', alter_sys=True)",
  ].join("\n");
}

/** argv after `--entrypoint python <image>`: the guarded entry point, then pip's own arguments. */
export function pipInvocation(mode: ResolverMode, platform: PlatformSpec): string[] {
  return ["-I", "-c", pipEntryCode(mode, platform)];
}

/** The packages the in-container guard refused, or null when its marker is absent. */
export function parseAcceleratorGuard(output: string): AcceleratorFinding[] | null {
  const line = output
    .split("\n")
    .reverse()
    .find((item) => item.startsWith(`${ACCELERATOR_GUARD_MARKER} `));
  if (line === undefined) return null;
  let packages: unknown;
  try {
    packages = (JSON.parse(line.slice(ACCELERATOR_GUARD_MARKER.length + 1)) as { packages?: unknown }).packages;
  } catch {
    return [];
  }
  if (!Array.isArray(packages)) return [];
  const findings = new Map<string, AcceleratorFinding>();
  for (const item of packages) {
    const name = typeof item?.name === "string" ? normalizePackageName(item.name) : "";
    const version = typeof item?.version === "string" ? item.version : "";
    if (name === "" || findings.has(name)) continue;
    // Re-decided on the host: the container only stops the download.
    const reason = acceleratorReason(name, version) ?? "refused by the in-container CPU-only guard";
    findings.set(name, { name, spec: version ? `${name}==${version}` : name, reason, origin: "resolved" });
  }
  return [...findings.values()];
}
