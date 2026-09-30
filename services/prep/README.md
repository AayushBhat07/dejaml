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

1. `discoverDependencies(repoDir)` walks the checkout. It skips `.git`, goes at
   most 4 levels deep, reads at most 5000 entries, never follows symlinks and
   only reads files of 1 MiB or less. It returns the dependency files it found
   (with sha256), the preferred lockfile, the parsed requirements, every
   rejected line with a reason, and anything unsupported (`setup.py`/`setup.cfg`
   are flagged `executable_build_metadata` and never run; conda, npm, Cargo, Go
   and R files are reported explicitly).
2. `DependencyPreparer.resolvePython({ runId, requirements, includeInstaller })`
   writes a generated `requirements.in` made only from validated specs (plus
   `pip` when `includeInstaller` is set, because the lab image has no pip). It
   then runs `pip install --dry-run --ignore-installed --only-binary=:all:
   --report` and validates the report: one wheel per package, `https` on an
   allowlisted host, a sha256, a wheel file name that matches the name and
   version, and at most `maxPackages` packages.
3. `downloadWheels(resolution)` re-validates the resolution. Packages already in
   the verified cache are re-hashed and reused. Everything else is fetched by a
   fresh container running `pip download --no-deps --only-binary=:all:
   --require-hashes`. On the host, every file must be a regular `.whl` (checked
   with lstat, so no symlinks) whose name matches, whose size is within the
   limits and whose sha256 equals the resolved hash. Only then is it moved into
   the write-once cache `<cacheDir>/wheels/<sha256>/<filename>`. A per-run
   wheelhouse is then built (files 0444, directory 0555) with the wheels,
   `requirements.lock.txt` (`name==version --hash=sha256:…`, pip excluded),
   `installer.json` and `manifest.json`. If every wheel is already cached, no
   container is started at all.
4. The lab installs offline with `offlineInstallCommands(...)`: `python -m venv
   --without-pip`, then pip run straight from its wheel with `--no-index
   --find-links <wheelhouse> --only-binary=:all: --require-hashes`.

## Docker topology per call

Everything carries the labels `dejaml.prep=<prepId>` and `dejaml.run=<runId>`.
The image is identified by `docker image inspect --format {{.Id}}` (and must
equal `expectedImageId` when that is set). Containers are created from that
image ID with `--pull never`, so nothing is ever pulled implicitly.

```
docker network create --internal <labels> dejaml-prep-<id>

# egress proxy: on the default bridge, then attached to the internal network
docker create --name dejaml-prep-<id>-egress --pull never <labels> --network bridge \
  --user 65534:65534 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 \
  --mount type=bind,src=<pkg>/proxy/egress_proxy.py,dst=/opt/dejaml/egress_proxy.py,readonly \
  --entrypoint python <imageId> -I -u /opt/dejaml/egress_proxy.py --listen 0.0.0.0:3128 \
  --allow pypi.org --allow files.pythonhosted.org --budget-bytes <maxTotal+128MiB> --idle-timeout 60
docker network connect --alias egress dejaml-prep-<id> dejaml-prep-<id>-egress
docker start dejaml-prep-<id>-egress

# resolver / downloader: ONLY on the internal network
docker run --name dejaml-prep-<id>-resolve --pull never <labels> --network dejaml-prep-<id> \
  --user 65534:65534 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
  --cpus <cpus> --memory <mb>m --memory-swap <mb>m --pids-limit <pids> \
  --env HOME=/tmp --env HTTPS_PROXY=http://egress:3128 --env PIP_INDEX_URL=<indexUrl> \
  --env PIP_DISABLE_PIP_VERSION_CHECK=1 --env PIP_NO_INPUT=1 --env PIP_NO_CACHE_DIR=1 \
  [--env PIP_CERT=/etc/dejaml/ca-bundle.pem] \
  --mount type=bind,src=<tmp>/in,dst=/in,readonly [--mount <ca copy>,dst=/etc/dejaml/ca-bundle.pem,readonly] \
  --mount type=bind,src=<tmp>/out,dst=/out \
  --workdir /tmp --entrypoint python <imageId> -m pip install --dry-run ...
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
| `no_compatible_wheel` | pip reports "No matching distribution found" / "Could not find a version that satisfies" (`requirement` holds the name), or the report points at a non-wheel. Source distributions are never built; getting past this needs explicit approval or a prebuilt lab image. |
| `resolution_conflict` | `ResolutionImpossible` or conflicting dependencies |
| `egress_denied` | the proxy log shows a denied CONNECT, or a resolved URL is on a host that is not allowlisted |
| `limit_exceeded` | `maxPackages`, `maxFileBytes`, `maxTotalBytes`, the proxy byte budget, or an OOM kill |
| `timeout` / `cancelled` | `timeoutSeconds` elapsed, or the caller's `AbortSignal` fired |
| `invalid_requirement` | a requirement or `runId` failed validation, or the resolution was a direct/VCS reference |
| `integrity_error` | a downloaded or cached wheel did not match its sha256, or an unexpected file appeared |
| `image_mismatch` | the image ID differs from `expectedImageId` |
| `invalid_policy` | invalid operator configuration |
| `runtime_error` | anything else (Docker failures, missing image, etc.) |

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
| `DEJAML_PREP_IMAGE` | `python:3.13.15-slim-trixie` | must already be present locally |
| `DEJAML_PREP_IMAGE_ID` | unset | `sha256:<64 hex>`; enforced before use |
| `DEJAML_PREP_INDEX_URL` | `https://pypi.org/simple` | https only, no credentials or port; the host must be allowlisted |
| `DEJAML_PREP_ALLOWED_HOSTS` | `pypi.org,files.pythonhosted.org` | comma-separated DNS names; no IPs or wildcards |
| `DEJAML_PREP_MAX_PACKAGES` | `150` | |
| `DEJAML_PREP_MAX_TOTAL_MB` | `800` | total wheel bytes; the proxy budget is this plus 128 MiB |
| `DEJAML_PREP_CA_BUNDLE` | unset | see below |

These can only be changed in code through `PrepPolicy`: `maxFileBytes` (150 MiB),
`timeoutSeconds` (600), `cpus` (2), `memoryMb` (2048) and `pids` (256).

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

`scripts/verify-prep-docker.mjs` uses the locally present
`python:3.13.15-slim-trixie` image. It sets `DEJAML_PREP_CA_BUNDLE` to
`/root/.ccr/ca-bundle.crt` only when that file exists, because the cloud machine
intercepts TLS. It proves the following:

1. matplotlib and its dependencies, plus pip, are resolved and downloaded with
   every hash verified.
2. `numpy==1.19.5` fails with `no_compatible_wheel` and nothing is built.
3. From the internal network, a direct TCP connection to 1.1.1.1:443 fails,
   DNS fails, and `CONNECT example.com:443`, `pypi.org:80`, `1.1.1.1:443` and
   `169.254.169.254:443` are denied (logged `allowed:false`), while
   `pypi.org:443` is allowed.
4. An offline install works in a `--network none --read-only --cap-drop ALL
   --user 10001:10001` container with the wheelhouse mounted read-only, and
   `import matplotlib` succeeds.
5. A second run is served entirely from the cache: the downloader is skipped
   and no bytes pass through the proxy.
6. Cancellation cleans up.
7. No `dejaml.prep` containers, networks or temp directories remain.

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
  Dynamic dependencies, poetry multi-constraint entries, optional dependencies
  and dev groups are not expanded. Constraints files are parsed for rejections
  but not applied. Markers are passed to pip as-is and evaluated against the
  preparation image's interpreter.
- The preparation image should use the same Python minor version and platform as
  the lab image, or the wheels may not install. The manifest records the
  resolver's `pythonVersion` and `imageId` so this can be checked.
