"""Plain failure text for a hosted VM's QEMU.

Studio checks free RAM before launching and, when QEMU still dies, shows the
memory sentence for an out-of-memory failure and otherwise only the LAST
meaningful stderr line: blank lines and ``warning:`` lines (the repeated
host-CPUID feature warnings) are dropped and the ``qemu-system-*`` program
prefix is stripped. Windows showed the raw stderr in the sidebar when a second
4 GiB VM started with under 5 GB free (2026-10-18). Mirrors
apps/builder-windows/src/VM/QemuFailure.cs; pinned by vm-core-vectors.json
"qemuFailure".
"""
from __future__ import annotations

from i18n import tr

import re
from typing import Optional

GIB = 1 << 30

_PROGRAM_PREFIX = re.compile(r"^.*?qemu-system-[A-Za-z0-9_]+(?:\.exe)?:\s*")
_OUT_OF_MEMORY = (
    "failed to map gpa range",
    "cannot allocate memory",
    "out of memory",
    "failed to allocate",
)


def not_enough_memory_message(need_bytes: int) -> str:
    gib = -(-need_bytes // GIB)
    return tr('Not enough free memory: this server needs {0} GiB. Close other apps and try again.').format(gib)


def check_free_memory(need_bytes: int, available_bytes: Optional[int], headroom_bytes: int) -> Optional[str]:
    """None when the host has enough free RAM (or can't tell), otherwise the
    plain sentence to show instead of launching."""
    if available_bytes is None:
        return None
    if available_bytes >= need_bytes + headroom_bytes:
        return None
    return not_enough_memory_message(need_bytes)


def last_meaningful_line(stderr: str) -> str:
    kept = [
        line.strip()
        for line in stderr.splitlines()
        if line.strip() and "warning:" not in line
    ]
    if not kept:
        return ""
    return _PROGRAM_PREFIX.sub("", kept[-1], count=1).strip()


def describe_exit(exit_code: int, stderr: str, memory_bytes: int) -> str:
    lowered = stderr.lower()
    if any(marker in lowered for marker in _OUT_OF_MEMORY):
        return not_enough_memory_message(memory_bytes)
    line = last_meaningful_line(stderr)
    if not line:
        return tr('QEMU stopped unexpectedly (exit {0}).').format(exit_code)
    return tr('QEMU stopped (exit {0}): {1}').format(exit_code, line)


def available_memory_bytes() -> Optional[int]:
    """MemAvailable from /proc/meminfo; None where it can't be read."""
    try:
        with open("/proc/meminfo", encoding="ascii") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return None
