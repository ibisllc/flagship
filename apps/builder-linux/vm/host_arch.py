"""Which base-ISO / QEMU architecture this machine's CPU needs when hosting.

Burning always targets amd64 (real boxes are x86) — this exists only for the
host-on-this-PC path, where the guest must be native-arch (arm64 Chromebooks
and SBCs with Crostini/KVM are real hosting targets). Mirrors
apps/builder-mac/Sources/FlagshipBuilderCore/VM/HostArch.swift.

The mapping is pure (pass `machine` in tests); only `platform.machine()` is
impure. An architecture we can't host on maps to None — callers surface an
honest "hosting isn't supported on this CPU" instead of guessing.
"""
from __future__ import annotations

import platform
from typing import Optional

ARCH_AMD64 = "amd64"
ARCH_ARM64 = "arm64"

# Every arch a VMConfig/toolchain may legally carry.
KNOWN_ARCHES = (ARCH_AMD64, ARCH_ARM64)


def current(machine: Optional[str] = None) -> Optional[str]:
    """platform.machine() → the manifest/QEMU arch tag, or None when this CPU
    isn't a supported hosting target (riscv64, …)."""
    m = (machine if machine is not None else platform.machine()).lower()
    if m in ("x86_64", "amd64"):
        return ARCH_AMD64
    if m in ("aarch64", "arm64"):
        return ARCH_ARM64
    return None
