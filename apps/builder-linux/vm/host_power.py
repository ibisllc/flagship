"""Keeping this PC out of sleep while hosted servers need it.

The GUI first asks GTK (Gtk.Application.inhibit: the desktop portal or the
session manager, so it also works inside Flatpak); when that isn't honoured it
falls back to logind through systemd-inhibit, held for as long as a child
process lives. The display may still sleep, as on the Mac.
"""
from __future__ import annotations

import shutil
import subprocess
from typing import Callable, List, Optional

WHY = "Hosting Flagship servers for the internet"


def systemd_inhibit_argv(binary: str) -> List[str]:
    return [
        binary, "--what=sleep", "--who=Flagship Studio", f"--why={WHY}",
        "--mode=block", "sleep", "infinity",
    ]


class SleepInhibitor:
    """hold(True/False) with an injectable GTK inhibit and process spawner,
    so the choice between them is unit-tested."""

    def __init__(
        self,
        gtk_inhibit: Callable[[], int],
        gtk_uninhibit: Callable[[int], None],
        which: Callable[[str], Optional[str]] = shutil.which,
        spawn: Callable[[List[str]], object] = lambda argv: subprocess.Popen(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        ),
        log: Callable[[str], None] = lambda _m: None,
    ) -> None:
        self._gtk_inhibit = gtk_inhibit
        self._gtk_uninhibit = gtk_uninhibit
        self._which = which
        self._spawn = spawn
        self._log = log
        self._cookie = 0
        self._proc: Optional[object] = None

    @property
    def holding(self) -> bool:
        return bool(self._cookie) or self._proc is not None

    def hold(self, on: bool) -> None:
        if on and not self.holding:
            try:
                self._cookie = self._gtk_inhibit() or 0
            except Exception:
                self._cookie = 0
            if self._cookie:
                return
            binary = self._which("systemd-inhibit")
            if binary is None:
                self._log("Can't keep this PC awake: no sleep inhibitor is available. Turn off automatic suspend while hosting.")
                return
            try:
                self._proc = self._spawn(systemd_inhibit_argv(binary))
            except OSError as e:
                self._log(f"Can't keep this PC awake: {e}")
        elif not on:
            if self._cookie:
                try:
                    self._gtk_uninhibit(self._cookie)
                except Exception:
                    pass
                self._cookie = 0
            if self._proc is not None:
                try:
                    self._proc.terminate()  # type: ignore[attr-defined]
                except Exception:
                    pass
                self._proc = None
