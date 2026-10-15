# R lab base image

The lab image for R studies: [`rocker/r-ver`](https://hub.docker.com/r/rocker/r-ver) (Ubuntu 24.04) for one R
version, pinned by its multi-platform index digest in `bases.lock.json`, with:

- the non-root lab user (uid and gid 10001) and the `/workspace/case` workdir, like the Python base;
- Python 3.12 from a dated Ubuntu archive snapshot (`aptSnapshot`), because the lab's own tools (file listing,
  integrity checks, the repository copy) are Python programs. Studies never run Python here, and pip is absent;
- `R_LIBS_SITE` and `R_LIBS_USER` pointing at `/workspace/case/rlib`, where a study's CRAN packages are mounted
  read-only.

CRAN packages are never installed or compiled in the lab. Preparation downloads prebuilt Linux binaries for
Ubuntu 24.04 and this R version from a dated [Posit Package Manager](https://packagemanager.posit.co) snapshot,
verifies each one is a binary built for this R version and architecture, and unpacks them into the library that
is mounted. A package with no prebuilt binary is refused.

## Refreshing the lock

```sh
docker buildx imagetools inspect docker.io/rocker/r-ver:4.5.3
```

Copy the index digest and the `linux/amd64` and `linux/arm64` manifest digests into `bases.lock.json`, choose an
`aptSnapshot` on or after the base image's date, and rebuild both platforms.
