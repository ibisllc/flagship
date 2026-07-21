"""The pure qemu-system-x86_64 argv builder — KVM flavor of the Windows
QemuCommandLineTests (no WHPX VMX/SGX masking here; that was a WHPX-only
workaround)."""
from __future__ import annotations

import pytest

from vm import qemu_command_line, resource_plan
from vm.config import VMConfig, VMNetworkMode, VMProvisioningMode
from vm.inventory import VMBundleLayout


def config(debug: bool = False, encrypted: bool = True) -> VMConfig:
    return VMConfig(
        name="home.harry.flagship.services",
        server_domain="home.harry.flagship.services",
        username="harry",
        server_name="home",
        cpu_count=2,
        memory_bytes=4 * resource_plan.GIB,
        main_disk_size_bytes=resource_plan.DEFAULT_MAIN_DISK_SIZE_BYTES,
        network_mode=VMNetworkMode.NAT,
        serial_console_enabled=debug,
        boot_unlock_mode="auto",
        disk_encrypted=encrypted,
    )


LAYOUT = VMBundleLayout("/data/VMs")


def build(cfg: VMConfig, attach: bool = False, ssh: int = 0, accel: str = "kvm"):
    return qemu_command_line.build(
        cfg, LAYOUT, "/usr/share/OVMF/OVMF_CODE_4M.fd", attach, 4444, 4445, ssh, accel
    )


def pairs(args):
    return list(zip(args, args[1:]))


def test_kvm_uses_host_cpu_without_whpx_masking():
    args = build(config())
    assert ("-accel", "kvm") in pairs(args)
    assert ("-cpu", "host") in pairs(args)
    assert not any("vmx=off" in a or "sgx=off" in a for a in args)
    assert not any("kernel-irqchip" in a for a in args)


def test_tcg_fallback_uses_cpu_max():
    args = build(config(), accel="tcg")
    assert ("-accel", "tcg") in pairs(args)
    assert ("-cpu", "max") in pairs(args)


def test_main_disk_is_ahci_for_metal_identical_sda():
    args = build(config())
    assert ("-machine", "q35") in pairs(args)
    assert (
        "-drive",
        "id=flagship-main,if=none,format=qcow2,file=/data/VMs/home.harry.flagship.services/disk.qcow2",
    ) in pairs(args)
    assert ("-device", "ide-hd,drive=flagship-main") in pairs(args)
    assert not any(a.startswith("virtio-blk") for a in args)


def test_uefi_pflash_pair():
    args = build(config())
    assert ("-drive", "if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd") in pairs(args)
    assert (
        "-drive",
        "if=pflash,format=raw,file=/data/VMs/home.harry.flagship.services/efi-vars.fd",
    ) in pairs(args)


def test_installer_iso_rides_usb_with_no_reboot():
    args = build(config(), attach=True)
    assert ("-device", "qemu-xhci") in pairs(args)
    assert (
        "-drive",
        "id=flagship-installer,if=none,format=raw,readonly=on,"
        "file=/data/VMs/home.harry.flagship.services/installer.iso",
    ) in pairs(args)
    assert ("-device", "usb-storage,drive=flagship-installer") in pairs(args)
    assert "-no-reboot" in args


def test_boot_from_disk_has_no_installer_and_no_no_reboot():
    args = build(config(), attach=False)
    assert not any("flagship-installer" in a for a in args)
    assert "-no-reboot" not in args


def test_prebuilt_appliance_attaches_read_only_raw_seed_not_iso():
    from dataclasses import replace
    args = build(replace(config(), provisioning_mode=VMProvisioningMode.PREBUILT_APPLIANCE), attach=True)
    assert (
        "-drive",
        "id=flagship-seed,if=none,format=raw,readonly=on,"
        "file=/data/VMs/home.harry.flagship.services/seed.img",
    ) in pairs(args)
    assert ("-device", "virtio-blk-pci,drive=flagship-seed") in pairs(args)
    assert not any("flagship-installer" in a for a in args)
    assert ("-device", "qemu-xhci") not in pairs(args)


def test_production_vm_gets_no_serial_and_no_ssh_forward():
    args = build(config(debug=False))
    assert ("-serial", "none") in pairs(args)
    assert not any("hostfwd" in a for a in args)
    assert ("-netdev", "user,id=net0") in pairs(args)


def test_debug_vm_gets_serial_console_with_transcript():
    args = build(config(debug=True))
    chardev = [a for a in args if a.startswith("socket,id=ser0")]
    assert len(chardev) == 1
    assert "port=4445" in chardev[0]
    assert "logfile=/data/VMs/home.harry.flagship.services/console.log" in chardev[0]
    assert ("-serial", "chardev:ser0") in pairs(args)


def test_debug_vm_ssh_forward_targets_loopback_22():
    args = build(config(debug=True), ssh=50022)
    assert ("-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:50022-:22") in pairs(args)


def test_refuses_ssh_forward_for_a_production_vm():
    with pytest.raises(ValueError):
        build(config(debug=False), ssh=50022)


def test_qmp_is_loopback_only_and_display_none():
    args = build(config())
    assert ("-qmp", "tcp:127.0.0.1:4444,server=on,wait=off") in pairs(args)
    assert ("-display", "none") in pairs(args)


def test_memory_is_mebibytes():
    args = build(config())
    assert ("-m", "4096M") in pairs(args)
    assert ("-smp", "2") in pairs(args)
