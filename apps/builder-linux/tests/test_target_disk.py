""""Disk to install on" (B2 #9): the field's check is the generator's, pinned by
test-vectors/install-disk-stop.json, and only a USB installer gets --target-disk."""
from __future__ import annotations

import json
from pathlib import Path

from cli_runner import Resolved
from disk_enumerator import DeviceInfo
from wizard import (
    TARGET_DISK_PATTERN,
    WizardModel,
    WizardState,
    normalize_target_disk,
    target_disk_is_valid,
)


def _vectors() -> dict:
    for d in Path(__file__).resolve().parents:
        f = d / "test-vectors" / "install-disk-stop.json"
        if f.exists():
            return json.loads(f.read_text(encoding="utf-8"))
    raise FileNotFoundError("test-vectors/install-disk-stop.json")


def _disk(path: str) -> DeviceInfo:
    return DeviceInfo(
        device_path=path, size_bytes=8_000_000_000, model="Test Stick", bus="USB", mounted=False,
        removable=True, internal=False, verdict="removable-usb", verdict_reason="removable USB device, 8.0GB",
    )


def test_pattern_is_the_generators():
    assert TARGET_DISK_PATTERN.pattern == _vectors()["targetDiskPattern"]


def test_valid_and_invalid_vectors():
    v = _vectors()["targetDisk"]
    for ok in v["valid"]:
        assert target_disk_is_valid(ok), ok
        assert target_disk_is_valid(f"  {ok}\t"), ok
        assert normalize_target_disk(f" {ok} ") == ok
    for bad in v["invalid"]:
        assert not target_disk_is_valid(bad), bad


def test_blank_means_no_option():
    assert target_disk_is_valid("") and target_disk_is_valid("   ") and target_disk_is_valid(None)
    assert normalize_target_disk("  ") is None


def test_an_invalid_disk_blocks_the_burn():
    s = WizardState()
    s.recipe_path = Path("/r.json")
    s.selected_disk = _disk("/dev/sdb")
    assert s.can_flash
    s.target_disk = "/dev/sda"
    assert not s.can_flash
    s.target_disk = " serial:S64ANS0T123456 "
    assert s.can_flash


def _bake_args(tmp_path, target_disk: str) -> list[str]:
    base = tmp_path / "base.iso"
    base.write_bytes(b"iso")
    model = WizardModel(
        locate_fn=lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts"),
        ensure_base_fn=lambda *a, **k: base,
    )
    model.state.recipe_path = tmp_path / "r.json"
    model.state.selected_disk = _disk("/dev/sdb")
    model.set_target_disk(target_disk)
    calls: list = []
    model._run_cli_core = lambda build_args, on_success, use_pkexec=False: calls.append(build_args("/cli.ts"))
    model._run_simple_bake_sync()
    assert len(calls) == 1
    return calls[0]


def test_usb_burn_passes_the_disk_only_when_set(tmp_path):
    args = _bake_args(tmp_path, "  by-id:ata-WDC_WD20_WD-XYZ ")
    i = args.index("--target-disk")
    assert args[i + 1] == "by-id:ata-WDC_WD20_WD-XYZ"
    assert "--target-disk" not in _bake_args(tmp_path, "   ")
