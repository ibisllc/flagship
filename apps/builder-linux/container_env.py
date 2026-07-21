"""Detects when the builder runs inside ChromeOS's Linux container (Crostini).

Crostini is a first-class home for the builder — modern ChromeOS exposes
/dev/kvm to the container, so "Host on this PC" runs with full KVM
acceleration — but USB sticks are NOT visible as block devices until the user
shares the drive with Linux (ChromeOS Settings), so the burn path needs
different guidance than "plug one in".

Pure: the path predicate is injected so tests never touch the real fs.
"""
from __future__ import annotations

import os
from typing import Callable

# Installed/mounted by the cros guest tools inside the penguin container. Any
# one marker is a strong signal; a set so a future ChromeOS rearrangement of a
# single path doesn't flip the verdict.
_CROSTINI_MARKERS = (
    "/opt/google/cros-containers",
    "/dev/.cros_milestone",
    "/etc/apt/sources.list.d/cros.list",
)

NO_DISKS_GENERIC = "No removable disks detected. Plug one in and click Refresh."

NO_DISKS_CROSTINI = (
    "No removable disks detected. In ChromeOS's Linux container a USB drive "
    "stays invisible until you share it: plug it in, enable it under ChromeOS "
    "Settings → Linux → Manage USB devices, then click Refresh. Or "
    "skip the USB entirely and use Host on this PC."
)


def is_chromeos_container(exists: Callable[[str], bool] = os.path.exists) -> bool:
    return any(exists(m) for m in _CROSTINI_MARKERS)


def no_disks_hint(chromeos: bool) -> str:
    return NO_DISKS_CROSTINI if chromeos else NO_DISKS_GENERIC
