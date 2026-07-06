"""The wizard model's hosting + pairing slice — pane switching (mirrors
Wizard.cs / WizardStateMachineTests.cs), the host-here pipeline, sidebar
actions, SSH dispatch, and the pair-event handling. No GTK, no QEMU, no Node:
every seam is injected."""
from __future__ import annotations

import json
from pathlib import Path

from cli_runner import Resolved
from pair_session import PairEvent
from vm import resource_plan
from vm.config import VMConfig, VMNetworkMode
from vm.inventory import VMBundleLayout, VMInventoryStore
from vm.lifecycle import VMStateKind
from vm.manager import VMManager
from vm.qemu_locator import QemuToolchain
from vm.server_tier import ServerDestination
from wizard import VerifyInfo, WizardModel

TOOLCHAIN = QemuToolchain("/usr/bin/qemu-system-x86_64", "/usr/bin/qemu-img", "/c.fd", "/v.fd")

RECIPE = {
    "version": 2,
    "serverDomain": "home.harry.flagship.services",
    "username": "harry",
    "serverName": "home",
}


class FakeHost:
    def __init__(self) -> None:
        self.on_guest_stopped = None
        self.started: list = []
        self.qmp_port = 1
        self.serial_port = 0
        self.ssh_port = 0

    def start(self, cfg, layout, attach) -> None:
        self.started.append((cfg.name, attach))

    def force_stop(self) -> None:
        pass


def make_vm(tmp_path, toolchain=TOOLCHAIN, error=None, host=None) -> VMManager:
    return VMManager(
        VMInventoryStore(VMBundleLayout(str(tmp_path / "VMs"))),
        toolchain,
        error,
        host_factory=lambda: (host if host is not None else FakeHost()),
        unlock_probe=lambda url: False,
        unlock_interval=0.01,
    )


def make_model(tmp_path, vm=None, pair_factory=None, ssh_launch_fn=None) -> WizardModel:
    return WizardModel(
        locate_fn=lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts"),
        vm_manager=vm if vm is not None else make_vm(tmp_path),
        pair_session_factory=pair_factory,
        ssh_launch_fn=ssh_launch_fn,
    )


def verified(model) -> None:
    model.state.verified = VerifyInfo(
        ok=True, server_domain="home.harry.flagship.services"
    )


# ---- pane switching (priority: detail > pairing > chooser > host-here > wizard) ----


def test_fresh_model_shows_the_wizard_panes(tmp_path):
    m = make_model(tmp_path)
    assert m.show_wizard_panes
    assert not m.show_destination_chooser
    assert not m.show_host_here_pane
    assert not m.show_pairing_cover
    assert not m.show_server_detail


def test_verified_recipe_opens_the_destination_chooser(tmp_path):
    m = make_model(tmp_path)
    verified(m)
    assert m.show_destination_chooser
    assert not m.show_wizard_panes


def test_choosing_usb_returns_to_the_wizard_with_a_back_link(tmp_path):
    m = make_model(tmp_path)
    verified(m)
    m.set_destination(ServerDestination.BURN_TO_USB)
    assert m.show_wizard_panes
    assert m.show_destination_back_link
    m.set_destination(None)
    assert m.show_destination_chooser


def test_choosing_host_here_shows_that_pane(tmp_path):
    m = make_model(tmp_path)
    verified(m)
    m.set_destination(ServerDestination.HOST_HERE)
    assert m.show_host_here_pane
    assert not m.show_destination_chooser


def test_selected_server_detail_wins_over_everything(tmp_path):
    vm = make_vm(tmp_path)
    m = make_model(tmp_path, vm=vm)
    vm.create_server(_config("a.h.flagship.services"))
    verified(m)
    m.select_server("a.h.flagship.services")
    assert m.show_server_detail
    assert not m.show_destination_chooser
    m.reset_to_new_server()
    assert not m.show_server_detail
    assert m.state.verified is None  # fresh wizard


def _config(name: str, debug: bool = False) -> VMConfig:
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
        disk_encrypted=True,
    )


# ---- host-here availability ----


def test_host_here_disabled_reason_surfaces_the_toolchain_error(tmp_path):
    vm = make_vm(tmp_path, toolchain=None, error="QEMU is not installed. Install it…")
    m = make_model(tmp_path, vm=vm)
    assert m.host_here_disabled_reason == "QEMU is not installed. Install it…"
    assert not m.host_here_enabled


def test_missing_kvm_warns_but_does_not_block(tmp_path):
    vm = VMManager(
        VMInventoryStore(VMBundleLayout(str(tmp_path / "VMs"))),
        TOOLCHAIN,
        accel="tcg",
        accel_warning="No KVM. The VM will run without hardware acceleration (much slower).",
        host_factory=FakeHost,
        unlock_probe=lambda url: False,
    )
    m = make_model(tmp_path, vm=vm)
    assert m.host_here_disabled_reason is None
    assert "much slower" in m.host_here_accel_warning


def test_badges_and_spec_summary(tmp_path):
    m = make_model(tmp_path)
    assert m.hardware_badge_label == "Appliance (hardware)"
    assert m.hosted_vm_badge_label == "Appliance (hosted VM)"
    assert m.host_here_spec_summary.startswith("Will run as a managed VM on this PC")


# ---- the host-here pipeline ----


def _write_recipe(tmp_path, extra=None) -> Path:
    p = tmp_path / "r.json"
    p.write_text(json.dumps({**RECIPE, **(extra or {})}))
    return p


def test_run_host_here_creates_remasters_shreds_and_installs(tmp_path, monkeypatch):
    host = FakeHost()
    vm = make_vm(tmp_path, host=host)
    base = tmp_path / "base.iso"
    base.write_bytes(b"iso")
    m = WizardModel(
        locate_fn=lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts"),
        vm_manager=vm,
        ensure_base_fn=lambda *_a, **_k: base,
    )
    recipe = _write_recipe(tmp_path)
    m.state.recipe_path = recipe
    verified(m)
    m.set_destination(ServerDestination.HOST_HERE)

    ran: dict = {}

    def fake_run_cli(build_args, on_success, use_pkexec=False):
        ran["args"] = build_args("/cli.ts")
        # The remastered installer lands in the bundle.
        Path(vm.installer_iso_path("home.harry.flagship.services")).write_bytes(b"remastered")
        on_success("")

    monkeypatch.setattr(m, "_run_cli_core", fake_run_cli)
    m._run_host_here_sync()

    # prepare (not write): recipe + base -> the bundle's installer.iso, recipe
    # KEPT by the CLI (the model shreds it itself after success).
    assert ran["args"][:2] == ["/cli.ts", "prepare"]
    assert ran["args"][2] == str(recipe)
    assert ran["args"][3] == str(base)
    assert ran["args"][4] == vm.installer_iso_path("home.harry.flagship.services")
    assert "--keep-recipe" in ran["args"]
    assert not recipe.exists()  # shredded, single-use
    (s,) = vm.servers
    assert s.record.state.kind == VMStateKind.INSTALLING
    assert host.started == [("home.harry.flagship.services", True)]
    assert m.state.selected_server_name == "home.harry.flagship.services"
    assert m.state.recipe_path is None and m.state.verified is None


def test_run_host_here_rolls_back_the_bundle_when_remaster_fails(tmp_path, monkeypatch):
    vm = make_vm(tmp_path)
    base = tmp_path / "base.iso"
    base.write_bytes(b"iso")
    m = WizardModel(
        locate_fn=lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts"),
        vm_manager=vm,
        ensure_base_fn=lambda *_a, **_k: base,
    )
    recipe = _write_recipe(tmp_path)
    m.state.recipe_path = recipe
    verified(m)

    monkeypatch.setattr(m, "_run_cli_core", lambda build_args, on_success, use_pkexec=False: None)
    m._run_host_here_sync()
    assert vm.servers == []  # no half-created bundle
    assert recipe.exists()  # NOT shredded on failure


def test_run_host_here_refuses_when_disabled(tmp_path):
    vm = make_vm(tmp_path, toolchain=None, error="no qemu")
    m = make_model(tmp_path, vm=vm)
    m.state.recipe_path = _write_recipe(tmp_path)
    verified(m)
    m._run_host_here_sync()
    assert vm.servers == []
    assert any("no qemu" in ll.text for ll in m.state.log_lines)


def test_run_host_here_debug_recipe_yields_a_debug_vm(tmp_path, monkeypatch):
    # The debug grant rides the recipe into VMConfig (serial console + SSH
    # gate) AND stays in the recipe file the CLI prepare consumes — the same
    # grant-carried key path (debugSshKeyFromGrant) a Windows/USB burn uses.
    vm = make_vm(tmp_path)
    base = tmp_path / "base.iso"
    base.write_bytes(b"iso")
    m = WizardModel(
        locate_fn=lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts"),
        vm_manager=vm,
        ensure_base_fn=lambda *_a, **_k: base,
    )
    grant = json.dumps({"v": 1, "grant": {"sshAuthorizedKey": "ssh-ed25519 AAAA dev"}})
    m.state.recipe_path = _write_recipe(tmp_path, {"debugGrant": grant})
    verified(m)
    monkeypatch.setattr(
        m,
        "_run_cli_core",
        lambda build_args, on_success, use_pkexec=False: on_success(""),
    )
    m._run_host_here_sync()
    (s,) = vm.servers
    assert s.console_enabled is True


def test_run_host_here_owns_is_running_for_the_whole_pipeline(tmp_path, monkeypatch):
    vm = make_vm(tmp_path)
    base = tmp_path / "base.iso"
    base.write_bytes(b"iso")
    seen: dict = {}

    def fake_ensure(_version, cancel_event=None, **_k):
        seen["is_running_during_download"] = m.state.is_running
        seen["cancel_event"] = cancel_event
        return base

    m = WizardModel(
        locate_fn=lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts"),
        vm_manager=vm,
        ensure_base_fn=fake_ensure,
    )
    m.state.recipe_path = _write_recipe(tmp_path)
    verified(m)
    monkeypatch.setattr(
        m, "_run_cli_core", lambda build_args, on_success, use_pkexec=False: on_success("")
    )
    m._run_host_here_sync()
    assert seen["is_running_during_download"] is True
    assert seen["cancel_event"] is not None
    assert m.state.is_running is False


# ---- sidebar actions ----


def test_delete_server_clears_the_selection(tmp_path):
    vm = make_vm(tmp_path)
    m = make_model(tmp_path, vm=vm)
    vm.create_server(_config("a.h.flagship.services"))
    m.select_server("a.h.flagship.services")
    m.delete_server("a.h.flagship.services")
    assert m.state.selected_server_name is None
    assert vm.servers == []


def test_open_ssh_launches_at_the_forwarded_port(tmp_path):
    host = FakeHost()
    host.ssh_port = 50022
    vm = make_vm(tmp_path, host=host)
    launched: list[int] = []
    m = make_model(tmp_path, vm=vm, ssh_launch_fn=lambda port: launched.append(port))
    vm.create_server(_config("a.h.flagship.services", debug=True))
    vm._hosts["a.h.flagship.services"] = host
    m.open_ssh("a.h.flagship.services")
    assert launched == [50022]


def test_open_ssh_without_a_running_forward_explains_itself(tmp_path):
    vm = make_vm(tmp_path)
    launched: list[int] = []
    m = make_model(tmp_path, vm=vm, ssh_launch_fn=lambda port: launched.append(port))
    vm.create_server(_config("a.h.flagship.services", debug=True))
    m.open_ssh("a.h.flagship.services")
    assert launched == []
    assert any("once the server is running" in ll.text for ll in m.state.log_lines)


# ---- pairing ----


class FakePairSession:
    def __init__(self) -> None:
        self.cancelled = False
        self.debug = None
        self.recipe_out_path = "/tmp/fake.json"

    def run(self, on_event, on_log) -> int:
        self._on_event = on_event
        return 0

    def cancel(self) -> None:
        self.cancelled = True


def test_pairing_cover_lifecycle(tmp_path):
    session = FakePairSession()

    def factory(debug: bool):
        session.debug = debug
        return session

    m = make_model(tmp_path, pair_factory=factory)
    m.set_pair_debug(True)
    m.start_pairing()
    assert m.state.is_pairing and m.show_pairing_cover
    assert session.debug is True

    m._handle_pair_event(
        PairEvent(event="ready", human_code="ABCD-1234", qr_terminal="█▀█")
    )
    assert m.state.pair_qr == "█▀█"
    assert m.state.pair_code == "ABCD-1234"
    m._handle_pair_event(PairEvent(event="phone-connected", sas="418 902"))
    assert m.state.pair_sas == "418 902"
    m._handle_pair_event(PairEvent(event="paired"))
    m._handle_pair_event(
        PairEvent(event="delivered", server_domain="home.harry.flagship.services")
    )
    assert "home.harry" in m.state.pair_status


def test_pair_debug_result_logs_the_granted_field(tmp_path):
    m = make_model(tmp_path, pair_factory=lambda debug: FakePairSession())
    m.start_pairing()
    m._handle_pair_event(PairEvent(event="debug-result", granted=True))
    assert any("debug access granted" in ll.text for ll in m.state.log_lines)
    m._handle_pair_event(PairEvent(event="debug-result", granted=False))
    assert any("not granted" in ll.text for ll in m.state.log_lines)


def test_pair_done_accepts_the_delivered_recipe_like_a_dropped_file(tmp_path, monkeypatch):
    m = make_model(tmp_path, pair_factory=lambda debug: FakePairSession())
    accepted: list = []
    monkeypatch.setattr(m, "accept_recipe_file", accepted.append)
    m.start_pairing()
    recipe = _write_recipe(tmp_path)
    m._handle_pair_event(
        PairEvent(event="done", recipe_path=str(recipe), server_domain=RECIPE["serverDomain"])
    )
    assert not m.state.is_pairing
    assert accepted == [Path(str(recipe))]


def test_pair_error_ends_the_cover_with_the_message(tmp_path):
    m = make_model(tmp_path, pair_factory=lambda debug: FakePairSession())
    m.start_pairing()
    m._handle_pair_event(PairEvent(event="error", message="pairing session timed out"))
    assert not m.state.is_pairing
    assert m.state.pair_status == "pairing session timed out"


def test_cancel_pairing_cancels_the_session(tmp_path):
    session = FakePairSession()
    m = make_model(tmp_path, pair_factory=lambda debug: session)
    m.start_pairing()
    m.cancel_pairing()
    assert session.cancelled
    assert not m.state.is_pairing
