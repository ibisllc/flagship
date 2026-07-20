"""Locates the QEMU toolchain + OVMF/UEFI firmware on this Linux machine.

Mirrors apps/builder-windows/src/VM/QemuLocator.cs, adapted to the Linux layout:
QEMU is system-installed (on PATH) and OVMF ships in a separate package, so the
firmware lives in well-known /usr/share paths rather than bundled under the
QEMU root. Env overrides come first; pure path logic is injectable for tests.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Callable, List, Optional

# Env overrides for a non-standard install. They win for EITHER arch — an
# explicit override is the operator saying "use exactly this".
ENV_SYSTEM = "FLAGSHIP_QEMU_SYSTEM"   # qemu-system-x86_64 / qemu-system-aarch64
ENV_IMG = "FLAGSHIP_QEMU_IMG"          # qemu-img
ENV_OVMF_CODE = "FLAGSHIP_OVMF_CODE"   # readonly UEFI code pflash
ENV_OVMF_VARS = "FLAGSHIP_OVMF_VARS"   # UEFI vars template (copied per-VM)

# Well-known OVMF firmware locations across distros. The 4M split-code build is
# preferred (matches the split VARS template); the monolithic build is the
# fallback. These are (code, vars) pairs so we keep them matched.
_OVMF_CANDIDATES = [
    ("/usr/share/OVMF/OVMF_CODE_4M.fd", "/usr/share/OVMF/OVMF_VARS_4M.fd"),
    ("/usr/share/OVMF/OVMF_CODE.fd", "/usr/share/OVMF/OVMF_VARS.fd"),
    ("/usr/share/edk2/ovmf/OVMF_CODE.fd", "/usr/share/edk2/ovmf/OVMF_VARS.fd"),
    ("/usr/share/edk2/x64/OVMF_CODE.4m.fd", "/usr/share/edk2/x64/OVMF_VARS.4m.fd"),
    ("/usr/share/edk2/x64/OVMF_CODE.fd", "/usr/share/edk2/x64/OVMF_VARS.fd"),
    ("/usr/share/qemu/edk2-x86_64-code.fd", "/usr/share/qemu/edk2-i386-vars.fd"),
]

# The aarch64 twin (AAVMF on Debian/Ubuntu, edk2-aarch64 on Fedora, plus the
# qemu-bundled build) — for hosting a native guest on an arm64 Chromebook/SBC.
_AAVMF_CANDIDATES = [
    ("/usr/share/AAVMF/AAVMF_CODE.fd", "/usr/share/AAVMF/AAVMF_VARS.fd"),
    (
        "/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw",
        "/usr/share/edk2/aarch64/vars-template-pflash.raw",
    ),
    ("/usr/share/qemu/edk2-aarch64-code.fd", "/usr/share/qemu/edk2-arm-vars.fd"),
]

# Per-arch toolchain facts: (system binary, firmware candidates, install hint).
_ARCH_TABLE = {
    "amd64": (
        "qemu-system-x86_64",
        _OVMF_CANDIDATES,
        "`sudo apt install qemu-system-x86 ovmf` or `sudo dnf install qemu-system-x86 edk2-ovmf`",
    ),
    "arm64": (
        "qemu-system-aarch64",
        _AAVMF_CANDIDATES,
        "`sudo apt install qemu-system-arm qemu-efi-aarch64` or `sudo dnf install qemu-system-aarch64 edk2-aarch64`",
    ),
}


@dataclass(frozen=True)
class QemuToolchain:
    system_binary: str      # qemu-system-x86_64
    img_binary: str         # qemu-img
    uefi_code_path: str     # OVMF code (readonly pflash)
    uefi_vars_template: str  # OVMF vars template (per-VM copy source)


class QemuLocatorError(Exception):
    pass


def locate(
    env: Optional[dict] = None,
    which: Callable[[str], Optional[str]] = shutil.which,
    exists: Callable[[str], bool] = os.path.exists,
    arch: str = "amd64",
) -> QemuToolchain:
    """Resolve the toolchain for hosting an `arch` guest, or raise
    QemuLocatorError with an actionable message. Injectable (env/which/exists)
    so it's fully unit-testable."""
    env = env if env is not None else os.environ
    if arch not in _ARCH_TABLE:
        raise QemuLocatorError(
            f"Hosting isn't supported on this CPU architecture ({arch})."
        )
    binary_name, firmware_candidates, install_hint = _ARCH_TABLE[arch]

    system = env.get(ENV_SYSTEM) or which(binary_name)
    if not system or not exists(system):
        raise QemuLocatorError(
            "QEMU is not installed. Install it with your package manager "
            f"(e.g. {install_hint}), or set "
            f"{ENV_SYSTEM} to your {binary_name} binary."
        )

    img = env.get(ENV_IMG) or which("qemu-img")
    if not img or not exists(img):
        raise QemuLocatorError(
            f"Found {binary_name} but qemu-img is missing — install the "
            "qemu-utils / qemu-img package."
        )

    code = env.get(ENV_OVMF_CODE)
    vars_ = env.get(ENV_OVMF_VARS)
    if not (code and vars_):
        found = _find_firmware(exists, firmware_candidates)
        if found is None:
            raise QemuLocatorError(
                "UEFI firmware not found. Install it (e.g. "
                f"{install_hint}), or "
                f"set {ENV_OVMF_CODE} and {ENV_OVMF_VARS}."
            )
        code, vars_ = found
    if not exists(code) or not exists(vars_):
        raise QemuLocatorError(
            f"UEFI firmware paths are set but unreadable ({code}, {vars_}) — "
            "reinstall the ovmf/edk2 package."
        )

    return QemuToolchain(system, img, code, vars_)


def _find_firmware(
    exists: Callable[[str], bool], candidates: List[tuple]
) -> Optional[tuple]:
    for code, vars_ in candidates:
        if exists(code) and exists(vars_):
            return (code, vars_)
    return None
