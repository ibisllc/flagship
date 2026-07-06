"""Builds + launches `ssh … debug@127.0.0.1` for a hosted debug VM's loopback
host-forward.

The Linux analog of apps/burner-windows/src/VM/SshLaunch.cs: the argv builder
and the terminal picker are pure + unit-tested; only `launch` spawns anything.
The guest's own debug gate still governs whether the login succeeds — this only
saves the owner from hunting a LAN IP. It is a LOCAL loopback affordance: the
target is ALWAYS a VM this app hosts on THIS machine, never a relay.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from typing import Callable, List, Optional

DEBUG_USER = "debug"

# Tried in order when $TERMINAL isn't set. x-terminal-emulator is the Debian
# alternatives symlink (whatever the user chose as their default); on ChromeOS
# it resolves to garcon-terminal-handler, which opens the ChromeOS Terminal.
TERMINAL_CANDIDATES = [
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "ptyxis",
    "foot",
    "alacritty",
    "kitty",
    "xfce4-terminal",
    "xterm",
]


class SshLaunchError(Exception):
    pass


def ssh_args(ssh_port: int) -> List[str]:
    """`-p <port> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
    debug@127.0.0.1`. Host-key checking is disabled because the guest
    regenerates its host key on first boot and the target is loopback (the
    forward, not a real network peer), so a pinned known_hosts would just nag
    on every reburn."""
    return [
        "-p", str(ssh_port),
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        f"{DEBUG_USER}@127.0.0.1",
    ]


def ssh_command(ssh_port: int) -> List[str]:
    return ["ssh", *ssh_args(ssh_port)]


def pick_terminal(
    which: Callable[[str], Optional[str]] = shutil.which,
    environ: Optional[dict] = None,
) -> Optional[str]:
    """The terminal emulator to spawn: $TERMINAL first (the user's explicit
    choice), then the well-known candidates in order. Returns a resolved
    path/name `which` accepted, or None when no terminal exists (headless)."""
    env = environ if environ is not None else os.environ
    preferred = env.get("TERMINAL")
    if preferred:
        found = which(preferred)
        if found:
            return found
    for candidate in TERMINAL_CANDIDATES:
        found = which(candidate)
        if found:
            return found
    return None


def terminal_command(
    terminal_path: str,
    command: List[str],
    realpath: Callable[[str], str] = os.path.realpath,
) -> List[str]:
    """The full argv that opens `command` in a new terminal window.
    gnome-terminal removed `-e`; ChromeOS's garcon-terminal-handler passes its
    argv verbatim to the ChromeOS Terminal (no flag at all); everything else
    speaks the classic `-e cmd args…` convention (xterm, konsole, and whatever
    $TERMINAL names). The symlink chain is resolved because the convention
    belongs to the real target — on Debian x-terminal-emulator is an
    alternatives link to any of them."""
    base = os.path.basename(realpath(terminal_path))
    if base == "gnome-terminal":
        return [terminal_path, "--", *command]
    if base == "garcon-terminal-handler":
        return [terminal_path, *command]
    return [terminal_path, "-e", *command]


def launch(
    ssh_port: int,
    which: Callable[[str], Optional[str]] = shutil.which,
    environ: Optional[dict] = None,
    spawn: Callable[[List[str]], object] = lambda argv: subprocess.Popen(
        argv, stdin=subprocess.DEVNULL, start_new_session=True
    ),
) -> List[str]:
    """Open an interactive SSH session in the user's terminal. Returns the
    argv it spawned (for logging); raises SshLaunchError when no terminal
    emulator could be found."""
    terminal = pick_terminal(which, environ)
    if terminal is None:
        raise SshLaunchError(
            "No terminal emulator found. Set $TERMINAL, or run manually: "
            + " ".join(ssh_command(ssh_port))
        )
    argv = terminal_command(terminal, ssh_command(ssh_port))
    spawn(argv)
    return argv
