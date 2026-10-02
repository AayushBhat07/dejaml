# @dejaml/prep: controlled dependency preparation (trust zone 2)

Paper repositories often need Python packages that the offline lab image does
not have. This package gets those packages to the lab without two things:

- no model (agent) ever gets unrestricted package-manager network access, and
- the cloned repository is never executed, built or even mounted outside the lab.

## Trust zones

| Zone | What runs there | Network |
| --- | --- | --- |
| 1. Host (DéjàML services) | `discoverDependencies` reads the checkout as text; requirement lines are validated by `parseRequirementLine`; wheels are hash-verified and cached | host |
| **2. Preparation (this package)** | a short-lived `pip` resolver/downloader container per call, with no repository mounted | internal Docker network whose only exit is the egress proxy |
| 3. Lab (`@dejaml/lab-manager`) | the repository and the experiment, with the wheelhouse mounted read-only | `--network none` |

Data moves one way. Validated requirement strings go into zone 2. Wheels come
out of it, and the host checks each one against its sha256 before anything
reaches the lab.

## Flow

Every call is for one explicit `PlatformSpec` (from `@dejaml/contracts`):
architecture, container platform, CPython version and ABI, glibc, the
CPU-only accelerator policy and the administrator's package index profile.

1. `discoverDependencies(repoDir, { extras? })` walks the checkout. It skips
   `.git`, goes at most 4 levels deep, reads at most 5000 entries, never follows
   symlinks and only reads files of 1 MiB or less. It returns the dependency
   files it found (with sha256), the preferred lockfile, the parsed requirements
   (requirements files, `[project] dependencies`, `[tool.poetry.dependencies]`,
   and `[project.optional-dependencies]` / poetry extras only for the requested
   `extras`), every rejected line with a reason (including
   `--extra-index-url` lines that point at CUDA/ROCm indexes), and anything
   unsupported (`setup.py`/`setup.cfg` are flagged `executable_build_metadata`
   and never run; conda, npm, Cargo, Go and R files are reported explicitly).
2. `DependencyPreparer.resolvePython({ runId, platform, requirements,
   constraints?, rejected?, includeInstaller })`:
   - validates every requirement and refuses accelerator packages
     (`accelerator_package_refused`) before any container exists;
   - validates project-owned compatibility constraints (never from the
     repository; each needs a reason) and applies them with pip `-c`;
   - selects the digest-pinned image for `platform.python.version` and a
     resolver mode: `native` (the engine is the target platform), `emulated`
     (the engine runs the target platform's image, probed once), or `cross`
     (a same-Python container of the engine's platform runs pip with
     `--platform <manylinux tags> --python-version --implementation cp --abi`);
   - runs `pip install --dry-run --ignore-installed --only-binary=:all:
     --report`, then validates the report: one wheel per package, `https` on an
     allowlisted host, a sha256, a matching file name, at most `maxPackages`,
     the interpreter's Python version, no accelerator package anywhere in the
     transitive set, and `wheelMatchesPlatform` for every wheel.
3. `downloadWheels(resolution, { platform?, signal })` re-validates all of the
   above. Cached wheels (`<cacheDir>/wheels/<platformCacheKey>/<sha256>/<file>`,
   so platforms never mix) are re-hashed and reused. Everything else is fetched
   by `pip download --no-deps --only-binary=:all: --require-hashes` (plus the
   cross options in cross mode). On the host every file must be a regular
   `.whl` for the platform, within the size limits, with the resolved sha256
   (streamed, never buffered whole). The per-run wheelhouse (files 0444,
   directory 0555) holds the wheels, `requirements.lock.txt`
   (`name==version --hash=sha256:…`, pip excluded), `installer.json` and
   `manifest.json` (schema 2: platform, platform key, image reference, digest,
   ID and platform, resolver mode, repository requirements and compatibility
   constraints with `source` and reason, every compatibility change, rejected
   repository lines, per-wheel platform tags, hashes, disk usage, cleanup).
4. The lab installs offline with `offlineInstallCommands(...)` (`--no-index
   --find-links <wheelhouse> --only-binary=:all: --require-hashes`) and checks
   the result with `installationReceipt(manifest, inspected)`.

## Preparation image

`policy.images` maps each Python version to an official
`python:<version>-slim-trixie` image pinned by the digest of its
multi-platform index (see `DEFAULT_PREP_IMAGES`). The image is looked up with
`docker image inspect --platform <platform> <repository>@<digest>` and every
container is created from that digest reference with `--platform` and
`--pull never`. Missing images are pulled only when `pullImages` is set, by
digest and for the exact platform, and concurrent requests share one pull.
A different lookup (the lab manager's `ImageReadiness`) can be injected as
`imageProvider`; the preparer still checks that the result carries the pinned
digest and the requested platform.

The earlier implementation looked the image up by its mutable tag
(`docker image inspect python:3.13.15-slim-trixie`) and reported any
non-zero exit as "not present locally". An image obtained by digest (as
everything else in this repository pins it: `docker pull name:tag@sha256:…`
stores only `name@sha256:…`) has no local tag, so the image was reported
missing although it was there; daemon errors were reported the same way, and a
multi-platform index without content for the requested platform looked
present. Now only "No such image" (or an index without content for the
platform) counts as missing, other Docker failures are `runtime_error`, and a
wrong platform is `platform_mismatch`.

**Per-platform digests.** An index digest names one immutable manifest per
platform. `OFFICIAL_PYTHON_PLATFORM_MANIFESTS` (kept identical to
`lab-images/python-base/bases.lock.json` by a test, so the lab base and the
preparation image are the same per-platform builds) maps each default index to
its `linux/amd64` and `linux/arm64` manifests, and `platformDigestFor` returns
the one for the requested platform; it is recorded as
`imageIdentity.platformDigest`. A pin that is itself one platform's manifest
(for example the arm64 digest Docker Desktop shows on a Mac) is accepted only
for that platform and refused for the other with `platform_mismatch` before
Docker is asked or anything is pulled, and an inspection that reports another
platform's manifest is refused too. Docker Desktop's classic image store keeps
one platform per reference and answers a platform inspection of the other one
with "was found but does not match the specified platform"; that is
`platform_mismatch` (it used to be `runtime_error`), so an Apple Silicon engine
targeting `linux/amd64` without the amd64 image falls back to cross resolution
with its arm64 image. A container Docker cannot create for the platform (exit
125, "does not provide the specified platform", "No such image") is
`platform_mismatch` or `image_unavailable`, never `runtime_error`.

## Container identity

Preparation containers (proxy, resolver, downloader, the emulation probe) never
run as root. `selectPrepIdentity` chooses and validates the `--user`:

| host service runs as | container user | writable bind mounts (`out`, `tmp`) |
| --- | --- | --- |
| root (Linux servers, CI) | `65534:65534` (`nobody`) | chowned to `65534:65534`, mode 0755/0700 |
| a non-root user (macOS Docker Desktop, rootless or desktop Linux) | that user's own `uid:gid`, e.g. `501:20` on a Mac | owned by that user already, mode 0755/0700 |
| no POSIX ids (Windows) | `65534:65534` | 0777 (Docker Desktop on Windows does not map ownership) |

The service's own ids are used for a non-root service because it cannot chown
to `nobody`, and Docker Desktop's file sharing (virtiofs/gRPC FUSE) checks
writes against the host owner: `65534` could only write if the directories
were world-writable. With the service's ids nothing is made world-writable,
and the service can measure and delete everything the container wrote. A
non-root service whose uid or gid is 0 (the root group), or a malformed id, is
refused with `invalid_policy`. The input mount is read-only either way.
`DependencyPreparer.containerIdentity` reports the selected identity.

## Docker topology per call

Everything carries the labels `dejaml.prep=<prepId>` and `dejaml.run=<runId>`.
Containers are created from the pinned digest reference with `--platform` and
`--pull never`.

```
docker network create --internal <labels> dejaml-prep-<id>

# egress proxy: on the default bridge, then attached to the internal network
docker create --name dejaml-prep-<id>-egress --pull never --platform <p> <labels> --network bridge \
  --user <uid:gid> --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 \
  --mount type=bind,src=<pkg>/proxy/egress_proxy.py,dst=/opt/dejaml/egress_proxy.py,readonly \
  --entrypoint python <repo@sha256:digest> -I -u /opt/dejaml/egress_proxy.py --listen 0.0.0.0:3128 \
  --allow pypi.org --allow files.pythonhosted.org --budget-bytes <maxTotal+128MiB> --idle-timeout 60
docker network connect --alias egress dejaml-prep-<id> dejaml-prep-<id>-egress
docker start dejaml-prep-<id>-egress

# resolver / downloader: ONLY on the internal network
docker run --name dejaml-prep-<id>-resolve --pull never --platform <p> <labels> --network dejaml-prep-<id> \
  --user <uid:gid> --read-only --cap-drop ALL --security-opt no-new-privileges \
  --cpus <cpus> --memory <mb>m --memory-swap <mb>m --pids-limit <pids> \
  --env HOME=/tmp --env TMPDIR=/tmp --env HTTPS_PROXY=http://egress:3128 --env PIP_INDEX_URL=<indexUrl> \
  --env PIP_DISABLE_PIP_VERSION_CHECK=1 --env PIP_NO_INPUT=1 --env PIP_NO_CACHE_DIR=1 \
  [--env PIP_CERT=/etc/dejaml/ca-bundle.pem] \
  --mount type=bind,src=<tmp>/in,dst=/in,readonly [--mount <ca copy>,dst=/etc/dejaml/ca-bundle.pem,readonly] \
  --mount type=bind,src=<tmp>/out,dst=/out --mount type=bind,src=<tmp>/tmp,dst=/tmp \
  --workdir /tmp --entrypoint python <repo@sha256:digest> -m pip install --dry-run [cross options] ...
```

The worker never gets any variable from the host environment: no provider keys,
GitHub tokens, Docker credentials or proxy settings. It gets only the variables
listed above. The repository is never mounted. The Docker CLI is always called
with an argv array (`DockerCliRuntime` from `@dejaml/lab-manager`) and never
through a shell.

Every exit path runs cleanup: success, failure, timeout (`timeoutSeconds`) and
cancellation (`AbortSignal`). Cleanup runs `docker rm --force` on the worker and
the proxy, `docker network rm` on the network, and removes the per-call temp
directory, which also holds any partial downloads. It then checks that
`docker ps -a` and `docker network ls`, filtered by the prep label, both come
back empty. The resulting `PrepCleanupReceipt` is attached to the result or to
the `PrepError`. `cleanupOrphans()` removes anything labelled `dejaml.prep`, so
call it at service start and not while preparations are running.

## What the egress proxy allows

`proxy/egress_proxy.py` is a small asyncio HTTP CONNECT proxy that uses only
the Python standard library. It allows exactly one thing: `CONNECT host:443`
where `host` exactly matches an `--allow` entry. It answers everything else
with 403 and logs it: plain HTTP or other methods (`method_not_allowed`), other
ports (`port_not_allowed`), IP literals including shorthand such as `127.1`
(`ip_literal`), and unknown hosts (`host_not_allowed`). The proxy resolves the
host itself. If **any** DNS answer is not `is_global` (loopback, RFC 1918,
link-local, 169.254.169.254 metadata, and so on), the connection is refused with
`non_global_address`. Otherwise the proxy connects to one validated address
(IPv4 first) and never resolves it again, so DNS rebinding cannot redirect the
tunnel. The proxy also enforces a total byte budget across all tunnels (it logs
`{"event":"budget_exceeded"}` and closes every tunnel), a 60 s per-tunnel idle
timeout and at most 64 concurrent tunnels. It prints one JSON line per
connection:

```json
{"event":"connect","host":"pypi.org","ip":"151.101.64.223","allowed":true,"reason":"ok","bytes_up":1234,"bytes_down":56789,"ms":840}
```

The resolver sits only on an `--internal` network, so it has no route and no
external DNS. The proxy is the only thing it can reach.

## Typed failures (`PrepError.code`)

| code | when |
| --- | --- |
| `no_compatible_wheel` | no CPU binary wheel for the platform: pip reports "No matching distribution found" / "Could not find a version that satisfies" for a non-accelerator package (`requirement` holds the name), or the report points at a non-wheel. Every platform is CPU-only, so this is also the "no compatible CPU wheel" outcome; a missing accelerator dependency is `accelerator_package_refused` instead. Source distributions are never built; getting past this needs explicit approval or a prebuilt lab image. |
| `accelerator_package_refused` | CPU-only policy: a CUDA/ROCm/GPU/TPU package or build (`nvidia-*`, `cuda-*`, `cupy-cuda*`, `*-cu12`, `+cu*`/`+rocm*` local versions, `triton`, `tensorflow-gpu`, `onnxruntime-gpu`, `jax[cuda*]`, `rocm-*`, …) was requested, constrained, resolved transitively, or named by a failed resolution (for example no `nvidia-*` wheel for the platform). `refused` lists the names; nothing was downloaded. `evidence` is a typed `AcceleratorRefusalEvidence`: stage, findings, platform and cache key, resolver mode, image digest and platform digest, `wheelsDownloaded: 0`. |
| `platform_mismatch` | a wheel, the resolver's interpreter or marker environment, or the image does not match the `PlatformSpec` (`refused` lists wheels); includes a platform-manifest pin used for another platform and Docker's "does not match the specified platform" |
| `image_unavailable` | no image is configured for the Python version, or it is not present for the platform (and pulling is off or failed), including an index without the platform's content |
| `insufficient_preparation_space` | not enough free space (plus `minFreeBytes`) before resolution, download, caching or the wheelhouse, or the per-run temp directory exceeded `maxTempBytes`/`maxTempInodes` |
| `resolution_conflict` | `ResolutionImpossible` or conflicting dependencies (including a compatibility constraint that conflicts with the repository) |
| `egress_denied` | the proxy log shows a denied CONNECT, or a resolved URL is on a host that is not allowlisted |
| `limit_exceeded` | `maxPackages`, `maxFileBytes`, `maxTotalBytes`, the proxy byte budget, or an OOM kill |
| `timeout` / `cancelled` | `timeoutSeconds` elapsed, or the caller's `AbortSignal` fired |
| `invalid_requirement` | a requirement, constraint or `runId` failed validation, or the resolution was a direct/VCS reference |
| `integrity_error` | a downloaded or cached wheel did not match its sha256, or an unexpected file appeared |
| `image_mismatch` | the image does not carry the pinned digest, or its ID differs from `expectedImageIds` |
| `invalid_policy` | invalid operator configuration or platform (including a package index profile outside the allowed hosts) |
| `runtime_error` | anything else (Docker failures, etc.) |

`detail` holds the last 4 KB of pip output, and `cleanup` holds the receipt.

## Requirement subset

`parseRequirementLine` accepts a name
(`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`, 100 characters at most),
optional extras, up to 8 comma-separated specifiers (`== != <= >= < > ~= ===`,
versions `[A-Za-z0-9.*+!_-]{1,64}`), an optional marker (`[A-Za-z0-9_
.'"<>=!()~,-]`, 200 characters at most) and, on pinned lines only, trailing
`--hash=sha256:<64 hex>`. It rejects, with a reason: every option line (`-r`,
`-c`, `-e`, `-f`, `-i`, `--index-url`, `--extra-index-url`, `--trusted-host`,
`--find-links`, `--pre`, …), options embedded after whitespace, URLs,
`name @ url` direct references, VCS (`git+…`), local paths (`./`, `/`, `~`,
`file:`) and control characters. Names are normalized per PEP 503.

## Configuration (operator environment)

| variable | default | notes |
| --- | --- | --- |
| `DEJAML_PREP_IMAGES` | `DEFAULT_PREP_IMAGES` (3.10–3.13 `python:<v>-slim-trixie@sha256:…`) | `3.11=<image>@sha256:<digest>,…`; digest required |
| `DEJAML_PREP_IMAGE` | unset | legacy: `python:3.X[.Y]-slim-trixie[@sha256:…]`; pinned replaces that version's image, unpinned keeps the pinned default of that line |
| `DEJAML_PREP_IMAGE_ID` | unset | with `DEJAML_PREP_IMAGE`: the `docker image inspect --platform` ID that version's image must have |
| `DEJAML_PREP_PULL` | `0` | `1` pulls a missing image by digest for the exact platform |
| `DEJAML_PREP_RESOLVER_MODE` | `auto` | `native` refuses emulation and cross resolution |
| `DEJAML_PREP_INDEX_URL` | unset | when set, the platform's index profile must use exactly this index |
| `DEJAML_PREP_ALLOWED_HOSTS` | `pypi.org,files.pythonhosted.org` | upper bound on the profile's hosts; DNS names only |
| `DEJAML_PREP_MAX_PACKAGES` | `150` | |
| `DEJAML_PREP_MAX_FILE_MB` | `1024` | per wheel |
| `DEJAML_PREP_MAX_TOTAL_MB` | `3072` | total wheel bytes; the proxy budget is this plus 128 MiB |
| `DEJAML_PREP_MAX_TEMP_MB` | `6144` | byte quota of the per-run temp directory |
| `DEJAML_PREP_MAX_TEMP_INODES` | `200000` | file-count quota of the per-run temp directory |
| `DEJAML_PREP_MIN_FREE_MB` | `1024` | free-space margin on the work, cache and wheelhouse filesystems |
| `DEJAML_PREP_CA_BUNDLE` | unset | see below |

The index and egress hosts of a run come from `PlatformSpec.packageIndex`
(`DEFAULT_PACKAGE_INDEX` is PyPI); every host must be in
`DEJAML_PREP_ALLOWED_HOSTS`. Accelerator support has no setting: every
profile is CPU-only. These can only be changed in code through `PrepPolicy`:
`timeoutSeconds` (600), `cpus` (2), `memoryMb` (2048), `pids` (256) and
`diskPollMs` (1000).

Temporary storage: pip's `/tmp` is a bind mount of `<workRoot>/<prepId>-…/tmp`
(disk, not a RAM tmpfs, so large wheels do not count against container memory
or a 512 MiB limit). The per-run directory is measured every `diskPollMs` and
after the worker exits; exceeding the byte or inode quota, or free space
falling below the margin, aborts the worker with
`insufficient_preparation_space`. The directory is always removed.

**`DEJAML_PREP_CA_BUNDLE`** is an operator setting for networks where a
TLS-intercepting proxy re-signs outbound HTTPS (corporate networks, the Claude
Code cloud machine). It points at a PEM bundle on the host. The bundle is copied
into the per-call temp directory, mounted read-only at
`/etc/dejaml/ca-bundle.pem` and passed to pip as `PIP_CERT`. It widens what the
downloader trusts, so agents must never be able to set it. Leave it unset on a
normal network.

## Docker proof

```
npm run build && npm run verify:docker
```

`scripts/verify-prep-docker.mjs` uses the digest-pinned
`python:3.11-slim-trixie` image for the host platform (it is never pulled by
the proof). It sets `DEJAML_PREP_CA_BUNDLE` to `/root/.ccr/ca-bundle.crt`
only when that file exists, because the cloud machine intercepts TLS. It
proves the following:

0. the image is found by digest even when its tag is not local;
1. numpy and scikit-learn (+pip) resolve and download for the host platform,
   every wheel checked with `wheelMatchesPlatform` and its sha256;
2. they install offline in a `--network none --read-only --cap-drop ALL`
   container of the same platform from the read-only wheelhouse, import, and
   `installationReceipt` matches;
3. PyPI `torch` is refused for linux/amd64 and for linux/arm64 (one natively,
   the other across platforms) because of its `nvidia-*` dependencies, each
   with an `accelerator_refusal` evidence receipt for that platform and the
   image's platform digest, and `nvidia-cublas-cu12` is refused before any
   container starts; no accelerator wheel is anywhere in the cache;
4. resolution for the other architecture (cross mode without emulation)
   yields only that architecture's wheels, in a separate cache;
5. `numpy==1.19.5` fails with `no_compatible_wheel` and nothing is built;
6. the internal network has no direct route or DNS, and the proxy allows only
   `CONNECT <allowed host>:443`;
7. a 4 MiB temp quota refuses the numpy download with
   `insufficient_preparation_space` and leaves nothing behind;
8. cancellation in the middle of a download cleans up;
9. no `dejaml.prep` containers, networks or temp directories remain.

## Honest limitations

- **pip still talks to the network during resolution.** The index and the
  metadata are fetched by pip inside zone 2 over the proxied connection. The
  proxy restricts *where* pip can connect, not *what* the index serves. A
  compromised index or mirror could serve malicious wheels.
- **Hashes are trust-on-first-use from the index.** The sha256 values come from
  the index over TLS, so they protect against tampering in transit and against
  later cache corruption. They do not protect against a malicious package that
  was published to the index. Wheels are never executed in zone 2, but the lab
  will import them.
- **The CA-bundle setting widens trust.** With `DEJAML_PREP_CA_BUNDLE`, whoever
  controls the intercepting proxy can see and alter package traffic. It is an
  operator setting for environments that require it.
- **Wheels only.** Anything without a compatible binary wheel for the image's
  Python and platform fails with `no_compatible_wheel`. Building sdists would
  mean running `setup.py` from the internet, which is deliberately out of scope.
- **The proxy sits on the default bridge** so it can reach the internet. Other
  containers on that bridge could talk to its port 3128 while it runs, but they
  get only the same allowlisted CONNECT. The tunnel is opaque TLS, so the proxy
  cannot filter URL paths on an allowed host.
- **The discovery parsers are deliberately conservative.** The TOML handling
  covers the shapes these files normally take and is not a full TOML parser.
  Dynamic dependencies, poetry multi-constraint entries and dev groups are not
  expanded. Repository constraints files are parsed for rejections but never
  applied; only project-owned compatibility constraints are. Markers are
  passed to pip as-is and evaluated against the preparation image's
  interpreter.
- In cross mode pip's `--platform` options select wheel tags, but pip evaluates
  environment markers against the interpreter it runs on. The cross entry point
  (`pipInvocation`) therefore makes `platform.machine()` report the target
  machine, so `platform_machine == "x86_64"` dependencies (torch's `nvidia-*`)
  are resolved, and refused, for an amd64 target on an arm64 engine; the
  report's marker environment must name the target machine or the resolution
  is `platform_mismatch`. `platform_release`/`platform_version` markers still
  see the engine's kernel. Wheels are still validated with
  `wheelMatchesPlatform`; run on a native or emulating engine for exact markers.
- The accelerator denylist is name- and version-based. A package that ships
  GPU code under an innocuous name on PyPI would not be caught by name.
- Quotas are enforced by measuring (every `diskPollMs` and at exit), so a
  worker can overshoot by what it writes between two polls; the free-space
  margin bounds the damage.
- The lab must use the platform's Python version and architecture; the
  manifest records both, and `installationReceipt` checks the interpreter.
