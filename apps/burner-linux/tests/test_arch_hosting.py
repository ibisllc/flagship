"""Multi-arch hosting seams: host-arch detection, the arch-scoped manifest
request, per-arch base-cache coexistence, and the per-arch QEMU locator.

Mirrors the Mac suite's HostArchTests + per-arch IsoBaseCacheTests: an arm64
Chromebook/SBC hosts a native arm64 guest; burning always stays amd64; the
two cached bases must never evict or shadow each other.
"""
from __future__ import annotations

import json

import pytest

from pathlib import Path

from cli_runner import Resolved
from iso_base_cache import ManifestFetchError, cached_path_for, ensure, inspect_cache
from iso_manifest_client import ManifestResult, fetch_manifest
from vm import host_arch, qemu_command_line, resource_plan
from vm.config import VMConfig, VMNetworkMode
from vm.inventory import VMBundleLayout, VMInventoryStore
from vm.lifecycle import VMStateKind
from vm.manager import VMManager
from vm.qemu_locator import QemuLocatorError, QemuToolchain, locate
from wizard import VerifyInfo, WizardModel


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


# ---- arm64 argv: -machine virt + explicit AHCI (handoff item 1) ----


def _vm_config(arch: str) -> VMConfig:
    return VMConfig(
        name="home.harry.flagship.services",
        server_domain="home.harry.flagship.services",
        username="harry",
        server_name="home",
        cpu_count=2,
        memory_bytes=4 * resource_plan.GIB,
        main_disk_size_bytes=resource_plan.DEFAULT_MAIN_DISK_SIZE_BYTES,
        network_mode=VMNetworkMode.NAT,
        serial_console_enabled=False,
        boot_unlock_mode="auto",
        disk_encrypted=True,
        arch=arch,
    )


_LAYOUT = VMBundleLayout("/data/VMs")


def _argv(arch: str):
    return qemu_command_line.build(
        _vm_config(arch), _LAYOUT, "/fw/code.fd", False, 4444, 4445, 0, "kvm"
    )


def _pairs(args):
    return list(zip(args, args[1:]))


def test_arm64_argv_boots_the_virt_machine():
    assert ("-machine", "virt") in _pairs(_argv("arm64"))


def test_arm64_argv_adds_explicit_ahci_for_metal_identical_sda():
    # virt has no built-in SATA (q35 does): without an explicit AHCI the main
    # disk can't be an ide-hd and the guest loses its metal-identical /dev/sda.
    p = _pairs(_argv("arm64"))
    assert ("-device", "ahci,id=ahci") in p
    assert ("-device", "ide-hd,drive=flagship-main,bus=ahci.0") in p


def test_amd64_argv_is_unchanged_by_the_arch_work():
    p = _pairs(_argv("amd64"))
    assert ("-machine", "q35") in p
    assert ("-device", "ide-hd,drive=flagship-main") in p
    assert not any(a == "ahci,id=ahci" for a in _argv("amd64"))


# ---- cross-arch refusal (handoff item 2) ----


class _FakeHost:
    def __init__(self) -> None:
        self.on_guest_stopped = None
        self.started: list = []
        self.qmp_port = 1
        self.serial_port = 0
        self.ssh_port = 0

    def start(self, cfg, layout, attach) -> None:
        self.started.append((cfg.name, attach))

    def force_stop(self) -> None:
        pass


_TOOLCHAIN = QemuToolchain("/usr/bin/qemu-system-x86_64", "/usr/bin/qemu-img", "/c.fd", "/v.fd")


def _manager(tmp_path, host_arch_tag):
    return VMManager(
        VMInventoryStore(VMBundleLayout(str(tmp_path / "VMs"))),
        _TOOLCHAIN,
        host_factory=_FakeHost,
        unlock_probe=lambda url: False,
        unlock_interval=0.01,
        host_arch_tag=host_arch_tag,
    )


def test_create_server_refuses_a_cross_arch_config(tmp_path):
    vm = _manager(tmp_path, host_arch_tag="amd64")
    with pytest.raises(ValueError) as e:
        vm.create_server(_vm_config("arm64"))
    assert "arm64" in str(e.value) and "amd64" in str(e.value)
    assert vm.servers == []


def test_starting_a_foreign_arch_bundle_is_refused_with_an_honest_log(tmp_path):
    # The bundle store travels with the home dir — a backup restored onto a
    # different-arch machine must refuse to start, not crawl under TCG.
    vm = _manager(tmp_path, host_arch_tag="arm64")
    vm.create_server(_vm_config("arm64"))
    logs: list[str] = []
    vm.log = logs.append
    vm.host_arch_tag = "amd64"
    host = vm._hosts.get("home.harry.flagship.services")
    vm.begin_install("home.harry.flagship.services")
    (s,) = vm.servers
    assert s.record.state.kind == VMStateKind.CREATED
    assert host is None or host.started == []
    assert any("can't run here" in m for m in logs)


# ---- wizard arch pass-through (handoff item 3) ----


def test_host_here_passes_the_host_arch_into_plan_and_base_fetch(tmp_path, monkeypatch):
    vm = _manager(tmp_path, host_arch_tag="arm64")
    base = tmp_path / "base-arm64.iso"
    base.write_bytes(b"iso")
    captured: dict = {}

    def fake_ensure(burner_version, **kw):
        captured["arch"] = kw.get("arch")
        return base

    m = WizardModel(
        locate_fn=lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts"),
        vm_manager=vm,
        ensure_base_fn=fake_ensure,
        handoff_seconds=0,
    )
    recipe = tmp_path / "r.json"
    recipe.write_text(json.dumps({
        "version": 2,
        "serverDomain": "home.harry.flagship.services",
        "username": "harry",
        "serverName": "home",
    }))
    m.state.recipe_path = recipe
    m.state.verified = VerifyInfo(ok=True, server_domain="home.harry.flagship.services")

    def fake_run_cli(build_args, on_success, use_pkexec=False):
        Path(vm.installer_iso_path("home.harry.flagship.services")).write_bytes(b"remastered")
        on_success("")

    monkeypatch.setattr(m, "_run_cli_core", fake_run_cli)
    m._run_host_here_sync()

    assert captured["arch"] == "arm64"
    (s,) = vm.servers
    assert s.record.config.arch == "arm64"
