"""Detects when the burner runs inside ChromeOS's Linux container (Crostini).

Crostini is a first-class home for the burner — modern ChromeOS exposes
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

# ChromeOS shares a USB into the Linux container but MANAGES the removable
# device itself: raw block writes from the container truncate after a few
# hundred KB (empirically ~488 KB) with no error, so a burn stalls at ~0%.
# Surface this BEFORE the write instead of a cryptic mid-burn ENOSPC.
USB_BURN_ADVISORY = (
    "Heads-up: burning a USB from inside ChromeOS's Linux container usually "
    "fails — ChromeOS manages the removable drive and caps raw writes from "
    "the container, so the burn stalls near 0%. Use Host on this PC to run "
    "the server as a local VM (recommended on a Chromebook), or run this "
    "burner on a native Linux machine to write the stick."
)


def is_chromeos_container(exists: Callable[[str], bool] = os.path.exists) -> bool:
    return any(exists(m) for m in _CROSTINI_MARKERS)


def no_disks_hint(chromeos: bool) -> str:
    return NO_DISKS_CROSTINI if chromeos else NO_DISKS_GENERIC
