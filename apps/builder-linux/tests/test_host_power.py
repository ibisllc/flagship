"""Keeping the PC awake while servers run: GTK's inhibit first, logind's
systemd-inhibit when GTK can't, and an honest log line when neither can. The
manager asks for the hold exactly while a server needs the PC."""
from __future__ import annotations

from vm import resource_plan
from vm.config import VMConfig, VMNetworkMode
from vm.host_power import SleepInhibitor, systemd_inhibit_argv
from vm.inventory import VMBundleLayout, VMInventoryStore, VMRecord
from vm.lifecycle import VMState
from vm.manager import VMManager
from vm.qemu_locator import QemuToolchain


class Proc:
    def __init__(self) -> None:
        self.terminated = False

    def terminate(self) -> None:
        self.terminated = True


def test_prefers_the_gtk_inhibit():
    released = []
    spawned = []
    inh = SleepInhibitor(lambda: 7, released.append, which=lambda _b: "/usr/bin/systemd-inhibit",
                         spawn=lambda argv: spawned.append(argv))
    inh.hold(True)
    inh.hold(True)
    assert inh.holding and spawned == []
    inh.hold(False)
    assert released == [7] and not inh.holding


def test_falls_back_to_systemd_inhibit():
    procs = []

    def spawn(argv):
        procs.append((argv, Proc()))
        return procs[-1][1]

    inh = SleepInhibitor(lambda: 0, lambda _c: None, which=lambda _b: "/usr/bin/systemd-inhibit", spawn=spawn)
    inh.hold(True)
    assert procs[0][0] == systemd_inhibit_argv("/usr/bin/systemd-inhibit")
    assert "--what=sleep" in procs[0][0] and "--mode=block" in procs[0][0]
    inh.hold(False)
    assert procs[0][1].terminated and not inh.holding


def test_says_so_when_nothing_can_hold_the_pc_awake():
    logs = []
    inh = SleepInhibitor(lambda: 0, lambda _c: None, which=lambda _b: None, log=logs.append)
    inh.hold(True)
    assert not inh.holding
    assert "Can't keep this PC awake" in logs[0]


class FakeHost:
    def __init__(self) -> None:
        self.on_guest_stopped = None

    def start(self, cfg, layout, attach) -> None:
        pass

    def stop(self, grace_seconds: float = 60) -> None:
        pass

    def force_stop(self) -> None:
        pass


def test_the_manager_holds_while_a_server_needs_the_pc(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    cfg = VMConfig(
        name="a.h.flagship.services", server_domain="a.h.flagship.services", username="h",
        server_name="a", cpu_count=2, memory_bytes=4 * resource_plan.GIB,
        main_disk_size_bytes=resource_plan.DEFAULT_MAIN_DISK_SIZE_BYTES,
        network_mode=VMNetworkMode.NAT, serial_console_enabled=False,
        boot_unlock_mode="auto", disk_encrypted=True,
    )
    store.create(VMRecord(config=cfg, state=VMState.stopped(), created_at=1.0))
    m = VMManager(
        store, QemuToolchain("/q", "/i", "/c", "/v"), host_factory=FakeHost,
        unlock_probe=lambda _u: False, unlock_interval=0.01, health_fetch=lambda _u: None,
    )
    holds = []
    m.on_wake_hold = holds.append
    m.power_on("a.h.flagship.services")
    assert holds == [True]
    m.power_off("a.h.flagship.services")
    assert holds == [True, False]
