"""Runtime orchestrator for hosted VMs.

Owns the inventory, one pure VMLifecycle per VM (the decision-maker), and one
QemuHost per live VM (the dumb executor). Every state change is persisted, so
the sidebar survives relaunches. Mirrors apps/builder-windows/src/VM/VMManager.cs
(HostedServer included — the pure presentation mapping the sidebar rows and the
detail pane bind to).

Threading: mutations may arrive from watcher/poll threads; `on_change` is fired
from whichever thread mutated — the GTK view marshals via GLib.idle_add, tests
run inline.
"""
from __future__ import annotations

import platform
import json
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import replace
from typing import Callable, Dict, List, Optional

from . import host_arch, kvm_probe, resource_plan
from .config import VMConfig
from .host_resources import HostResources
from .inventory import VMBundleLayout, VMInventoryStore, VMRecord, VMStoreError
from .lifecycle import (
    VMEvent,
    VMEventKind,
    VMFailurePhase,
    VMLifecycle,
    VMLifecycleError,
    VMState,
    VMStateKind,
    coming_up_is_stalled,
)
from .qemu_host import QemuHost, QemuHostError
from .qemu_locator import QemuLocatorError, QemuToolchain, locate
from .server_tier import ServerTier


_PROVISION_PHASES = {
    "booting", "partitioning", "installing", "downloading", "registering",
    "sealing", "installed", "pairing", "live", "error",
}
_SERIAL_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class InstallObservation:
    def __init__(self, phase: str, detail: Optional[str], updated_at: float) -> None:
        self.phase = phase
        self.detail = detail
        self.updated_at = updated_at

    @property
    def summary(self) -> str:
        if self.detail:
            return self.detail
        return {
            "booting": "Booting the installer",
            "partitioning": "Preparing the encrypted disk",
            "installing": "Installing Debian",
            "downloading": "Downloading Flagship software",
            "registering": "Registering the server",
            "sealing": "Sealing the disk key",
            "installed": "Installation complete",
            "pairing": "Pairing with your phone",
            "live": "Server is live",
            "error": "Installation reported an error",
        }.get(self.phase, "Waiting for an installer checkpoint")

    def stale_minutes(self, now: float) -> int:
        return max(0, int(now - self.updated_at) // 60)

    def is_stale(self, now: float) -> bool:
        return now - self.updated_at >= 180


class HostedServer:
    """One hosted server as the UI sees it: the persisted record + derived
    display properties. Pure presentation mapping — no QEMU, no filesystem."""

    def __init__(self, record: VMRecord) -> None:
        self.record = record
        self.install_observation: Optional[InstallObservation] = None

    @property
    def name(self) -> str:
        return self.record.config.name

    @property
    def display_name(self) -> str:
        """"home.harry" — the short server.username identity, matching the
        Mac/Windows sidebars."""
        c = self.record.config
        return f"{c.server_name}.{c.username}"

    @property
    def fqdn(self) -> str:
        return self.record.config.server_domain

    @property
    def badge_label(self) -> str:
        return self.record.tier.badge_label

    @property
    def state_label(self) -> str:
        return self.record.state.label

    @property
    def state_kind(self) -> VMStateKind:
        return self.record.state.kind

    @property
    def status_subtitle(self) -> str:
        s = self.record.state
        c = self.record.config
        if s.kind == VMStateKind.AWAITING_PHONE_UNLOCK:
            if c.boot_unlock_mode == "approve":
                return "The disk is sealed — approve the unlock on your phone."
            return "The disk is sealed — waiting for the phone-home unlock."
        if s.kind == VMStateKind.INSTALLING:
            observation = self.install_observation
            if observation is None:
                return "Waiting for the first guest checkpoint."
            now = time.time()
            if observation.is_stale(now):
                return (
                    f"No new guest checkpoint for {observation.stale_minutes(now)} minutes. "
                    f"Last reported: {observation.summary}. The VM may be stalled."
                )
            return f"{observation.summary}. Guest checkpoint is current."
        if s.kind == VMStateKind.RUNNING:
            return f"Serving at https://{c.server_domain}/"
        if s.kind == VMStateKind.FAILED:
            return s.failure.reason if s.failure else ""
        if s.kind in (VMStateKind.INSTALLED, VMStateKind.STOPPED):
            return "Start the server to bring it online."
        return "Preparing the installer…"

    def coming_up_stalled(self, now: float) -> bool:
        """True iff this sealed guest has awaited unlock past the stall
        threshold — the UI surfaces an advisory then (the poll keeps running)."""
        since = self.record.state_changed_at or self.record.created_at
        return coming_up_is_stalled(self.record.state.kind, now - since)

    def status_subtitle_at(self, now: float) -> str:
        """status_subtitle, but returns the stall advisory once a sealed guest
        has waited too long to come online."""
        if self.coming_up_stalled(now):
            return (
                "Taking longer than expected — the box may not have reached the "
                "network. Check that it's online, or power off and retry."
            )
        return self.status_subtitle

    @property
    def spec_summary(self) -> str:
        c = self.record.config
        enc = "Encrypted (LUKS)" if c.disk_encrypted else "Unencrypted"
        return (
            f"{c.cpu_count} vCPU · {c.memory_bytes // resource_plan.GIB} GiB RAM · "
            f"{c.main_disk_size_bytes // resource_plan.GIB} GiB disk · {enc}"
        )

    @property
    def can_start(self) -> bool:
        s = self.record.state
        return s.kind in (VMStateKind.INSTALLED, VMStateKind.STOPPED) or (
            s.kind == VMStateKind.FAILED
            and s.failure is not None
            and s.failure.phase == VMFailurePhase.RUN
        )

    @property
    def can_stop(self) -> bool:
        return self.record.state.kind in (
            VMStateKind.RUNNING,
            VMStateKind.AWAITING_PHONE_UNLOCK,
        )

    @property
    def can_cancel_install(self) -> bool:
        return self.record.state.kind == VMStateKind.INSTALLING

    @property
    def can_retry_install(self) -> bool:
        s = self.record.state
        return (
            s.kind == VMStateKind.FAILED
            and s.failure is not None
            and s.failure.phase == VMFailurePhase.INSTALL
        )

    @property
    def console_enabled(self) -> bool:
        return self.record.config.serial_console_enabled


def _default_unlock_probe(url: str) -> bool:
    """TLS terminates ON THE BOX (SNI passthrough), so ANY HTTP response —
    including an error status — proves the LUKS unlock completed, the daemon
    came up, and the tunnel serves. A refused/failed handshake means still
    sealed."""
    try:
        with urllib.request.urlopen(url, timeout=10):
            return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


class VMManager:
    """The runtime orchestrator. `host_factory` / `unlock_probe` /
    `unlock_interval` / `clock` are injectable for tests; production uses the
    defaults."""

    def __init__(
        self,
        store: VMInventoryStore,
        toolchain: Optional[QemuToolchain],
        toolchain_error: Optional[str] = None,
        accel: str = "kvm",
        accel_warning: Optional[str] = None,
        clock: Optional[Callable[[], float]] = None,
        host_factory: Optional[Callable[[], QemuHost]] = None,
        unlock_probe: Callable[[str], bool] = _default_unlock_probe,
        unlock_interval: float = 15.0,
        on_change: Optional[Callable[[], None]] = None,
        host_arch_tag: Optional[str] = host_arch.ARCH_AMD64,
    ) -> None:
        self.store = store
        self.toolchain = toolchain
        # The arch this machine can host (None = unsupported CPU). A config
        # whose arch differs is refused — cross-arch TCG would be dishonestly
        # slow, and the bundle was simply built on a different machine.
        self.host_arch_tag = host_arch_tag
        # Non-None when the QEMU toolchain could not be located; the host-here
        # path is disabled with this reason.
        self.toolchain_error = toolchain_error
        self.accel = accel
        # Non-None when KVM is unavailable and the VM would run under TCG —
        # hosting still works, honestly labeled as much slower.
        self.accel_warning = accel_warning
        self.servers: List[HostedServer] = []
        # Log sink — the wizard routes this into its log pane.
        self.log: Callable[[str], None] = lambda _m: None
        self.on_change = on_change or (lambda: None)
        self._clock = clock or time.time
        self._host_factory = host_factory or (
            lambda: QemuHost(self.toolchain, accel=self.accel)  # type: ignore[arg-type]
        )
        self._unlock_probe = unlock_probe
        self._unlock_interval = unlock_interval
        self._lifecycles: Dict[str, VMLifecycle] = {}
        self._hosts: Dict[str, QemuHost] = {}
        self._attach_iso: Dict[str, bool] = {}
        self._unlock_polls: Dict[str, threading.Event] = {}
        self._install_polls: Dict[str, threading.Event] = {}
        self._install_stall_logged: set[str] = set()
        self._load_and_normalize()

    @staticmethod
    def create_default(on_change: Optional[Callable[[], None]] = None) -> "VMManager":
        toolchain: Optional[QemuToolchain] = None
        error: Optional[str] = None
        host = host_arch.current()
        if host is None:
            error = (
                "Hosting isn't supported on this CPU architecture "
                f"({platform.machine()})."
            )
        else:
            try:
                toolchain = locate(arch=host)
            except QemuLocatorError as e:
                error = str(e)
        # KVM missing degrades to TCG with an honest warning (unlike Windows,
        # where no WHPX blocks hosting) — TCG genuinely works, just slowly.
        verdict = kvm_probe.probe()
        accel = "kvm" if verdict.is_available else "tcg"
        warning = (
            None
            if verdict.is_available
            else f"{verdict.message} The VM will run without hardware "
            "acceleration (much slower)."
        )
        return VMManager(
            VMInventoryStore(VMBundleLayout.default_root()),
            toolchain,
            error,
            accel=accel,
            accel_warning=warning,
            on_change=on_change,
            host_arch_tag=host,
        )

    # ---- capacity (pure cap math passthrough) ----

    @property
    def max_vm_count(self) -> int:
        return resource_plan.max_vm_count(HostResources.current())

    @property
    def at_capacity(self) -> bool:
        return len(self.servers) >= self.max_vm_count

    def server(self, name: str) -> Optional[HostedServer]:
        for s in self.servers:
            if s.name == name:
                return s
        return None

    def host(self, name: str) -> Optional[QemuHost]:
        """The live QEMU adapter for a VM (SSH/console ports), if running."""
        return self._hosts.get(name)

    def installer_iso_path(self, name: str) -> str:
        return self.store.layout.installer_iso_path(name)

    def appliance_seed_path(self, name: str) -> str:
        return self.store.layout.appliance_seed_path(name)

    # ---- launch normalization ----

    def _load_and_normalize(self) -> None:
        """VMs die with the app, so any persisted "live" state found at launch
        is stale: a mid-install VM becomes a retryable install failure; a
        booted one is simply stopped."""
        for record in self.store.list():
            kind = record.state.kind
            if kind == VMStateKind.INSTALLING:
                normalized = VMRecord(
                    config=record.config,
                    state=VMState.failed(
                        VMFailurePhase.INSTALL,
                        "The app quit while the install was running.",
                    ),
                    created_at=record.created_at,
                    tier=record.tier,
                    state_changed_at=self._clock(),
                )
            elif kind in (VMStateKind.AWAITING_PHONE_UNLOCK, VMStateKind.RUNNING):
                normalized = VMRecord(
                    config=record.config,
                    state=VMState.stopped(),
                    created_at=record.created_at,
                    tier=record.tier,
                    state_changed_at=self._clock(),
                )
            else:
                normalized = record
            if normalized is not record:
                try:
                    self.store.save(normalized)
                except VMStoreError:
                    pass
            self.servers.append(HostedServer(normalized))

    # ---- creation / deletion ----

    def arch_refusal(self, config: VMConfig) -> Optional[str]:
        """Why this config can't run on this machine (None = it can). KVM
        boots native-arch guests only; cross-arch TCG would be dishonestly
        slow — a bundle built for another arch belongs on that machine."""
        if self.host_arch_tag is not None and config.arch != self.host_arch_tag:
            return (
                f"'{config.name}' was built for {config.arch}, but this "
                f"machine hosts {self.host_arch_tag} — it can't run here."
            )
        return None

    def create_server(self, config: VMConfig) -> None:
        """Create the persistent bundle for a planned VM. The caller (wizard)
        then remasters the installer ISO into installer_iso_path(name) and
        calls begin_install."""
        refusal = self.arch_refusal(config)
        if refusal is not None:
            raise ValueError(refusal)
        now = self._clock()
        record = VMRecord(
            config=config,
            state=VMState.created(),
            created_at=now,
            tier=ServerTier.HOSTED_VM,
            state_changed_at=now,
        )
        self.store.create(record)
        self._insert_sorted(HostedServer(record))
        self._lifecycles[config.name] = VMLifecycle(
            config.awaits_phone_unlock_at_boot, VMState.created(), self._clock
        )
        self.on_change()

    def delete_server(self, name: str) -> None:
        """Drop a hosted server entirely (its disk image included). Stops it
        first if live."""
        host = self._hosts.pop(name, None)
        if host is not None:
            try:
                host.on_guest_stopped = None
                host.force_stop()
            except Exception:
                pass
        self._lifecycles.pop(name, None)
        self._cancel_unlock_poll(name)
        self._cancel_install_poll(name)
        try:
            self.store.delete(name)
        except VMStoreError:
            pass
        server = self.server(name)
        if server is not None:
            self.servers.remove(server)
        self.on_change()

    # ---- lifecycle driving ----

    def begin_install(self, name: str) -> None:
        self._apply(VMEvent.start_install(), name)

    def cancel_install(self, name: str) -> None:
        self._apply(VMEvent.install_failed("Installation stopped by you."), name)

    def power_on(self, name: str) -> None:
        self._apply(VMEvent.power_on(), name)

    def power_off(self, name: str) -> None:
        self._apply(VMEvent.power_off(), name)

    def _apply(self, event: VMEvent, name: str) -> None:
        """Feed one event through the pure state machine, persist the new
        state, and execute the effects it ordered."""
        server = self.server(name)
        if server is None:
            return
        if event.kind in (VMEventKind.START_INSTALL, VMEventKind.POWER_ON):
            refusal = self.arch_refusal(server.record.config)
            if refusal is not None:
                self.log(f"VM {name}: {refusal}")
                return
        lc = self._lifecycles.get(name)
        if lc is None:
            lc = VMLifecycle(
                server.record.config.awaits_phone_unlock_at_boot,
                server.record.state,
                self._clock,
            )
            self._lifecycles[name] = lc
        try:
            effects = lc.handle(event)
        except VMLifecycleError:
            self.log(f"VM {name}: ignored {event.kind.value} in state {server.record.state.label}")
            return
        config = server.record.config
        if lc.state.kind == VMStateKind.INSTALLED:
            config = replace(config, provision_status_serial=None)
        server.record = VMRecord(
            config=config,
            state=lc.state,
            created_at=server.record.created_at,
            tier=server.record.tier,
            state_changed_at=lc.state_changed_at,
        )
        try:
            self.store.save(server.record)
        except VMStoreError:
            pass
        self.on_change()
        self._run_effects(effects, server.record.config)
        self._sync_unlock_poll(server.record.config)
        self._sync_install_poll(server.record.config)

    def _run_effects(self, effects, config: VMConfig) -> None:
        import os

        from .lifecycle import VMEffect

        name = config.name
        for effect in effects:
            if effect == VMEffect.ATTACH_INSTALLER_ISO:
                self._attach_iso[name] = True
            elif effect == VMEffect.DETACH_INSTALLER_ISO:
                self._attach_iso[name] = False
                # Reclaim the (large) single-use installer once the install
                # SUCCEEDED; a failed install keeps it so retry can re-attach.
                if self._current_state_kind(name) == VMStateKind.INSTALLED:
                    try:
                        media = (
                            self.store.layout.appliance_seed_path(name)
                            if config.provisioning_mode.value == "prebuiltAppliance"
                            else self.store.layout.installer_iso_path(name)
                        )
                        os.unlink(media)
                    except OSError:
                        pass
            elif effect == VMEffect.START_VIRTUAL_MACHINE:
                self._start_vm(config)
            elif effect == VMEffect.STOP_VIRTUAL_MACHINE:
                host = self._hosts.pop(name, None)
                if host is not None:
                    try:
                        host.on_guest_stopped = None
                        host.force_stop()
                    except Exception:
                        pass

    def _current_state_kind(self, name: str) -> VMStateKind:
        server = self.server(name)
        return server.record.state.kind if server else VMStateKind.CREATED

    def _start_vm(self, config: VMConfig) -> None:
        name = config.name
        if self.toolchain is None:
            reason = self.toolchain_error or "QEMU is not installed."
            self.log(f"VM {name}: cannot start — {reason}")
            self._fail_from_state(name, reason)
            return
        try:
            host = self._host_factory()
            host.on_guest_stopped = lambda code, tail: self._guest_stopped(name, code, tail)
            self._hosts[name] = host
            host.start(config, self.store.layout, bool(self._attach_iso.get(name)))
            self.log(
                f"VM {name}: started ({config.cpu_count} vCPU, "
                f"{config.memory_bytes // resource_plan.GIB} GiB, {self.accel})"
            )
        except (QemuHostError, OSError) as e:
            self._hosts.pop(name, None)
            self.log(f"VM {name}: failed to start — {e}")
            self._fail_from_state(name, str(e))

    def _fail_from_state(self, name: str, reason: str) -> None:
        kind = self._current_state_kind(name)
        if kind == VMStateKind.INSTALLING:
            self._apply(VMEvent.install_failed(reason), name)
        elif kind in (VMStateKind.AWAITING_PHONE_UNLOCK, VMStateKind.RUNNING):
            self._apply(VMEvent.runtime_failed(reason), name)

    def _guest_stopped(self, name: str, exit_code: int, stderr_tail: str) -> None:
        """The guest stopped on its own. What it MEANS depends on the phase the
        pure lifecycle is in. During install a clean stop is AMBIGUOUS
        (success-poweroff / completed-install reboot / never-booted all look
        identical), so it goes through the duration-gated verdict."""
        self._hosts.pop(name, None)
        kind = self._current_state_kind(name)
        if kind == VMStateKind.INSTALLING:
            if exit_code != 0:
                self._apply(
                    VMEvent.install_failed(f"QEMU exited {exit_code}: {stderr_tail.strip()}"),
                    name,
                )
                return
            lc = self._lifecycles.get(name)
            from .config import VMProvisioningMode
            from .lifecycle import verdict_for_clean_provisioning_stop
            verdict = VMEvent.install_succeeded()
            if lc is not None:
                verdict = verdict_for_clean_provisioning_stop(
                    self._clock() - lc.state_changed_at,
                    self.server(name).record.config.provisioning_mode
                        == VMProvisioningMode.PREBUILT_APPLIANCE,
                )
            if verdict.kind == VMEventKind.INSTALL_SUCCEEDED:
                verb = (
                    "specialization"
                    if self.server(name).record.config.provisioning_mode
                        == VMProvisioningMode.PREBUILT_APPLIANCE
                    else "install"
                )
                self.log(f"VM {name}: {verb} finished — booting sealed disk")
                self._apply(VMEvent.install_succeeded(), name)
                # First boot from disk follows immediately; an encrypted guest
                # then sits sealed in awaiting-phone-unlock.
                self._apply(VMEvent.power_on(), name)
            else:
                self.log(f"VM {name}: {verdict.reason}")
                self._apply(verdict, name)
        elif kind in (VMStateKind.AWAITING_PHONE_UNLOCK, VMStateKind.RUNNING):
            if exit_code != 0:
                self._apply(
                    VMEvent.runtime_failed(f"QEMU exited {exit_code}: {stderr_tail.strip()}"),
                    name,
                )
            else:
                self._apply(VMEvent.power_off(), name)

    # ---- unlock detection ----

    def _sync_unlock_poll(self, config: VMConfig) -> None:
        """While a guest sits sealed, poll its public FQDN. Any HTTP response
        proves the unlock completed and the tunnel serves — real evidence, not
        a timer. The host app is not in the unlock loop and never holds a
        key."""
        name = config.name
        if self._current_state_kind(name) != VMStateKind.AWAITING_PHONE_UNLOCK:
            self._cancel_unlock_poll(name)
            return
        if name in self._unlock_polls:
            return
        stop = threading.Event()
        self._unlock_polls[name] = stop
        url = f"https://{config.server_domain}/"

        def poll() -> None:
            while not stop.is_set():
                if self._unlock_probe(url):
                    if not stop.is_set():
                        self._apply(VMEvent.guest_unlocked(), name)
                    return
                stop.wait(self._unlock_interval)

        threading.Thread(target=poll, daemon=True).start()

    def _cancel_unlock_poll(self, name: str) -> None:
        stop = self._unlock_polls.pop(name, None)
        if stop is not None:
            stop.set()

    # ---- privacy-safe install checkpoints ----

    def _sync_install_poll(self, config: VMConfig) -> None:
        name = config.name
        if self._current_state_kind(name) != VMStateKind.INSTALLING:
            self._cancel_install_poll(name)
            self._install_stall_logged.discard(name)
            return
        serial = config.provision_status_serial
        if name in self._install_polls or not serial or not _SERIAL_RE.fullmatch(serial):
            return
        server = self.server(name)
        started_at = server.record.state_changed_at if server else self._clock()
        stop = threading.Event()
        self._install_polls[name] = stop
        url = f"https://flagshipserver.com/api/order/{serial}/status"

        def poll() -> None:
            while not stop.is_set():
                try:
                    with urllib.request.urlopen(url, timeout=10) as response:
                        raw = json.load(response)
                    phase = raw.get("phase")
                    updated_at = float(raw.get("updatedAt", 0)) / 1000
                    if phase in _PROVISION_PHASES and updated_at >= started_at - 30:
                        detail = raw.get("detail")
                        if isinstance(detail, str):
                            detail = "".join(c for c in detail if c.isprintable())[:240]
                        else:
                            detail = None
                        observation = InstallObservation(phase, detail, updated_at)
                        current = self.server(name)
                        if current is not None:
                            prior = current.install_observation
                            current.install_observation = observation
                            if prior is None or (
                                prior.phase, prior.detail, prior.updated_at
                            ) != (observation.phase, observation.detail, observation.updated_at):
                                self.log(f"VM {name}: installer checkpoint — {observation.summary}")
                                self.on_change()
                            if not observation.is_stale(self._clock()):
                                self._install_stall_logged.discard(name)
                except Exception:
                    pass
                current = self.server(name)
                observation = current.install_observation if current else None
                if (
                    observation is not None
                    and observation.is_stale(self._clock())
                    and name not in self._install_stall_logged
                ):
                    self._install_stall_logged.add(name)
                    self.log(
                        f"VM {name}: no guest checkpoint for "
                        f"{observation.stale_minutes(self._clock())} minutes; "
                        f"last: {observation.summary}"
                    )
                    self.on_change()
                stop.wait(15)

        threading.Thread(target=poll, daemon=True).start()

    def _cancel_install_poll(self, name: str) -> None:
        stop = self._install_polls.pop(name, None)
        if stop is not None:
            stop.set()

    # ---- plumbing ----

    def _insert_sorted(self, server: HostedServer) -> None:
        i = 0
        while i < len(self.servers) and self.servers[i].name < server.name:
            i += 1
        self.servers.insert(i, server)
