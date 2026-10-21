"""The published prebuilt VM appliance: download once per release, verify,
keep, and hand out as the read-only qcow2 backing file of every new server.

Mirrors apps/builder-mac FlagshipBuilderCore/VM/ApplianceCache.swift with one
deliberate difference: QEMU reads qcow2 itself, so the verified archive (the
concatenated parts) IS the base. Nothing is expanded; each server gets a thin
qcow2 overlay on top of it (the CLI's appliance-provision). The trust model is
the Mac's: flagshipserver.com names the image over TLS, and every part and the
whole archive are checked against that manifest before use.

A base stays on disk while any server's overlay still reads from it; only a
superseded base that no server uses is deleted.
"""
from __future__ import annotations

from i18n import tr

import hashlib
import json
import os
import re
import shutil
import struct
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional, Set, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_ORIGIN = "https://flagshipserver.com"
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_PART_NAME = re.compile(r"^part-[0-9]{2}$")
_QCOW2_MAGIC = b"QFI\xfb"
# Room left on the disk after the archive lands: the first server's overlay
# grows into it during specialization.
_HEADROOM_BYTES = 2_000_000_000


class ApplianceCacheError(Exception):
    """kind: unavailable | ref-mismatch | invalid-manifest | offline |
    http-status | checksum | insufficient-space | cancelled."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind

    @property
    def falls_back_to_installer(self) -> bool:
        """Failures that mean "use the installer ISO instead" rather than
        "something is wrong with what we downloaded"."""
        return self.kind in ("unavailable", "ref-mismatch", "invalid-manifest")


def _unavailable(arch: str) -> ApplianceCacheError:
    return ApplianceCacheError("unavailable", tr('No prebuilt {0} server image is published yet.').format(arch))


def _invalid() -> ApplianceCacheError:
    return ApplianceCacheError("invalid-manifest", tr("The prebuilt server image's manifest is malformed."))


def _offline(why: str) -> ApplianceCacheError:
    return ApplianceCacheError("offline", tr("Couldn't download the prebuilt server image: {0}").format(why))


def _http(code: int) -> ApplianceCacheError:
    return ApplianceCacheError(
        "http-status", tr('The server returned HTTP {0} for the prebuilt server image.').format(code)
    )


def _checksum(what: str) -> ApplianceCacheError:
    return ApplianceCacheError(
        "checksum", tr('The prebuilt server image failed its integrity check ({0}).').format(what)
    )


@dataclass(frozen=True)
class AppliancePart:
    name: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class ApplianceDistribution:
    """/downloads/FlagshipVMAppliance-<arch>.json: a compressed qcow2 split into
    parts, plus the hash of the raw disk it expands to."""

    arch: str
    installer_git_ref: str
    sha256: str
    size_bytes: int
    parts: Tuple[AppliancePart, ...]
    raw_sha256: str
    raw_size_bytes: int

    @staticmethod
    def parse(data: bytes) -> "ApplianceDistribution":
        try:
            d = json.loads(data)
            parts = tuple(
                AppliancePart(p["name"], p["sizeBytes"], p["sha256"]) for p in d["parts"]
            )
            dist = ApplianceDistribution(
                arch=d["arch"],
                installer_git_ref=d["installerGitRef"],
                sha256=d["sha256"],
                size_bytes=d["sizeBytes"],
                parts=parts,
                raw_sha256=d["rawSha256"],
                raw_size_bytes=d["rawSizeBytes"],
            )
            ok = (
                d["version"] == 1
                and d["format"] == "qcow2"
                and isinstance(dist.installer_git_ref, str)
                and _HEX64.fullmatch(str(dist.sha256))
                and _HEX64.fullmatch(str(dist.raw_sha256))
                and _is_count(dist.size_bytes)
                and _is_count(dist.raw_size_bytes)
                and parts
                and all(
                    _PART_NAME.fullmatch(str(p.name))
                    and _HEX64.fullmatch(str(p.sha256))
                    and _is_count(p.size_bytes)
                    for p in parts
                )
                and sum(p.size_bytes for p in parts) == dist.size_bytes
            )
        except (ValueError, KeyError, TypeError):
            raise _invalid() from None
        if not ok:
            raise _invalid()
        return dist

    @property
    def key_prefix(self) -> str:
        """R2 key prefix the factory workflow publishes the parts under."""
        slug = "".join(
            c if (c.isascii() and c.isalnum()) or c in ".-" else "-" for c in self.installer_git_ref
        )
        return f"flagship-vm-appliance-{self.arch}-{slug}-{self.sha256[:12]}.qcow2"


def _is_count(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def default_root() -> str:
    """$XDG_DATA_HOME/flagship-builder/Appliances. Data, not cache: this is a
    multi-GB download every new server needs, and servers read from it."""
    data_home = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return str(Path(data_home) / "flagship-builder" / "Appliances")


def qcow2_backing_file(path: str) -> Optional[str]:
    """The backing file a qcow2 image names in its header, or None."""
    try:
        with open(path, "rb") as f:
            header = f.read(20)
            if len(header) < 20 or header[:4] != _QCOW2_MAGIC:
                return None
            offset, size = struct.unpack(">QI", header[8:20])
            if offset == 0 or size == 0 or size > 4096:
                return None
            f.seek(offset)
            name = f.read(size)
        return name.decode("utf-8") if len(name) == size else None
    except (OSError, UnicodeDecodeError):
        return None


def backing_files_in_use(disks: Iterable[str]) -> Set[str]:
    """Absolute, normalized backing paths of the given server disks."""
    used: Set[str] = set()
    for disk in disks:
        backing = qcow2_backing_file(disk)
        if backing:
            if not os.path.isabs(backing):
                backing = os.path.join(os.path.dirname(disk), backing)
            used.add(os.path.realpath(backing))
    return used


# fetch(url) -> (body, status); raises OSError when offline.
FetchFn = Callable[[str], Tuple[bytes, int]]
# download(url, sink, cancel) -> status; sink(bytes) receives the body.
DownloadFn = Callable[[str, Callable[[bytes], None], Optional[threading.Event]], int]
# progress(phase, fraction): phase is "download" | "verify" | "ready".
ProgressFn = Callable[[str, Optional[float]], None]


def _live_fetch(url: str) -> Tuple[bytes, int]:
    req = Request(url, headers={"User-Agent": "flagship-builder-linux", "Cache-Control": "no-cache"})
    try:
        with urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https origin
            return resp.read(1 << 20), getattr(resp, "status", 200) or 200
    except HTTPError as e:
        return b"", e.code
    except URLError as e:
        raise OSError(str(e.reason)) from e


def _live_download(url: str, sink: Callable[[bytes], None], cancel: Optional[threading.Event]) -> int:
    req = Request(url, headers={"User-Agent": "flagship-builder-linux"})
    try:
        resp = urlopen(req, timeout=60)  # noqa: S310 - fixed https origin
    except HTTPError as e:
        return e.code
    except URLError as e:
        raise OSError(str(e.reason)) from e
    with resp:
        status = getattr(resp, "status", 200) or 200
        if not 200 <= status <= 299:
            return status
        while True:
            if cancel is not None and cancel.is_set():
                raise ApplianceCacheError("cancelled", tr("Download cancelled."))
            block = resp.read(1 << 20)
            if not block:
                return status
            sink(block)


def _live_free_bytes(path: str) -> Optional[int]:
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return None


class ApplianceCache:
    def __init__(
        self,
        arch: str,
        root: Optional[str] = None,
        origin: str = DEFAULT_ORIGIN,
        fetch: FetchFn = _live_fetch,
        download: DownloadFn = _live_download,
        free_bytes: Callable[[str], Optional[int]] = _live_free_bytes,
        in_use: Callable[[], Set[str]] = lambda: set(),
        log: Callable[[str], None] = lambda _m: None,
    ) -> None:
        self.arch = arch
        self.root = root or default_root()
        self.origin = origin.rstrip("/")
        self._fetch = fetch
        self._download = download
        self._free_bytes = free_bytes
        self._in_use = in_use
        self._log = log

    @property
    def arch_root(self) -> str:
        return os.path.join(self.root, f"appliance-{self.arch}")

    def manifest_url(self) -> str:
        return f"{self.origin}/downloads/FlagshipVMAppliance-{self.arch}.json"

    def ensure(
        self,
        installer_git_ref: str,
        progress: ProgressFn = lambda _p, _f: None,
        cancel: Optional[threading.Event] = None,
    ) -> str:
        """A verified base (qcow2) with its runtime manifest beside it
        (`<base>.json`, the shape the CLI's appliance-provision reads)."""
        try:
            body, status = self._fetch(self.manifest_url())
        except OSError as e:
            cached = self.newest_ready_base(installer_git_ref)
            if cached is not None:
                self._log(f"appliance: offline ({e}); using cached {cached}")
                progress("ready", None)
                return cached
            raise _offline(str(e)) from e
        if status == 404:
            raise _unavailable(self.arch)
        if not 200 <= status <= 299:
            raise _http(status)
        dist = ApplianceDistribution.parse(body)
        if dist.arch != self.arch:
            raise _invalid()
        if dist.installer_git_ref != installer_git_ref:
            raise ApplianceCacheError(
                "ref-mismatch",
                tr('The prebuilt server image is for {0}, but this recipe installs {1}.').format(dist.installer_git_ref, installer_git_ref),
            )

        directory = os.path.join(self.arch_root, dist.sha256[:16])
        base = os.path.join(directory, "base.qcow2")
        if self.is_ready(base, dist.sha256, dist.size_bytes):
            self._log(f"appliance: cached {base} sha256={dist.sha256}")
            self.prune(keep=directory)
            progress("ready", None)
            return base

        os.makedirs(directory, exist_ok=True)
        partial = base + ".partial"
        have = os.path.getsize(partial) if os.path.exists(partial) else 0
        needed = dist.size_bytes - have + _HEADROOM_BYTES
        free = self._free_bytes(directory)
        if free is not None and free < needed:
            raise ApplianceCacheError(
                "insufficient-space",
                tr('Not enough free disk space for the server image: needs {0:.1f} GB, {1:.1f} GB free.').format(needed / 1e9, free / 1e9),
            )

        offset = 0
        with open(partial, "ab"):
            pass
        os.chmod(partial, 0o600)
        for part in dist.parts:
            if _range_sha256(partial, offset, part.size_bytes) == part.sha256:
                offset += part.size_bytes
                continue
            _truncate(partial, offset)
            url = f"{self.origin}/build/iso/{dist.key_prefix}.{part.name}"
            hasher = hashlib.sha256()
            written = [0]
            with open(partial, "ab") as out:

                def sink(block: bytes, out=out, hasher=hasher) -> None:
                    out.write(block)
                    hasher.update(block)
                    written[0] += len(block)
                    progress("download", min(1.0, (offset + written[0]) / dist.size_bytes))

                try:
                    status = self._download(url, sink, cancel)
                except ApplianceCacheError:
                    out.close()
                    _truncate(partial, offset)
                    raise
                except OSError as e:
                    out.close()
                    _truncate(partial, offset)
                    raise _offline(str(e)) from e
            if not 200 <= status <= 299:
                _truncate(partial, offset)
                raise _http(status)
            if written[0] != part.size_bytes or hasher.hexdigest() != part.sha256:
                _truncate(partial, offset)
                raise _checksum(part.name)
            offset += part.size_bytes

        progress("verify", None)
        if _range_sha256(partial, 0, dist.size_bytes) != dist.sha256 or os.path.getsize(partial) != dist.size_bytes:
            _remove(partial)
            raise _checksum("archive")
        os.replace(partial, base)
        os.chmod(base, 0o600)
        runtime = {
            "version": 1,
            "arch": dist.arch,
            "installerGitRef": dist.installer_git_ref,
            "sha256": dist.sha256,
            "sizeBytes": dist.size_bytes,
            "virtualSizeBytes": dist.raw_size_bytes,
        }
        tmp = base + ".json.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(runtime, f)
        os.replace(tmp, base + ".json")
        self.prune(keep=directory)
        self._log(f"appliance: downloaded {base} sha256={dist.sha256}")
        progress("ready", None)
        return base

    # ---- helpers ----

    @staticmethod
    def _runtime(base: str) -> Optional[dict]:
        try:
            with open(base + ".json", "rb") as f:
                d = json.load(f)
            return d if isinstance(d, dict) else None
        except (OSError, ValueError):
            return None

    def is_ready(self, base: str, sha256: str, size: int) -> bool:
        m = self._runtime(base)
        return (
            m is not None
            and m.get("sha256") == sha256
            and os.path.isfile(base)
            and os.path.getsize(base) == size
        )

    def newest_ready_base(self, installer_git_ref: str) -> Optional[str]:
        best: Optional[Tuple[float, str]] = None
        try:
            entries = os.listdir(self.arch_root)
        except OSError:
            return None
        for entry in entries:
            base = os.path.join(self.arch_root, entry, "base.qcow2")
            m = self._runtime(base)
            if (
                m is None
                or m.get("installerGitRef") != installer_git_ref
                or not os.path.isfile(base)
                or os.path.getsize(base) != m.get("sizeBytes")
            ):
                continue
            mtime = os.path.getmtime(base)
            if best is None or mtime > best[0]:
                best = (mtime, base)
        return best[1] if best else None

    def prune(self, keep: str) -> None:
        """Keep one release per arch, plus any older base a server's overlay
        still reads from."""
        try:
            entries = os.listdir(self.arch_root)
        except OSError:
            return
        in_use = self._in_use()
        keep_real = os.path.realpath(keep)
        for entry in entries:
            directory = os.path.join(self.arch_root, entry)
            if os.path.realpath(directory) == keep_real:
                continue
            base = os.path.realpath(os.path.join(directory, "base.qcow2"))
            if base in in_use:
                continue
            shutil.rmtree(directory, ignore_errors=True)
            self._log(f"appliance: removed superseded {directory}")


def _range_sha256(path: str, offset: int, length: int) -> Optional[str]:
    try:
        if os.path.getsize(path) < offset + length:
            return None
        hasher = hashlib.sha256()
        with open(path, "rb") as f:
            f.seek(offset)
            remaining = length
            while remaining:
                block = f.read(min(1 << 20, remaining))
                if not block:
                    return None
                hasher.update(block)
                remaining -= len(block)
        return hasher.hexdigest()
    except OSError:
        return None


def _truncate(path: str, size: int) -> None:
    try:
        with open(path, "r+b") as f:
            f.truncate(size)
    except OSError:
        pass


def _remove(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def is_qcow2(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(4) == _QCOW2_MAGIC
    except OSError:
        return False

