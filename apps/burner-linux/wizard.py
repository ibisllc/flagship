"""GTK4 + libadwaita wizard module — UX-matches apps/burner-mac 1:1.

Five-step wizard in one Adw.ApplicationWindow with a scrolling content area
and a log pane pinned at the bottom:

  1. Drop recipe JSON (or paste raw JSON into a text area)
  2. Drop the stock Ubuntu Server ISO
  3. Pick target USB drive (read-only list of removable drives)
  4. Big "Bake" button → calls `flagship-burn write` and streams output
  5. Done — show server-domain + when it expires

The view layer (this module) talks to the runtime via the WizardModel,
which owns CLI invocation and state. The model is GUI-agnostic so it can
be unit-tested without a display; see tests/test_disk_enumerator.py for
the disk-side; the wizard view itself we drive manually.

Import-safe: `import wizard` works even without GTK/libadwaita installed,
so unit tests can import the helper functions. GTK objects are only
constructed inside `WizardWindow.__init__`, which raises a clear error
if the libraries are missing."""
from __future__ import annotations

import os
import shlex
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import container_env
import elevation
import iso_base_cache
from disk_enumerator import (
    DeviceInfo,
    enumerate_devices,
    safe_devices,
)
from cli_runner import (
    CLILocateError,
    CLIRunner,
    LogLine,
    Resolved,
    args_prepare,
    args_verify,
    args_write,
    locate,
    parse_verify_json,
)
from pair_session import PairEvent, PairSession
from vm import host_arch, recipe_info, resource_plan, ssh_launch
from vm.config import VMConfig
from vm.host_resources import HostResources
from vm.inventory import VMStoreError
from vm.manager import VMManager
from vm.server_tier import ServerDestination, ServerTier


# Two flows, same remaster+write engine (the Node CLI's `write` subcommand):
#   simple   : recipe + USB only. The Debian-netinst base ISO is fetched per
#              the SERVER manifest (/api/iso-manifest) + cached, then handed to
#              the SAME Node CLI remaster+write path Advanced uses. Default.
#   advanced : recipe + a user-supplied stock Ubuntu/Debian ISO. Same CLI path.
MODE_SIMPLE = "simple"
MODE_ADVANCED = "advanced"

# Reported to /api/iso-manifest as `burnerVersion`. Bump on release.
BURNER_VERSION = "0.1.0"


def locate_flasher() -> str:
    """Absolute path to disk_write.py — the small script pkexec elevates for
    the raw write. Resolves next to this module (works in a checkout and in the
    AppImage's flagship-burner share dir). Override with $FLAGSHIP_FLASHER."""
    override = os.environ.get("FLAGSHIP_FLASHER")
    if override and Path(override).exists():
        return override
    here = Path(__file__).resolve().parent
    candidate = here / "disk_write.py"
    if candidate.exists():
        return str(candidate)
    # AppImage / system layout: alongside the other share-dir modules.
    for c in (
        Path("/usr/share/flagship-burner/disk_write.py"),
        here / "disk_write.py",
    ):
        if c.exists():
            return str(c)
    return str(candidate)


class PkexecFlasher:
    """Run `pkexec python3 disk_write.py <image> <device>` and stream its
    control lines (FLAGSHIP_PROGRESS: / FLAGSHIP_PHASE:) + log output.

    Mirrors CLIRunner's lifecycle (start/wait/terminate) but for a local raw
    write. pkexec pops the standard PolicyKit admin-auth dialog; the elevated
    child is the tiny, auditable flasher — not the whole GUI."""

    def __init__(
        self,
        image_path: str,
        device_path: str,
        python_path: str = "/usr/bin/python3",
        flasher_path: Optional[str] = None,
        use_pkexec: bool = True,
    ) -> None:
        self.image_path = image_path
        self.device_path = device_path
        self.python_path = python_path
        self.flasher_path = flasher_path or locate_flasher()
        self.use_pkexec = use_pkexec
        self._proc: Optional[subprocess.Popen] = None
        self._threads: list[threading.Thread] = []

    @property
    def command_vector(self) -> list[str]:
        base = [self.python_path, self.flasher_path, self.image_path, self.device_path]
        if self.use_pkexec:
            return ["pkexec", *base]
        return base

    @property
    def command_string(self) -> str:
        return " ".join(shlex.quote(a) for a in self.command_vector)

    def start(
        self,
        on_line: Callable[[LogLine], None],
        on_control: Callable[[str], bool],
    ) -> None:
        if self._proc is not None:
            raise RuntimeError("PkexecFlasher already started")
        self._proc = subprocess.Popen(
            self.command_vector,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        def tail(stream, label: str) -> None:
            for raw in stream:
                line = raw.rstrip("\n").rstrip("\r")
                # Control lines (progress/phase) are consumed, not logged.
                if label == "stdout" and on_control(line):
                    continue
                on_line(LogLine(stream=label, text=line))

        t_out = threading.Thread(target=tail, args=(self._proc.stdout, "stdout"), daemon=True)
        t_err = threading.Thread(target=tail, args=(self._proc.stderr, "stderr"), daemon=True)
        t_out.start()
        t_err.start()
        self._threads = [t_out, t_err]

    def wait(self) -> int:
        if self._proc is None:
            raise RuntimeError("PkexecFlasher not started")
        for t in self._threads:
            t.join()
        return self._proc.wait()

    def terminate(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()


@dataclass
class VerifyInfo:
    ok: bool
    server_domain: str
    username: Optional[str] = None
    server_name: Optional[str] = None
    expires_at: Optional[str] = None
    installer_git_ref: Optional[str] = None
    signature_valid: Optional[bool] = None

    @classmethod
    def from_dict(cls, d: dict) -> "VerifyInfo":
        return cls(
            ok=bool(d.get("ok", False)),
            server_domain=str(d.get("serverDomain", "")),
            username=d.get("username"),
            server_name=d.get("serverName"),
            expires_at=d.get("expiresAt"),
            installer_git_ref=d.get("installerGitRef"),
            signature_valid=d.get("signatureValid"),
        )


@dataclass
class WizardState:
    """GUI-agnostic state container — what the wizard knows at any moment.

    Kept separate from the GTK view so unit tests can poke at it
    without a display. The view observes via on_change callback.
    """
    recipe_path: Optional[Path] = None
    pasted_recipe_staging: Optional[Path] = None
    iso_path: Optional[Path] = None
    disks: list[DeviceInfo] = field(default_factory=list)
    selected_disk: Optional[DeviceInfo] = None
    is_refreshing_disks: bool = False
    is_running: bool = False
    log_lines: list[LogLine] = field(default_factory=list)
    recipe_error: Optional[str] = None
    verified: Optional[VerifyInfo] = None
    out_iso_path: Optional[Path] = None
    is_finished: bool = False
    # Simple = server-manifest Debian base; Advanced = user-supplied ISO.
    # Both remaster + flash via the Node CLI's `write` subcommand.
    mode: str = MODE_SIMPLE
    # 0…1 during the byte-write / base download; None = indeterminate/idle.
    progress: Optional[float] = None
    # Raw phase token: "download" | "remaster" | "write".
    phase: Optional[str] = None
    # URL of the base ISO being fetched in Simple mode — shown under the bar.
    download_url: Optional[str] = None
    # Cached/fetched base ISO path used by the Simple-mode CLI write.
    base_iso_path: Optional[Path] = None
    # Where the verified recipe should live: None until the user picks on the
    # destination chooser (usb => the wizard steps; host-here => a managed VM).
    destination: Optional[ServerDestination] = None
    # Sidebar selection: the hosted server whose detail fills the main area.
    # None shows the wizard/chooser.
    selected_server_name: Optional[str] = None
    # Phone pairing (the QR cover — how a recipe arrives without a file).
    is_pairing: bool = False
    pair_qr: Optional[str] = None
    pair_code: Optional[str] = None
    pair_sas: Optional[str] = None
    pair_status: Optional[str] = None
    # Advanced: request an owner-signed debug-access grant during pairing.
    pair_debug: bool = False

    @property
    def requires_user_iso(self) -> bool:
        return self.mode == MODE_ADVANCED

    @property
    def can_flash(self) -> bool:
        if self.recipe_path is None or self.selected_disk is None:
            return False
        if self.requires_user_iso and self.iso_path is None:
            return False
        return True

    @property
    def readiness_summary(self) -> str:
        missing: list[str] = []
        if self.recipe_path is None:
            missing.append("recipe")
        if self.requires_user_iso and self.iso_path is None:
            missing.append("ISO")
        if self.selected_disk is None:
            missing.append("USB drive")
        if not missing:
            if self.requires_user_iso:
                what = self.iso_path.name if self.iso_path else ""
            else:
                what = self.verified.server_domain if self.verified else "your server"
            disk_node = self.selected_disk.device_path if self.selected_disk else ""
            return f"Ready: {what} -> {disk_node}"
        return f"Need: {', '.join(missing)}."

    @property
    def phase_label(self) -> Optional[str]:
        return {
            "download": "Downloading base image…",
            "remaster": "Building image…",
            "write": "Writing to USB…",
        }.get(self.phase or "")


def stage_pasted_recipe(text: str, tmp_dir: Optional[Path] = None) -> Path:
    """Write a pasted recipe blob to a 0600 temp file the CLI can read.

    Mirrors WizardModel.acceptRecipeText. Raises ValueError on empty/
    whitespace-only input; OSError on filesystem failure."""
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("Pasted recipe was empty.")
    base = tmp_dir if tmp_dir is not None else Path(tempfile.gettempdir())
    base.mkdir(parents=True, exist_ok=True)
    out = base / f"flagship-recipe-{uuid.uuid4()}.json"
    out.write_text(cleaned, encoding="utf-8")
    os.chmod(out, 0o600)
    return out


def derive_out_iso_path(iso_path: Path) -> Path:
    """Same shape as the Mac model: `<iso-stem>.flagship.iso` next to
    the input."""
    return iso_path.parent / f"{iso_path.stem}.flagship.iso"


# ---- model (GUI-agnostic controller) ----


class WizardModel:
    """Owns the wizard's mutable state + CLI invocation. The view layer
    calls these methods and registers `on_change` to receive notifications.

    All CLI work runs on background threads; `on_change` is invoked from
    whichever thread mutates state — the GTK view marshals to the main
    loop via `GLib.idle_add`."""

    def __init__(
        self,
        on_change: Optional[Callable[[], None]] = None,
        run_lsblk: Optional[Callable[[], str]] = None,
        locate_fn: Optional[Callable[[], Resolved]] = None,
        probe_elevation: Callable[[], Optional[elevation.Elevation]] = elevation.probe,
        mode: str = MODE_SIMPLE,
        # Injectable seam so the Simple-mode base fetch is unit-testable
        # without network: defaults to the real manifest-driven cache.
        ensure_base_fn: Optional[Callable[..., Path]] = None,
        burner_version: str = BURNER_VERSION,
        # Injectable seams for the host-here / pairing paths (tests pass fakes;
        # production uses the live defaults).
        vm_manager: Optional[VMManager] = None,
        pair_session_factory: Optional[Callable[[bool], PairSession]] = None,
        ssh_launch_fn: Optional[Callable[[int], object]] = None,
    ) -> None:
        self.state = WizardState(mode=mode)
        self.on_change = on_change or (lambda: None)
        self._run_lsblk = run_lsblk
        self._locate_fn = locate_fn or locate
        self._probe_elevation = probe_elevation
        self._current_runner: Optional[object] = None
        self._lock = threading.Lock()
        self._ensure_base = ensure_base_fn or iso_base_cache.ensure
        self._burner_version = burner_version
        self.vm = vm_manager if vm_manager is not None else VMManager.create_default()
        self.vm.on_change = self._notify
        self.vm.log = lambda m: self._append_log("stdout", m)
        self._pair_session_factory = pair_session_factory or (
            lambda debug: PairSession(debug, locate_fn=self._locate_fn)
        )
        self._ssh_launch = ssh_launch_fn or ssh_launch.launch
        self._pair: Optional[PairSession] = None
        # Set while a Simple-mode base download can be cancelled (the analog of
        # Wizard.cs's CancellationTokenSource); cancel() trips it.
        self._cancel_download: Optional[threading.Event] = None

    def set_mode(self, mode: str) -> None:
        if mode not in (MODE_SIMPLE, MODE_ADVANCED):
            return
        self.state.mode = mode
        self._notify()

    def _notify(self) -> None:
        try:
            self.on_change()
        except Exception:  # pragma: no cover - defensive
            pass

    def accept_recipe_file(self, path: Path) -> None:
        self.state.recipe_error = None
        self.state.recipe_path = path
        self._notify()
        threading.Thread(target=self._run_verify_sync, daemon=True).start()

    def accept_recipe_text(self, text: str) -> None:
        self.state.recipe_error = None
        try:
            staged = stage_pasted_recipe(text)
        except ValueError as e:
            self.state.recipe_error = str(e)
            self._notify()
            return
        except OSError as e:
            self.state.recipe_error = f"Could not stage pasted recipe: {e}"
            self._notify()
            return
        self.state.pasted_recipe_staging = staged
        self.state.recipe_path = staged
        self._notify()
        threading.Thread(target=self._run_verify_sync, daemon=True).start()

    def accept_iso_file(self, path: Path) -> None:
        self.state.iso_path = path
        self._notify()

    def refresh_disks(self) -> None:
        if self.state.is_refreshing_disks:
            return
        self.state.is_refreshing_disks = True
        self._notify()
        threading.Thread(target=self._refresh_disks_sync, daemon=True).start()

    def _refresh_disks_sync(self) -> None:
        try:
            all_disks = enumerate_devices(self._run_lsblk)
            self.state.disks = safe_devices(all_disks)
            if self.state.selected_disk and self.state.selected_disk.device_path not in {
                d.device_path for d in self.state.disks
            }:
                self.state.selected_disk = None
        finally:
            self.state.is_refreshing_disks = False
            self._notify()

    def select_disk(self, device_path: str) -> None:
        for d in self.state.disks:
            if d.device_path == device_path:
                self.state.selected_disk = d
                self._notify()
                return

    def clear_log(self) -> None:
        self.state.log_lines = []
        self._notify()

    def cancel(self) -> None:
        cancel = self._cancel_download
        if cancel is not None:
            cancel.set()
        if self._current_runner is not None:
            self._current_runner.terminate()

    def run_verify(self) -> None:
        threading.Thread(target=self._run_verify_sync, daemon=True).start()

    def _run_verify_sync(self) -> None:
        if self.state.recipe_path is None:
            return
        def build(entry: str) -> list[str]:
            return args_verify(entry, str(self.state.recipe_path))
        self._run_cli(build, on_success=self._on_verify_ok)

    def _on_verify_ok(self, stdout_text: str) -> None:
        parsed = parse_verify_json(stdout_text)
        if parsed is not None:
            self.state.verified = VerifyInfo.from_dict(parsed)
            self._notify()

    def run_bake(self) -> None:
        """Flash the USB. Both modes remaster + write via the Node CLI's
        `write` subcommand (needs root → pkexec). Simple mode first ensures the
        server-manifest Debian base ISO is cached, then feeds it to the SAME
        CLI path Advanced uses with a user-supplied ISO."""
        if self.state.mode == MODE_SIMPLE:
            threading.Thread(target=self._run_simple_bake_sync, daemon=True).start()
        else:
            threading.Thread(target=self._run_bake_sync, daemon=True).start()

    def _run_bake_sync(self) -> None:
        if not self.state.can_flash:
            return
        recipe = self.state.recipe_path
        iso = self.state.iso_path
        disk = self.state.selected_disk
        assert recipe is not None and iso is not None and disk is not None
        self.state.phase = "remaster"
        self.state.progress = None
        self._notify()
        self._cli_write(recipe, iso, disk)

    def _run_simple_bake_sync(self) -> None:
        """Ensure the server-manifest base ISO, then run the same CLI
        remaster+write path Advanced uses. Owns is_running across the WHOLE
        download→remaster→write pipeline (mirrors Wizard.cs RunSimpleBakeAsync)
        so the UI shows progress + Cancel from the first byte and a second
        bake can't start mid-download."""
        recipe = self.state.recipe_path
        disk = self.state.selected_disk
        if recipe is None or disk is None:
            return
        with self._lock:
            if self.state.is_running:
                return
            self.state.is_running = True
        cancel = threading.Event()
        self._cancel_download = cancel

        # 1. Fetch/verify the base ISO per the server manifest. The download
        #    URL is surfaced via state.download_url (shown under the bar).
        self.state.phase = "download"
        self.state.progress = None
        self.state.download_url = None
        self._notify()

        def _on_progress(fraction: float, url: str) -> None:
            self.state.progress = fraction
            self.state.download_url = url
            self._notify()

        def _on_download_start(descriptor) -> None:
            self.state.download_url = descriptor.url
            self._append_log(
                "stdout",
                f"+ fetching base image {descriptor.version} ({descriptor.url})",
            )
            self._notify()

        try:
            try:
                base = self._ensure_base(
                    self._burner_version,
                    progress=_on_progress,
                    on_download_start=_on_download_start,
                    log=lambda m: self._append_log("stdout", m),
                    cancel_event=cancel,
                )
            except iso_base_cache.CacheError as e:
                self._append_log("stderr", str(e))
                return

            self.state.base_iso_path = Path(base)
            self.state.iso_path = Path(base)
            self.state.download_url = None

            # 2. Same Node-CLI remaster+write path Advanced uses.
            self.state.phase = "remaster"
            self.state.progress = None
            self._notify()

            def build(entry: str) -> list[str]:
                return args_write(
                    entry,
                    str(recipe),
                    str(base),
                    device=disk.device_path,
                    yes=True,
                    keep_recipe=False,
                )

            self._run_cli_core(build, on_success=self._on_bake_ok, use_pkexec=True)
        finally:
            self._cancel_download = None
            self.state.phase = None
            self.state.progress = None
            self.state.download_url = None
            with self._lock:
                self.state.is_running = False
            self._notify()

    def _cli_write(self, recipe: Path, iso: Path, disk: DeviceInfo) -> None:
        def build(entry: str) -> list[str]:
            return args_write(
                entry,
                str(recipe),
                str(iso),
                device=disk.device_path,
                yes=True,
                keep_recipe=False,
            )
        self._run_cli(build, on_success=self._on_bake_ok, use_pkexec=True)

    def _on_bake_ok(self, _stdout_text: str) -> None:
        self.state.is_finished = True
        self.state.phase = None
        self.state.progress = None
        self._notify()

    def run_prepare(self) -> None:
        """Optional path: emit a flashable ISO without writing to the
        USB. Kept around because the Mac GUI exposes it; useful when
        the user wants to dd elsewhere."""
        threading.Thread(target=self._run_prepare_sync, daemon=True).start()

    def _run_prepare_sync(self) -> None:
        if self.state.recipe_path is None or self.state.iso_path is None:
            return
        recipe = self.state.recipe_path
        iso = self.state.iso_path
        out = derive_out_iso_path(iso)
        self.state.out_iso_path = out
        self._notify()
        def build(entry: str) -> list[str]:
            return args_prepare(entry, str(recipe), str(iso), str(out), keep_recipe=True)
        self._run_cli(build, on_success=self._on_prepare_ok)

    def _on_prepare_ok(self, _stdout_text: str) -> None:
        self.state.is_finished = True
        self._notify()

    # ---- pane switching (mirrors Wizard.cs: exactly one main pane visible;
    #      priority: server detail, then the pairing cover, then the
    #      recipe -> destination flow) ----

    @property
    def selected_server(self):
        name = self.state.selected_server_name
        return self.vm.server(name) if name else None

    @property
    def show_server_detail(self) -> bool:
        return self.selected_server is not None

    @property
    def show_pairing_cover(self) -> bool:
        return not self.show_server_detail and self.state.is_pairing

    @property
    def show_destination_chooser(self) -> bool:
        return (
            not self.show_server_detail
            and not self.state.is_pairing
            and self.state.verified is not None
            and self.state.destination is None
            and not self.state.is_running
            and not self.state.is_finished
        )

    @property
    def show_host_here_pane(self) -> bool:
        return (
            not self.show_server_detail
            and not self.state.is_pairing
            and self.state.destination == ServerDestination.HOST_HERE
        )

    @property
    def show_wizard_panes(self) -> bool:
        return (
            not self.show_server_detail
            and not self.state.is_pairing
            and not self.show_destination_chooser
            and not self.show_host_here_pane
        )

    @property
    def show_destination_back_link(self) -> bool:
        return (
            self.show_wizard_panes
            and self.state.verified is not None
            and self.state.destination == ServerDestination.BURN_TO_USB
            and not self.state.is_running
        )

    @property
    def has_hosted_servers(self) -> bool:
        return len(self.vm.servers) > 0

    def set_destination(self, destination: Optional[ServerDestination]) -> None:
        self.state.destination = destination
        self._notify()

    def select_server(self, name: Optional[str]) -> None:
        self.state.selected_server_name = name
        self._notify()

    def reset_to_new_server(self) -> None:
        """The "+ Add a server" sidebar entry: back to a fresh wizard."""
        if self.state.is_pairing:
            self.cancel_pairing()
        self.state.selected_server_name = None
        self.state.destination = None
        self.state.recipe_path = None
        self.state.pasted_recipe_staging = None
        self.state.verified = None
        self.state.recipe_error = None
        self.state.is_finished = False
        self._notify()

    # ---- Host on this PC ----

    @property
    def host_here_disabled_reason(self) -> Optional[str]:
        """Why "Host on this PC" is unavailable — None means it's usable.
        Honest, actionable reasons only (toolchain / capacity). A missing KVM
        does NOT block: the VM degrades to TCG with accel_warning."""
        if self.vm.toolchain_error is not None:
            return self.vm.toolchain_error
        cap = self.vm.max_vm_count
        if cap == 0:
            floor = resource_plan.MINIMUM_VM_MEMORY_BYTES // resource_plan.GIB
            return (
                "This PC doesn't have enough free memory to host a server "
                f"(each server needs ~{floor} GiB)."
            )
        if len(self.vm.servers) >= cap:
            return (
                f"This PC is at its hosting limit ({cap}). Remove one first, "
                "or burn to USB."
            )
        return None

    @property
    def host_here_enabled(self) -> bool:
        return self.host_here_disabled_reason is None

    @property
    def host_here_accel_warning(self) -> Optional[str]:
        return self.vm.accel_warning

    @property
    def hardware_badge_label(self) -> str:
        return ServerTier.HARDWARE.badge_label

    @property
    def hosted_vm_badge_label(self) -> str:
        return ServerTier.HOSTED_VM.badge_label

    @property
    def host_here_spec_summary(self) -> str:
        host = HostResources.current()
        return (
            "Will run as a managed VM on this PC — "
            f"{resource_plan.vm_cpu_count(host)} vCPU, "
            f"{resource_plan.vm_memory_bytes(host) // resource_plan.GIB} GiB RAM, "
            f"{resource_plan.DEFAULT_MAIN_DISK_SIZE_BYTES // resource_plan.GIB} GiB disk."
        )

    def run_host_here(self) -> None:
        threading.Thread(target=self._run_host_here_sync, daemon=True).start()

    def _run_host_here_sync(self) -> None:
        """"Host here": the SAME recipe -> the SAME remastered installer ISO
        (via the Node CLI's prepare, which also bakes the debug grant's SSH key
        exactly like a USB burn), but applied to a managed VM on this PC. The
        guest boot chain (unattended install -> LUKS -> phone-home unlock ->
        register) runs unmodified inside the VM; this app never holds a key."""
        if self.state.recipe_path is None or self.state.verified is None:
            return
        reason = self.host_here_disabled_reason
        if reason is not None:
            self._append_log("stderr", reason)
            return
        recipe = self.state.recipe_path
        try:
            raw = Path(recipe).read_bytes()
            fields = recipe_info.read_recipe_fields(raw)
        except (OSError, ValueError) as e:
            self._append_log("stderr", f"Cannot read the recipe: {e}")
            return
        # host_here_disabled_reason above already refused a None host arch
        # (create_default sets toolchain_error), so the fallback never fires
        # in practice — it only keeps the type honest.
        guest_arch = self.vm.host_arch_tag or host_arch.ARCH_AMD64
        config = VMConfig.plan(fields, raw, HostResources.current(), arch=guest_arch)

        # Own is_running across the whole download→remaster pipeline (mirrors
        # Wizard.cs RunHostHereAsync) so progress + Cancel work from the first
        # byte and nothing else can start mid-flight.
        with self._lock:
            if self.state.is_running:
                return
            self.state.is_running = True
        cancel = threading.Event()
        self._cancel_download = cancel
        self._notify()
        try:
            # Same Simple-mode base ISO fetch as the USB path (HOST arch — the
            # guest must match this machine); Advanced mode may bring its own
            # stock ISO.
            if self.state.mode == MODE_ADVANCED and self.state.iso_path is not None:
                base = self.state.iso_path
            else:
                self.state.phase = "download"
                self.state.progress = None
                self.state.download_url = None
                self._notify()

                def _on_progress(fraction: float, url: str) -> None:
                    self.state.progress = fraction
                    self.state.download_url = url
                    self._notify()

                def _on_download_start(descriptor) -> None:
                    self.state.download_url = descriptor.url
                    self._append_log(
                        "stdout",
                        f"+ fetching base image {descriptor.version} ({descriptor.url})",
                    )

                try:
                    base = Path(
                        self._ensure_base(
                            self._burner_version,
                            progress=_on_progress,
                            on_download_start=_on_download_start,
                            log=lambda m: self._append_log("stdout", m),
                            cancel_event=cancel,
                            arch=guest_arch,
                        )
                    )
                except iso_base_cache.CacheError as e:
                    self._append_log("stderr", str(e))
                    return

            # Create the bundle, then remaster the installer INTO it — identical
            # remaster to the USB path (same engine, same recipe).
            self.state.phase = "remaster"
            self.state.progress = None
            self.state.download_url = None
            self._notify()
            try:
                self.vm.create_server(config)
            except (VMStoreError, ValueError) as e:
                self._append_log("stderr", str(e))
                return
            out_iso = self.vm.installer_iso_path(config.name)
            remastered = [False]

            def build(entry: str) -> list[str]:
                return args_prepare(entry, str(recipe), str(base), out_iso, keep_recipe=True)

            def on_ok(_stdout: str) -> None:
                remastered[0] = True

            self._run_cli_core(build, on_success=on_ok)
            if not remastered[0]:
                self.vm.delete_server(config.name)
                return

            # Shred the single-use recipe, exactly like a successful USB burn.
            try:
                os.unlink(recipe)
            except OSError:
                pass
            self.state.selected_server_name = config.name
            self.state.destination = None
            self.state.recipe_path = None
            self.state.pasted_recipe_staging = None
            self.state.verified = None
            self._notify()
            self.vm.begin_install(config.name)
        finally:
            self._cancel_download = None
            self.state.phase = None
            self.state.progress = None
            self.state.download_url = None
            with self._lock:
                self.state.is_running = False
            self._notify()

    # ---- hosted-server actions (sidebar rows + detail pane) ----

    def start_server(self, name: str) -> None:
        threading.Thread(target=lambda: self.vm.power_on(name), daemon=True).start()

    def stop_server(self, name: str) -> None:
        threading.Thread(target=lambda: self.vm.power_off(name), daemon=True).start()

    def retry_install(self, name: str) -> None:
        threading.Thread(target=lambda: self.vm.begin_install(name), daemon=True).start()

    def delete_server(self, name: str) -> None:
        """Confirmation is the VIEW's job (dialog); this executes."""
        self.vm.delete_server(name)
        if self.state.selected_server_name == name:
            self.state.selected_server_name = None
        self._notify()

    def open_ssh(self, name: str) -> None:
        """Open the user's terminal at the hosted debug VM's forwarded loopback
        port. The forward exists only for a RUNNING debug VM (a production VM
        never gets one — guarded in qemu_command_line); the guest's own debug
        gate still governs whether the login is accepted. Always local:
        127.0.0.1:<port>, never a relay."""
        host = self.vm.host(name)
        if host is None or host.ssh_port == 0:
            self._append_log(
                "stderr",
                "SSH is available once the server is running (a debug-enabled "
                "VM forwards a local port to the guest).",
            )
            return
        try:
            argv = self._ssh_launch(host.ssh_port)
            if isinstance(argv, list):
                self._append_log("stdout", "+ " + " ".join(argv))
        except ssh_launch.SshLaunchError as e:
            self._append_log("stderr", str(e))

    # ---- phone pairing ----

    def start_pairing(self) -> None:
        """Spawn `flagship-burn pair --emit-events`, surface the QR / code /
        SAS / status, and on delivery load the received recipe (identical to a
        dropped-in recipe file) -> the destination chooser."""
        if self.state.is_pairing:
            return
        s = self.state
        s.selected_server_name = None
        s.destination = None
        s.recipe_error = None
        s.verified = None
        s.is_finished = False
        s.pair_qr = None
        s.pair_code = None
        s.pair_sas = None
        s.pair_status = "Starting…"
        s.is_pairing = True
        self._notify()

        session = self._pair_session_factory(s.pair_debug)
        self._pair = session

        def run() -> None:
            try:
                session.run(
                    on_event=self._handle_pair_event,
                    on_log=lambda ll: self._append_log(ll.stream, ll.text),
                )
            except (CLILocateError, FileNotFoundError, OSError) as e:
                self._append_log("stderr", f"pair failed: {e}")
                self._end_pairing("Pairing couldn't start — is Node installed?")

        threading.Thread(target=run, daemon=True).start()

    def cancel_pairing(self) -> None:
        pair = self._pair
        if pair is not None:
            pair.cancel()
        self._end_pairing(None)

    def set_pair_debug(self, value: bool) -> None:
        self.state.pair_debug = bool(value)
        self._notify()

    def _end_pairing(self, status: Optional[str]) -> None:
        self._pair = None
        self.state.is_pairing = False
        if status is not None:
            self.state.pair_status = status
        self.state.pair_qr = None
        self.state.pair_sas = None
        self._notify()

    def _handle_pair_event(self, ev: PairEvent) -> None:
        s = self.state
        if ev.event == "ready":
            s.pair_qr = ev.qr_terminal
            s.pair_code = ev.human_code
            s.pair_status = "Scan the QR with the Flagship app, or type the code."
        elif ev.event == "phone-connected":
            s.pair_sas = ev.sas
            s.pair_status = (
                "Phone connected — check the security code matches, then "
                "approve on your phone."
            )
        elif ev.event == "paired":
            s.pair_status = "Paired — receiving your recipe…"
        elif ev.event == "delivered":
            s.pair_status = f"Recipe received for {ev.server_domain}."
        elif ev.event == "debug-result":
            self._append_log(
                "stdout",
                "debug access granted (owner-signed)"
                if ev.granted
                else "debug access not granted — production image",
            )
        elif ev.event == "done":
            s.is_pairing = False
            self._pair = None
            s.pair_sas = None
            s.pair_status = None
            if ev.recipe_path and os.path.exists(ev.recipe_path):
                # Identical to a dropped-in recipe file: verify + go to the
                # destination chooser.
                self.accept_recipe_file(Path(ev.recipe_path))
                return  # accept_recipe_file notified
        elif ev.event == "error":
            self._end_pairing(ev.message or "Pairing failed.")
            return
        self._notify()

    def _run_cli(
        self,
        build_args: Callable[[str], list[str]],
        on_success: Callable[[str], None],
        use_pkexec: bool = False,
    ) -> None:
        with self._lock:
            if self.state.is_running:
                return
            self.state.is_running = True
        self._notify()
        try:
            self._run_cli_core(build_args, on_success, use_pkexec)
        finally:
            self.state.phase = None
            self.state.progress = None
            self.state.download_url = None
            with self._lock:
                self.state.is_running = False
            self._notify()

    def _run_cli_core(
        self,
        build_args: Callable[[str], list[str]],
        on_success: Callable[[str], None],
        use_pkexec: bool = False,
    ) -> None:
        """CLI body WITHOUT the is_running toggle/guard — for callers (Simple
        bake, host-here) that already own the running state across a
        multi-phase pipeline. Mirrors Wizard.cs RunCliCoreAsync."""
        # Unelevatable otherwise surfaces as a bare ENOENT at spawn time —
        # after the remaster already ran. Probe up front: pkexec normally,
        # passwordless sudo where pkexec can't work (ChromeOS's container).
        elev = None
        if use_pkexec:
            elev = self._probe_elevation()
            if elev is None:
                self._append_log("stderr", elevation.MISSING_MESSAGE)
                return
            if elev.prefix != ["pkexec"]:
                self._append_log("stdout", f"+ elevating via {elev.label}")
        try:
            resolved = self._locate_fn()
        except CLILocateError as e:
            self._append_log("stderr", f"CLI locate failed: {e}")
            return
        args = build_args(resolved.entry_path)
        runner = CLIRunner(
            node_path=resolved.node_path,
            arguments=args,
            use_pkexec=use_pkexec,
            elevation_prefix=elev.prefix if elev is not None else None,
        )
        self._current_runner = runner
        self._append_log("stdout", f"+ {runner.command_string}")
        try:
            try:
                runner.start(on_line=lambda ll: self._append_log(ll.stream, ll.text))
            except (FileNotFoundError, OSError) as e:
                self._append_log("stderr", f"spawn failed: {e}")
                return
            code = runner.wait()
            stdout_text = runner.stdout_text
            if code == 0:
                on_success(stdout_text)
            else:
                self._append_log("stderr", f"CLI exited {code}")
        finally:
            self._current_runner = None

    def _append_log(self, stream: str, text: str) -> None:
        self.state.log_lines.append(LogLine(stream=stream, text=text))
        self._notify()


# ---- GTK view (only constructed when libadwaita is available) ----


def build_window(application, model: Optional[WizardModel] = None):
    """Construct the wizard window. Raises ImportError on systems without
    GTK4/libadwaita installed. Returns an Adw.ApplicationWindow."""
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("Adw", "1")
    from gi.repository import Adw, Gtk, GLib, Gio  # type: ignore  # noqa: E402

    wizard_model = model if model is not None else WizardModel(mode=MODE_SIMPLE)

    window = Adw.ApplicationWindow(application=application)
    window.set_title("Flagship Burner")
    window.set_default_size(960, 820)

    header = Adw.HeaderBar()

    # ---- mode toggle (Simple default / Advanced) ----
    mode_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
    mode_label = Gtk.Label(label="Bring my own ISO (Advanced)", xalign=0.0)
    mode_switch = Gtk.Switch()
    mode_switch.set_active(wizard_model.state.mode == MODE_ADVANCED)
    mode_switch.set_valign(Gtk.Align.CENTER)

    def _on_mode_toggle(sw, _pspec):
        wizard_model.set_mode(MODE_ADVANCED if sw.get_active() else MODE_SIMPLE)

    mode_switch.connect("notify::active", _on_mode_toggle)
    mode_box.append(mode_label)
    mode_box.append(mode_switch)
    header.pack_end(mode_box)

    # Main vertical layout: (main panes | hosted-servers sidebar) + log pane.
    root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    if hasattr(Adw, "ToolbarView"):
        toolbar = Adw.ToolbarView()
        toolbar.add_top_bar(header)
        toolbar.set_content(root)
        window.set_content(toolbar)
    else:
        # libadwaita < 1.4 (Debian 12 / Ubuntu 22.04 / ChromeOS's stock
        # container) has no ToolbarView; a plain box gives the same layout.
        fallback = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        fallback.append(header)
        root.set_vexpand(True)
        fallback.append(root)
        window.set_content(fallback)

    content_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
    content_row.set_vexpand(True)
    root.append(content_row)

    # Exactly one main pane is visible at a time (pane switching mirrors the
    # Windows app): wizard steps / destination chooser / host-here / pairing
    # cover / hosted-server detail.
    main_stack = Gtk.Stack()
    main_stack.set_hexpand(True)
    main_stack.set_vexpand(True)
    content_row.append(main_stack)

    scroller = Gtk.ScrolledWindow()
    scroller.set_vexpand(True)
    scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    main_stack.add_named(scroller, "wizard")

    content_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
    content_box.set_margin_top(20)
    content_box.set_margin_bottom(20)
    content_box.set_margin_start(24)
    content_box.set_margin_end(24)
    scroller.set_child(content_box)

    # ---- Step 1: recipe ----
    step1 = _wizard_card(
        step=1,
        title="Drop the recipe",
        subtitle="JSON file from the website after you scanned the QR code.",
    )
    content_box.append(step1["card"])

    recipe_drop = _drop_zone(
        "Drop .flagship-recipe.json here",
        on_drop=lambda p: wizard_model.accept_recipe_file(Path(p)),
        Gtk=Gtk,
    )
    step1["body"].append(recipe_drop)

    choose_recipe = Gtk.Button(label="Choose file...")
    choose_recipe.connect("clicked", lambda _b: _pick_file(
        window, "Pick recipe", filters=[("JSON", "*.json")],
        on_pick=lambda p: wizard_model.accept_recipe_file(Path(p)),
        Gtk=Gtk,
    ))
    step1["body"].append(choose_recipe)

    paste_label = Gtk.Label(label="Or paste the JSON:", xalign=0.0)
    paste_label.add_css_class("dim-label")
    step1["body"].append(paste_label)

    paste_buf = Gtk.TextBuffer()
    paste_view = Gtk.TextView(buffer=paste_buf)
    paste_view.set_monospace(True)
    paste_scroll = Gtk.ScrolledWindow()
    paste_scroll.set_min_content_height(100)
    paste_scroll.set_child(paste_view)
    step1["body"].append(paste_scroll)

    use_pasted = Gtk.Button(label="Use pasted JSON")

    def _on_use_pasted(_b):
        text = paste_buf.get_text(paste_buf.get_start_iter(), paste_buf.get_end_iter(), True)
        wizard_model.accept_recipe_text(text)

    use_pasted.connect("clicked", _on_use_pasted)
    step1["body"].append(use_pasted)

    pair_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    pair_btn = Gtk.Button(label="Pair with your phone")
    pair_btn.set_tooltip_text(
        "Scan a QR with the Flagship app to receive a recipe — no file needed."
    )
    pair_btn.connect("clicked", lambda _b: wizard_model.start_pairing())
    pair_row.append(pair_btn)
    pair_debug_check = Gtk.CheckButton(label="Request debug access (Advanced)")
    pair_debug_check.set_tooltip_text(
        "Asks your phone to sign a debug-access grant. The box verifies it "
        "against your owner key; without it the image is production (no "
        "console, no SSH)."
    )
    pair_debug_check.connect(
        "toggled", lambda cb: wizard_model.set_pair_debug(cb.get_active())
    )
    pair_row.append(pair_debug_check)
    step1["body"].append(pair_row)

    recipe_status = Gtk.Label(xalign=0.0)
    recipe_status.set_wrap(True)
    step1["body"].append(recipe_status)

    verify_badge = Gtk.Label(xalign=0.0)
    verify_badge.set_wrap(True)
    verify_badge.add_css_class("success")
    step1["body"].append(verify_badge)

    # ---- Step 2: ISO ----
    step2 = _wizard_card(
        step=2,
        title="Drop the ISO",
        subtitle="Ubuntu Server stock image. Run `flagship-burn distros` for accepted SHAs.",
    )
    content_box.append(step2["card"])

    iso_drop = _drop_zone(
        "Drop ubuntu-*-live-server.iso here",
        on_drop=lambda p: wizard_model.accept_iso_file(Path(p)),
        Gtk=Gtk,
    )
    step2["body"].append(iso_drop)

    choose_iso = Gtk.Button(label="Choose file...")
    choose_iso.connect("clicked", lambda _b: _pick_file(
        window, "Pick ISO", filters=[("ISO", "*.iso")],
        on_pick=lambda p: wizard_model.accept_iso_file(Path(p)),
        Gtk=Gtk,
    ))
    step2["body"].append(choose_iso)

    iso_status = Gtk.Label(xalign=0.0)
    step2["body"].append(iso_status)

    # ---- Step 3: USB disk ----
    step3 = _wizard_card(
        step=3,
        title="Pick the USB drive",
        subtitle="Only removable drives in the 500MB-500GB band. Internal disks are hidden by design.",
    )
    content_box.append(step3["card"])

    disk_controls = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
    refresh_btn = Gtk.Button(label="Refresh")
    refresh_btn.connect("clicked", lambda _b: wizard_model.refresh_disks())
    disk_controls.append(refresh_btn)
    refresh_spinner = Gtk.Spinner()
    disk_controls.append(refresh_spinner)
    step3["body"].append(disk_controls)

    disks_list = Gtk.ListBox()
    disks_list.set_selection_mode(Gtk.SelectionMode.SINGLE)

    def _on_disk_selected(_lb, row):
        if row is not None:
            wizard_model.select_disk(row.device_path)  # type: ignore[attr-defined]

    disks_list.connect("row-selected", _on_disk_selected)
    step3["body"].append(disks_list)

    no_disks = Gtk.Label(
        label=container_env.no_disks_hint(container_env.is_chromeos_container()),
        xalign=0.0,
    )
    no_disks.set_wrap(True)
    no_disks.add_css_class("dim-label")
    step3["body"].append(no_disks)

    # ---- Step 4: bake ----
    step4 = _wizard_card(
        step=4,
        title="Flash the USB",
        subtitle="Writes the install image to the picked disk. Needs admin via pkexec.",
    )
    content_box.append(step4["card"])

    readiness = Gtk.Label(xalign=0.0)
    readiness.set_wrap(True)
    step4["body"].append(readiness)

    bake_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    bake_btn = Gtk.Button(label="Flash to USB")
    bake_btn.add_css_class("suggested-action")
    bake_btn.add_css_class("pill")
    bake_btn.connect("clicked", lambda _b: wizard_model.run_bake())
    bake_row.append(bake_btn)

    prep_btn = Gtk.Button(label="Bake ISO only (no flash)")
    prep_btn.connect("clicked", lambda _b: wizard_model.run_prepare())
    bake_row.append(prep_btn)

    verify_btn = Gtk.Button(label="Verify recipe only")
    verify_btn.connect("clicked", lambda _b: wizard_model.run_verify())
    bake_row.append(verify_btn)
    step4["body"].append(bake_row)

    # Progress: accent-coloured during the base download + remaster + write.
    progress_bar = Gtk.ProgressBar()
    progress_bar.set_show_text(True)
    progress_bar.set_visible(False)
    step4["body"].append(progress_bar)

    # Download URL surfaced directly under the bar (Simple-mode base fetch).
    download_url_label = Gtk.Label(xalign=0.0)
    download_url_label.set_wrap(True)
    download_url_label.set_selectable(True)
    download_url_label.add_css_class("dim-label")
    download_url_label.add_css_class("monospace")
    download_url_label.set_visible(False)
    step4["body"].append(download_url_label)

    out_path_label = Gtk.Label(xalign=0.0)
    out_path_label.set_selectable(True)
    out_path_label.add_css_class("monospace")
    step4["body"].append(out_path_label)

    # ---- Step 5: done ----
    step5 = _wizard_card(
        step=5,
        title="Done",
        subtitle="Bring this USB to the machine you're installing on.",
    )
    content_box.append(step5["card"])
    done_label = Gtk.Label(xalign=0.0)
    done_label.set_wrap(True)
    done_label.set_selectable(True)
    step5["body"].append(done_label)
    step5["card"].set_visible(False)

    # ---- Destination chooser (a verified recipe picks USB vs host-here) ----
    chooser_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
    for setter in ("set_margin_top", "set_margin_bottom", "set_margin_start", "set_margin_end"):
        getattr(chooser_box, setter)(24)
    chooser_domain = Gtk.Label(xalign=0.0)
    chooser_domain.add_css_class("title-3")
    chooser_box.append(chooser_domain)
    chooser_sub = Gtk.Label(
        label="Recipe verified — choose where this server should live.", xalign=0.0
    )
    chooser_sub.add_css_class("dim-label")
    chooser_box.append(chooser_sub)

    usb_card = Gtk.Button()
    usb_inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
    usb_title = Gtk.Label(label="Burn to USB", xalign=0.0)
    usb_title.add_css_class("heading")
    usb_inner.append(usb_title)
    usb_badge = Gtk.Label(label=wizard_model.hardware_badge_label, xalign=0.0)
    usb_badge.add_css_class("dim-label")
    usb_inner.append(usb_badge)
    usb_hint = Gtk.Label(
        label="Build a dedicated hardware appliance — the gold standard. "
        "Boot any spare box from the USB stick.",
        xalign=0.0,
    )
    usb_hint.set_wrap(True)
    usb_hint.add_css_class("dim-label")
    usb_inner.append(usb_hint)
    usb_card.set_child(usb_inner)
    usb_card.connect(
        "clicked", lambda _b: wizard_model.set_destination(ServerDestination.BURN_TO_USB)
    )
    chooser_box.append(usb_card)

    host_card = Gtk.Button()
    host_inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
    host_title = Gtk.Label(label="Host on this PC", xalign=0.0)
    host_title.add_css_class("heading")
    host_inner.append(host_title)
    host_badge = Gtk.Label(label=wizard_model.hosted_vm_badge_label, xalign=0.0)
    host_badge.add_css_class("dim-label")
    host_inner.append(host_badge)
    host_hint = Gtk.Label(
        label="Run the same encrypted, phone-gated appliance as a managed VM "
        "inside this app. Same recipe, same unlock — your phone still holds "
        "the keys.",
        xalign=0.0,
    )
    host_hint.set_wrap(True)
    host_hint.add_css_class("dim-label")
    host_inner.append(host_hint)
    host_reason = Gtk.Label(xalign=0.0)
    host_reason.set_wrap(True)
    host_reason.add_css_class("warning")
    host_reason.set_visible(False)
    host_inner.append(host_reason)
    host_card.set_child(host_inner)
    host_card.connect(
        "clicked", lambda _b: wizard_model.set_destination(ServerDestination.HOST_HERE)
    )
    chooser_box.append(host_card)
    main_stack.add_named(chooser_box, "chooser")

    # ---- Host here (create the VM) ----
    hosthere_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    for setter in ("set_margin_top", "set_margin_bottom", "set_margin_start", "set_margin_end"):
        getattr(hosthere_box, setter)(24)
    hh_back = Gtk.Button(label="‹ Choose destination")
    hh_back.set_halign(Gtk.Align.START)
    hh_back.add_css_class("flat")
    hh_back.connect("clicked", lambda _b: wizard_model.set_destination(None))
    hosthere_box.append(hh_back)
    hh_domain = Gtk.Label(xalign=0.0)
    hh_domain.add_css_class("title-3")
    hosthere_box.append(hh_domain)
    hh_spec = Gtk.Label(xalign=0.0)
    hh_spec.set_wrap(True)
    hh_spec.add_css_class("dim-label")
    hosthere_box.append(hh_spec)
    hh_note = Gtk.Label(
        label="The VM installs unattended from the same image a USB burn uses, "
        "then boots encrypted and waits for your phone to unlock it. This app "
        "never sees the disk key.",
        xalign=0.0,
    )
    hh_note.set_wrap(True)
    hh_note.add_css_class("dim-label")
    hosthere_box.append(hh_note)
    hh_accel_warning = Gtk.Label(xalign=0.0)
    hh_accel_warning.set_wrap(True)
    hh_accel_warning.add_css_class("warning")
    hh_accel_warning.set_visible(False)
    hosthere_box.append(hh_accel_warning)
    hh_create = Gtk.Button(label="Create server on this PC")
    hh_create.add_css_class("suggested-action")
    hh_create.add_css_class("pill")
    hh_create.set_halign(Gtk.Align.CENTER)
    hh_create.connect("clicked", lambda _b: wizard_model.run_host_here())
    hosthere_box.append(hh_create)
    hh_caption = Gtk.Label(label="Encrypted disk · unlocked by your phone")
    hh_caption.add_css_class("dim-label")
    hosthere_box.append(hh_caption)
    hh_progress = Gtk.ProgressBar()
    hh_progress.set_show_text(True)
    hh_progress.set_visible(False)
    hosthere_box.append(hh_progress)
    hh_url = Gtk.Label(xalign=0.0)
    hh_url.set_wrap(True)
    hh_url.add_css_class("dim-label")
    hh_url.add_css_class("monospace")
    hh_url.set_visible(False)
    hosthere_box.append(hh_url)
    main_stack.add_named(hosthere_box, "hosthere")

    # ---- Pairing cover ----
    pairing_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    pairing_box.set_valign(Gtk.Align.CENTER)
    pairing_box.set_halign(Gtk.Align.CENTER)
    pairing_title = Gtk.Label(label="Pair with your phone")
    pairing_title.add_css_class("title-2")
    pairing_box.append(pairing_title)
    pairing_status = Gtk.Label()
    pairing_status.set_wrap(True)
    pairing_status.add_css_class("dim-label")
    pairing_box.append(pairing_status)
    pairing_qr = Gtk.Label()
    pairing_qr.add_css_class("monospace")
    pairing_qr.set_selectable(False)
    pairing_box.append(pairing_qr)
    pairing_code = Gtk.Label()
    pairing_code.add_css_class("monospace")
    pairing_code.set_selectable(True)
    pairing_box.append(pairing_code)
    pairing_sas_caption = Gtk.Label(
        label="Security code — confirm it matches your phone"
    )
    pairing_sas_caption.add_css_class("dim-label")
    pairing_sas_caption.set_visible(False)
    pairing_box.append(pairing_sas_caption)
    pairing_sas = Gtk.Label()
    pairing_sas.add_css_class("title-1")
    pairing_sas.set_visible(False)
    pairing_box.append(pairing_sas)
    pairing_cancel = Gtk.Button(label="Cancel")
    pairing_cancel.set_halign(Gtk.Align.CENTER)
    pairing_cancel.connect("clicked", lambda _b: wizard_model.cancel_pairing())
    pairing_box.append(pairing_cancel)
    main_stack.add_named(pairing_box, "pairing")

    # ---- Hosted-server detail ----
    detail_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    for setter in ("set_margin_top", "set_margin_bottom", "set_margin_start", "set_margin_end"):
        getattr(detail_box, setter)(24)
    detail_title = Gtk.Label(xalign=0.0)
    detail_title.add_css_class("title-2")
    detail_box.append(detail_title)
    detail_fqdn = Gtk.Label(xalign=0.0)
    detail_fqdn.add_css_class("monospace")
    detail_fqdn.add_css_class("dim-label")
    detail_fqdn.set_selectable(True)
    detail_box.append(detail_fqdn)
    detail_badge = Gtk.Label(xalign=0.0)
    detail_badge.add_css_class("dim-label")
    detail_box.append(detail_badge)
    status_card = Gtk.Frame()
    status_card.add_css_class("card")
    status_inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
    for setter in ("set_margin_top", "set_margin_bottom", "set_margin_start", "set_margin_end"):
        getattr(status_inner, setter)(14)
    detail_state = Gtk.Label(xalign=0.0)
    detail_state.add_css_class("heading")
    status_inner.append(detail_state)
    detail_subtitle = Gtk.Label(xalign=0.0)
    detail_subtitle.set_wrap(True)
    detail_subtitle.add_css_class("dim-label")
    status_inner.append(detail_subtitle)
    status_card.set_child(status_inner)
    detail_box.append(status_card)
    detail_spec = Gtk.Label(xalign=0.0)
    detail_spec.add_css_class("dim-label")
    detail_box.append(detail_spec)
    detail_actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    detail_start = Gtk.Button(label="Start")
    detail_start.add_css_class("suggested-action")
    detail_actions.append(detail_start)
    detail_stop = Gtk.Button(label="Stop")
    detail_actions.append(detail_stop)
    detail_retry = Gtk.Button(label="Retry install")
    detail_retry.add_css_class("suggested-action")
    detail_actions.append(detail_retry)
    # SSH exists IFF the recipe carried the owner-signed debug grant. A
    # production VM shows no debug affordance at all (the phone-signed grant is
    # the gate; there is no host-side override).
    detail_ssh = Gtk.Button(label="Open in SSH")
    detail_actions.append(detail_ssh)
    detail_box.append(detail_actions)
    detail_delete = Gtk.Button(label="Delete this server")
    detail_delete.add_css_class("destructive-action")
    detail_delete.add_css_class("flat")
    detail_delete.set_halign(Gtk.Align.END)
    detail_delete.set_margin_top(24)
    detail_box.append(detail_delete)
    main_stack.add_named(detail_box, "detail")

    def _selected_name() -> Optional[str]:
        return wizard_model.state.selected_server_name

    def _confirm_delete(name: str) -> None:
        server = wizard_model.vm.server(name)
        fqdn = server.fqdn if server else name
        dialog = Adw.MessageDialog(
            transient_for=window,
            heading="Delete this server?",
            body=f"Delete {fqdn}?\n\nThe VM and its encrypted disk image are "
            "removed from this PC. The server's identity and any backups live "
            "with your phone/account, not here.",
        )
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("delete", "Delete")
        dialog.set_response_appearance("delete", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_default_response("cancel")

        def _on_response(_d, response):
            if response == "delete":
                wizard_model.delete_server(name)

        dialog.connect("response", _on_response)
        dialog.present()

    detail_start.connect(
        "clicked", lambda _b: wizard_model.start_server(_selected_name()) if _selected_name() else None
    )
    detail_stop.connect(
        "clicked", lambda _b: wizard_model.stop_server(_selected_name()) if _selected_name() else None
    )
    detail_retry.connect(
        "clicked", lambda _b: wizard_model.retry_install(_selected_name()) if _selected_name() else None
    )
    detail_ssh.connect(
        "clicked", lambda _b: wizard_model.open_ssh(_selected_name()) if _selected_name() else None
    )
    detail_delete.connect(
        "clicked", lambda _b: _confirm_delete(_selected_name()) if _selected_name() else None
    )

    # ---- Sidebar: servers hosted in this app ----
    content_row.append(Gtk.Separator(orientation=Gtk.Orientation.VERTICAL))
    sidebar = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    sidebar.set_size_request(250, -1)
    content_row.append(sidebar)
    sidebar_title = Gtk.Label(label="Servers on this PC", xalign=0.0)
    sidebar_title.add_css_class("heading")
    for setter in ("set_margin_top", "set_margin_start", "set_margin_end"):
        getattr(sidebar_title, setter)(12)
    sidebar.append(sidebar_title)
    server_list = Gtk.ListBox()
    server_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
    server_list.set_vexpand(True)
    server_list.add_css_class("navigation-sidebar")

    def _on_server_row_selected(_lb, row):
        if row is None:
            return
        name = getattr(row, "server_name", None)
        if name and name != wizard_model.state.selected_server_name:
            wizard_model.select_server(name)

    server_list.connect("row-selected", _on_server_row_selected)
    sidebar.append(server_list)
    no_servers = Gtk.Label(
        label='None yet. Verify a recipe and choose "Host on this PC".',
        xalign=0.0,
    )
    no_servers.set_wrap(True)
    no_servers.add_css_class("dim-label")
    for setter in ("set_margin_start", "set_margin_end"):
        getattr(no_servers, setter)(12)
    sidebar.append(no_servers)
    sidebar.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
    add_server_btn = Gtk.Button(label="＋ Add a server")
    add_server_btn.add_css_class("flat")
    add_server_btn.set_halign(Gtk.Align.START)
    for setter in ("set_margin_start", "set_margin_end", "set_margin_bottom"):
        getattr(add_server_btn, setter)(8)
    add_server_btn.connect("clicked", lambda _b: wizard_model.reset_to_new_server())
    sidebar.append(add_server_btn)

    def _rebuild_server_list() -> None:
        while True:
            row = server_list.get_first_child()
            if row is None:
                break
            server_list.remove(row)
        selected = wizard_model.state.selected_server_name
        for server in wizard_model.vm.servers:
            row = Gtk.ListBoxRow()
            row.server_name = server.name  # type: ignore[attr-defined]
            grid = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            for setter in ("set_margin_top", "set_margin_bottom", "set_margin_start", "set_margin_end"):
                getattr(grid, setter)(6)
            col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            col.set_hexpand(True)
            name_label = Gtk.Label(label=server.display_name, xalign=0.0)
            name_label.add_css_class("heading")
            name_label.set_ellipsize(3)  # Pango.EllipsizeMode.END
            col.append(name_label)
            badge_label = Gtk.Label(label=server.badge_label, xalign=0.0)
            badge_label.add_css_class("dim-label")
            col.append(badge_label)
            state_label = Gtk.Label(label=f"● {server.state_label}", xalign=0.0)
            state_label.add_css_class("dim-label")
            col.append(state_label)
            grid.append(col)

            # Row actions: the ⋯ button, right-click, and double-click all
            # reach the same dispatch; SSH appears only for a debug-enabled VM.
            menu_btn = Gtk.MenuButton(label="⋯")
            menu_btn.add_css_class("flat")
            menu_btn.set_valign(Gtk.Align.START)
            popover = Gtk.Popover()
            actions = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)

            def _action(label: str, name: str, fn, destructive: bool = False):
                b = Gtk.Button(label=label)
                b.add_css_class("flat")
                if destructive:
                    b.add_css_class("destructive-action")

                def _on(_btn, n=name, f=fn):
                    popover.popdown()
                    wizard_model.select_server(n)
                    f(n)

                b.connect("clicked", _on)
                actions.append(b)

            if server.console_enabled:
                _action("Open in SSH", server.name, wizard_model.open_ssh)
            if server.can_start:
                _action("Start", server.name, wizard_model.start_server)
            if server.can_stop:
                _action("Stop", server.name, wizard_model.stop_server)
            if server.can_retry_install:
                _action("Retry install", server.name, wizard_model.retry_install)
            _action("Delete…", server.name, _confirm_delete, destructive=True)
            popover.set_child(actions)
            menu_btn.set_popover(popover)
            grid.append(menu_btn)

            right_click = Gtk.GestureClick()
            right_click.set_button(3)
            right_click.connect(
                "pressed", lambda _g, _n, _x, _y, mb=menu_btn: mb.popup()
            )
            grid.add_controller(right_click)
            double_click = Gtk.GestureClick()
            double_click.set_button(1)

            def _on_double(_g, n_press, _x, _y, s=server):
                # Double-click is the shortcut to the primary debug action —
                # SSH into a running debug VM. A non-debug VM just stays
                # selected (no SSH surface).
                if n_press == 2 and s.console_enabled:
                    wizard_model.select_server(s.name)
                    wizard_model.open_ssh(s.name)

            double_click.connect("pressed", _on_double)
            grid.add_controller(double_click)

            row.set_child(grid)
            server_list.append(row)
            if selected == server.name:
                server_list.select_row(row)

    # ---- Log pane ----
    log_outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    log_outer.set_margin_start(24)
    log_outer.set_margin_end(24)
    log_outer.set_margin_bottom(16)
    root.append(log_outer)

    log_header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
    log_title = Gtk.Label(label="Log", xalign=0.0)
    log_title.add_css_class("heading")
    log_header.append(log_title)
    log_spinner = Gtk.Spinner()
    log_header.append(log_spinner)
    log_outer.append(log_header)

    cancel_btn = Gtk.Button(label="Cancel")
    cancel_btn.connect("clicked", lambda _b: wizard_model.cancel())
    cancel_btn.set_sensitive(False)
    log_header.append(cancel_btn)

    clear_btn = Gtk.Button(label="Clear")
    clear_btn.connect("clicked", lambda _b: wizard_model.clear_log())
    log_header.append(clear_btn)

    log_scroll = Gtk.ScrolledWindow()
    log_scroll.set_min_content_height(180)
    log_scroll.set_max_content_height(220)
    log_outer.append(log_scroll)

    log_view = Gtk.TextView()
    log_view.set_editable(False)
    log_view.set_monospace(True)
    log_view.set_cursor_visible(False)
    log_scroll.set_child(log_view)
    log_buf = log_view.get_buffer()

    # ---- Sync state -> view ----
    def _render() -> None:
        s = wizard_model.state
        # main pane (priority mirrors Wizard.cs)
        if wizard_model.show_server_detail:
            main_stack.set_visible_child_name("detail")
        elif wizard_model.show_pairing_cover:
            main_stack.set_visible_child_name("pairing")
        elif wizard_model.show_destination_chooser:
            main_stack.set_visible_child_name("chooser")
        elif wizard_model.show_host_here_pane:
            main_stack.set_visible_child_name("hosthere")
        else:
            main_stack.set_visible_child_name("wizard")
        # destination chooser
        chooser_domain.set_text(s.verified.server_domain if s.verified else "")
        reason = wizard_model.host_here_disabled_reason
        host_card.set_sensitive(reason is None)
        host_reason.set_text(reason or "")
        host_reason.set_visible(reason is not None)
        # host-here pane
        hh_domain.set_text(s.verified.server_domain if s.verified else "")
        hh_spec.set_text(wizard_model.host_here_spec_summary)
        accel_warning = wizard_model.host_here_accel_warning
        hh_accel_warning.set_text(accel_warning or "")
        hh_accel_warning.set_visible(accel_warning is not None)
        hh_create.set_visible(not s.is_running)
        hh_caption.set_visible(not s.is_running)
        if s.is_running and s.phase in ("download", "remaster"):
            hh_progress.set_visible(True)
            if s.progress is None:
                hh_progress.pulse()
            else:
                hh_progress.set_fraction(max(0.0, min(1.0, s.progress)))
            hh_progress.set_text(s.phase_label or "")
        else:
            hh_progress.set_visible(False)
        if s.phase == "download" and s.download_url:
            hh_url.set_text(s.download_url)
            hh_url.set_visible(True)
        else:
            hh_url.set_visible(False)
        # pairing cover
        pairing_status.set_text(s.pair_status or "")
        pairing_qr.set_text(s.pair_qr or "")
        pairing_qr.set_visible(bool(s.pair_qr))
        pairing_code.set_text(f"Code: {s.pair_code}" if s.pair_code else "")
        pairing_code.set_visible(bool(s.pair_code))
        pairing_sas_caption.set_visible(bool(s.pair_sas))
        pairing_sas.set_text(s.pair_sas or "")
        pairing_sas.set_visible(bool(s.pair_sas))
        # server detail
        server = wizard_model.selected_server
        if server is not None:
            detail_title.set_text(server.display_name)
            detail_fqdn.set_text(server.fqdn)
            detail_badge.set_text(server.badge_label)
            detail_state.set_text(server.state_label)
            detail_subtitle.set_text(server.status_subtitle)
            detail_spec.set_text(server.spec_summary)
            detail_start.set_visible(server.can_start)
            detail_stop.set_visible(server.can_stop)
            detail_retry.set_visible(server.can_retry_install)
            detail_ssh.set_visible(server.console_enabled)
        # sidebar
        _rebuild_server_list()
        no_servers.set_visible(not wizard_model.has_hosted_servers)
        # recipe status
        if s.recipe_error:
            recipe_status.set_text(s.recipe_error)
            recipe_status.add_css_class("error")
        elif s.recipe_path:
            recipe_status.set_text(f"Loaded: {s.recipe_path.name}")
            recipe_status.remove_css_class("error")
        else:
            recipe_status.set_text("")
        if s.verified is not None:
            exp = s.verified.expires_at or "(unknown)"
            verify_badge.set_text(
                f"Recipe verified · server: {s.verified.server_domain} · expires: {exp}"
            )
            verify_badge.set_visible(True)
        else:
            verify_badge.set_visible(False)
        # ISO step — only shown in Advanced (Simple fetches the base itself).
        step2["card"].set_visible(s.requires_user_iso)
        # Reflect the toggle if state changed programmatically.
        if mode_switch.get_active() != (s.mode == MODE_ADVANCED):
            mode_switch.set_active(s.mode == MODE_ADVANCED)
        if s.requires_user_iso and s.iso_path:
            iso_status.set_text(f"Loaded: {s.iso_path.name}")
        else:
            iso_status.set_text("")
        # disks
        if s.is_refreshing_disks:
            refresh_spinner.start()
        else:
            refresh_spinner.stop()
        _rebuild_disks_list(
            disks_list=disks_list,
            disks=s.disks,
            selected=s.selected_disk,
            Gtk=Gtk,
        )
        no_disks.set_visible(len(s.disks) == 0)
        # readiness
        readiness.set_text(s.readiness_summary)
        bake_btn.set_sensitive(s.can_flash and not s.is_running)
        prep_btn.set_sensitive(
            s.recipe_path is not None and s.iso_path is not None
            and not s.is_running
        )
        verify_btn.set_sensitive(s.recipe_path is not None and not s.is_running)
        pair_btn.set_sensitive(not s.is_running and not s.is_pairing)
        pair_debug_check.set_sensitive(not s.is_pairing)
        if pair_debug_check.get_active() != s.pair_debug:
            pair_debug_check.set_active(s.pair_debug)
        cancel_btn.set_sensitive(s.is_running)
        if s.is_running:
            log_spinner.start()
        else:
            log_spinner.stop()
        # progress bar: accent-coloured during the base download + remaster + write.
        if s.is_running and s.phase in ("download", "remaster", "write"):
            progress_bar.set_visible(True)
            if s.progress is None:
                progress_bar.pulse()
            else:
                progress_bar.set_fraction(max(0.0, min(1.0, s.progress)))
            progress_bar.set_text(s.phase_label or "")
        else:
            progress_bar.set_visible(False)
        # Download URL surfaced directly under the bar during the base fetch.
        if s.phase == "download" and s.download_url:
            download_url_label.set_text(s.download_url)
            download_url_label.set_visible(True)
        else:
            download_url_label.set_visible(False)
        if s.out_iso_path is not None:
            out_path_label.set_text(f"output: {s.out_iso_path}")
        else:
            out_path_label.set_text("")
        # log
        log_buf.set_text("")
        for ll in s.log_lines:
            marker = "!" if ll.stream == "stderr" else " "
            it = log_buf.get_end_iter()
            log_buf.insert(it, f"{marker} {ll.text}\n")
        # done
        step5["card"].set_visible(s.is_finished)
        if s.is_finished:
            parts: list[str] = []
            if s.verified:
                parts.append(f"server domain: {s.verified.server_domain}")
                if s.verified.expires_at:
                    parts.append(f"expires: {s.verified.expires_at}")
            if s.out_iso_path:
                parts.append(f"file: {s.out_iso_path}")
            if s.selected_disk:
                parts.append(f"device: {s.selected_disk.device_path}")
            done_label.set_text("\n".join(parts))

    def _on_change() -> None:
        # The model fires on_change from background threads; marshal to
        # the main loop before touching widgets.
        GLib.idle_add(_render)

    wizard_model.on_change = _on_change
    _render()

    # Kick off the initial disk scan once the window is shown.
    GLib.idle_add(wizard_model.refresh_disks)

    return window


def _wizard_card(step: int, title: str, subtitle: str):
    import gi
    from gi.repository import Gtk  # type: ignore
    card = Gtk.Frame()
    card.add_css_class("card")
    inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    inner.set_margin_top(16)
    inner.set_margin_bottom(16)
    inner.set_margin_start(16)
    inner.set_margin_end(16)
    card.set_child(inner)
    head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    step_label = Gtk.Label(label=str(step))
    step_label.add_css_class("heading")
    step_label.set_size_request(32, 32)
    head.append(step_label)
    title_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
    title_label = Gtk.Label(label=title, xalign=0.0)
    title_label.add_css_class("title-3")
    title_box.append(title_label)
    sub_label = Gtk.Label(label=subtitle, xalign=0.0)
    sub_label.set_wrap(True)
    sub_label.add_css_class("dim-label")
    title_box.append(sub_label)
    head.append(title_box)
    inner.append(head)
    body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    inner.append(body)
    return {"card": card, "body": body}


def _drop_zone(label: str, on_drop, Gtk):
    """Build a dashed-border drop target. The GTK4 drop API uses
    Gtk.DropTarget with a Gio.File value type."""
    from gi.repository import Gdk, Gio  # type: ignore

    frame = Gtk.Frame()
    frame.add_css_class("flagship-dropzone")
    inner = Gtk.Label(label=label, xalign=0.5)
    inner.set_wrap(True)
    inner.add_css_class("dim-label")
    inner.set_margin_top(20)
    inner.set_margin_bottom(20)
    inner.set_margin_start(16)
    inner.set_margin_end(16)
    frame.set_child(inner)

    drop = Gtk.DropTarget.new(Gio.File, Gdk.DragAction.COPY)

    def _on_drop(_dt, value, _x, _y):
        try:
            path = value.get_path()
            if path:
                on_drop(path)
                return True
        except Exception:
            return False
        return False

    drop.connect("drop", _on_drop)
    frame.add_controller(drop)
    return frame


def _pick_file(window, title: str, filters, on_pick, Gtk):
    """Open a Gtk.FileDialog (GTK 4.10+). On older GTKs we fall back to
    GtkFileChooserNative."""
    from gi.repository import Gio  # type: ignore
    try:
        dialog = Gtk.FileDialog()
        dialog.set_title(title)
        store = Gio.ListStore.new(Gtk.FileFilter)
        for name, pattern in filters:
            f = Gtk.FileFilter()
            f.set_name(name)
            f.add_pattern(pattern)
            store.append(f)
        dialog.set_filters(store)

        def _on_response(dlg, result):
            try:
                f = dlg.open_finish(result)
                if f is not None:
                    on_pick(f.get_path())
            except Exception:
                pass

        dialog.open(window, None, _on_response)
    except AttributeError:  # pragma: no cover - GTK < 4.10
        chooser = Gtk.FileChooserNative.new(
            title, window, Gtk.FileChooserAction.OPEN, "_Open", "_Cancel"
        )
        for name, pattern in filters:
            f = Gtk.FileFilter()
            f.set_name(name)
            f.add_pattern(pattern)
            chooser.add_filter(f)

        def _on_response(dlg, response):
            if response == Gtk.ResponseType.ACCEPT:
                f = dlg.get_file()
                if f is not None:
                    on_pick(f.get_path())
            dlg.destroy()

        chooser.connect("response", _on_response)
        chooser.show()


def _rebuild_disks_list(disks_list, disks: list[DeviceInfo], selected: Optional[DeviceInfo], Gtk) -> None:
    """Repopulate the ListBox with the current disk set. Cheap O(n)
    rebuild — the picker rarely has more than a handful of rows."""
    while True:
        row = disks_list.get_first_child()
        if row is None:
            break
        disks_list.remove(row)
    for d in disks:
        row = Gtk.ListBoxRow()
        row.device_path = d.device_path  # type: ignore[attr-defined]
        hbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        hbox.set_margin_top(8)
        hbox.set_margin_bottom(8)
        hbox.set_margin_start(8)
        hbox.set_margin_end(8)
        primary = Gtk.Label(label=d.display_name, xalign=0.0)
        primary.set_wrap(True)
        hbox.append(primary)
        secondary = Gtk.Label(
            label=f"{d.device_path} · removable: {d.removable} · bus: {d.bus} · {d.verdict_reason}",
            xalign=0.0,
        )
        secondary.add_css_class("dim-label")
        secondary.set_wrap(True)
        hbox.append(secondary)
        row.set_child(hbox)
        disks_list.append(row)
        if selected is not None and d.device_path == selected.device_path:
            disks_list.select_row(row)
