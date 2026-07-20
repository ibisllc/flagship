"""One hosted VM's lifecycle — pure and event-driven.

The host (QEMU adapter / UI) feeds it events and executes the effects it
returns; nothing in here touches QEMU, the filesystem, or a real clock.

    created --startInstall--> installing (installer ISO attached)
    installing --installSucceeded--> installed (ISO DETACHED — from here the
                                      guest boots from its own disk)
    installed/stopped --powerOn--> awaitingPhoneUnlock  (encrypted guest:
                                      sealed in the initramfs until the
                                      phone-home unlock answers)
                                                      `----> running            (unencrypted guest)
    awaitingPhoneUnlock --guestUnlocked--> running
    running/awaitingPhoneUnlock --powerOff--> stopped
    + failure states (install / run), each retryable.

Mirrors apps/burner-windows/src/VM/VMLifecycle.cs; the shared contract is
pinned by apps/desktop-shared/golden/vm-core-vectors.json.
"""
from __future__ import annotations

import enum
import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple


class VMFailurePhase(enum.Enum):
    INSTALL = "install"
    RUN = "run"


@dataclass(frozen=True)
class VMFailure:
    phase: VMFailurePhase
    reason: str


class VMStateKind(enum.Enum):
    CREATED = "created"
    INSTALLING = "installing"
    INSTALLED = "installed"
    AWAITING_PHONE_UNLOCK = "awaitingPhoneUnlock"
    RUNNING = "running"
    STOPPED = "stopped"
    FAILED = "failed"


@dataclass(frozen=True)
class VMState:
    kind: VMStateKind
    failure: Optional[VMFailure] = None

    # Singleton-style constructors mirroring the C# static readonly fields.
    @staticmethod
    def created() -> "VMState":
        return VMState(VMStateKind.CREATED)

    @staticmethod
    def installing() -> "VMState":
        return VMState(VMStateKind.INSTALLING)

    @staticmethod
    def installed() -> "VMState":
        return VMState(VMStateKind.INSTALLED)

    @staticmethod
    def awaiting_phone_unlock() -> "VMState":
        return VMState(VMStateKind.AWAITING_PHONE_UNLOCK)

    @staticmethod
    def running() -> "VMState":
        return VMState(VMStateKind.RUNNING)

    @staticmethod
    def stopped() -> "VMState":
        return VMState(VMStateKind.STOPPED)

    @staticmethod
    def failed(phase: VMFailurePhase, reason: str) -> "VMState":
        return VMState(VMStateKind.FAILED, VMFailure(phase, reason))

    @property
    def label(self) -> str:
        """User-facing status label (sidebar / detail)."""
        if self.kind == VMStateKind.CREATED:
            return "Created"
        if self.kind == VMStateKind.INSTALLING:
            return "Installing…"
        if self.kind == VMStateKind.INSTALLED:
            return "Installed"
        if self.kind == VMStateKind.AWAITING_PHONE_UNLOCK:
            return "Waiting for you to unlock"
        if self.kind == VMStateKind.RUNNING:
            return "Running"
        if self.kind == VMStateKind.STOPPED:
            return "Stopped"
        if self.kind == VMStateKind.FAILED:
            return "Install failed" if (self.failure and self.failure.phase == VMFailurePhase.INSTALL) else "Stopped unexpectedly"
        return "Unknown"


class VMEventKind(enum.Enum):
    START_INSTALL = "startInstall"
    INSTALL_SUCCEEDED = "installSucceeded"
    INSTALL_FAILED = "installFailed"
    POWER_ON = "powerOn"
    GUEST_UNLOCKED = "guestUnlocked"
    POWER_OFF = "powerOff"
    RUNTIME_FAILED = "runtimeFailed"


@dataclass(frozen=True)
class VMEvent:
    kind: VMEventKind
    reason: Optional[str] = None

    @staticmethod
    def start_install() -> "VMEvent":
        return VMEvent(VMEventKind.START_INSTALL)

    @staticmethod
    def install_succeeded() -> "VMEvent":
        return VMEvent(VMEventKind.INSTALL_SUCCEEDED)

    @staticmethod
    def install_failed(reason: str) -> "VMEvent":
        return VMEvent(VMEventKind.INSTALL_FAILED, reason)

    @staticmethod
    def power_on() -> "VMEvent":
        return VMEvent(VMEventKind.POWER_ON)

    @staticmethod
    def guest_unlocked() -> "VMEvent":
        return VMEvent(VMEventKind.GUEST_UNLOCKED)

    @staticmethod
    def power_off() -> "VMEvent":
        return VMEvent(VMEventKind.POWER_OFF)

    @staticmethod
    def runtime_failed(reason: str) -> "VMEvent":
        return VMEvent(VMEventKind.RUNTIME_FAILED, reason)


class VMEffect(enum.Enum):
    ATTACH_INSTALLER_ISO = "attachInstallerISO"
    DETACH_INSTALLER_ISO = "detachInstallerISO"
    START_VIRTUAL_MACHINE = "startVirtualMachine"
    STOP_VIRTUAL_MACHINE = "stopVirtualMachine"


class VMLifecycleError(Exception):
    def __init__(self, from_state: VMState, on_event: VMEvent) -> None:
        super().__init__(f"Invalid VM transition: {from_state.kind.value} on {on_event.kind.value}.")
        self.from_state = from_state
        self.on_event = on_event


# A hypervisor-level clean guest-stop during install is AMBIGUOUS
# (success-poweroff / completed-install reboot / never-booted all look
# identical), so the verdict is duration-gated. The Mac Phase-0 boot proved the
# only reliable discriminator is elapsed time — a real unattended Debian
# install cannot complete faster than this. Edge: exactly the minimum counts as
# success.
MIN_PLAUSIBLE_INSTALL_SECONDS = 90.0


def verdict_for_clean_install_stop(elapsed_seconds: float) -> VMEvent:
    """The duration-gated verdict for a clean guest-stop observed while
    installing. Pure — pinned by the shared golden vectors."""
    if elapsed_seconds >= MIN_PLAUSIBLE_INSTALL_SECONDS:
        return VMEvent.install_succeeded()
    secs = int(round(elapsed_seconds))
    return VMEvent.install_failed(
        f"The installer stopped after only {secs}s — too fast to have completed. "
        "The guest likely failed to boot the installer ISO. Retry the install; "
        "if it persists, re-download the base image and remaster again."
    )


# A sealed guest awaiting phone-unlock should come online within a few minutes;
# past this it has very likely failed to reach the network (e.g. a first-boot
# NIC/DHCP failure) and would otherwise spin on "Waiting for you to unlock"
# forever with no hint. The UI keeps polling, but past this threshold it surfaces
# an advisory. Mirrors macOS VMLifecycle.comingUpStallThreshold.
COMING_UP_STALL_THRESHOLD_SECONDS = 8 * 60.0


def coming_up_is_stalled(state_kind: VMStateKind, elapsed_seconds: float) -> bool:
    """True iff a hosted server has been sealed + awaiting unlock past the stall
    threshold. Pure so the view can evaluate it against a live clock."""
    return (
        state_kind == VMStateKind.AWAITING_PHONE_UNLOCK
        and elapsed_seconds >= COMING_UP_STALL_THRESHOLD_SECONDS
    )


class VMLifecycle:
    def __init__(
        self,
        sealed_at_boot: bool,
        state: Optional[VMState] = None,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self.sealed_at_boot = sealed_at_boot
        self._clock = clock or time.time
        self.state = state if state is not None else VMState.created()
        self.state_changed_at = self._clock()

    def verdict_for_clean_install_stop_now(self, now: Optional[float] = None) -> VMEvent:
        """Convenience for the live adapter: derive the elapsed install time
        from this machine's own state timestamp. Only meaningful while
        installing."""
        if self.state.kind != VMStateKind.INSTALLING:
            raise RuntimeError(f"Install verdict requested in state {self.state.kind.value}.")
        at = now if now is not None else self._clock()
        return verdict_for_clean_install_stop(at - self.state_changed_at)

    def handle(self, event: VMEvent) -> List[VMEffect]:
        """Apply one event. Returns the effects to execute; raises on an event
        that is meaningless in the current state (a programming error or a
        stale caller — never silently swallowed)."""
        next_state, effects = self._transition(event)
        self.state = next_state
        self.state_changed_at = self._clock()
        return effects

    def _transition(self, event: VMEvent) -> Tuple[VMState, List[VMEffect]]:
        k = self.state.kind
        e = event.kind
        f = self.state.failure

        if k == VMStateKind.CREATED and e == VMEventKind.START_INSTALL:
            return VMState.installing(), [VMEffect.ATTACH_INSTALLER_ISO, VMEffect.START_VIRTUAL_MACHINE]
        if k == VMStateKind.FAILED and e == VMEventKind.START_INSTALL and f and f.phase == VMFailurePhase.INSTALL:
            return VMState.installing(), [VMEffect.ATTACH_INSTALLER_ISO, VMEffect.START_VIRTUAL_MACHINE]

        if k == VMStateKind.INSTALLING and e == VMEventKind.INSTALL_SUCCEEDED:
            # The install->first-boot seam: the ISO comes OFF here so every
            # subsequent boot is from the guest's own disk.
            return VMState.installed(), [VMEffect.DETACH_INSTALLER_ISO]
        if k == VMStateKind.INSTALLING and e == VMEventKind.INSTALL_FAILED:
            return (
                VMState.failed(VMFailurePhase.INSTALL, event.reason or ""),
                [VMEffect.STOP_VIRTUAL_MACHINE, VMEffect.DETACH_INSTALLER_ISO],
            )

        if e == VMEventKind.POWER_ON and k in (VMStateKind.INSTALLED, VMStateKind.STOPPED):
            return (
                VMState.awaiting_phone_unlock() if self.sealed_at_boot else VMState.running(),
                [VMEffect.START_VIRTUAL_MACHINE],
            )
        if k == VMStateKind.FAILED and e == VMEventKind.POWER_ON and f and f.phase == VMFailurePhase.RUN:
            return (
                VMState.awaiting_phone_unlock() if self.sealed_at_boot else VMState.running(),
                [VMEffect.START_VIRTUAL_MACHINE],
            )

        if k == VMStateKind.AWAITING_PHONE_UNLOCK and e == VMEventKind.GUEST_UNLOCKED:
            return VMState.running(), []
        if e == VMEventKind.POWER_OFF and k in (VMStateKind.AWAITING_PHONE_UNLOCK, VMStateKind.RUNNING):
            return VMState.stopped(), [VMEffect.STOP_VIRTUAL_MACHINE]
        if e == VMEventKind.RUNTIME_FAILED and k in (VMStateKind.AWAITING_PHONE_UNLOCK, VMStateKind.RUNNING):
            return VMState.failed(VMFailurePhase.RUN, event.reason or ""), []

        raise VMLifecycleError(self.state, event)
