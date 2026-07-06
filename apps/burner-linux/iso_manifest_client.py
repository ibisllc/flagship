"""Server-manifest client for the Simple-mode Debian base ISO.

The burner is a DUMB EXECUTOR. It POSTs its current cached-base state to the
server's /api/iso-manifest endpoint and obeys the response verbatim:

  - response has a non-null `download` → fetch + verify + cache those bytes.
  - response `download` is null → keep whatever is cached.

The burner NEVER decides by sha client-side; it only *reports* `current` and
*verifies* the bytes it downloads against the sha the server hands back.

LOCKED WIRE CONTRACT
--------------------
POST https://flagshipserver.com/api/iso-manifest

Request JSON:
  { "platform": "linux",
    "burnerVersion": "<string>",
    "current": { "version": "<string>", "sha256": "<hex64>" } | null,
    "arch": "amd64" | "arm64" }          # OPTIONAL; absent = "amd64"

Burning always requests amd64 (real boxes are x86; the arch key stays ABSENT
so the burn-path request is byte-identical to the pre-arch wire format). The
host-on-this-PC path requests the HOST arch — an arm64 guest is the only kind
an arm64 Chromebook/SBC can host. `download: null` for a requested arch means
"keep what you've got" — UNLESS nothing is cached for that arch, in which case
the CACHE layer surfaces "no base for this arch" (see iso_base_cache).

Response JSON, exactly one of:
  { "download": { "url": "<https>", "sha256": "<hex64>",
                  "version": "<string>", "sizeBytes": <int>,
                  "attestation": "<https>" } }
  { "download": null }

Stdlib only (urllib + json) so it imports without GTK or third-party packages
and works inside the AppImage/Flatpak sandbox.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

PLATFORM = "linux"
MANIFEST_URL = "https://flagshipserver.com/api/iso-manifest"


class ManifestError(Exception):
    """Base for manifest-fetch failures — carries a user-facing message."""


class ManifestOfflineError(ManifestError):
    def __init__(self, why: str) -> None:
        super().__init__(
            f"Couldn't reach the base-image manifest — check your internet "
            f"connection. ({why})"
        )


class ManifestHTTPError(ManifestError):
    def __init__(self, code: int) -> None:
        self.code = code
        super().__init__(f"Base-image manifest request failed (HTTP {code}).")


class ManifestParseError(ManifestError):
    def __init__(self, why: str) -> None:
        super().__init__(f"Base-image manifest response was malformed. ({why})")


@dataclass(frozen=True)
class CurrentBase:
    """What the burner currently has cached. Reported as `current`."""
    version: str
    sha256: str

    def to_wire(self) -> dict:
        return {"version": self.version, "sha256": self.sha256}


@dataclass(frozen=True)
class DownloadDescriptor:
    """The server's instruction to fetch a new base ISO."""
    url: str
    sha256: str
    version: str
    size_bytes: int
    attestation: str

    @classmethod
    def from_wire(cls, d: dict) -> "DownloadDescriptor":
        try:
            parsed = cls(
                url=str(d["url"]),
                sha256=str(d["sha256"]).lower(),
                version=str(d["version"]),
                size_bytes=int(d["sizeBytes"]),
                attestation=str(d["attestation"]),
            )
        except (KeyError, TypeError, ValueError) as e:
            raise ManifestParseError(f"download missing/invalid field: {e}") from e
        # Match the Windows/Mac clients: refuse a non-https byte source and a
        # sha that can't possibly verify (the download would fail anyway, but
        # fail HERE with a message that blames the manifest, not the network).
        if not parsed.url.startswith("https://"):
            raise ManifestParseError("download URL is not https")
        if len(parsed.sha256) != 64 or any(
            c not in "0123456789abcdef" for c in parsed.sha256
        ):
            raise ManifestParseError("sha256 is not a 64-char hex digest")
        return parsed


@dataclass(frozen=True)
class ManifestResult:
    """Parsed /api/iso-manifest response. `download` is None when the server
    tells the burner to keep its cache."""
    download: Optional[DownloadDescriptor]


def fetch_manifest(
    burner_version: str,
    current: Optional[CurrentBase],
    url: str = MANIFEST_URL,
    *,
    arch: Optional[str] = None,
    opener=None,
) -> ManifestResult:
    """POST the manifest request and parse the response.

    `opener` is an injectable seam for tests: a callable taking a
    urllib.request.Request and returning a file-like response (mirrors
    urlopen). Defaults to the real urlopen.

    Raises ManifestError subclasses on network / HTTP / parse failure.
    """
    do_open = opener or (lambda req: urlopen(req))  # noqa: S310 - fixed https URL constant

    body = {
        "platform": PLATFORM,
        "burnerVersion": burner_version,
        "current": current.to_wire() if current is not None else None,
    }
    # amd64 is encoded as an ABSENT key so the burn-path request stays
    # byte-identical to the pre-arch wire format (matches the Mac client).
    if arch is not None and arch != "amd64":
        body["arch"] = arch
    payload = json.dumps(body).encode("utf-8")
    req = Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "flagship-burner-linux",
        },
    )

    try:
        resp = do_open(req)
    except HTTPError as e:
        raise ManifestHTTPError(e.code) from e
    except (URLError, OSError) as e:
        raise ManifestOfflineError(str(getattr(e, "reason", e))) from e

    try:
        with resp:
            status = getattr(resp, "status", 200) or 200
            if not (200 <= status <= 299):
                raise ManifestHTTPError(status)
            raw = resp.read()
    except (URLError, OSError) as e:
        raise ManifestOfflineError(str(getattr(e, "reason", e))) from e

    try:
        parsed = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as e:
        raise ManifestParseError(str(e)) from e

    if not isinstance(parsed, dict) or "download" not in parsed:
        raise ManifestParseError("response is not an object with a `download` key")

    dl = parsed["download"]
    if dl is None:
        return ManifestResult(download=None)
    if not isinstance(dl, dict):
        raise ManifestParseError("`download` must be an object or null")
    return ManifestResult(download=DownloadDescriptor.from_wire(dl))
