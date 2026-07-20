"""Picks how the raw USB write gets root.

pkexec (PolicyKit) is the desktop-correct path: a GUI auth dialog, a
command scoped by the installed policy. Where it can't work — ChromeOS's
stock container ships no pkexec, and a pkexec without a polkit auth agent
can't prompt — non-interactive passwordless sudo is the honest fallback
(Crostini grants it to the primary user by design). A password-prompting
sudo is useless from a GUI (there is no TTY to type into), so only
`sudo -n` qualifies.

Pure: `which`/`run` are injected in tests; probe() is the only caller-facing
entry.
"""
from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable, List, Optional

MISSING_MESSAGE = (
    "No way to elevate the raw USB write: pkexec (PolicyKit) is not "
    "installed and passwordless sudo isn't available. Install pkexec "
    "(Debian/Ubuntu: sudo apt install pkexec; Fedora: sudo dnf install "
    "polkit) and retry."
)


@dataclass(frozen=True)
class Elevation:
    prefix: List[str]   # argv prefix, e.g. ["pkexec"] or ["sudo", "-n"]
    label: str          # for the log pane


def _sudo_n_works(run: Callable[..., "subprocess.CompletedProcess"]) -> bool:
    try:
        r = run(
            ["sudo", "-n", "true"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def probe(
    which: Callable[[str], Optional[str]] = shutil.which,
    run: Callable[..., "subprocess.CompletedProcess"] = subprocess.run,
) -> Optional[Elevation]:
    """The elevation this machine supports, or None (surface MISSING_MESSAGE).
    pkexec wins when present — it is the path the polkit policies scope."""
    if which("pkexec"):
        return Elevation(["pkexec"], "pkexec (PolicyKit)")
    if which("sudo") and _sudo_n_works(run):
        return Elevation(["sudo", "-n"], "passwordless sudo")
    return None
