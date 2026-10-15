"""A pairing code stays up without anyone pressing a button: started at
launch, paused while offline, back with the network, failed sessions retried
with a growing delay, and never restarted over a delivered recipe or a
cancel. Mirrors the Mac WizardModel pairing lifecycle."""
from __future__ import annotations

from pathlib import Path

from cli_runner import Resolved
from pair_session import PairEvent
from pairing_watch import RETRY_DELAYS, ConnectivityMonitor, PairingWatch
from vm.inventory import VMBundleLayout, VMInventoryStore
from vm.manager import VMManager
from wizard import WizardModel


class Clock:
    def __init__(self) -> None:
        self.pending: list = []

    def schedule(self, delay, fn):
        entry = [delay, fn, False]
        self.pending.append(entry)

        def cancel():
            entry[2] = True

        return cancel

    def fire(self) -> float:
        delay, fn, cancelled = self.pending.pop(0)
        if not cancelled:
            fn()
        return delay


def watch(wanted=True):
    calls: list = []
    clock = Clock()
    state = {"wants": wanted}
    w = PairingWatch(
        wants_pairing=lambda: state["wants"],
        start=lambda: calls.append("start"),
        stop=lambda: calls.append("stop"),
        schedule=clock.schedule,
    )
    return w, calls, clock, state


def test_starts_at_launch_only_when_wanted():
    w, calls, _, _ = watch()
    w.launch()
    assert calls == ["start"]
    w, calls, _, _ = watch(wanted=False)
    w.launch()
    assert calls == []


def test_offline_stops_and_online_starts_again():
    w, calls, _, _ = watch()
    w.on_connectivity(False)
    w.on_connectivity(False)
    assert calls == ["stop"]
    w.on_connectivity(True)
    assert calls == ["stop", "start"]


def test_failures_retry_with_growing_delays_and_reset_once_ready():
    w, calls, clock, _ = watch()
    delays = []
    for _ in range(len(RETRY_DELAYS) + 1):
        w.on_failed()
        delays.append(clock.fire())
    assert delays == list(RETRY_DELAYS) + [RETRY_DELAYS[-1]]
    assert calls == ["start"] * (len(RETRY_DELAYS) + 1)
    w.on_ready()
    w.on_failed()
    assert clock.fire() == RETRY_DELAYS[0]


def test_no_retry_while_offline_or_once_no_longer_wanted():
    w, calls, clock, state = watch()
    w.on_failed()
    w.on_connectivity(False)
    clock.fire()
    assert calls == ["stop"]
    w.on_connectivity(True)
    assert calls == ["stop", "start"]
    w.on_failed()
    state["wants"] = False
    clock.fire()
    assert calls == ["stop", "start"]


def test_connectivity_monitor_reports_each_probe():
    seen = []
    probes = iter([True, False])
    m = ConnectivityMonitor(seen.append, probe=lambda: next(probes, False), interval=0.0)
    m._stop.set()
    m._run()
    assert seen == []
    m2 = ConnectivityMonitor(lambda o: (seen.append(o), m2.stop()), probe=lambda: False, interval=0.0)
    m2._run()
    assert seen == [False]


# ---- the wizard model ----


class FakePair:
    instances: list = []

    def __init__(self, debug):
        self.cancelled = False
        FakePair.instances.append(self)

    def run(self, on_event, on_log):
        pass

    def cancel(self):
        self.cancelled = True


def model(tmp_path) -> tuple:
    FakePair.instances = []
    clock = Clock()
    vm = VMManager(VMInventoryStore(VMBundleLayout(str(tmp_path / "VMs"))), None, "no qemu")
    m = WizardModel(
        locate_fn=lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts"),
        vm_manager=vm,
        pair_session_factory=FakePair,
        auto_pair=True,
        schedule=clock.schedule,
    )
    return m, clock


def test_the_app_pairs_at_launch_and_waits_offline(tmp_path):
    m, _ = model(tmp_path)
    m.pairing_watch.launch()
    assert m.state.is_pairing and len(FakePair.instances) == 1
    m.pairing_watch.on_connectivity(False)
    assert FakePair.instances[0].cancelled
    assert m.state.is_pairing
    assert m.state.pair_status == "Waiting for an internet connection…"
    assert m.state.pair_qr is None
    m.pairing_watch.on_connectivity(True)
    assert len(FakePair.instances) == 2 and m.state.is_pairing


def test_a_failed_session_is_retried_but_a_cancel_is_respected(tmp_path):
    m, clock = model(tmp_path)
    m.pairing_watch.launch()
    m._handle_pair_event(PairEvent(event="error", message="relay connection failed"))
    assert not m.state.is_pairing
    clock.fire()
    assert m.state.is_pairing and len(FakePair.instances) == 2
    m.cancel_pairing()
    m.pairing_watch.on_connectivity(False)
    m.pairing_watch.on_connectivity(True)
    assert len(FakePair.instances) == 2
    m.reset_to_new_server()
    assert m.state.is_pairing and len(FakePair.instances) == 3


def test_a_delivered_recipe_is_not_paired_over(tmp_path):
    m, clock = model(tmp_path)
    m.pairing_watch.launch()
    recipe = tmp_path / "r.json"
    recipe.write_text("{}")
    m.accept_recipe_file = lambda p: setattr(m.state, "recipe_path", Path(p))
    m._handle_pair_event(PairEvent(event="done", recipe_path=str(recipe)))
    m.pairing_watch.on_connectivity(False)
    m.pairing_watch.on_connectivity(True)
    assert len(FakePair.instances) == 1
    assert clock.pending == []
