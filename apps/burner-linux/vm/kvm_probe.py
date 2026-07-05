"""Whether this machine can actually host a VM under KVM, with an HONEST,
actionable reason when it can't.

The Linux analog of apps/burner-windows/src/VM/WhpxProbe.cs. Detection is
direct rather than empirical: KVM exposes /dev/kvm when the kvm kernel modules
are loaded and CPU virtualization is on. We check that the device exists and is
read+write accessible to this user, and read /proc/cpuinfo for the vmx/svm flag
to distinguish "firmware has virtualization off" from "the module isn't loaded"
and "you're not in the kvm group". The classification is pure + unit-tested;
only the file probes are impure.
"""
from __future__ import annotations

import enum
import os
from dataclasses import dataclass
from typing import Callable


class KvmVerdictKind(enum.Enum):
    AVAILABLE = "available"
    # /dev/kvm exists but this user can't open it — the classic "add yourself to
    # the kvm group and re-login" case.
    PERMISSION_DENIED = "permission-denied"
    # CPU virtualization (VT-x / AMD-V) is off in firmware — no vmx/svm flag.
    VIRTUALIZATION_DISABLED_IN_FIRMWARE = "virtualization-disabled-in-firmware"
    # CPU supports virt but /dev/kvm is absent — the kvm module isn't loaded.
    KVM_MODULE_MISSING = "kvm-module-missing"


@dataclass(frozen=True)
class KvmVerdict:
    kind: KvmVerdictKind
    message: str

    @property
    def is_available(self) -> bool:
        return self.kind == KvmVerdictKind.AVAILABLE


def classify(kvm_exists: bool, kvm_readable: bool, kvm_writable: bool, cpu_supports_virt: bool) -> KvmVerdict:
    """Pure classifier over the probed facts. Kept separate from the file
    probes so it's unit-testable."""
    if kvm_exists and kvm_readable and kvm_writable:
        return KvmVerdict(KvmVerdictKind.AVAILABLE, "KVM is available.")
    if kvm_exists:
        # The device node is there but we can't open it read/write.
        return KvmVerdict(
            KvmVerdictKind.PERMISSION_DENIED,
            "KVM is present but this user can't access /dev/kvm. Add yourself to "
            "the 'kvm' group (`sudo usermod -aG kvm $USER`), then log out and "
            "back in.",
        )
    if not cpu_supports_virt:
        return KvmVerdict(
            KvmVerdictKind.VIRTUALIZATION_DISABLED_IN_FIRMWARE,
            "CPU virtualization (Intel VT-x / AMD-V) is disabled in your PC's "
            "firmware. Enable it in the BIOS/UEFI settings, then try again.",
        )
    return KvmVerdict(
        KvmVerdictKind.KVM_MODULE_MISSING,
        "The kvm kernel module isn't loaded (no /dev/kvm). Load it with "
        "`sudo modprobe kvm_intel` (or kvm_amd) — or your kernel may lack KVM.",
    )


def probe(
    kvm_path: str = "/dev/kvm",
    exists: Callable[[str], bool] = os.path.exists,
    access: Callable[[str, int], bool] = os.access,
    read_cpuinfo: Callable[[], str] = None,  # type: ignore[assignment]
) -> KvmVerdict:
    """Live probe. Injectable for tests."""
    kvm_exists = exists(kvm_path)
    kvm_readable = kvm_exists and access(kvm_path, os.R_OK)
    kvm_writable = kvm_exists and access(kvm_path, os.W_OK)
    cpu_supports_virt = _cpu_supports_virt(read_cpuinfo)
    return classify(kvm_exists, kvm_readable, kvm_writable, cpu_supports_virt)


def _cpu_supports_virt(read_cpuinfo) -> bool:
    try:
        if read_cpuinfo is None:
            with open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        else:
            text = read_cpuinfo()
    except (FileNotFoundError, OSError):
        # Not Linux / no cpuinfo — assume the CPU is capable so we don't
        # misreport a firmware problem; the /dev/kvm check is the real gate.
        return True
    return (" vmx" in text) or ("\tvmx" in text) or (" svm" in text) or ("\tsvm" in text)
