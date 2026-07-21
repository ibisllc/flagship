"""Unit tests for the Linux disk enumerator.

Mirrors apps/builder-mac/Tests/FlagshipBuilderTests/DiskEnumeratorTests.swift
+ packages/flagship-builder/tests/devices.test.ts. Tests run via:

    python -m pytest apps/builder-linux/tests/
"""
from __future__ import annotations

import json

import pytest

from disk_enumerator import (
    MAX_DEVICE_SIZE_BYTES,
    MIN_DEVICE_SIZE_BYTES,
    compute_verdict,
    enumerate_devices,
    fmt_size,
    parse_lsblk,
    safe_devices,
)


# ---- parse_lsblk ----


def test_parse_lsblk_handles_empty_root():
    assert parse_lsblk({}) == []
    assert parse_lsblk({"blockdevices": None}) == []
    assert parse_lsblk(None) == []
    assert parse_lsblk("not a dict") == []


def test_parse_lsblk_skips_non_disk_types():
    payload = {
        "blockdevices": [
            {"name": "loop0", "type": "loop", "size": 1000},
            {"name": "ram0", "type": "rom", "size": 1000},
        ]
    }
    assert parse_lsblk(payload) == []


def test_parse_lsblk_keeps_usb_disk():
    payload = {
        "blockdevices": [
            {
                "name": "sdb",
                "size": 32_010_928_128,
                "type": "disk",
                "rm": True,
                "ro": False,
                "model": "Ultra USB 3.0",
                "vendor": "SanDisk",
                "tran": "usb",
                "mountpoint": None,
                "hotplug": True,
                "children": [
                    {"name": "sdb1", "size": 1000, "type": "part", "mountpoint": "/media/u/FLAG"},
                ],
            }
        ]
    }
    devs = parse_lsblk(payload)
    assert len(devs) == 1
    d = devs[0]
    assert d.device_path == "/dev/sdb"
    assert d.size_bytes == 32_010_928_128
    assert d.model == "SanDisk Ultra USB 3.0"
    assert d.bus == "USB"
    assert d.removable is True
    assert d.internal is False
    assert d.mounted is True
    assert d.verdict == "removable-usb"


def test_parse_lsblk_internal_nvme_is_internal():
    payload = {
        "blockdevices": [
            {
                "name": "nvme0n1",
                "size": 500_107_862_016,
                "type": "disk",
                "rm": False,
                "tran": "nvme",
                "model": "Samsung SSD 980",
                "vendor": "Samsung",
            }
        ]
    }
    devs = parse_lsblk(payload)
    assert len(devs) == 1
    assert devs[0].verdict == "internal"


def test_parse_lsblk_internal_sata_is_internal():
    payload = {
        "blockdevices": [
            {
                "name": "sda",
                "size": 256_060_514_304,
                "type": "disk",
                "rm": False,
                "tran": "sata",
                "model": "ST500DM002",
                "vendor": "Seagate",
            }
        ]
    }
    devs = parse_lsblk(payload)
    assert devs[0].verdict == "internal"


def test_parse_lsblk_too_small_when_size_below_min():
    payload = {
        "blockdevices": [
            {
                "name": "sdc",
                "size": 100 * 1024 * 1024,  # 100 MB
                "type": "disk",
                "rm": True,
                "tran": "usb",
            }
        ]
    }
    devs = parse_lsblk(payload)
    assert devs[0].verdict == "too-small"


def test_parse_lsblk_huge_device_is_internal():
    payload = {
        "blockdevices": [
            {
                "name": "sdd",
                "size": 2_000_000_000_000,  # 2 TB
                "type": "disk",
                "rm": True,
                "tran": "usb",
            }
        ]
    }
    devs = parse_lsblk(payload)
    # >500GB is hard-refused even if marked removable.
    assert devs[0].verdict == "internal"


def test_parse_lsblk_unknown_when_removable_with_no_size():
    payload = {
        "blockdevices": [
            {
                "name": "sdz",
                "size": 0,
                "type": "disk",
                "rm": True,
                "tran": "usb",
                "model": "Empty card reader",
            }
        ]
    }
    devs = parse_lsblk(payload)
    assert devs[0].verdict == "unknown"


def test_parse_lsblk_mountpoint_at_root_means_mounted():
    payload = {
        "blockdevices": [
            {
                "name": "sde",
                "size": 8_000_000_000,
                "type": "disk",
                "rm": True,
                "tran": "usb",
                "mountpoint": "/mnt/stick",
            }
        ]
    }
    assert parse_lsblk(payload)[0].mounted is True


def test_parse_lsblk_handles_string_size_from_some_lsblk_versions():
    payload = {
        "blockdevices": [
            {
                "name": "sdf",
                "size": "8000000000",
                "type": "disk",
                "rm": "1",
                "tran": "usb",
            }
        ]
    }
    d = parse_lsblk(payload)[0]
    assert d.size_bytes == 8_000_000_000
    assert d.removable is True


def test_parse_lsblk_uses_vendor_only_when_model_missing():
    payload = {
        "blockdevices": [
            {
                "name": "sdg",
                "size": 8_000_000_000,
                "type": "disk",
                "rm": True,
                "tran": "usb",
                "vendor": "Kingston",
                "model": "",
            }
        ]
    }
    assert parse_lsblk(payload)[0].model == "Kingston"


def test_parse_lsblk_unknown_model_when_both_blank():
    payload = {
        "blockdevices": [
            {
                "name": "sdh",
                "size": 8_000_000_000,
                "type": "disk",
                "rm": True,
                "tran": "usb",
                "vendor": "",
                "model": "",
            }
        ]
    }
    assert parse_lsblk(payload)[0].model == "(unknown model)"


# ---- compute_verdict (direct unit tests) ----


def test_compute_verdict_internal_marked():
    v, _ = compute_verdict(
        device_path="/dev/sda", size_bytes=200_000_000_000,
        internal_=True, removable=False, bus="SATA", virtual=False,
    )
    assert v == "internal"


def test_compute_verdict_too_small():
    v, _ = compute_verdict(
        device_path="/dev/sdb", size_bytes=100 * 1024 * 1024,
        internal_=False, removable=True, bus="USB", virtual=False,
    )
    assert v == "too-small"


def test_compute_verdict_oversize_refused():
    v, _ = compute_verdict(
        device_path="/dev/sdc",
        size_bytes=MAX_DEVICE_SIZE_BYTES + 1,
        internal_=False, removable=True, bus="USB", virtual=False,
    )
    assert v == "internal"


def test_compute_verdict_virtual_unknown():
    v, _ = compute_verdict(
        device_path="/dev/loop0",
        size_bytes=8_000_000_000,
        internal_=False, removable=False, bus="UNKNOWN", virtual=True,
    )
    assert v == "unknown"


def test_compute_verdict_happy_path_usb():
    v, reason = compute_verdict(
        device_path="/dev/sdb",
        size_bytes=8_000_000_000,
        internal_=False, removable=True, bus="USB", virtual=False,
    )
    assert v == "removable-usb"
    assert "USB" in reason


def test_compute_verdict_boundary_at_min_size_is_safe():
    # The MIN guard is strictly less-than; the boundary itself is accepted.
    v, _ = compute_verdict(
        device_path="/dev/sdb",
        size_bytes=MIN_DEVICE_SIZE_BYTES,
        internal_=False, removable=True, bus="USB", virtual=False,
    )
    assert v == "removable-usb"


# ---- safe_devices ----


def test_safe_devices_filters_everything_but_removable_usb():
    payload = {
        "blockdevices": [
            {"name": "sda", "size": 256_060_514_304, "type": "disk", "rm": False, "tran": "sata"},
            {"name": "sdb", "size": 8_000_000_000, "type": "disk", "rm": True, "tran": "usb"},
            {"name": "sdc", "size": 100 * 1024 * 1024, "type": "disk", "rm": True, "tran": "usb"},
        ]
    }
    devs = parse_lsblk(payload)
    safe = safe_devices(devs)
    assert len(safe) == 1
    assert safe[0].device_path == "/dev/sdb"


# ---- enumerate_devices with injected runner ----


def test_enumerate_devices_with_fake_runner():
    fake_json = json.dumps({
        "blockdevices": [
            {"name": "sdb", "size": 8_000_000_000, "type": "disk", "rm": True, "tran": "usb"}
        ]
    })
    devs = enumerate_devices(run_lsblk=lambda: fake_json)
    assert len(devs) == 1
    assert devs[0].device_path == "/dev/sdb"


def test_enumerate_devices_returns_empty_on_malformed_json():
    devs = enumerate_devices(run_lsblk=lambda: "not json")
    assert devs == []


def test_enumerate_devices_returns_empty_when_runner_raises():
    def boom() -> str:
        raise OSError("lsblk missing")
    devs = enumerate_devices(run_lsblk=boom)
    assert devs == []


# ---- fmt_size ----


def test_fmt_size_bytes():
    assert fmt_size(0) == "0B"
    assert fmt_size(500) == "500B"


def test_fmt_size_kb():
    assert fmt_size(1500) == "1.5KB"


def test_fmt_size_mb():
    assert fmt_size(2 * 1024 * 1024) == "2.0MB"


def test_fmt_size_gb():
    assert fmt_size(16 * 1024 * 1024 * 1024) == "16.00GB"


# ---- DeviceInfo derived properties ----


def test_device_info_human_size_present():
    payload = {
        "blockdevices": [
            {
                "name": "sdb",
                "size": 16_000_000_000,
                "type": "disk",
                "rm": True,
                "tran": "usb",
                "vendor": "Kingston",
                "model": "DataTraveler",
            }
        ]
    }
    d = parse_lsblk(payload)[0]
    assert "GB" in d.human_size
    assert "Kingston DataTraveler" in d.display_name
    assert "USB" in d.display_name
    assert d.is_safe is True
