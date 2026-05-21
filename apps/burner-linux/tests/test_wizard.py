"""Unit tests for the GUI-agnostic parts of wizard — WizardState helpers,
stage_pasted_recipe, derive_out_iso_path, and the WizardModel state
machine (no GTK required)."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

import pytest

from cli_runner import Resolved
from disk_enumerator import DeviceInfo
from wizard import (
    VerifyInfo,
    WizardModel,
    WizardState,
    derive_out_iso_path,
    stage_pasted_recipe,
)


# ---- pure helpers ----


def test_stage_pasted_recipe_writes_to_temp(tmp_path):
    out = stage_pasted_recipe('{"a": 1}', tmp_dir=tmp_path)
    assert out.exists()
    assert out.read_text() == '{"a": 1}'
    mode = oct(out.stat().st_mode)[-3:]
    assert mode == "600"


def test_stage_pasted_recipe_strips_whitespace(tmp_path):
    out = stage_pasted_recipe('   {"a":1}\n\n', tmp_dir=tmp_path)
    assert out.read_text() == '{"a":1}'


def test_stage_pasted_recipe_rejects_empty(tmp_path):
    with pytest.raises(ValueError):
        stage_pasted_recipe("   \n\t", tmp_dir=tmp_path)


def test_derive_out_iso_path_keeps_stem():
    inp = Path("/srv/ubuntu-22.04.5-live-server-amd64.iso")
    out = derive_out_iso_path(inp)
    assert out.name == "ubuntu-22.04.5-live-server-amd64.flagship.iso"
    assert out.parent == inp.parent


# ---- WizardState ----


def test_wizard_state_can_flash_requires_all_three():
    s = WizardState()
    assert s.can_flash is False
    s.recipe_path = Path("/r.json")
    assert s.can_flash is False
    s.iso_path = Path("/iso.iso")
    assert s.can_flash is False
    s.selected_disk = _make_disk("/dev/sdb")
    assert s.can_flash is True


def test_wizard_state_readiness_summary_lists_missing():
    s = WizardState()
    assert "recipe" in s.readiness_summary
    assert "ISO" in s.readiness_summary
    assert "USB drive" in s.readiness_summary


def test_wizard_state_readiness_summary_ready():
    s = WizardState(
        recipe_path=Path("/r.json"),
        iso_path=Path("/ubuntu-22.04.iso"),
        selected_disk=_make_disk("/dev/sdb"),
    )
    summary = s.readiness_summary
    assert summary.startswith("Ready:")
    assert "ubuntu-22.04.iso" in summary
    assert "/dev/sdb" in summary


# ---- VerifyInfo.from_dict ----


def test_verify_info_from_dict_minimal():
    v = VerifyInfo.from_dict({"ok": True, "serverDomain": "alice.flagship.services"})
    assert v.ok is True
    assert v.server_domain == "alice.flagship.services"
    assert v.username is None


def test_verify_info_from_dict_full():
    v = VerifyInfo.from_dict({
        "ok": True,
        "serverDomain": "alice.flagship.services",
        "username": "alice",
        "serverName": "home",
        "expiresAt": "2026-06-01T00:00:00.000Z",
        "installerGitRef": "abc123",
        "signatureValid": True,
    })
    assert v.username == "alice"
    assert v.expires_at == "2026-06-01T00:00:00.000Z"
    assert v.signature_valid is True


# ---- WizardModel ----


def test_wizard_model_accept_iso_updates_state():
    model = _model_with_fake_locate(node="/usr/bin/node", entry="/cli.ts")
    model.accept_iso_file(Path("/ubuntu.iso"))
    assert model.state.iso_path == Path("/ubuntu.iso")


def test_wizard_model_select_disk_picks_matching():
    model = _model_with_fake_locate(node="/usr/bin/node", entry="/cli.ts")
    d1 = _make_disk("/dev/sdb")
    d2 = _make_disk("/dev/sdc")
    model.state.disks = [d1, d2]
    model.select_disk("/dev/sdc")
    assert model.state.selected_disk == d2


def test_wizard_model_select_disk_ignores_unknown():
    model = _model_with_fake_locate(node="/usr/bin/node", entry="/cli.ts")
    model.state.disks = [_make_disk("/dev/sdb")]
    model.select_disk("/dev/sdz")
    assert model.state.selected_disk is None


def test_wizard_model_clear_log_resets():
    model = _model_with_fake_locate(node="/usr/bin/node", entry="/cli.ts")
    model._append_log("stdout", "hello")  # type: ignore[attr-defined]
    assert len(model.state.log_lines) == 1
    model.clear_log()
    assert model.state.log_lines == []


def test_wizard_model_refresh_disks_filters_to_safe(tmp_path):
    fake_lsblk = lambda: json.dumps({
        "blockdevices": [
            {"name": "sda", "size": 256_060_514_304, "type": "disk",
             "rm": False, "tran": "sata"},
            {"name": "sdb", "size": 8_000_000_000, "type": "disk",
             "rm": True, "tran": "usb"},
        ]
    })
    locate_fn = lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts")
    model = WizardModel(run_lsblk=fake_lsblk, locate_fn=locate_fn)
    model._refresh_disks_sync()  # sync flavor; runs on calling thread.
    assert len(model.state.disks) == 1
    assert model.state.disks[0].device_path == "/dev/sdb"


def test_wizard_model_pasted_recipe_error_surfaces():
    model = _model_with_fake_locate(node="/usr/bin/node", entry="/cli.ts")
    model.accept_recipe_text("   \n\t")
    assert model.state.recipe_error == "Pasted recipe was empty."
    assert model.state.recipe_path is None


def test_wizard_model_on_change_fires_on_state_mutation():
    fired: list[int] = []
    locate_fn = lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts")
    model = WizardModel(on_change=lambda: fired.append(1), locate_fn=locate_fn)
    model.state.disks = [_make_disk("/dev/sdb")]
    model.select_disk("/dev/sdb")
    assert sum(fired) >= 1


# ---- helpers ----


def _make_disk(device_path: str) -> DeviceInfo:
    return DeviceInfo(
        device_path=device_path,
        size_bytes=8_000_000_000,
        model="Test Stick",
        bus="USB",
        mounted=False,
        removable=True,
        internal=False,
        verdict="removable-usb",
        verdict_reason="removable USB device, 8.0GB",
    )


def _model_with_fake_locate(node: str, entry: str) -> WizardModel:
    locate_fn = lambda: Resolved(node_path=node, entry_path=entry)
    return WizardModel(locate_fn=locate_fn)
