"""The published-appliance cache: download + per-part and whole-archive
verification, cache reuse, offline reuse, installer fallback, disk-space
refusal, and pruning that never deletes a base a server still reads from.
Mirrors apps/builder-mac ApplianceCacheTests.swift. No network: fetch and
download are fakes."""
from __future__ import annotations

import hashlib
import json
import os
import struct
from pathlib import Path

import pytest

from vm.appliance_cache import (
    ApplianceCache,
    ApplianceCacheError,
    ApplianceDistribution,
    backing_files_in_use,
    qcow2_backing_file,
)

REPO = Path(__file__).resolve().parents[3]
PART_A = b"QFI\xfb" + b"a" * 1000
PART_B = b"b" * 777


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def manifest(ref: str = "main", arch: str = "amd64") -> bytes:
    whole = PART_A + PART_B
    return json.dumps({
        "version": 1, "arch": arch, "installerGitRef": ref, "format": "qcow2",
        "sha256": sha(whole), "sizeBytes": len(whole),
        "parts": [
            {"name": "part-00", "sizeBytes": len(PART_A), "sha256": sha(PART_A)},
            {"name": "part-01", "sizeBytes": len(PART_B), "sha256": sha(PART_B)},
        ],
        "rawSha256": "0" * 64, "rawSizeBytes": 8 * 1024 ** 3,
    }).encode()


class Fakes:
    def __init__(self, body=None, status=200, corrupt=None, offline=False, free=None):
        self.body = manifest() if body is None else body
        self.status = status
        self.corrupt = corrupt
        self.offline = offline
        self.free = free
        self.downloads: list[str] = []

    def fetch(self, url):
        if self.offline:
            raise OSError("network unreachable")
        return self.body, self.status

    def download(self, url, sink, cancel):
        self.downloads.append(url)
        name = url.rsplit(".", 1)[-1]
        data = {"part-00": PART_A, "part-01": PART_B}.get(name)
        if data is None:
            return 404
        if name == self.corrupt:
            data = bytes([data[0] ^ 0xFF]) + data[1:]
        sink(data[:100])
        sink(data[100:])
        return 200


def cache(tmp_path, fakes: Fakes, in_use=lambda: set()) -> ApplianceCache:
    return ApplianceCache(
        "amd64", root=str(tmp_path / "Appliances"), origin="https://example.test",
        fetch=fakes.fetch, download=fakes.download, free_bytes=lambda _p: fakes.free,
        in_use=in_use,
    )


def test_downloads_verifies_and_serves_from_cache(tmp_path):
    fakes = Fakes()
    phases = []
    base = cache(tmp_path, fakes).ensure("main", progress=lambda p, f: phases.append(p))
    assert Path(base).read_bytes() == PART_A + PART_B
    assert oct(os.stat(base).st_mode & 0o777) == "0o600"
    runtime = json.loads(Path(base + ".json").read_text())
    assert runtime == {
        "version": 1, "arch": "amd64", "installerGitRef": "main",
        "sha256": sha(PART_A + PART_B), "sizeBytes": len(PART_A + PART_B),
        "virtualSizeBytes": 8 * 1024 ** 3,
    }
    dist = ApplianceDistribution.parse(manifest())
    assert fakes.downloads == [
        f"https://example.test/build/iso/{dist.key_prefix}.part-00",
        f"https://example.test/build/iso/{dist.key_prefix}.part-01",
    ]
    assert phases[0] == "download" and "verify" in phases and phases[-1] == "ready"
    assert not os.path.exists(base + ".partial")

    again = cache(tmp_path, fakes).ensure("main")
    assert again == base
    assert len(fakes.downloads) == 2, "a cached base is not downloaded again"


def test_uses_the_cached_base_when_offline(tmp_path):
    base = cache(tmp_path, Fakes()).ensure("main")
    assert cache(tmp_path, Fakes(offline=True)).ensure("main") == base
    with pytest.raises(ApplianceCacheError) as e:
        cache(tmp_path, Fakes(offline=True)).ensure("release-2")
    assert e.value.kind == "offline" and not e.value.falls_back_to_installer


def test_refuses_a_corrupt_part_and_keeps_the_verified_one_for_the_retry(tmp_path):
    with pytest.raises(ApplianceCacheError) as e:
        cache(tmp_path, Fakes(corrupt="part-01")).ensure("main")
    assert e.value.kind == "checksum" and "part-01" in str(e.value)
    assert not e.value.falls_back_to_installer
    retry = Fakes()
    cache(tmp_path, retry).ensure("main")
    assert [u.rsplit(".", 1)[-1] for u in retry.downloads] == ["part-01"]


def test_falls_back_when_nothing_is_published_or_the_ref_differs(tmp_path):
    for fakes, kind in (
        (Fakes(body=b"", status=404), "unavailable"),
        (Fakes(body=manifest(ref="release-1")), "ref-mismatch"),
        (Fakes(body=b"{not json"), "invalid-manifest"),
        (Fakes(body=manifest(arch="arm64")), "invalid-manifest"),
    ):
        with pytest.raises(ApplianceCacheError) as e:
            cache(tmp_path, fakes).ensure("main")
        assert e.value.kind == kind
        assert e.value.falls_back_to_installer
        assert fakes.downloads == []


def test_stops_before_downloading_when_the_disk_is_too_full(tmp_path):
    fakes = Fakes(free=1000)
    with pytest.raises(ApplianceCacheError) as e:
        cache(tmp_path, fakes).ensure("main")
    assert e.value.kind == "insufficient-space"
    assert fakes.downloads == []


def test_server_errors_surface_without_falling_back(tmp_path):
    with pytest.raises(ApplianceCacheError) as e:
        cache(tmp_path, Fakes(body=b"", status=503)).ensure("main")
    assert e.value.kind == "http-status" and not e.value.falls_back_to_installer


def test_a_new_release_prunes_the_old_base_unless_a_server_reads_from_it(tmp_path):
    old = cache(tmp_path, Fakes()).ensure("main")
    old_dir = os.path.dirname(old)
    # Pretend the published release moved on: a stale sibling base appears.
    stale = os.path.join(os.path.dirname(old_dir), "0" * 16)
    os.makedirs(stale)
    Path(stale, "base.qcow2").write_bytes(b"old")
    in_use = {os.path.realpath(os.path.join(stale, "base.qcow2"))}
    cache(tmp_path, Fakes(), in_use=lambda: in_use).ensure("main")
    assert os.path.exists(stale), "a base a server still reads from is kept"
    cache(tmp_path, Fakes()).ensure("main")
    assert not os.path.exists(stale)
    assert os.path.exists(old)


def test_key_prefix_matches_the_factory_workflow():
    dist = ApplianceDistribution.parse(manifest(ref="feat/x y"))
    assert dist.key_prefix == f"flagship-vm-appliance-amd64-feat-x-y-{dist.sha256[:12]}.qcow2"


@pytest.mark.parametrize("arch", ["amd64", "arm64"])
def test_published_manifests_parse(arch):
    path = REPO / "apps" / "web" / "public" / "downloads" / f"FlagshipVMAppliance-{arch}.json"
    dist = ApplianceDistribution.parse(path.read_bytes())
    assert dist.arch == arch


def _qcow2_with_backing(path: Path, backing: str) -> None:
    name = backing.encode()
    header = b"QFI\xfb" + struct.pack(">I", 3) + struct.pack(">QI", 512, len(name))
    path.write_bytes(header + b"\0" * (512 - len(header)) + name)


def test_reads_the_backing_file_a_server_disk_names(tmp_path):
    disk = tmp_path / "disk.qcow2"
    _qcow2_with_backing(disk, "/data/Appliances/appliance-amd64/abc/base.qcow2")
    assert qcow2_backing_file(str(disk)) == "/data/Appliances/appliance-amd64/abc/base.qcow2"
    plain = tmp_path / "plain.qcow2"
    plain.write_bytes(b"QFI\xfb" + struct.pack(">I", 3) + struct.pack(">QI", 0, 0) + b"\0" * 100)
    assert qcow2_backing_file(str(plain)) is None
    assert qcow2_backing_file(str(tmp_path / "missing")) is None
    raw = tmp_path / "raw.img"
    raw.write_bytes(b"\0" * 64)
    assert qcow2_backing_file(str(raw)) is None
    assert backing_files_in_use([str(disk), str(plain), str(raw)]) == {
        os.path.realpath("/data/Appliances/appliance-amd64/abc/base.qcow2")
    }
