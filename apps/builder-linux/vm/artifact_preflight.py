"""Before Studio makes a server (a hosted VM, a remastered ISO or a USB stick),
check that the signed box release the install will download is published.

The bootstrap (SEC-INSTALL-001) fetches
<control host>/build/iso/flagship-box-<commit12>-<arch>.{tar.gz,manifest.json}
and stops for good when it is missing, so a recipe naming a release the control
plane doesn't serve yet could never finish (2026-11-02, home.serene-parrot).
Mirrors apps/builder-mac ArtifactPreflight.swift and apps/builder-windows
ArtifactPreflight.cs; pinned by vm-core-vectors.json "artifactPreflight".
"""
from __future__ import annotations

from i18n import tr

import re
from typing import Callable, Mapping, Optional
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from vm import control_plane

PUBLISHED = "published"
MISSING = "missing"
UNREACHABLE = "unreachable"

TIMEOUT_SECONDS = 15

_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_ARCHES = ("amd64", "arm64")


def missing_message(control_host: Optional[str] = None) -> str:
    return tr("This server can't be installed yet: its software package isn't published on {0}. Update Flagship Studio and the Flagship app, or try again later.").format(control_host or control_plane.control_host())


def unreachable_message(control_host: Optional[str] = None) -> str:
    return tr("Couldn't check that this server's software package is published on {0}. Check your internet connection and try again.").format(control_host or control_plane.control_host())


def message(verdict: str, env: Optional[Mapping[str, str]] = None, control_host: Optional[str] = None) -> Optional[str]:
    """The refusal for a verdict; None when the install may go ahead. The
    sentence names the control host the check asked (the gym when Studio
    follows FLAGSHIP_CONTROL_HOST), never a hard-coded flagshipserver.com."""
    host = control_host or control_plane.control_host(env)
    if verdict == MISSING:
        return missing_message(host)
    if verdict == UNREACHABLE:
        return unreachable_message(host)
    return None


def manifest_url(control_host: str, commit: Optional[str], arch: str) -> Optional[str]:
    """The manifest the bootstrap will download, or None when the recipe names
    no exact commit or the architecture is one no box runs (the bootstrap would
    refuse those too)."""
    if commit is None or not _COMMIT.fullmatch(commit) or arch not in _ARCHES:
        return None
    return f"https://{control_host}/build/iso/flagship-box-{commit[:12]}-{arch}.manifest.json"


def verdict_for(status: Optional[int]) -> str:
    """None status = no answer (timeout, DNS, TLS, offline)."""
    if status is None:
        return UNREACHABLE
    if 200 <= status < 300:
        return PUBLISHED
    if status in (404, 410):
        return MISSING
    return UNREACHABLE


def _head_status(url: str) -> Optional[int]:
    req = Request(url, method="HEAD", headers={"User-Agent": "flagship-builder-linux", "Cache-Control": "no-cache"})
    try:
        with urlopen(req, timeout=TIMEOUT_SECONDS) as resp:  # noqa: S310 - https only, built above
            return resp.status
    except HTTPError as e:
        return e.code
    except Exception:
        return None


def check(
    commit: Optional[str],
    arch: str,
    env: Optional[Mapping[str, str]] = None,
    head: Callable[[str], Optional[int]] = _head_status,
) -> str:
    """One HEAD for the manifest of `commit` on `arch`, against the control
    plane Studio follows."""
    url = manifest_url(control_plane.control_host(env), (commit or "").strip() or None, arch)
    if url is None:
        return MISSING
    return verdict_for(head(url))
