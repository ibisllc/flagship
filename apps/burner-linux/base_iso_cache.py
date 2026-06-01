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
) -> Path:
    """Return the cached base ISO, downloading + verifying it once if absent.

    `progress` is called 0…1 during the download phase only. `on_download_start`
    fires once if a download is actually starting (so the UI can show the
    one-time-download banner). Returns the cached path.

    Raises CacheError subclasses with clear messages on no-internet / HTTP
    status / checksum mismatch.
    """
    progress = progress or (lambda _p: None)
    on_download_start = on_download_start or (lambda: None)

    dest = cached_path()
    if dest.exists():
        # Trust the cached copy; a corrupt cache surfaces at flash time.
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
    return dest
