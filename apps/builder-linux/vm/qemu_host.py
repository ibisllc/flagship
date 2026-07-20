"""The ONE file that runs QEMU.

Deliberately dumb: it translates a pure VMConfig (all decisions already made —
see qemu_command_line.py) into a process and starts/stops it. The pure layer is
what's unit-tested; this adapter is exercised by the live e2e boot. Mirrors
apps/builder-windows/src/VM/QemuHost.cs (the Mac analog is VZHost).

on_guest_stopped fires when the guest stops on its own — install completion
(the preseed/-no-reboot end the process) or a crash. The pure lifecycle decides
what it means (for installs, via the duration-gated verdict).
"""
from __future__ import annotations

import shutil
import socket
import subprocess
import threading
import time
from typing import Callable, Optional

from . import qemu_command_line
from .config import VMConfig
from .inventory import VMBundleLayout
from .qemu_locator import QemuToolchain
from .qmp_client import QmpClient, QmpError
from .resource_plan import GIB


class QemuHostError(Exception):
    pass


def _free_loopback_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _tail(text: str, limit: int = 2000) -> str:
    return text if len(text) <= limit else text[-limit:]


class QemuHost:
    """One live qemu-system-x86_64 process. `accel` is decided by the manager
    ("kvm" normally; "tcg" when the KVM probe said no, with a warning)."""

    def __init__(self, toolchain: QemuToolchain, accel: str = "kvm") -> None:
        self._toolchain = toolchain
        self._accel = accel
        self._proc: Optional[subprocess.Popen] = None
        self.qmp_port = 0
        # 0 when stopped or production — the console device / SSH forward only
        # exist under a debug grant.
        self.serial_port = 0
        self.ssh_port = 0
        # Fired (on a watcher thread) when the guest stops for ANY reason:
        # (exit_code, stderr_tail). The caller marshals to its own context.
        self.on_guest_stopped: Optional[Callable[[int, str], None]] = None

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def ensure_bundle_artifacts(self, config: VMConfig, layout: VMBundleLayout) -> None:
        """Create the sparse main disk (qcow2 grows into it) + the per-VM OVMF
        vars copy if they don't exist yet. Idempotent."""
        import os

        disk = layout.disk_image_path(config.name)
        if not os.path.exists(disk):
            gib = config.main_disk_size_bytes // GIB
            r = subprocess.run(
                [self._toolchain.img_binary, "create", "-f", "qcow2", disk, f"{gib}G"],
                capture_output=True,
                text=True,
            )
            if r.returncode != 0:
                raise QemuHostError(
                    f"qemu-img create failed ({r.returncode}): {r.stderr.strip()}"
                )
        vars_path = layout.efi_variable_store_path(config.name)
        if not os.path.exists(vars_path):
            shutil.copyfile(self._toolchain.uefi_vars_template, vars_path)

    def start(self, config: VMConfig, layout: VMBundleLayout, attach_installer_iso: bool) -> None:
        """Start the VM. attach_installer_iso mirrors the lifecycle effects."""
        if self.is_running:
            raise QemuHostError(f"VM '{config.name}' is already running.")
        self.ensure_bundle_artifacts(config, layout)

        self.qmp_port = _free_loopback_port()
        self.serial_port = _free_loopback_port() if config.serial_console_enabled else 0
        # SSH forward only for a debug VM, and never during the install phase
        # (the guest isn't a running system yet).
        self.ssh_port = (
            _free_loopback_port()
            if config.serial_console_enabled and not attach_installer_iso
            else 0
        )
        args = qemu_command_line.build(
            config,
            layout,
            self._toolchain.uefi_code_path,
            attach_installer_iso,
            self.qmp_port,
            self.serial_port,
            self.ssh_port,
            accel=self._accel,
        )

        proc = subprocess.Popen(
            [self._toolchain.system_binary, *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        self._proc = proc

        stderr_box: list[str] = []

        def watch() -> None:
            try:
                stderr_box.append(proc.stderr.read() if proc.stderr else "")
            except Exception:
                stderr_box.append("")
            code = proc.wait()
            self._proc = None
            self.qmp_port = 0
            self.serial_port = 0
            self.ssh_port = 0
            cb = self.on_guest_stopped
            if cb is not None:
                cb(code, _tail(stderr_box[0] if stderr_box else ""))

        threading.Thread(target=watch, daemon=True).start()

        # Surface an immediate startup failure (bad args, KVM refusal) as a
        # thrown error rather than a phantom "running" VM.
        time.sleep(0.75)
        if proc.poll() is not None:
            self.on_guest_stopped = None
            tail = _tail(stderr_box[0] if stderr_box else "")
            raise QemuHostError(f"QEMU failed to start (exit {proc.returncode}): {tail.strip()}")

    def stop(self, grace_seconds: int = 90) -> None:
        """Ask the guest to power down cleanly (ACPI); after grace_seconds
        without an exit, hard-stop. on_guest_stopped carries the final word."""
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            with QmpClient.connect(self.qmp_port, timeout=5.0) as qmp:
                qmp.system_powerdown()
        except (OSError, QmpError):
            pass  # QMP unreachable — fall through to the hard stop below.
        try:
            proc.wait(timeout=grace_seconds)
            return
        except subprocess.TimeoutExpired:
            pass
        self.force_stop()

    def force_stop(self) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            with QmpClient.connect(self.qmp_port, timeout=3.0) as qmp:
                qmp.quit()
            proc.wait(timeout=3)
            return
        except (OSError, QmpError, subprocess.TimeoutExpired):
            pass
        try:
            proc.kill()
            proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
