"""QemuHost.stop: press the power button, wait out the grace, then force. No
QEMU is spawned (the process and QMP socket are fakes)."""
from __future__ import annotations

import subprocess

import pytest

from vm import qemu_host
from vm.qemu_host import QemuHost
from vm.qemu_locator import QemuToolchain
from vm.qmp_client import QmpError


class FakeProc:
    def __init__(self, obeys_power_button: bool) -> None:
        self.obeys = obeys_power_button
        self.powered_down = False
        self.exited = False
        self.waits: list = []
        self.killed = False

    def poll(self):
        return 0 if self.exited else None

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.exited or (self.obeys and self.powered_down):
            self.exited = True
            return 0
        raise subprocess.TimeoutExpired("qemu", timeout)

    def kill(self) -> None:
        self.killed = True
        self.exited = True


class FakeQmp:
    commands: list = []
    proc: FakeProc = None  # type: ignore[assignment]
    reachable = True
    quit_works = True

    @classmethod
    def connect(cls, port, timeout=5.0):
        if not cls.reachable:
            raise ConnectionRefusedError("no qmp")
        return cls()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return None

    def system_powerdown(self) -> None:
        FakeQmp.commands.append("system_powerdown")
        FakeQmp.proc.powered_down = True

    def quit(self) -> None:
        FakeQmp.commands.append("quit")
        if not FakeQmp.quit_works:
            raise QmpError("quit refused")
        FakeQmp.proc.exited = True


@pytest.fixture
def host(monkeypatch):
    FakeQmp.commands = []
    FakeQmp.reachable = True
    FakeQmp.quit_works = True
    monkeypatch.setattr(qemu_host, "QmpClient", FakeQmp)
    h = QemuHost(QemuToolchain("/q", "/qi", "/c.fd", "/v.fd"))
    h.qmp_port = 4444
    return h


def attach(h: QemuHost, obeys: bool) -> FakeProc:
    proc = FakeProc(obeys)
    FakeQmp.proc = proc
    h._proc = proc  # type: ignore[assignment]
    return proc


def test_default_grace_is_a_minute(host):
    proc = attach(host, obeys=True)
    host.stop()
    assert proc.waits == [60]


def test_a_guest_that_powers_off_is_never_forced(host):
    proc = attach(host, obeys=True)
    host.stop(grace_seconds=0.01)
    assert FakeQmp.commands == ["system_powerdown"]
    assert not proc.killed


def test_a_guest_that_ignores_the_power_button_is_forced_after_the_grace(host):
    proc = attach(host, obeys=False)
    host.stop(grace_seconds=0.01)
    assert FakeQmp.commands == ["system_powerdown", "quit"]
    assert proc.waits[0] == 0.01
    assert proc.exited and not proc.killed


def test_a_wedged_qemu_is_killed_when_quit_fails_too(host):
    FakeQmp.quit_works = False
    proc = attach(host, obeys=False)
    host.stop(grace_seconds=0.01)
    assert proc.killed


def test_unreachable_qmp_forces_at_once_instead_of_waiting_the_grace(host):
    FakeQmp.reachable = False
    proc = attach(host, obeys=False)
    host.stop(grace_seconds=60)
    assert 60 not in proc.waits
    assert proc.killed
