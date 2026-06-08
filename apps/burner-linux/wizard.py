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
        mode: str = MODE_SIMPLE,
        # Injectable seam so the Simple-mode base fetch is unit-testable
        # without network: defaults to the real manifest-driven cache.
        ensure_base_fn: Optional[Callable[..., Path]] = None,
        burner_version: str = BURNER_VERSION,
    ) -> None:
        self.state = WizardState(mode=mode)
        self.on_change = on_change or (lambda: None)
        self._run_lsblk = run_lsblk
        self._locate_fn = locate_fn or locate
        self._current_runner: Optional[object] = None
        self._lock = threading.Lock()
        self._ensure_base = ensure_base_fn or iso_base_cache.ensure
        self._burner_version = burner_version

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
        remaster+write path Advanced uses."""
        recipe = self.state.recipe_path
        disk = self.state.selected_disk
        if recipe is None or disk is None:
            return

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
            base = self._ensure_base(
                self._burner_version,
                progress=_on_progress,
                on_download_start=_on_download_start,
                log=lambda m: self._append_log("stdout", m),
            )
        except iso_base_cache.CacheError as e:
            self._append_log("stderr", str(e))
            self.state.phase = None
            self.state.progress = None
            self.state.download_url = None
            self._notify()
            return

        self.state.base_iso_path = Path(base)
        self.state.iso_path = Path(base)
        self.state.download_url = None

        # 2. Same Node-CLI remaster+write path Advanced uses.
        self.state.phase = "remaster"
        self.state.progress = None
        self._notify()
        self._cli_write(recipe, Path(base), disk)

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
            )
            self._current_runner = runner
            self._append_log("stdout", f"+ {runner.command_string}")
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
            self.state.phase = None
            self.state.progress = None
            self.state.download_url = None
            with self._lock:
                self.state.is_running = False
            self._notify()

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
    window.set_default_size(720, 820)

    toolbar = Adw.ToolbarView()
    header = Adw.HeaderBar()
    toolbar.add_top_bar(header)

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

    # Main vertical layout: scrolled wizard cards + log pane.
    root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    toolbar.set_content(root)
    window.set_content(toolbar)

    scroller = Gtk.ScrolledWindow()
    scroller.set_vexpand(True)
    scroller.set_hscrollbar_policy(Gtk.PolicyType.NEVER)
    root.append(scroller)

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
        label="No removable disks detected. Plug one in and click Refresh.",
        xalign=0.0,
    )
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
