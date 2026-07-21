"""Removable-storage enumeration for the Flagship Studio Linux GUI.

Mirrors packages/flagship-builder/src/devices.ts::parseLsblk + the Mac GUI's
DiskEnumerator.accept rules. We do NOT shell out to the Node CLI here —
recomputing keeps the picker responsive and keeps the safety classification
under our control.

Verdicts (same as devices.ts):
  removable-usb : safe to offer. external + (rm|usb) + 500MB..500GB
  internal      : refused even with explicit selection. system drive,
                  NVMe-without-removable, anything >500GB
  too-small     : <500MB, can't hold a Flagship ISO
  unknown       : enumeration succeeded but we can't classify; treated as
                  internal for safety

The whole module is built around an injectable `run_lsblk` so the safety +
classification logic is unit-testable without touching real disks.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from typing import Callable, Optional


MIN_DEVICE_SIZE_BYTES = 500 * 1024 * 1024  # 500 MB
MAX_DEVICE_SIZE_BYTES = 500 * 1024 * 1024 * 1024  # 500 GB

SafetyVerdict = str  # "removable-usb" | "internal" | "too-small" | "unknown"


@dataclass(frozen=True)
class DeviceInfo:
    device_path: str
    size_bytes: int
    model: str
    bus: str
    mounted: bool
    removable: bool
    internal: bool
    verdict: SafetyVerdict
    verdict_reason: str

    @property
    def human_size(self) -> str:
        return fmt_size(self.size_bytes)

    @property
    def display_name(self) -> str:
        return f"{self.model} ({self.human_size}, {self.bus})"

    @property
    def is_safe(self) -> bool:
        return self.verdict == "removable-usb"


LsblkRunner = Callable[[], str]


def _default_run_lsblk() -> str:
    proc = subprocess.run(
        [
            "lsblk", "-J", "-b", "-o",
            "NAME,SIZE,TYPE,RM,RO,MODEL,VENDOR,TRAN,MOUNTPOINT,HOTPLUG",
        ],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        return "{}"
    return proc.stdout


def enumerate_devices(run_lsblk: Optional[LsblkRunner] = None) -> list[DeviceInfo]:
    """Run lsblk + classify every whole disk. Never raises; returns []
    when lsblk fails or the JSON is malformed."""
    runner = run_lsblk if run_lsblk is not None else _default_run_lsblk
    try:
        raw = runner()
    except (OSError, FileNotFoundError):
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return []
    return parse_lsblk(parsed)


def parse_lsblk(payload: object) -> list[DeviceInfo]:
    """Pure parser. Takes the decoded lsblk JSON, returns a DeviceInfo per
    `type: disk` entry."""
    if not isinstance(payload, dict):
        return []
    blockdevices = payload.get("blockdevices")
    if not isinstance(blockdevices, list):
        return []
    out: list[DeviceInfo] = []
    for node in blockdevices:
        if not isinstance(node, dict):
            continue
        if node.get("type") != "disk":
            continue
        name = node.get("name") or ""
        if not name:
            continue
        device_path = f"/dev/{name}"
        size_bytes = _to_int(node.get("size"))
        rm = _truthy(node.get("rm")) or _truthy(node.get("hotplug"))
        tran_raw = node.get("tran") or ""
        tran = str(tran_raw).lower()
        is_usb = tran == "usb"
        is_nvme = tran == "nvme"
        is_internal = (tran in ("sata", "ata") or is_nvme) and not rm
        vendor = str(node.get("vendor") or "").strip()
        model_str = str(node.get("model") or "").strip()
        model = " ".join(p for p in (vendor, model_str) if p) or "(unknown model)"
        mounted = _node_or_child_mounted(node)
        verdict, reason = compute_verdict(
            device_path=device_path,
            size_bytes=size_bytes,
            internal_=is_internal,
            removable=rm or is_usb,
            bus=tran.upper() or "UNKNOWN",
            virtual=False,
        )
        out.append(DeviceInfo(
            device_path=device_path,
            size_bytes=size_bytes,
            model=model,
            bus=tran.upper() or "UNKNOWN",
            mounted=mounted,
            removable=rm or is_usb,
            internal=is_internal,
            verdict=verdict,
            verdict_reason=reason,
        ))
    return out


def _node_or_child_mounted(node: dict) -> bool:
    mp = node.get("mountpoint")
    if isinstance(mp, str) and len(mp) > 0:
        return True
    children = node.get("children")
    if isinstance(children, list):
        for c in children:
            if isinstance(c, dict) and _node_or_child_mounted(c):
                return True
    return False


def compute_verdict(
    *,
    device_path: str,
    size_bytes: int,
    internal_: bool,
    removable: bool,
    bus: str,
    virtual: bool,
) -> tuple[SafetyVerdict, str]:
    """Mirror of devices.ts::computeVerdict, minus the macOS /dev/disk0
    hard-code (Linux has its own system-drive heuristic via tran=sata|ata|nvme
    + !rm).

    Defense in depth: regardless of what the OS reports, refuse anything
    looking like a typical laptop SSD (/dev/sda when it's the only SATA
    disk, /dev/nvme0n1, anything >500GB)."""
    if size_bytes > 0 and size_bytes < MIN_DEVICE_SIZE_BYTES:
        return ("too-small",
                f"device is {fmt_size(size_bytes)} (need >= {fmt_size(MIN_DEVICE_SIZE_BYTES)})")
    if size_bytes > MAX_DEVICE_SIZE_BYTES:
        return ("internal",
                f"device is {fmt_size(size_bytes)} (>{fmt_size(MAX_DEVICE_SIZE_BYTES)} "
                f"— almost certainly an internal drive)")
    if internal_:
        return ("internal", f"OS marks {device_path} as internal media")
    if virtual:
        return ("unknown", "device is a virtual disk image, not physical hardware")
    if removable or bus == "USB":
        if size_bytes == 0:
            return ("unknown", "removable but size unknown — refusing")
        return ("removable-usb", f"removable {bus} device, {fmt_size(size_bytes)}")
    return ("unknown", "cannot determine if device is removable")


def fmt_size(bytes_: int) -> str:
    if bytes_ < 1024:
        return f"{bytes_}B"
    if bytes_ < 1024 * 1024:
        return f"{bytes_ / 1024:.1f}KB"
    if bytes_ < 1024 * 1024 * 1024:
        return f"{bytes_ / (1024 * 1024):.1f}MB"
    return f"{bytes_ / (1024 * 1024 * 1024):.2f}GB"


def _to_int(v: object) -> int:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        try:
            return int(v)
        except ValueError:
            try:
                return int(float(v))
            except ValueError:
                return 0
    return 0


def _truthy(v: object) -> bool:
    if v is True:
        return True
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0
    if isinstance(v, str):
        return v == "1" or v.lower() == "true"
    return False


def safe_devices(devices: list[DeviceInfo]) -> list[DeviceInfo]:
    """Filter to only devices the picker should show — the wizard never
    offers internal / too-small / unknown drives. Belt-and-braces with the
    CLI which also refuses these on explicit --device."""
    return [d for d in devices if d.verdict == "removable-usb"]
