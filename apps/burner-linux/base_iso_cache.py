"""One-time base-ISO cache (Python port of BaseIsoCache.swift).

The burner downloads the stock Flagship Alpine base ISO ONCE, verifies its
sha256, and keeps it under $XDG_CACHE_HOME/flagship-burner (fallback
~/.cache/flagship-burner). Every subsequent server reuses the cached copy —
no re-download — so the user only ever pays the ~240 MB transfer the first
time. The recipe trailer is then appended locally (alpine_personalize).

Stdlib only (urllib + hashlib) so it imports without GTK or third-party
packages and works in the AppImage/Flatpak sandbox.
"""
from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path
from typing import Callable, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# Pinned base ISO. Bump version + sha256 together when the base is rebuilt;
# ideally a future /api/iso-manifest makes this dynamic.
VERSION = "alpine-3.21.0"
SHA256_HEX = "f63e57b0ad4a94444f3141bf29877dbe4502553725b7c883900215ad4d3c08cd"
# Served straight from R2 via the /build/iso/:filename route (returns the R2
# body directly — runtime-native, no truncation).
URL = "https://flagshipserver.com/build/iso/flagship-alpine-base.iso"

# Mirrors BaseIsoCache.cachedURL's filename: flagship-base-<version>.iso.
CACHE_FILENAME = f"flagship-base-{VERSION}.iso"

# After this long, the next apkovl burn does ONE quiet HEAD to see whether a
# newer base was published — so a long-lived cache doesn't silently miss an
# update, without re-checking on every burn. Mirrors BaseIsoCache.maxCacheAge.
MAX_CACHE_AGE = 7 * 24 * 3600  # one week, in seconds

ProgressCb = Callable[[float], None]
OnDownloadStart = Callable[[], None]


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


def cache_dir() -> Path:
    """$XDG_CACHE_HOME/flagship-burner, falling back to ~/.cache/flagship-burner
    per the XDG Base Directory spec."""
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg) if xdg else (Path.home() / ".cache")
    return base / "flagship-burner"


def cached_path() -> Path:
    """The absolute path the verified base ISO lives at (created lazily)."""
    d = cache_dir()
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise NoCacheDirError() from e
    return d / CACHE_FILENAME


def is_cached() -> bool:
    """True if a base ISO is already on disk (so the UI can skip the one-time
    download phase + its messaging). Mirrors BaseIsoCache.isCached — trusts the
    cached copy; a corrupt cache surfaces at personalize/flash time."""
    try:
        return cached_path().exists()
    except CacheError:
        return False


def ensure(
    progress: Optional[ProgressCb] = None,
    on_download_start: Optional[OnDownloadStart] = None,
    notice: Optional[Callable[[str], None]] = None,
) -> Path:
    """Return the cached base ISO, downloading + verifying it once if absent.

    `progress` is called 0…1 during the download phase only. `on_download_start`
    fires once if a download is actually starting (so the UI can show the
    one-time-download banner). `notice` carries informational messages (e.g. a
    newer base being available) to the log. Returns the cached path.

    Raises CacheError subclasses with clear messages on no-internet / HTTP
    status / checksum mismatch.
    """
    progress = progress or (lambda _p: None)
    on_download_start = on_download_start or (lambda: None)
    notice = notice or (lambda _m: None)

    dest = cached_path()
    if dest.exists():
        if time.time() - dest.stat().st_mtime < MAX_CACHE_AGE:
            return dest  # fresh — use directly, no network touched
        # Stale (> a week): ONE quiet HEAD to see if a newer base shipped.
        remote_tag = _head_etag()
        if remote_tag is not None:
            if remote_tag == _stored_etag(dest):
                _touch(dest)  # unchanged upstream — reset the week
            else:
                notice("a newer base image is available — update the Flagship Assembler to use it")
                _store_etag(remote_tag, dest)
                _touch(dest)  # re-check (and re-warn) at most once per week
        # HEAD failed (offline) → keep the valid cache; never block a burn.
        return dest

    on_download_start()

    req = Request(URL, headers={"User-Agent": "flagship-burner-linux"})
    try:
        resp = urlopen(req)  # noqa: S310 - fixed https URL constant
    except HTTPError as e:
        raise HTTPStatusError(e.code) from e
    except (URLError, OSError) as e:
        raise OfflineError(str(getattr(e, "reason", e))) from e

    with resp:
        status = getattr(resp, "status", 200) or 200
        if not (200 <= status <= 299):
            raise HTTPStatusError(status)
        etag = resp.headers.get("ETag")
        length_header = resp.headers.get("Content-Length")
        expected_len = int(length_header) if length_header else -1

        tmp = dest.with_suffix(dest.suffix + ".partial")
        hasher = hashlib.sha256()
        received = 0
        try:
            with open(tmp, "wb") as handle:
                while True:
                    block = resp.read(1 << 20)
                    if not block:
                        break
                    handle.write(block)
                    hasher.update(block)
                    received += len(block)
                    if expected_len > 0:
                        progress(min(1.0, received / expected_len))
        except (URLError, OSError) as e:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise OfflineError(str(getattr(e, "reason", e))) from e

    progress(1.0)

    got = hasher.hexdigest()
    if got != SHA256_HEX:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise ChecksumMismatchError(expected=SHA256_HEX, got=got)

    # Atomic move into place.
    os.replace(tmp, dest)
    if etag:
        _store_etag(etag, dest)
    return dest


# --- Freshness helpers (mirror BaseIsoCache.swift) ---------------------------


def _etag_sidecar(dest: Path) -> Path:
    return dest.with_suffix(dest.suffix + ".etag")


def _stored_etag(dest: Path) -> Optional[str]:
    try:
        return _etag_sidecar(dest).read_text(encoding="utf-8")
    except OSError:
        return None


def _store_etag(tag: str, dest: Path) -> None:
    try:
        _etag_sidecar(dest).write_text(tag, encoding="utf-8")
    except OSError:
        pass


def _touch(dest: Path) -> None:
    try:
        os.utime(dest, None)  # bump mtime/atime to now — resets the week
    except OSError:
        pass


def _head_etag() -> Optional[str]:
    """Lightweight conditional check — a HEAD for the ETag. Returns None when
    the network is unreachable, so the caller keeps using the valid cache
    rather than blocking the burn."""
    req = Request(URL, method="HEAD", headers={"User-Agent": "flagship-burner-linux"})
    try:
        with urlopen(req, timeout=8) as r:  # noqa: S310 - fixed https URL constant
            return r.headers.get("ETag")
    except (HTTPError, URLError, OSError):
        return None
