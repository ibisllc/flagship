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

from cli_runner import CLILocateError, Resolved
from disk_enumerator import DeviceInfo
from wizard import (
    MODE_ADVANCED,
    MODE_SIMPLE,
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


def test_wizard_state_can_flash_requires_all_three_advanced():
    s = WizardState(mode=MODE_ADVANCED)
    assert s.can_flash is False
    s.recipe_path = Path("/r.json")
    assert s.can_flash is False
    s.iso_path = Path("/iso.iso")
    assert s.can_flash is False
    s.selected_disk = _make_disk("/dev/sdb")
    assert s.can_flash is True


def test_wizard_state_can_flash_simple_no_user_iso():
    # Simple mode (the default) needs only recipe + USB — the base ISO comes
    # from the server manifest, not the user.
    s = WizardState()
    assert s.mode == MODE_SIMPLE
    assert s.requires_user_iso is False
    s.recipe_path = Path("/r.json")
    assert s.can_flash is False
    s.selected_disk = _make_disk("/dev/sdb")
    assert s.can_flash is True


def test_wizard_state_readiness_summary_lists_missing():
    s = WizardState(mode=MODE_ADVANCED)
    assert "recipe" in s.readiness_summary
    assert "ISO" in s.readiness_summary
    assert "USB drive" in s.readiness_summary


def test_wizard_state_readiness_summary_simple_omits_iso():
    s = WizardState()  # Simple default
    summary = s.readiness_summary
    assert "recipe" in summary
    assert "ISO" not in summary
    assert "USB drive" in summary


def test_wizard_state_readiness_summary_ready():
    s = WizardState(
        mode=MODE_ADVANCED,
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


def test_wizard_model_set_mode_switches():
    model = _model_with_fake_locate(node="/usr/bin/node", entry="/cli.ts")
    assert model.state.mode == MODE_SIMPLE
    model.set_mode(MODE_ADVANCED)
    assert model.state.mode == MODE_ADVANCED
    model.set_mode(MODE_SIMPLE)
    assert model.state.mode == MODE_SIMPLE


def test_wizard_model_set_mode_ignores_unknown():
    model = _model_with_fake_locate(node="/usr/bin/node", entry="/cli.ts")
    model.set_mode("bogus")
    assert model.state.mode == MODE_SIMPLE


def test_simple_bake_ensures_base_then_runs_cli_with_that_iso(tmp_path):
    # Simple mode: the base ISO returned by ensure_base must be the ISO the
    # Node-CLI write path receives (same engine as Advanced).
    base = tmp_path / "flagship-base-debian-12.iso"
    base.write_bytes(b"iso")

    captured: dict = {}

    def fake_ensure(builder_version, progress=None, on_download_start=None, log=None, **kw):
        captured["builder_version"] = builder_version
        captured["is_running_during_download"] = _running_holder[0].state.is_running
        if log:
            log(f"cached base {base} sha256=deadbeef")
        return base

    locate_fn = lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts")
    model = WizardModel(locate_fn=locate_fn, ensure_base_fn=fake_ensure)
    _running_holder = [model]
    model.state.recipe_path = tmp_path / "r.json"
    model.state.selected_disk = _make_disk("/dev/sdb")

    cli_calls: list = []
    model._run_cli_core = (
        lambda build_args, on_success, use_pkexec=False: cli_calls.append(
            (build_args("/cli.ts"), use_pkexec)
        )
    )

    model._run_simple_bake_sync()

    assert captured["builder_version"]  # forwarded the builder version
    # The model owns is_running for the WHOLE pipeline, download included —
    # the Wizard.cs parity fix (progress/Cancel live from the first byte).
    assert captured["is_running_during_download"] is True
    assert model.state.base_iso_path == base
    assert len(cli_calls) == 1
    args, use_pkexec = cli_calls[0]
    assert args[:2] == ["/cli.ts", "write"]
    assert str(base) in args
    assert use_pkexec is True
    assert model.state.is_running is False  # released at the end


def test_simple_bake_refuses_reentry_while_running(tmp_path):
    locate_fn = lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts")
    model = WizardModel(
        locate_fn=locate_fn,
        ensure_base_fn=lambda *a, **k: pytest.fail("must not fetch while running"),
    )
    model.state.recipe_path = tmp_path / "r.json"
    model.state.selected_disk = _make_disk("/dev/sdb")
    model.state.is_running = True
    model._run_simple_bake_sync()  # no-op, no fetch, no CLI


def test_simple_bake_surfaces_cache_error(tmp_path):
    import iso_base_cache

    def boom(builder_version, progress=None, on_download_start=None, log=None, **kw):
        raise iso_base_cache.OfflineError("no net")

    locate_fn = lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts")
    model = WizardModel(locate_fn=locate_fn, ensure_base_fn=boom)
    model.state.recipe_path = tmp_path / "r.json"
    model.state.selected_disk = _make_disk("/dev/sdb")
    model._run_cli_core = lambda *a, **k: pytest.fail(
        "CLI must not run when base fetch fails"
    )

    model._run_simple_bake_sync()

    assert any(ll.stream == "stderr" for ll in model.state.log_lines)
    assert model.state.phase is None
    assert model.state.is_running is False


def test_cancel_trips_the_download_cancel_event(tmp_path):
    import iso_base_cache

    seen: dict = {}

    def fake_ensure(builder_version, cancel_event=None, **kw):
        # The wizard hands its cancel event to the cache; cancel() trips it
        # mid-download, and the cache raises CancelledError.
        seen["event"] = cancel_event
        _model_holder[0].cancel()
        assert cancel_event.is_set()
        raise iso_base_cache.CancelledError()

    locate_fn = lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts")
    model = WizardModel(locate_fn=locate_fn, ensure_base_fn=fake_ensure)
    _model_holder = [model]
    model.state.recipe_path = tmp_path / "r.json"
    model.state.selected_disk = _make_disk("/dev/sdb")
    model._run_cli_core = lambda *a, **k: pytest.fail("CLI must not run after cancel")

    model._run_simple_bake_sync()

    assert seen["event"] is not None
    assert any("cancelled" in ll.text for ll in model.state.log_lines)
    assert model.state.is_running is False
    assert model._cancel_download is None  # cleared for the next run


def test_run_cli_with_pkexec_fails_up_front_when_nothing_can_elevate():
    import elevation

    locate_fn = lambda: pytest.fail("locate must not run — elevation check comes first")
    model = WizardModel(locate_fn=locate_fn, probe_elevation=lambda: None)
    model._run_cli(
        build_args=lambda entry: [entry],
        on_success=lambda _out: pytest.fail("must not succeed"),
        use_pkexec=True,
    )
    errs = [ll.text for ll in model.state.log_lines if ll.stream == "stderr"]
    assert elevation.MISSING_MESSAGE in errs
    assert model.state.is_running is False


def test_run_cli_without_pkexec_skips_the_elevation_check():
    locate_calls: list[int] = []

    def locate_fn():
        locate_calls.append(1)
        raise CLILocateError("stop here")

    model = WizardModel(locate_fn=locate_fn, probe_elevation=lambda: None)
    model._run_cli(
        build_args=lambda entry: [entry],
        on_success=lambda _out: pytest.fail("must not succeed"),
    )
    assert locate_calls == [1]


def test_run_cli_logs_the_sudo_fallback_when_pkexec_is_absent():
    import elevation

    def locate_fn():
        raise CLILocateError("stop after the elevation step")

    model = WizardModel(
        locate_fn=locate_fn,
        probe_elevation=lambda: elevation.Elevation(["sudo", "-n"], "passwordless sudo"),
    )
    model._run_cli(
        build_args=lambda entry: [entry],
        on_success=lambda _out: pytest.fail("must not succeed"),
        use_pkexec=True,
    )
    outs = [ll.text for ll in model.state.log_lines if ll.stream == "stdout"]
    assert any("passwordless sudo" in t for t in outs)


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
