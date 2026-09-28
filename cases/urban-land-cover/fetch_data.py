#!/usr/bin/env python3
"""Fetch and verify the two approved UCI Urban Land Cover CSV files."""

from __future__ import annotations

import hashlib
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

ARCHIVE_URL = (
    "https://archive.ics.uci.edu/static/public/295/urban%2Bland%2Bcover.zip"
)
ARCHIVE_SHA256 = "277a27000a4a4b593f655595b92904ccb30ece48b8bb2a35cf5d3854d7204f79"
MAX_ARCHIVE_BYTES = 5 * 1024 * 1024
MEMBERS = {
    "urban+land+cover/training.csv": "training.csv",
    "urban+land+cover/testing.csv": "testing.csv",
}


def main() -> int:
    request = urllib.request.Request(
        ARCHIVE_URL, headers={"User-Agent": "DejaML/0.1 case-fetcher"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(payload) > MAX_ARCHIVE_BYTES:
        raise ValueError("dataset archive exceeds the configured size limit")

    digest = hashlib.sha256(payload).hexdigest()
    if digest != ARCHIVE_SHA256:
        raise ValueError(f"dataset digest mismatch: expected {ARCHIVE_SHA256}, got {digest}")

    destination = Path(__file__).resolve().parent / "data"
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for member, filename in MEMBERS.items():
            info = archive.getinfo(member)
            if info.file_size > MAX_ARCHIVE_BYTES:
                raise ValueError(f"dataset member is unexpectedly large: {member}")
            target = destination / filename
            target.write_bytes(archive.read(info))
            print(f"wrote {target} ({info.file_size} bytes)")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"DEJAML_FETCH_ERROR={type(error).__name__}: {error}", file=sys.stderr)
        raise

