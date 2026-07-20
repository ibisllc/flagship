"""The pure KVM-availability classifier + the injectable probe."""
from __future__ import annotations

import os

from vm.kvm_probe import KvmVerdictKind, classify, probe


def test_all_good_is_available():
    v = classify(True, True, True, True)
    assert v.kind == KvmVerdictKind.AVAILABLE
    assert v.is_available


def test_device_present_but_unopenable_is_permission_denied():
    for readable, writable in ((False, False), (True, False), (False, True)):
        v = classify(True, readable, writable, True)
        assert v.kind == KvmVerdictKind.PERMISSION_DENIED
        assert "kvm" in v.message


def test_no_device_no_cpu_flag_is_firmware_disabled():
    v = classify(False, False, False, False)
    assert v.kind == KvmVerdictKind.VIRTUALIZATION_DISABLED_IN_FIRMWARE
    assert "BIOS" in v.message or "firmware" in v.message


def test_no_device_with_cpu_flag_is_module_missing():
    v = classify(False, False, False, True)
    assert v.kind == KvmVerdictKind.KVM_MODULE_MISSING
    assert "modprobe" in v.message


def test_probe_wires_the_filesystem_facts():
    v = probe(
        kvm_path="/dev/kvm",
        exists=lambda p: p == "/dev/kvm",
        access=lambda p, mode: True,
        read_cpuinfo=lambda: "flags\t\t: fpu vmx ssse3",
    )
    assert v.kind == KvmVerdictKind.AVAILABLE


def test_probe_detects_missing_write_access():
    v = probe(
        kvm_path="/dev/kvm",
        exists=lambda p: True,
        access=lambda p, mode: mode == os.R_OK,
        read_cpuinfo=lambda: "flags: vmx",
    )
    assert v.kind == KvmVerdictKind.PERMISSION_DENIED


def test_probe_reads_svm_flag_for_amd():
    v = probe(
        kvm_path="/dev/kvm",
        exists=lambda p: False,
        access=lambda p, mode: False,
        read_cpuinfo=lambda: "flags\t\t: fpu svm sse2",
    )
    assert v.kind == KvmVerdictKind.KVM_MODULE_MISSING


def test_probe_without_cpuinfo_assumes_capable_cpu():
    def boom() -> str:
        raise FileNotFoundError("/proc/cpuinfo")

    v = probe(
        kvm_path="/dev/kvm",
        exists=lambda p: False,
        access=lambda p, mode: False,
        read_cpuinfo=boom,
    )
    # The /dev/kvm check is the real gate; never misreport a firmware problem.
    assert v.kind == KvmVerdictKind.KVM_MODULE_MISSING
