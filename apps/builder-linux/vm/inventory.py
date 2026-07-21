"""On-disk inventory of hosted VMs + the bundle layout + FQDN name validation.

Mirrors apps/builder-windows/src/VM/VMInventoryStore.cs with Linux-native
storage: each VM bundle is a directory under the XDG data dir holding a qcow2
main disk (sparse), the remastered installer ISO (install phase only), the
per-VM OVMF variable store, an optional serial transcript, and config.json.

The FQDN name validation is pinned by the shared golden vectors — it must match
the Mac + Windows cores exactly.
"""
from __future__ import annotations

import enum
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from .config import VMConfig, VMNetworkMode
from .lifecycle import VMFailure, VMFailurePhase, VMState, VMStateKind
from .server_tier import ServerTier


@dataclass(frozen=True)
class VMBundleLayout:
    root: str

    @staticmethod
    def default_root() -> "VMBundleLayout":
        """Production default: $XDG_DATA_HOME/flagship-builder/VMs
        (falls back to ~/.local/share/…)."""
        data_home = os.environ.get("XDG_DATA_HOME")
        if not data_home:
            data_home = str(Path.home() / ".local" / "share")
        return VMBundleLayout(str(Path(data_home) / "flagship-builder" / "VMs"))

    def bundle_dir(self, name: str) -> str:
        return str(Path(self.root) / name)

    def config_path(self, name: str) -> str:
        return str(Path(self.bundle_dir(name)) / "config.json")

    def disk_image_path(self, name: str) -> str:
        return str(Path(self.bundle_dir(name)) / "disk.qcow2")

    def installer_iso_path(self, name: str) -> str:
        return str(Path(self.bundle_dir(name)) / "installer.iso")

    def efi_variable_store_path(self, name: str) -> str:
        return str(Path(self.bundle_dir(name)) / "efi-vars.fd")

    def console_log_path(self, name: str) -> str:
        return str(Path(self.bundle_dir(name)) / "console.log")


@dataclass(frozen=True)
class VMRecord:
    config: VMConfig
    state: VMState
    created_at: float
    tier: ServerTier = ServerTier.HOSTED_VM
    # When the current state was entered (mirrors macOS VMRecord.stateChangedAt).
    # Drives the "still coming up" stall advisory. 0.0 (legacy bundles) ⇒ callers
    # fall back to created_at.
    state_changed_at: float = 0.0


class VMStoreErrorKind(enum.Enum):
    INVALID_NAME = "invalid-name"
    ALREADY_EXISTS = "already-exists"
    NOT_FOUND = "not-found"


class VMStoreError(Exception):
    def __init__(self, kind: VMStoreErrorKind, name: str) -> None:
        msg = {
            VMStoreErrorKind.INVALID_NAME: f"'{name}' is not a valid server name.",
            VMStoreErrorKind.ALREADY_EXISTS: f"A hosted server named '{name}' already exists.",
            VMStoreErrorKind.NOT_FOUND: f"No hosted server named '{name}'.",
        }[kind]
        super().__init__(msg)
        self.kind = kind
        self.name = name


# ---- JSON codecs (self-consistent; only Linux reads these back) ----


def _config_to_dict(c: VMConfig) -> dict:
    return {
        "name": c.name,
        "serverDomain": c.server_domain,
        "username": c.username,
        "serverName": c.server_name,
        "cpuCount": c.cpu_count,
        "memoryBytes": c.memory_bytes,
        "mainDiskSizeBytes": c.main_disk_size_bytes,
        "networkMode": c.network_mode.value,
        "serialConsoleEnabled": c.serial_console_enabled,
        "bootUnlockMode": c.boot_unlock_mode,
        "diskEncrypted": c.disk_encrypted,
        "arch": c.arch,
        "provisionStatusSerial": c.provision_status_serial,
    }


def _config_from_dict(d: dict) -> VMConfig:
    return VMConfig(
        name=d["name"],
        server_domain=d["serverDomain"],
        username=d["username"],
        server_name=d["serverName"],
        cpu_count=int(d["cpuCount"]),
        memory_bytes=int(d["memoryBytes"]),
        main_disk_size_bytes=int(d["mainDiskSizeBytes"]),
        network_mode=VMNetworkMode(d.get("networkMode", "nat")),
        serial_console_enabled=bool(d["serialConsoleEnabled"]),
        boot_unlock_mode=d["bootUnlockMode"],
        disk_encrypted=bool(d["diskEncrypted"]),
        # Legacy bundles predate multi-arch hosting and are all amd64.
        arch=d.get("arch", "amd64"),
        provision_status_serial=d.get("provisionStatusSerial"),
    )


def _state_to_dict(s: VMState) -> dict:
    out: dict = {"kind": s.kind.value}
    if s.kind == VMStateKind.FAILED and s.failure is not None:
        out["failure"] = {"phase": s.failure.phase.value, "reason": s.failure.reason}
    return out


def _state_from_dict(d: dict) -> VMState:
    kind = VMStateKind(d["kind"])
    if kind == VMStateKind.FAILED:
        f = d["failure"]
        return VMState.failed(VMFailurePhase(f["phase"]), f.get("reason", ""))
    return VMState(kind)


def _record_to_dict(r: VMRecord) -> dict:
    return {
        "config": _config_to_dict(r.config),
        "state": _state_to_dict(r.state),
        "createdAt": r.created_at,
        # Written raw (round-trip identity); the created_at fallback for a 0.0 /
        # legacy value is applied at use time (HostedServer.coming_up_stalled).
        "stateChangedAt": r.state_changed_at,
        "tier": r.tier.value,
    }


def _record_from_dict(d: dict) -> VMRecord:
    created = float(d.get("createdAt", 0.0))
    return VMRecord(
        config=_config_from_dict(d["config"]),
        state=_state_from_dict(d.get("state", {"kind": "created"})),
        created_at=created,
        tier=ServerTier(d.get("tier", "hosted-vm")),
        # Legacy bundles predate the field ⇒ fall back to created_at.
        state_changed_at=float(d.get("stateChangedAt", created)),
    )


class VMInventoryStore:
    """Inventory of hosted VMs under an injected filesystem root — the app
    passes VMBundleLayout.default_root(), tests a temp dir."""

    def __init__(self, layout: VMBundleLayout) -> None:
        self.layout = layout

    def list(self) -> List[VMRecord]:
        """All persisted records, sorted by name. Entries whose config.json is
        missing/unreadable are skipped (never fatal to the rest)."""
        try:
            names = sorted(
                p.name for p in Path(self.layout.root).iterdir() if p.is_dir()
            )
        except (FileNotFoundError, NotADirectoryError, PermissionError, OSError):
            return []
        records: List[VMRecord] = []
        for name in names:
            try:
                records.append(self.load(name))
            except Exception:
                continue
        return records

    def load(self, name: str) -> VMRecord:
        path = self.layout.config_path(name)
        if not os.path.exists(path):
            raise VMStoreError(VMStoreErrorKind.NOT_FOUND, name)
        self._harden_permissions(name)
        with open(path, "rb") as f:
            return _record_from_dict(json.load(f))

    def create(self, record: VMRecord) -> None:
        """Create the bundle directory + initial config.json. Refuses to
        clobber."""
        name = record.config.name
        self.validate_name(name)
        d = self.layout.bundle_dir(name)
        if os.path.exists(d):
            raise VMStoreError(VMStoreErrorKind.ALREADY_EXISTS, name)
        os.makedirs(d, exist_ok=False)
        os.chmod(d, 0o700)
        self._write(record)

    def save(self, record: VMRecord) -> None:
        """Persist an updated record (state changes etc.). The bundle must
        exist."""
        name = record.config.name
        if not os.path.isdir(self.layout.bundle_dir(name)):
            raise VMStoreError(VMStoreErrorKind.NOT_FOUND, name)
        self._write(record)

    def delete(self, name: str) -> None:
        """Remove the whole bundle (disk image included)."""
        import shutil

        d = self.layout.bundle_dir(name)
        if not os.path.isdir(d):
            raise VMStoreError(VMStoreErrorKind.NOT_FOUND, name)
        shutil.rmtree(d)

    def _write(self, record: VMRecord) -> None:
        data = json.dumps(_record_to_dict(record), indent=2).encode("utf-8")
        path = self.layout.config_path(record.config.name)
        # Atomic-ish: write a sibling temp file then move over the target.
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)

    def _harden_permissions(self, name: str) -> None:
        paths = (
            self.layout.config_path(name),
            self.layout.disk_image_path(name),
            self.layout.installer_iso_path(name),
            self.layout.efi_variable_store_path(name),
            self.layout.console_log_path(name),
        )
        try:
            os.chmod(self.layout.bundle_dir(name), 0o700)
        except OSError:
            pass
        for path in paths:
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass

    # ---- FQDN name validation (pinned by the shared golden vectors) ----

    @staticmethod
    def validate_name(name: str) -> None:
        """Bundle names are server FQDNs — plain hostnames. Reject anything that
        could escape the root or collide with the filesystem: lowercase a-z 0-9
        . - only; non-empty; not "."/".."; no LEADING dot; no TRAILING dot
        (leading dashes ARE allowed, double dots ARE allowed)."""
        allowed = set("abcdefghijklmnopqrstuvwxyz0123456789.-")
        if (
            not name
            or name in (".", "..")
            or name.startswith(".")
            or name.endswith(".")
            or any(c not in allowed for c in name)
        ):
            raise VMStoreError(VMStoreErrorKind.INVALID_NAME, name)

    @staticmethod
    def is_valid_name(name: str) -> bool:
        try:
            VMInventoryStore.validate_name(name)
            return True
        except VMStoreError:
            return False
