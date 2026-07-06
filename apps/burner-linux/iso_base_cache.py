"""Manifest-driven base-ISO cache for Simple mode.

The burner keeps at most one stock Debian-netinst base ISO under
$XDG_CACHE_HOME/flagship-burner (fallback ~/.cache/flagship-burner). On every
Simple bake it:

  1. INSPECTS the cached ISO (if any) — computes its sha256 and LOGS its local
     path + sha256.
  2. POSTs /api/iso-manifest with `current` = {version, sha256} (or null when
     nothing is cached).
  3. OBEYS the response:
       - download non-null → fetch download.url (URL surfaced to the UI via the
         progress callback), stream-verify sha256 == download.sha256 (mismatch
         → delete the partial + error), store under
         flagship-base-<version>.iso, LOG `downloaded <path> sha256=<hex> from
         <url>`, return the new path.
       - download null → keep the cache, return the cached path.

The burner is a DUMB EXECUTOR: it NEVER decides-by-sha client-side. It reports
`current`, obeys the manifest, and verifies the bytes it downloads.

Stdlib only (urllib + hashlib) so it imports without GTK / third-party
packages and works in the AppImage/Flatpak sandbox.

Mechanics (chunked stream + sha256 + atomic replace) ported from the retired
Alpine base_iso_cache.py; the hardcoded Alpine constants are gone — versioning
+ URLs now come entirely from the server manifest.
"""
from __future__ import annotations

import glob
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from iso_manifest_client import (
    CurrentBase,
    DownloadDescriptor,
    ManifestError,
    fetch_manifest,
)

# Filename pattern for cached base ISOs: flagship-base-<version>.iso for the
# amd64 burn base (the legacy name, so existing caches stay valid) and
# flagship-base-arm64-<version>.iso for the arm64 hosting base. Mirrors the
# Mac IsoBaseCache's per-arch naming — the two bases must COEXIST (a burn and
# an arm64 host on the same machine), so inspect/download are arch-scoped and
# never see each other's entries.
_FILENAME_PREFIX = "flagship-base-"
_FILENAME_SUFFIX = ".iso"
_ARM64_TAG = "arm64-"

# progress(fraction, url) — fraction is 0…1 during the download; url is the
# byte source so the UI can surface it under the progress bar.
ProgressCb = Callable[[float, str], None]
# log(message) — informational lines routed into the wizard's log pane.
LogCb = Callable[[str], None]
OnDownloadStart = Callable[[DownloadDescriptor], None]


class CacheError(Exception):
    """Base for all cache failures — carries a user-facing message."""


class OfflineError(CacheError):
    def __init__(self, why: str) -> None:
        super().__init__(
            f"Couldn't download the base image — check your internet "
            f"connection. ({why})"
        )


class HTTPStatusError(CacheError):
    def __init__(self, code: int) -> None:
        self.code = code
        super().__init__(f"Base-image download failed (HTTP {code}).")


class ChecksumMismatchError(CacheError):
    def __init__(self, expected: str, got: str) -> None:
        self.expected = expected
        self.got = got
        super().__init__(
            f"Base image failed its integrity check "
            f"(expected {expected[:12]}…, got {got[:12]}…). Try again."
        )


class NoCacheDirError(CacheError):
    def __init__(self) -> None:
        super().__init__("Couldn't open the cache directory.")


class CancelledError(CacheError):
    """The user hit Cancel mid-download (wizard.cancel() trips the event)."""

    def __init__(self) -> None:
        super().__init__("Base-image download cancelled.")


class ManifestFetchError(CacheError):
    """Wraps an iso_manifest_client.ManifestError so callers only catch
    CacheError."""


def cache_dir() -> Path:
    """$XDG_CACHE_HOME/flagship-burner, falling back to ~/.cache/flagship-burner
    per the XDG Base Directory spec."""
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg) if xdg else (Path.home() / ".cache")
    return base / "flagship-burner"


def _ensure_cache_dir() -> Path:
    d = cache_dir()
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise NoCacheDirError() from e
    return d


def _arch_prefix(arch: str) -> str:
    """amd64 keeps the legacy bare prefix; other arches are tag-namespaced."""
    return _FILENAME_PREFIX if arch == "amd64" else f"{_FILENAME_PREFIX}{_ARM64_TAG}"


def cached_path_for(version: str, arch: str = "amd64") -> Path:
    """Absolute path a base ISO of `version` for `arch` lives at."""
    return cache_dir() / f"{_arch_prefix(arch)}{version}{_FILENAME_SUFFIX}"


@dataclass(frozen=True)
class CachedBase:
    """An on-disk cached base ISO + its parsed version + computed sha256."""
    path: Path
    version: str
    sha256: str


def _version_from_filename(path: Path, arch: str = "amd64") -> Optional[str]:
    """Parse the version out of an arch-matching cache filename; None when the
    name belongs to another arch. The legacy amd64 prefix is a prefix of every
    arm64 name, so the amd64 branch must explicitly reject the arm64 tag."""
    name = path.name
    prefix = _arch_prefix(arch)
    if not (name.startswith(prefix) and name.endswith(_FILENAME_SUFFIX)):
        return None
    version = name[len(prefix):-len(_FILENAME_SUFFIX)]
    if arch == "amd64" and version.startswith(_ARM64_TAG):
        return None
    return version or None


def _sha256_of(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(1 << 20)
            if not block:
                break
            hasher.update(block)
    return hasher.hexdigest()


def inspect_cache(log: Optional[LogCb] = None, arch: str = "amd64") -> Optional[CachedBase]:
    """Find the cached base ISO for `arch` (if any), compute its sha256, and
    LOG its local path + sha256. Returns None when nothing is cached.

    If multiple cached bases exist (e.g. after a version bump that hasn't been
    pruned), the most recently modified one is treated as current. Entries of
    the OTHER arch are invisible — the amd64 burn base and the arm64 hosting
    base coexist without evicting or shadowing each other.
    """
    log = log or (lambda _m: None)
    d = cache_dir()
    if not d.exists():
        return None
    matches = sorted(
        (Path(p) for p in glob.glob(str(d / f"{_FILENAME_PREFIX}*{_FILENAME_SUFFIX}"))),
        key=lambda p: p.stat().st_mtime if p.exists() else 0.0,
        reverse=True,
    )
    for candidate in matches:
        version = _version_from_filename(candidate, arch=arch)
        if version is None or not candidate.is_file():
            continue
        sha = _sha256_of(candidate)
        log(f"cached base {candidate} sha256={sha}")
        return CachedBase(path=candidate, version=version, sha256=sha)
    return None


def _download(
    descriptor: DownloadDescriptor,
    progress: ProgressCb,
    log: LogCb,
    opener=None,
    cancel_event=None,
    arch: str = "amd64",
) -> Path:
    """Stream the descriptor's URL to disk, verifying sha256 as we go.

    The download URL is passed to `progress` on every tick so the UI can show
    it under the progress bar. On a sha mismatch the partial file is deleted
    and ChecksumMismatchError is raised. A set `cancel_event`
    (threading.Event) aborts between chunks: the partial file is deleted and
    CancelledError raised."""
    do_open = opener or (lambda req: urlopen(req))  # noqa: S310 - URL from server manifest

    dest_dir = _ensure_cache_dir()
    dest = dest_dir / f"{_arch_prefix(arch)}{descriptor.version}{_FILENAME_SUFFIX}"

    req = Request(descriptor.url, headers={"User-Agent": "flagship-burner-linux"})
    try:
        resp = do_open(req)
    except HTTPError as e:
        raise HTTPStatusError(e.code) from e
    except (URLError, OSError) as e:
        raise OfflineError(str(getattr(e, "reason", e))) from e

    with resp:
        status = getattr(resp, "status", 200) or 200
        if not (200 <= status <= 299):
            raise HTTPStatusError(status)
        length_header = resp.headers.get("Content-Length") if hasattr(resp, "headers") else None
        expected_len = (
            int(length_header) if length_header
            else (descriptor.size_bytes if descriptor.size_bytes > 0 else -1)
        )

        tmp = dest.with_suffix(dest.suffix + ".partial")
        hasher = hashlib.sha256()
        received = 0
        progress(0.0, descriptor.url)
        try:
            with open(tmp, "wb") as handle:
                while True:
                    if cancel_event is not None and cancel_event.is_set():
                        raise CancelledError()
                    block = resp.read(1 << 20)
                    if not block:
                        break
                    handle.write(block)
                    hasher.update(block)
                    received += len(block)
                    if expected_len > 0:
                        progress(min(1.0, received / expected_len), descriptor.url)
        except CancelledError:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
        except (URLError, OSError) as e:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise OfflineError(str(getattr(e, "reason", e))) from e

    progress(1.0, descriptor.url)

    got = hasher.hexdigest()
    if got != descriptor.sha256:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise ChecksumMismatchError(expected=descriptor.sha256, got=got)

    os.replace(tmp, dest)
    log(f"downloaded {dest} sha256={got} from {descriptor.url}")
    return dest


def ensure(
    burner_version: str,
    progress: Optional[ProgressCb] = None,
    on_download_start: Optional[OnDownloadStart] = None,
    log: Optional[LogCb] = None,
    *,
    manifest_fn: Optional[Callable[..., object]] = None,
    opener=None,
    cancel_event=None,
    arch: str = "amd64",
) -> Path:
    """Return a verified base ISO path for `arch`, obeying the server manifest.

    Flow: inspect cache (LOG path+sha) → POST manifest with `current` →
    download-on-order (stream-verify sha, LOG path+sha) OR keep cache.

    `progress(fraction, url)` is called during a download only. `log(message)`
    routes informational lines to the wizard log. `manifest_fn` + `opener` are
    injectable seams for tests.

    Raises CacheError subclasses (incl. ManifestFetchError) with clear
    messages on manifest / network / HTTP / checksum failure. For an arch the
    server hasn't blessed yet, "no download + nothing cached" is reported as
    "hosting unavailable on this architecture" — never "up to date".
    """
    progress = progress or (lambda _f, _u: None)
    on_download_start = on_download_start or (lambda _d: None)
    log = log or (lambda _m: None)
    fetch = manifest_fn or fetch_manifest

    cached = inspect_cache(log=log, arch=arch)
    current = (
        CurrentBase(version=cached.version, sha256=cached.sha256)
        if cached is not None
        else None
    )

    try:
        result = fetch(burner_version, current, arch=arch)
    except ManifestError as e:
        # If we have a usable cache, a manifest hiccup must not block the burn.
        if cached is not None:
            log(f"manifest unavailable ({e}); using cached base {cached.path}")
            return cached.path
        raise ManifestFetchError(str(e)) from e

    descriptor = getattr(result, "download", None)
    if descriptor is None:
        if cached is None:
            # Server says "no download" but we have nothing cached — there is
            # no base ISO to bake with. Surface a clear, arch-honest error.
            if arch != "amd64":
                raise ManifestFetchError(
                    f"The server doesn't offer an {arch} base image yet, so "
                    f"Simple mode can't host a server on this machine for now. "
                    f"Use Advanced mode with an {arch} Debian netinst ISO instead."
                )
            raise ManifestFetchError(
                "Server returned no base image to download and none is cached."
            )
        log(f"manifest: keep cached base {cached.path}")
        return cached.path

    on_download_start(descriptor)
    return _download(
        descriptor, progress=progress, log=log, opener=opener,
        cancel_event=cancel_event, arch=arch,
    )
