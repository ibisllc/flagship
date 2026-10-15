"""The orchestrator: launch normalization, create/delete bookkeeping, honest
failure without a toolchain, the duration-gated guest-stop verdict, the unlock
poll, and the HostedServer display mapping. No QEMU is ever spawned (the host
is a fake). Mirrors apps/builder-windows/tests/VMManagerTests.cs."""
from __future__ import annotations

import threading

import pytest

from vm import resource_plan
from vm.config import VMConfig, VMNetworkMode
from vm.inventory import VMBundleLayout, VMInventoryStore, VMRecord
from vm.lifecycle import VMFailurePhase, VMState, VMStateKind
from vm.manager import STOP_GRACE_SECONDS, HostedServer, VMManager
from vm.qemu_locator import QemuToolchain
from vm.server_tier import ServerTier


def config(
    name: str = "a.h.flagship.services",
    debug: bool = False,
    encrypted: bool = True,
    provision_status_serial: str | None = None,
) -> VMConfig:
    return VMConfig(
        name=name,
        server_domain=name,
        username="harry",
        server_name=name.split(".")[0],
        cpu_count=2,
        memory_bytes=4 * resource_plan.GIB,
        main_disk_size_bytes=resource_plan.DEFAULT_MAIN_DISK_SIZE_BYTES,
        network_mode=VMNetworkMode.NAT,
        serial_console_enabled=debug,
        boot_unlock_mode="auto",
        disk_encrypted=encrypted,
        provision_status_serial=provision_status_serial,
    )


class FakeHost:
    """Stands in for QemuHost: records starts/stops, exposes the port trio.
    A graceful stop blocks while `hold_stop` is clear, like a guest still
    shutting down."""

    def __init__(self) -> None:
        self.on_guest_stopped = None
        self.started: list = []
        self.force_stops = 0
        self.graceful_stops: list = []
        self.hold_stop = threading.Event()
        self.hold_stop.set()
        self.stop_entered = threading.Event()
        self.qmp_port = 4444
        self.serial_port = 0
        self.ssh_port = 0
        self.fail_start: str = ""

    def start(self, cfg, layout, attach) -> None:
        if self.fail_start:
            from vm.qemu_host import QemuHostError

            raise QemuHostError(self.fail_start)
        self.started.append((cfg.name, attach))

    def stop(self, grace_seconds: float = 60) -> None:
        self.graceful_stops.append(grace_seconds)
        self.stop_entered.set()
        self.hold_stop.wait(timeout=5.0)

    def force_stop(self) -> None:
        self.force_stops += 1


TOOLCHAIN = QemuToolchain("/usr/bin/qemu-system-x86_64", "/usr/bin/qemu-img", "/c.fd", "/v.fd")


@pytest.fixture
def store(tmp_path):
    return VMInventoryStore(VMBundleLayout(str(tmp_path)))


def seed(store, name, state):
    store.create(VMRecord(config=config(name), state=state, created_at=1.0))


def manager(store, host=None, toolchain=TOOLCHAIN, error=None, clock=None, probe=None,
            health=None):
    return VMManager(
        store,
        toolchain,
        error,
        clock=clock,
        host_factory=(lambda: host) if host is not None else None,
        unlock_probe=probe or (lambda url: False),
        unlock_interval=0.01,
        health_fetch=health or (lambda url: None),
        health_interval=0.01,
    )


# ---- launch normalization ----


def test_stale_installing_becomes_retryable_install_failure(store):
    seed(store, "a.h.flagship.services", VMState.installing())
    m = manager(store)
    (s,) = m.servers
    assert s.record.state.kind == VMStateKind.FAILED
    assert s.record.state.failure.phase == VMFailurePhase.INSTALL
    # And it was PERSISTED, not just displayed.
    assert store.load("a.h.flagship.services").state.kind == VMStateKind.FAILED


def test_stale_live_states_become_stopped(store):
    seed(store, "a.h.flagship.services", VMState.running())
    seed(store, "b.h.flagship.services", VMState.awaiting_phone_unlock())
    m = manager(store)
    assert [s.record.state.kind for s in m.servers] == [VMStateKind.STOPPED, VMStateKind.STOPPED]


def test_rest_states_load_untouched(store):
    seed(store, "a.h.flagship.services", VMState.stopped())
    seed(store, "b.h.flagship.services", VMState.installed())
    seed(store, "c.h.flagship.services", VMState.created())
    m = manager(store)
    assert [s.record.state.kind for s in m.servers] == [
        VMStateKind.STOPPED,
        VMStateKind.INSTALLED,
        VMStateKind.CREATED,
    ]


# ---- create / delete bookkeeping ----


def test_create_server_persists_and_sorts_into_the_sidebar(store):
    m = manager(store)
    m.create_server(config("b.h.flagship.services"))
    m.create_server(config("a.h.flagship.services"))
    assert [s.name for s in m.servers] == ["a.h.flagship.services", "b.h.flagship.services"]
    assert store.load("a.h.flagship.services").state.kind == VMStateKind.CREATED
    assert store.load("a.h.flagship.services").tier == ServerTier.HOSTED_VM


def test_delete_server_removes_bundle_and_row(store):
    import os

    m = manager(store)
    m.create_server(config())
    m.delete_server("a.h.flagship.services")
    assert m.servers == []
    assert not os.path.isdir(store.layout.bundle_dir("a.h.flagship.services"))


def test_delete_stops_a_live_host_first(store):
    host = FakeHost()
    m = manager(store, host=host)
    m.create_server(config(encrypted=False))
    m.begin_install("a.h.flagship.services")
    assert host.started
    m.delete_server("a.h.flagship.services")
    assert host.force_stops == 1


# ---- guarded start without a toolchain ----


def test_start_without_qemu_fails_honestly_into_install_failed(store):
    m = manager(store, toolchain=None, error="no qemu in tests")
    m.create_server(config())
    m.begin_install("a.h.flagship.services")
    (s,) = m.servers
    assert s.record.state.kind == VMStateKind.FAILED
    assert s.record.state.failure.phase == VMFailurePhase.INSTALL
    assert "no qemu in tests" in s.record.state.failure.reason


def test_start_failure_at_the_host_layer_is_honest_too(store):
    host = FakeHost()
    host.fail_start = "KVM said no"
    m = manager(store, host=host)
    m.create_server(config())
    m.begin_install("a.h.flagship.services")
    (s,) = m.servers
    assert s.record.state.kind == VMStateKind.FAILED
    assert "KVM said no" in s.record.state.failure.reason


# ---- the install flow + duration-gated verdict ----


def test_install_attaches_iso_and_starts(store):
    host = FakeHost()
    m = manager(store, host=host)
    m.create_server(config())
    m.begin_install("a.h.flagship.services")
    assert host.started == [("a.h.flagship.services", True)]
    assert m.servers[0].record.state.kind == VMStateKind.INSTALLING


def test_cancel_install_stops_host_and_keeps_retryable_installer(store):
    host = FakeHost()
    m = manager(store, host=host)
    m.create_server(config())
    iso = m.installer_iso_path("a.h.flagship.services")
    open(iso, "wb").write(b"iso")
    m.begin_install("a.h.flagship.services")
    assert m.servers[0].can_cancel_install
    m.cancel_install("a.h.flagship.services")
    assert host.force_stops == 1
    assert host.graceful_stops == []
    assert m.servers[0].record.state.kind == VMStateKind.FAILED
    assert m.servers[0].can_retry_install
    import os

    assert os.path.exists(iso)


def test_clean_stop_after_plausible_duration_is_success_then_first_boot(store, tmp_path):
    now = [1000.0]
    host = FakeHost()
    m = manager(store, host=host, clock=lambda: now[0])
    m.create_server(config(encrypted=True, provision_status_serial="01VMTEST"))
    m.begin_install("a.h.flagship.services")
    # The single-use installer exists and is reclaimed on success.
    iso = m.installer_iso_path("a.h.flagship.services")
    open(iso, "wb").write(b"iso")
    now[0] += 600.0
    m._guest_stopped("a.h.flagship.services", 0, "")
    # installSucceeded -> powerOn: an encrypted guest sits sealed.
    assert m.servers[0].record.state.kind == VMStateKind.AWAITING_PHONE_UNLOCK
    import os

    assert not os.path.exists(iso)
    # The VM was restarted from disk (second start, no ISO).
    assert host.started == [("a.h.flagship.services", True), ("a.h.flagship.services", False)]
    # The order serial outlives the install: it reads the running server's health.
    assert store.load("a.h.flagship.services").config.provision_status_serial == "01VMTEST"
    m._cancel_unlock_poll("a.h.flagship.services")


def test_too_fast_clean_stop_is_a_retryable_failure_that_keeps_the_iso(store):
    now = [1000.0]
    host = FakeHost()
    m = manager(store, host=host, clock=lambda: now[0])
    m.create_server(config())
    m.begin_install("a.h.flagship.services")
    iso = m.installer_iso_path("a.h.flagship.services")
    open(iso, "wb").write(b"iso")
    now[0] += 5.0
    m._guest_stopped("a.h.flagship.services", 0, "")
    (s,) = m.servers
    assert s.record.state.kind == VMStateKind.FAILED
    assert s.record.state.failure.phase == VMFailurePhase.INSTALL
    assert "too fast" in s.record.state.failure.reason
    import os

    assert os.path.exists(iso)  # retry can re-attach
    assert s.can_retry_install


def test_nonzero_exit_during_install_carries_stderr(store):
    host = FakeHost()
    m = manager(store, host=host)
    m.create_server(config())
    m.begin_install("a.h.flagship.services")
    m._guest_stopped("a.h.flagship.services", 1, "kvm: permission denied")
    (s,) = m.servers
    assert s.record.state.kind == VMStateKind.FAILED
    assert "kvm: permission denied" in s.record.state.failure.reason


def test_unencrypted_guest_boots_straight_to_running_and_clean_stop_is_power_off(store):
    now = [0.0]
    host = FakeHost()
    m = manager(store, host=host, clock=lambda: now[0])
    m.create_server(config(encrypted=False))
    m.begin_install("a.h.flagship.services")
    now[0] += 300.0
    m._guest_stopped("a.h.flagship.services", 0, "")
    assert m.servers[0].record.state.kind == VMStateKind.RUNNING
    m._guest_stopped("a.h.flagship.services", 0, "")
    assert m.servers[0].record.state.kind == VMStateKind.STOPPED


def test_runtime_crash_is_failed_run_and_restartable(store):
    host = FakeHost()
    seed(store, "z.h.flagship.services", VMState.stopped())
    m = manager(store, host=host)
    m.power_on("z.h.flagship.services")
    m._cancel_unlock_poll("z.h.flagship.services")
    m._guest_stopped("z.h.flagship.services", 1, "kvm crashed")
    (s,) = m.servers
    assert s.record.state.kind == VMStateKind.FAILED
    assert s.record.state.failure.phase == VMFailurePhase.RUN
    assert s.can_start  # a run failure is restartable, not a reinstall
    m.power_on("z.h.flagship.services")
    m._cancel_unlock_poll("z.h.flagship.services")
    assert s.record.state.kind == VMStateKind.AWAITING_PHONE_UNLOCK


def test_power_cycle_from_stopped(store):
    host = FakeHost()
    seed(store, "z.h.flagship.services", VMState.stopped())
    m = manager(store, host=host)
    m.power_on("z.h.flagship.services")
    assert m.servers[-1].record.state.kind == VMStateKind.AWAITING_PHONE_UNLOCK
    m.power_off("z.h.flagship.services")
    assert m.servers[-1].record.state.kind == VMStateKind.STOPPED
    # Stop presses the power button and waits; it never pulls the plug itself.
    assert host.graceful_stops == [STOP_GRACE_SECONDS]
    assert host.force_stops == 0


def test_invalid_event_is_logged_and_ignored(store):
    m = manager(store)
    m.create_server(config())
    logs: list[str] = []
    m.log = logs.append
    m.power_on("a.h.flagship.services")  # created can't power on
    assert m.servers[0].record.state.kind == VMStateKind.CREATED
    assert any("ignored" in line for line in logs)


# ---- unlock detection ----


def test_unlock_poll_fires_guest_unlocked_on_first_http_response(store):
    host = FakeHost()
    unlocked = threading.Event()
    probed: list[str] = []

    def probe(url: str) -> bool:
        probed.append(url)
        return True

    seed(store, "s.h.flagship.services", VMState.stopped())
    m2 = VMManager(
        store,
        TOOLCHAIN,
        host_factory=lambda: host,
        unlock_probe=probe,
        unlock_interval=0.01,
    )
    m2.on_change = lambda: (
        unlocked.set()
        if m2.servers and m2.servers[-1].record.state.kind == VMStateKind.RUNNING
        else None
    )
    m2.power_on("s.h.flagship.services")
    assert unlocked.wait(timeout=5.0), "unlock poll never promoted the sealed guest"
    assert probed[0] == "https://s.h.flagship.services/"


def test_unlock_poll_is_cancelled_on_power_off(store):
    host = FakeHost()
    m = manager(store, host=host)
    seed(store, "s.h.flagship.services", VMState.stopped())
    m2 = VMManager(
        store,
        TOOLCHAIN,
        host_factory=lambda: host,
        unlock_probe=lambda url: False,
        unlock_interval=0.01,
    )
    m2.power_on("s.h.flagship.services")
    assert "s.h.flagship.services" in m2._unlock_polls
    m2.power_off("s.h.flagship.services")
    assert "s.h.flagship.services" not in m2._unlock_polls


# ---- HostedServer display mapping ----


def test_hosted_server_display_props():
    record = VMRecord(
        config=config("home.harry.flagship.services"),
        state=VMState.stopped(),
        created_at=1.0,
    )
    s = HostedServer(record)
    assert s.display_name == "home.harry"
    assert s.fqdn == "home.harry.flagship.services"
    assert s.badge_label == "Appliance (hosted VM)"
    assert s.state_label == "Stopped"
    assert s.status_subtitle == "Start the server to bring it online."
    assert "2 vCPU" in s.spec_summary
    assert "4 GiB RAM" in s.spec_summary
    assert "64 GiB disk" in s.spec_summary
    assert "Encrypted (LUKS)" in s.spec_summary
    assert s.can_start and not s.can_stop and not s.can_retry_install
    assert s.console_enabled is False


def test_status_subtitles_follow_state_and_unlock_mode():
    base = config("home.harry.flagship.services")
    sealed = HostedServer(
        VMRecord(config=base, state=VMState.awaiting_phone_unlock(), created_at=1.0)
    )
    assert "approve the first unlock" in sealed.status_subtitle
    assert sealed.state_label == "Waiting for you to unlock"
    ran_before = HostedServer(
        VMRecord(
            config=base,
            state=VMState.awaiting_phone_unlock(),
            created_at=1.0,
            last_connected_at=5.0,
        )
    )
    assert ran_before.state_label == "Unlocking…"
    assert "Nothing to approve" in ran_before.status_subtitle
    approve_cfg = VMConfig(**{**base.__dict__, "boot_unlock_mode": "approve"})
    approve = HostedServer(
        VMRecord(config=approve_cfg, state=VMState.awaiting_phone_unlock(), created_at=1.0)
    )
    assert "approve the unlock" in approve.status_subtitle
    approve_ran = HostedServer(
        VMRecord(
            config=approve_cfg,
            state=VMState.awaiting_phone_unlock(),
            created_at=1.0,
            last_connected_at=5.0,
        )
    )
    assert approve_ran.state_label != "Unlocking…"
    running = HostedServer(VMRecord(config=base, state=VMState.running(), created_at=1.0))
    assert running.status_subtitle == "Serving at https://home.harry.flagship.services/"
    assert running.can_stop and not running.can_start
    failed_run = HostedServer(
        VMRecord(config=base, state=VMState.failed(VMFailurePhase.RUN, "died"), created_at=1.0)
    )
    assert failed_run.status_subtitle == "died"
    assert failed_run.can_start and not failed_run.can_retry_install


# ---- graceful stop / quit ----


def test_guest_exit_after_graceful_stop_reads_as_stopped_not_crashed(store):
    host = FakeHost()
    seed(store, "z.h.flagship.services", VMState.stopped())
    m = manager(store, host=host)
    m.power_on("z.h.flagship.services")
    callback = host.on_guest_stopped
    m.power_off("z.h.flagship.services")
    assert host.on_guest_stopped is None
    # Even if the watcher had already captured the callback, a forced exit
    # code after the grace can't turn a requested stop into a crash.
    callback(137, "killed")
    s = m.servers[-1]
    assert s.record.state.kind == VMStateKind.STOPPED
    assert store.load("z.h.flagship.services").state.kind == VMStateKind.STOPPED


def test_start_waits_for_an_in_flight_stop(store):
    first, second = FakeHost(), FakeHost()
    hosts = iter([first, second])
    seed(store, "z.h.flagship.services", VMState.stopped())
    m = VMManager(
        store,
        TOOLCHAIN,
        host_factory=lambda: next(hosts),
        unlock_probe=lambda url: False,
        unlock_interval=0.01,
    )
    m.power_on("z.h.flagship.services")
    first.hold_stop.clear()
    stopper = threading.Thread(target=m.power_off, args=("z.h.flagship.services",))
    stopper.start()
    assert first.stop_entered.wait(timeout=5.0)
    assert m.has_live_servers  # still shutting down
    starter = threading.Thread(target=m.power_on, args=("z.h.flagship.services",))
    starter.start()
    starter.join(timeout=0.2)
    assert starter.is_alive(), "Start opened the disk while the guest was still shutting down"
    assert second.started == []
    first.hold_stop.set()
    stopper.join(timeout=5.0)
    starter.join(timeout=5.0)
    assert not starter.is_alive()
    assert second.started == [("z.h.flagship.services", False)]
    assert m.host("z.h.flagship.services") is second
    m._cancel_unlock_poll("z.h.flagship.services")


def test_quit_shuts_down_every_live_server_gracefully_in_parallel(store):
    names = ["a.h.flagship.services", "b.h.flagship.services", "c.h.flagship.services"]
    for n in names[:2]:
        seed(store, n, VMState.stopped())
    hosts = {n: FakeHost() for n in names}
    queue = iter(hosts[n] for n in names)
    m = VMManager(
        store,
        TOOLCHAIN,
        host_factory=lambda: next(queue),
        unlock_probe=lambda url: False,
        unlock_interval=0.01,
    )
    assert not m.has_live_servers
    for n in names[:2]:
        m.power_on(n)
    # The third is mid-install: the app quitting abandons that install anyway.
    m.create_server(config(names[2]))
    m.begin_install(names[2])
    assert m.server(names[2]).record.state.kind == VMStateKind.INSTALLING
    assert m.has_live_servers
    for n in names[:2]:
        hosts[n].hold_stop.clear()
    quitter = threading.Thread(target=m.shut_down_all)
    quitter.start()
    # Both live guests got the power button before either finished.
    assert hosts[names[0]].stop_entered.wait(timeout=5.0)
    assert hosts[names[1]].stop_entered.wait(timeout=5.0)
    assert quitter.is_alive()
    for n in names[:2]:
        hosts[n].hold_stop.set()
    quitter.join(timeout=5.0)
    assert not quitter.is_alive()
    for n in names[:2]:
        assert hosts[n].graceful_stops == [STOP_GRACE_SECONDS]
        assert hosts[n].force_stops == 0
        assert store.load(n).state.kind == VMStateKind.STOPPED
    assert hosts[names[2]].force_stops == 1
    assert not m.has_live_servers


def test_quit_waits_for_a_stop_already_in_flight(store):
    host = FakeHost()
    seed(store, "z.h.flagship.services", VMState.stopped())
    m = manager(store, host=host)
    m.power_on("z.h.flagship.services")
    host.hold_stop.clear()
    stopper = threading.Thread(target=m.power_off, args=("z.h.flagship.services",))
    stopper.start()
    assert host.stop_entered.wait(timeout=5.0)
    quitter = threading.Thread(target=m.shut_down_all)
    quitter.start()
    quitter.join(timeout=0.2)
    assert quitter.is_alive()
    host.hold_stop.set()
    quitter.join(timeout=5.0)
    stopper.join(timeout=5.0)
    assert not quitter.is_alive()
    assert host.graceful_stops == [STOP_GRACE_SECONDS]


# ---- health + last connected ----


def _health_body(received_ms: int) -> bytes:
    return (
        '{"serverDomain":"a.h.flagship.services","health":{"uptimeS":120,"memTotalMB":3900,'
        '"memAvailMB":800,"oomKills":0,"daemon":{"state":"active","restarts":0,"lastExit":0},'
        '"tunnel":true,"diskUsedPct":31,"receivedAt":%d}}' % received_ms
    ).encode()


def test_running_server_polls_its_order_health_and_remembers_it_connected(store):
    import time as _time

    store.create(
        VMRecord(
            config=config("a.h.flagship.services", provision_status_serial="01VMTEST"),
            state=VMState.stopped(),
            created_at=1.0,
        )
    )
    host = FakeHost()
    urls = []
    fetched = threading.Event()

    def fetch(url):
        urls.append(url)
        fetched.set()
        return _health_body(int(1000.0 * 1000))

    m = manager(store, host=host, clock=lambda: 1000.0, probe=lambda url: True, health=fetch)
    m.power_on("a.h.flagship.services")
    deadline = _time.time() + 5
    while m.servers[0].record.state.kind != VMStateKind.RUNNING and _time.time() < deadline:
        _time.sleep(0.01)
    assert m.servers[0].record.state.kind == VMStateKind.RUNNING
    assert fetched.wait(5)
    assert urls[0] == "https://flagshipserver.com/api/order/01VMTEST/health"
    deadline = _time.time() + 5
    while m.health_verdict("a.h.flagship.services") is None and _time.time() < deadline:
        _time.sleep(0.01)
    verdict = m.health_verdict("a.h.flagship.services")
    assert verdict is not None and verdict.ok
    deadline = _time.time() + 5
    while store.load("a.h.flagship.services").last_connected_at == 0.0 and _time.time() < deadline:
        _time.sleep(0.01)
    assert store.load("a.h.flagship.services").last_connected_at == 1000.0
    m.power_off("a.h.flagship.services")
    assert m.health_verdict("a.h.flagship.services") is None
    assert "a.h.flagship.services" not in m._health_polls
    assert store.load("a.h.flagship.services").last_connected_at == 1000.0


def test_server_without_an_order_serial_shows_no_health(store):
    seed(store, "a.h.flagship.services", VMState.stopped())
    host = FakeHost()
    called = []
    m = manager(store, host=host, probe=lambda url: True, health=lambda url: called.append(url))
    m.power_on("a.h.flagship.services")
    import time as _time

    deadline = _time.time() + 5
    while m.servers[0].record.state.kind != VMStateKind.RUNNING and _time.time() < deadline:
        _time.sleep(0.01)
    assert m.servers[0].record.state.kind == VMStateKind.RUNNING
    assert "a.h.flagship.services" not in m._health_polls
    assert called == []
