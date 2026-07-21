"""The deterministic spec for one hosted VM — a pure function of the recipe +
host resources.

All decisions live HERE; the QEMU adapter (qemu_command_line.py) merely
translates this into a command line. Mirrors
apps/builder-windows/src/VM/VMConfig.cs (and the Mac VMConfig.swift).
"""
from __future__ import annotations

import enum
from dataclasses import dataclass

from . import recipe_info, resource_plan
from .host_resources import HostResources
from .recipe_info import RecipeFields


class VMNetworkMode(enum.Enum):
    # User-mode NAT (QEMU -netdev user) — the guest gets outbound internet with
    # zero host configuration, which is all the appliance needs (it dials OUT to
    # .com/.services; inbound arrives over the tunnel). Bridged mode is future
    # work.
    NAT = "nat"


class VMProvisioningMode(enum.Enum):
    INSTALLER_ISO = "installerISO"
    PREBUILT_APPLIANCE = "prebuiltAppliance"


@dataclass(frozen=True)
class VMConfig:
    name: str
    server_domain: str
    username: str
    server_name: str
    cpu_count: int
    memory_bytes: int
    main_disk_size_bytes: int
    network_mode: VMNetworkMode
    # True iff the recipe carries the unsigned debugGrant sibling. Gates the
    # serial console AND the SSH host-forward: a production VM gets neither. The
    # host app must NEVER mount a production VM's disk or inject users to get
    # around it — the gate is the phone-signed grant, period.
    serial_console_enabled: bool
    # From the SIGNED blob: "auto" | "approve" (absent => "auto").
    boot_unlock_mode: str
    # From the SIGNED blob: whether the guest root is LUKS-encrypted.
    disk_encrypted: bool
    # Guest architecture — always the HOST's arch (KVM can't cross-run; TCG
    # could but would be dishonestly slow). "amd64" on x86 hosts, "arm64" on
    # arm64 Chromebooks/SBCs. Legacy bundles (no persisted arch) are amd64.
    arch: str = "amd64"
    provision_status_serial: str | None = None
    provisioning_mode: VMProvisioningMode = VMProvisioningMode.INSTALLER_ISO

    @property
    def awaits_phone_unlock_at_boot(self) -> bool:
        """Whether a boot passes through the sealed "waiting for you to unlock"
        state: an encrypted guest halts in the initramfs until the phone-home
        unlock supplies the key. An unencrypted guest boots straight through."""
        return self.disk_encrypted

    @staticmethod
    def plan(
        fields: RecipeFields,
        recipe_json: bytes,
        host: HostResources,
        main_disk_size_bytes: int = resource_plan.DEFAULT_MAIN_DISK_SIZE_BYTES,
        arch: str = "amd64",
        provisioning_mode: VMProvisioningMode = VMProvisioningMode.INSTALLER_ISO,
    ) -> "VMConfig":
        """Build the spec for a verified recipe on this host. Deterministic: the
        same recipe bytes + host always produce the same config.

        recipe_json is the RAW recipe document (needed for the unsigned
        debugGrant sibling, which read_recipe_fields deliberately omits)."""
        return VMConfig(
            name=fields.server_domain,
            server_domain=fields.server_domain,
            username=fields.username,
            server_name=fields.server_name,
            cpu_count=resource_plan.vm_cpu_count(host),
            memory_bytes=resource_plan.vm_memory_bytes(host),
            main_disk_size_bytes=main_disk_size_bytes,
            network_mode=VMNetworkMode.NAT,
            serial_console_enabled=recipe_info.debug_grant(recipe_json) is not None,
            boot_unlock_mode=fields.effective_boot_unlock_mode,
            disk_encrypted=fields.encrypts_disk,
            arch=arch,
            provision_status_serial=fields.auth_code_serial,
            provisioning_mode=provisioning_mode,
        )
