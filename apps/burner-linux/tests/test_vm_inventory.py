"""On-disk inventory round-trips + bundle layout. Name validation itself is
pinned by the shared vectors (test_vm_core_vectors)."""
from __future__ import annotations

import json
import os

import pytest

from vm import resource_plan
from vm.config import VMConfig, VMNetworkMode
from vm.inventory import (
    VMBundleLayout,
    VMInventoryStore,
    VMRecord,
    VMStoreError,
    VMStoreErrorKind,
)
from vm.lifecycle import VMFailurePhase, VMState, VMStateKind
from vm.server_tier import ServerTier


def config(name: str = "home.harry.flagship.services", debug: bool = False) -> VMConfig:
    return VMConfig(
        name=name,
        server_domain=name,
        username="harry",
        server_name=name.split(".")[0],
        cpu_count=2,
        memory_bytes=4 * resource_plan.GIB,
        main_disk_size_bytes=resource_plan.DEFAULT_MAIN_DISK_SIZE_BYTES,
        network_mode=VMNetworkMode.NAT,
        serial_console_enabled=debug,
        boot_unlock_mode="auto",
        disk_encrypted=True,
    )


def record(name: str = "home.harry.flagship.services", state: VMState = None) -> VMRecord:
    return VMRecord(
        config=config(name),
        state=state if state is not None else VMState.created(),
        created_at=1_750_000_000.0,
        tier=ServerTier.HOSTED_VM,
    )


def test_layout_paths(tmp_path):
    layout = VMBundleLayout(str(tmp_path))
    name = "home.harry.flagship.services"
    assert layout.bundle_dir(name) == str(tmp_path / name)
    assert layout.config_path(name).endswith("config.json")
    assert layout.disk_image_path(name).endswith("disk.qcow2")
    assert layout.installer_iso_path(name).endswith("installer.iso")
    assert layout.efi_variable_store_path(name).endswith("efi-vars.fd")
    assert layout.console_log_path(name).endswith("console.log")


def test_default_root_honors_xdg_data_home(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert VMBundleLayout.default_root().root == str(tmp_path / "flagship-burner" / "VMs")


def test_create_load_round_trip(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    store.create(record())
    got = store.load("home.harry.flagship.services")
    assert got == record()


def test_failed_state_round_trips_with_phase_and_reason(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    r = record(state=VMState.failed(VMFailurePhase.RUN, "crashed hard"))
    store.create(r)
    got = store.load(r.config.name)
    assert got.state.kind == VMStateKind.FAILED
    assert got.state.failure.phase == VMFailurePhase.RUN
    assert got.state.failure.reason == "crashed hard"


def test_persisted_json_shape_matches_the_windows_store(tmp_path):
    # camelCase keys + {"kind": …} state — the same shape VMInventoryStore.cs
    # writes, so a future cross-host migration stays trivial.
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    store.create(record())
    raw = json.loads(open(store.layout.config_path("home.harry.flagship.services")).read())
    assert raw["state"] == {"kind": "created"}
    assert raw["tier"] == "hosted-vm"
    assert raw["config"]["serverDomain"] == "home.harry.flagship.services"
    assert raw["config"]["networkMode"] == "nat"
    assert raw["config"]["serialConsoleEnabled"] is False


def test_create_refuses_to_clobber(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    store.create(record())
    with pytest.raises(VMStoreError) as e:
        store.create(record())
    assert e.value.kind == VMStoreErrorKind.ALREADY_EXISTS


def test_create_rejects_invalid_names(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    with pytest.raises(VMStoreError) as e:
        store.create(record(name="Upper.Case"))
    assert e.value.kind == VMStoreErrorKind.INVALID_NAME


def test_save_requires_an_existing_bundle(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    with pytest.raises(VMStoreError) as e:
        store.save(record())
    assert e.value.kind == VMStoreErrorKind.NOT_FOUND


def test_save_updates_state(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    store.create(record())
    store.save(record(state=VMState.stopped()))
    assert store.load("home.harry.flagship.services").state.kind == VMStateKind.STOPPED


def test_list_sorts_and_skips_unreadable(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    store.create(record("b.h.flagship.services"))
    store.create(record("a.h.flagship.services"))
    broken = tmp_path / "c.h.flagship.services"
    broken.mkdir()
    (broken / "config.json").write_text("{not json")
    assert [r.config.name for r in store.list()] == [
        "a.h.flagship.services",
        "b.h.flagship.services",
    ]


def test_list_of_missing_root_is_empty(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path / "nope")))
    assert store.list() == []


def test_delete_removes_the_whole_bundle(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    store.create(record())
    disk = store.layout.disk_image_path("home.harry.flagship.services")
    open(disk, "wb").write(b"x" * 64)
    store.delete("home.harry.flagship.services")
    assert not os.path.exists(store.layout.bundle_dir("home.harry.flagship.services"))
    with pytest.raises(VMStoreError):
        store.delete("home.harry.flagship.services")


def test_write_is_atomic_via_replace(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    store.create(record())
    leftovers = [
        p for p in os.listdir(store.layout.bundle_dir("home.harry.flagship.services"))
        if p.endswith(".tmp")
    ]
    assert leftovers == []
