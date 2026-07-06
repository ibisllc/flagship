"""PURE argv builder: a VMConfig (all decisions already made) + bundle layout
-> the qemu-system-x86_64 argument vector.

The Linux analog of apps/burner-windows/src/VM/QemuCommandLine.cs. Deliberately
dumb, fully unit-testable without QEMU — qemu_host.py spawns the process; this
file never touches one.

Linux vs Windows (WHPX):
  * accel is KVM, not WHPX. `-accel kvm` (no kernel-irqchip quirk) + `-cpu host`
    (KVM passes the host CPU straight through). The VMX/SGX masking in the
    Windows builder was a WHPX-only workaround (OVMF wrote IA32_FEATURE_CONTROL,
    unimplemented by WHPX) — KVM emulates those MSRs, so it is NOT copied.
  * Same AHCI main disk (ide-hd => the guest sees /dev/sda) + USB-attached ISO
    (=> the installer is sdb) so the guest sees a metal-identical device order
    (the fc33a5a3 Windows learning).
  * Same OVMF/UEFI pflash wiring + the loopback QMP + serial-console gate.
  * The SSH host-forward on the debug path genuinely works here: KVM + real
    QEMU user-net hostfwd means "Open SSH into a local VM" reaches the guest's
    :22 on 127.0.0.1:<sshPort>.
"""
from __future__ import annotations

from typing import List

from .config import VMConfig, VMNetworkMode
from .inventory import VMBundleLayout


def build(
    config: VMConfig,
    layout: VMBundleLayout,
    uefi_code_path: str,
    attach_installer_iso: bool,
    qmp_port: int,
    serial_port: int,
    ssh_host_port: int = 0,
    accel: str = "kvm",
) -> List[str]:
    """uefi_code_path: the shared readonly OVMF code image (only the VARS half
    is per-VM).

    attach_installer_iso mirrors the lifecycle's attach/detach effects: true
    during the install phase, false for every boot from disk. It also sets
    -no-reboot so a completed-install reboot surfaces as a clean process exit
    (which the duration-gated verdict then classifies).

    qmp_port: loopback TCP port for the QMP control socket. serial_port:
    loopback TCP port for the serial console — ONLY used when the pure layer
    said so (debug grant present). A production VM gets `-serial none`.

    accel: "kvm" in production; tests / CI without a hypervisor may pass "tcg".
    """
    if config.network_mode != VMNetworkMode.NAT:
        raise ValueError("Unsupported network mode for this VM.")
    # The SSH host-forward is gated on the SAME debug grant as the serial
    # console: a production VM gets neither. Never forward :22 for a box the
    # owner didn't authorize for debug.
    if ssh_host_port > 0 and not config.serial_console_enabled:
        raise ValueError("Refusing to forward SSH for a production (non-debug) VM.")

    name = config.name
    # KVM passes the host CPU model straight through (`-cpu host`) — the fastest
    # + most metal-identical option. Under TCG (no hypervisor, CI) fall back to
    # `-cpu max`. No VMX/SGX masking: that was a WHPX-only workaround.
    if accel == "kvm":
        accel_arg = "kvm"
        cpu_arg = "host"
    else:
        accel_arg = accel
        cpu_arg = "max"

    args: List[str] = [
        "-name", name,
        "-machine", "q35",
        "-accel", accel_arg,
        "-cpu", cpu_arg,
        "-smp", str(config.cpu_count),
        "-m", f"{config.memory_bytes // (1024 * 1024)}M",

        # EFI firmware + per-VM persistent variable store. OVMF reads the
        # remastered Debian netinst's UEFI boot entry directly, so the
        # remaster's grub.cfg preseed cmdline is honored.
        "-drive", f"if=pflash,format=raw,readonly=on,file={uefi_code_path}",
        "-drive", f"if=pflash,format=raw,file={layout.efi_variable_store_path(name)}",

        # Main disk on the q35 built-in AHCI so the guest sees /dev/sda —
        # METAL-IDENTICAL naming. The preseed's partman/early_command targets
        # `list-devices disk | head -n1`; with a virtio main disk (vda) the USB
        # installer stick becomes sda and d-i tries to install onto the stick.
        # SATA main + USB installer reproduces the metal order (sda = system
        # disk, sdb = installer).
        "-drive", f"id=flagship-main,if=none,format=qcow2,file={layout.disk_image_path(name)}",
        "-device", "ide-hd,drive=flagship-main",
    ]

    if attach_installer_iso:
        # USB mass storage matches how the ISO boots on real hardware (the
        # burner writes it to a USB stick) — the same isohybrid image, the same
        # EFI boot entry.
        args += [
            "-device", "qemu-xhci",
            "-drive", f"id=flagship-installer,if=none,format=raw,readonly=on,file={layout.installer_iso_path(name)}",
            "-device", "usb-storage,drive=flagship-installer",
            # A completed install ends in poweroff OR reboot; -no-reboot turns
            # both into a clean exit for the duration-gated verdict.
            "-no-reboot",
        ]

    # User-mode NAT: outbound-only is all the appliance needs. For a debug VM we
    # additionally forward a loopback host port to the guest's :22 so "Open in
    # SSH" can reach it without hunting a LAN IP — and on Linux (real KVM + real
    # QEMU user-net) this genuinely works.
    netdev = (
        f"user,id=net0,hostfwd=tcp:127.0.0.1:{ssh_host_port}-:22"
        if ssh_host_port > 0
        else "user,id=net0"
    )
    args += [
        "-netdev", netdev,
        "-device", "virtio-net-pci,netdev=net0",
        "-device", "virtio-rng-pci",
    ]

    # QMP control socket (loopback only): clean system_powerdown + the SHUTDOWN
    # event stream.
    args += ["-qmp", f"tcp:127.0.0.1:{qmp_port},server=on,wait=off"]

    if config.serial_console_enabled:
        # Interactive console over loopback TCP + a persistent transcript in
        # console.log (chardev logfile captures output even when no client is
        # attached).
        args += [
            "-chardev",
            f"socket,id=ser0,host=127.0.0.1,port={serial_port},server=on,wait=off,"
            f"logfile={layout.console_log_path(name)},logappend=on",
            "-serial", "chardev:ser0",
        ]
    else:
        args += ["-serial", "none"]

    # Headless: the appliance has no GUI; all interaction is phone/web.
    args += ["-display", "none"]

    return args
