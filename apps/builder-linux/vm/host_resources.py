"""A snapshot of the host machine's capacity, fed to the pure VM planning math.

Mirrors apps/builder-windows/src/VM/HostResources.cs (and the Mac
HostResources.swift). Tests pass explicit values; the app uses `current()`.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class HostResources:
    cpu_count: int
    memory_bytes: int

    @staticmethod
    def current() -> "HostResources":
        """The live host — the ONLY non-deterministic entry point; everything
        downstream is a pure function of this value."""
        cpu = os.cpu_count() or 1
        return HostResources(cpu, _physical_memory_bytes())


def _physical_memory_bytes() -> int:
    """Total physical RAM in bytes. On Linux this is SC_PHYS_PAGES *
    SC_PAGE_SIZE; if sysconf is unavailable we fall back to a conservative
    default so the app degrades to "one VM" rather than crashing."""
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        if pages > 0 and page_size > 0:
            return int(pages) * int(page_size)
    except (ValueError, OSError, AttributeError):
        pass
    # Conservative fallback: 8 GiB (yields exactly one VM under the plan).
    return 8 * (1 << 30)
