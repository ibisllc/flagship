"""Quick-mode flow tests — the Alpine pipeline wired into WizardModel + the
pkexec flasher + the disk_write final-block padding. No network / no root: the
cache + personalize + flasher seams are injected.

Mirrors the Mac WizardModel quick-path behaviour (download → personalize →
write phases, base_download_started banner) without driving GTK."""
from __future__ import annotations

import struct
from pathlib import Path

import pytest

import alpine_personalize as ap
import disk_write
from cli_runner import Resolved
from disk_enumerator import DeviceInfo
from wizard import (
    MODE_ADVANCED,
    MODE_QUICK,
    PkexecFlasher,
    WizardModel,
    WizardState,
    locate_flasher,
)


# ---- mode-aware WizardState ----


def test_quick_state_can_flash_without_iso():
    s = WizardState(mode=MODE_QUICK)
    assert s.can_flash is False
    s.recipe_path = Path("/r.json")
    assert s.can_flash is False  # still needs a disk
    s.selected_disk = _disk("/dev/sdb")
    assert s.can_flash is True  # no ISO required in quick mode


def test_advanced_state_still_requires_iso():
    s = WizardState(mode=MODE_ADVANCED)
    s.recipe_path = Path("/r.json")
    s.selected_disk = _disk("/dev/sdb")
    assert s.can_flash is False
    s.iso_path = Path("/u.iso")
    assert s.can_flash is True


def test_quick_readiness_summary_omits_iso():
    s = WizardState(mode=MODE_QUICK)
    summary = s.readiness_summary
    assert "ISO" not in summary
    assert "recipe" in summary and "USB drive" in summary


def test_phase_label_maps_phases():
    s = WizardState()
    s.phase = "download"
    assert "download" in s.phase_label.lower()
    s.phase = "write"
    assert "Writing" in s.phase_label
    s.phase = None
    assert s.phase_label is None


# ---- control-line parsing (mirrors handleControlLine) ----


def test_handle_control_line_progress_and_phase():
    m = _model()
    assert m._handle_control_line("FLAGSHIP_PROGRESS:0.42") is True
    assert m.state.progress == pytest.approx(0.42)
    assert m._handle_control_line("FLAGSHIP_PHASE:write") is True
    assert m.state.phase == "write"
    assert m.state.progress == 0.0
    assert m._handle_control_line("just a log line") is False


# ---- quick bake pipeline (injected seams) ----


def test_quick_bake_runs_download_personalize_write(tmp_path):
    recipe_file = tmp_path / "r.json"
    recipe_file.write_text("{}")  # parse_recipe is stubbed below

    base = tmp_path / "base.iso"
    base.write_bytes(b"BASE")

    events: list[str] = []

    def ensure(progress, on_download_start):
        on_download_start()
        progress(0.5)
        progress(1.0)
        events.append("ensure")
        return base

    def personalize(base_path, recipe, out_path):
        events.append("personalize")
        Path(out_path).write_bytes(b"PREPARED")
        return 8

    captured = {}

    class FakeFlasher:
        def __init__(self, image_path, device_path):
            captured["image"] = image_path
            captured["device"] = device_path

        command_string = "pkexec python3 disk_write.py img dev"

        def start(self, on_line, on_control):
            on_control("FLAGSHIP_PHASE:write")
            on_control("FLAGSHIP_PROGRESS:1.0")
            events.append("flash")

        def wait(self):
            return 0

        def terminate(self):
            pass

    m = WizardModel(
        mode=MODE_QUICK,
        locate_fn=lambda: Resolved("/usr/bin/node", "/cli.ts"),
        ensure_base_fn=ensure,
        personalize_fn=personalize,
        flasher_factory=lambda image, device: FakeFlasher(image, device),
    )
    # Stub recipe parsing so we don't need a full signed recipe.
    sample = _sample_recipe()
    _orig = ap.parse_recipe
    ap.parse_recipe = lambda *_a, **_k: sample
    try:
        m.state.recipe_path = recipe_file
        m.state.selected_disk = _disk("/dev/sdb")
        m._run_quick_bake_sync()
    finally:
        ap.parse_recipe = _orig

    assert events == ["ensure", "personalize", "flash"]
    assert m.state.is_finished is True
    assert m.state.base_download_started is True
    assert captured["device"] == "/dev/sdb"
    # the prepared temp file is cleaned up
    assert "image" in captured and not Path(captured["image"]).exists()


def test_quick_bake_surfaces_cache_error(tmp_path):
    import base_iso_cache

    recipe_file = tmp_path / "r.json"
    recipe_file.write_text("{}")

    def ensure(progress, on_download_start):
        raise base_iso_cache.OfflineError("no route to host")

    m = WizardModel(
        mode=MODE_QUICK,
        ensure_base_fn=ensure,
        locate_fn=lambda: Resolved("/usr/bin/node", "/cli.ts"),
    )
    sample = _sample_recipe()
    _orig = ap.parse_recipe
    ap.parse_recipe = lambda *_a, **_k: sample
    try:
        m.state.recipe_path = recipe_file
        m.state.selected_disk = _disk("/dev/sdb")
        m._run_quick_bake_sync()
    finally:
        ap.parse_recipe = _orig

    assert m.state.is_finished is False
    errs = [ll.text for ll in m.state.log_lines if ll.stream == "stderr"]
    assert any("internet" in e for e in errs)


def test_run_bake_dispatches_on_mode(monkeypatch):
    m = WizardModel(mode=MODE_QUICK, locate_fn=lambda: Resolved("/n", "/c"))
    called = {"quick": 0, "adv": 0}
    monkeypatch.setattr(m, "_run_quick_bake_sync", lambda: called.__setitem__("quick", 1))
    monkeypatch.setattr(m, "_run_bake_sync", lambda: called.__setitem__("adv", 1))
    # run_bake spawns a thread; call the chosen sync directly via the dispatch.
    m.state.mode = MODE_QUICK
    m.run_bake()
    _join_threads()
    assert called["quick"] == 1 and called["adv"] == 0


# ---- PkexecFlasher command vector ----


def test_flasher_command_vector_wraps_pkexec():
    f = PkexecFlasher(
        image_path="/tmp/img.iso",
        device_path="/dev/sdb",
        python_path="/usr/bin/python3",
        flasher_path="/x/disk_write.py",
    )
    assert f.command_vector == [
        "pkexec", "/usr/bin/python3", "/x/disk_write.py", "/tmp/img.iso", "/dev/sdb",
    ]


def test_flasher_command_vector_no_pkexec():
    f = PkexecFlasher(
        image_path="/tmp/img.iso",
        device_path="/dev/sdb",
        python_path="/usr/bin/python3",
        flasher_path="/x/disk_write.py",
        use_pkexec=False,
    )
    assert f.command_vector[0] == "/usr/bin/python3"


def test_locate_flasher_finds_sibling():
    p = locate_flasher()
    assert p.endswith("disk_write.py")
    assert Path(p).exists()


# ---- disk_write final-block padding ----


def test_disk_write_pad_to_sector():
    # Full sector — unchanged.
    assert disk_write.pad_to_sector(b"\x00" * 512) == b"\x00" * 512
    # Short final chunk rounds up to the next 512.
    out = disk_write.pad_to_sector(b"\xaa" * (512 + 100))
    assert len(out) == 1024
    assert out[:612] == b"\xaa" * 612
    assert out[612:] == b"\x00" * 412
    # Empty stays empty.
    assert disk_write.pad_to_sector(b"") == b""
    # Custom sector size.
    assert len(disk_write.pad_to_sector(b"x" * 100, 4096)) == 4096


def test_disk_write_refuses_non_dev(tmp_path):
    img = tmp_path / "img.bin"
    img.write_bytes(b"\x00" * 2048)
    with pytest.raises(disk_write.DiskWriteError):
        disk_write.write(str(img), str(tmp_path / "not-a-dev"))


def test_disk_write_refuses_tiny_image(tmp_path):
    img = tmp_path / "img.bin"
    img.write_bytes(b"\x00" * 10)
    with pytest.raises(disk_write.DiskWriteError):
        disk_write.write(str(img), "/dev/sdb")


# ---- helpers ----


def _disk(device_path: str) -> DeviceInfo:
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


def _model() -> WizardModel:
    return WizardModel(mode=MODE_QUICK, locate_fn=lambda: Resolved("/n", "/c"))


def _sample_recipe() -> ap.Recipe:
    ac = ap.RecipeAuthCode(
        1, "CPSERIAL0001", "dani", "home", "home.dani.flagship.services",
        "ab" * 32, "cd" * 32, 1, 2,
    )
    return ap.Recipe(
        2, "home.dani.flagship.services", "dani", "home", "ab" * 32,
        "https://x/y", ac, "11" * 64, "main", "ef" * 32, "22" * 64, None,
    )


def _join_threads():
    import threading
    import time

    deadline = time.time() + 2.0
    while time.time() < deadline:
        if threading.active_count() <= 1:
            break
        time.sleep(0.01)
