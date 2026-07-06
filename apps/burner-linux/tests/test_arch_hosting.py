"""Multi-arch hosting seams: host-arch detection, the arch-scoped manifest
request, per-arch base-cache coexistence, and the per-arch QEMU locator.

Mirrors the Mac suite's HostArchTests + per-arch IsoBaseCacheTests: an arm64
Chromebook/SBC hosts a native arm64 guest; burning always stays amd64; the
two cached bases must never evict or shadow each other.
"""
from __future__ import annotations

import json

import pytest

from iso_base_cache import ManifestFetchError, cached_path_for, ensure, inspect_cache
from iso_manifest_client import ManifestResult, fetch_manifest
from vm import host_arch
from vm.qemu_locator import QemuLocatorError, locate


# ---- host arch mapping ----


@pytest.mark.parametrize(
    "machine,expected",
    [
        ("x86_64", "amd64"),
        ("amd64", "amd64"),
        ("AMD64", "amd64"),
        ("aarch64", "arm64"),
        ("arm64", "arm64"),
        ("riscv64", None),
        ("armv7l", None),
    ],
)
def test_host_arch_mapping(machine, expected):
    assert host_arch.current(machine=machine) == expected


# ---- manifest request arch encoding ----


class _FakeResponse:
    def __init__(self, body: dict) -> None:
        self._body = json.dumps(body).encode("utf-8")
        self.status = 200
        self.headers = {}

    def read(self):
        b, self._body = self._body, b""
        return b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _capturing_opener(capture: dict):
    def opener(req):
        capture["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse({"download": None})

    return opener


def test_manifest_request_omits_arch_for_amd64():
    """The burn path must stay byte-identical to the pre-arch wire format."""
    cap: dict = {}
    fetch_manifest("1.0.0", None, opener=_capturing_opener(cap))
    assert "arch" not in cap["body"]
    cap = {}
    fetch_manifest("1.0.0", None, arch="amd64", opener=_capturing_opener(cap))
    assert "arch" not in cap["body"]


def test_manifest_request_carries_arm64():
    cap: dict = {}
    fetch_manifest("1.0.0", None, arch="arm64", opener=_capturing_opener(cap))
    assert cap["body"]["arch"] == "arm64"


# ---- per-arch cache coexistence ----


def _write_cache(tmp_path, monkeypatch, name: str, data: bytes = b"iso") -> None:
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    d = tmp_path / "flagship-burner"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(data)


def test_arch_scoped_paths_differ():
    amd = cached_path_for("debian-13.5.0", "amd64")
    arm = cached_path_for("debian-13.5.0", "arm64")
    assert amd != arm
    assert amd.name == "flagship-base-debian-13.5.0.iso"
    assert arm.name == "flagship-base-arm64-debian-13.5.0.iso"


def test_amd64_inspect_ignores_arm64_entry(tmp_path, monkeypatch):
    _write_cache(tmp_path, monkeypatch, "flagship-base-arm64-debian-13.5.0.iso")
    assert inspect_cache(arch="amd64") is None
    got = inspect_cache(arch="arm64")
    assert got is not None and got.version == "debian-13.5.0"


def test_arm64_inspect_ignores_amd64_entry(tmp_path, monkeypatch):
    _write_cache(tmp_path, monkeypatch, "flagship-base-debian-13.5.0.iso")
    assert inspect_cache(arch="arm64") is None
    got = inspect_cache(arch="amd64")
    assert got is not None and got.version == "debian-13.5.0"


def test_arm64_unblessed_is_honest_not_up_to_date(tmp_path, monkeypatch):
    """No arm64 manifest + nothing cached must say 'hosting unavailable — use
    Advanced mode', never 'up to date'."""
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    with pytest.raises(ManifestFetchError) as e:
        ensure(
            "1.0.0",
            manifest_fn=lambda v, c, arch="amd64": ManifestResult(download=None),
            arch="arm64",
        )
    assert "arm64" in str(e.value)
    assert "Advanced mode" in str(e.value)


def test_arm64_ensure_keeps_its_own_cache(tmp_path, monkeypatch):
    _write_cache(tmp_path, monkeypatch, "flagship-base-arm64-debian-13.5.0.iso")
    seen: dict = {}

    def fake_manifest(v, c, arch="amd64"):
        seen["arch"] = arch
        seen["current"] = c
        return ManifestResult(download=None)

    out = ensure("1.0.0", manifest_fn=fake_manifest, arch="arm64")
    assert out.name == "flagship-base-arm64-debian-13.5.0.iso"
    assert seen["arch"] == "arm64"
    assert seen["current"] is not None


# ---- per-arch QEMU locator ----


def _fake_fs(present: dict):
    def which(name):
        return present.get(name)

    def exists(path):
        return path in present.values() or path in present.get("_paths", [])

    return which, exists


def test_locator_arm64_finds_aarch64_toolchain():
    paths = [
        "/usr/share/AAVMF/AAVMF_CODE.fd",
        "/usr/share/AAVMF/AAVMF_VARS.fd",
    ]
    present = {
        "qemu-system-aarch64": "/usr/bin/qemu-system-aarch64",
        "qemu-img": "/usr/bin/qemu-img",
        "_paths": paths,
    }
    which, exists = _fake_fs(present)
    tc = locate(env={}, which=which, exists=exists, arch="arm64")
    assert tc.system_binary.endswith("qemu-system-aarch64")
    assert tc.uefi_code_path == paths[0]
    assert tc.uefi_vars_template == paths[1]


def test_locator_arm64_missing_qemu_names_the_right_packages():
    which, exists = _fake_fs({})
    with pytest.raises(QemuLocatorError) as e:
        locate(env={}, which=which, exists=exists, arch="arm64")
    assert "qemu-system-aarch64" in str(e.value)
    assert "qemu-system-arm" in str(e.value)


def test_locator_unknown_arch_is_refused():
    which, exists = _fake_fs({})
    with pytest.raises(QemuLocatorError) as e:
        locate(env={}, which=which, exists=exists, arch="riscv64")
    assert "riscv64" in str(e.value)


def test_locator_amd64_default_unchanged():
    paths = [
        "/usr/share/OVMF/OVMF_CODE_4M.fd",
        "/usr/share/OVMF/OVMF_VARS_4M.fd",
    ]
    present = {
        "qemu-system-x86_64": "/usr/bin/qemu-system-x86_64",
        "qemu-img": "/usr/bin/qemu-img",
        "_paths": paths,
    }
    which, exists = _fake_fs(present)
    tc = locate(env={}, which=which, exists=exists)
    assert tc.system_binary.endswith("qemu-system-x86_64")
    assert tc.uefi_code_path == paths[0]
