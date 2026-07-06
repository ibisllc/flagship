"""The SSH argv + terminal picker (pure; the spawn is injected)."""
from __future__ import annotations

import pytest

from vm.ssh_launch import (
    SshLaunchError,
    launch,
    pick_terminal,
    ssh_args,
    ssh_command,
    terminal_command,
)


def test_ssh_args_target_the_loopback_forward_as_the_debug_user():
    assert ssh_args(2222) == [
        "-p", "2222",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "debug@127.0.0.1",
    ]


def test_ssh_command_prepends_ssh():
    assert ssh_command(49712)[0] == "ssh"
    assert "debug@127.0.0.1" in ssh_command(49712)


def test_terminal_env_var_wins():
    got = pick_terminal(
        which=lambda name: f"/usr/bin/{name}",
        environ={"TERMINAL": "kitty"},
    )
    assert got == "/usr/bin/kitty"


def test_terminal_env_var_that_does_not_resolve_falls_through():
    got = pick_terminal(
        which=lambda name: "/usr/bin/xterm" if name == "xterm" else None,
        environ={"TERMINAL": "kitty"},
    )
    assert got == "/usr/bin/xterm"


def test_candidate_order_is_x_terminal_emulator_first():
    seen: list[str] = []

    def which(name: str):
        seen.append(name)
        return None

    assert pick_terminal(which=which, environ={}) is None
    assert seen == ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]


def test_gnome_terminal_uses_double_dash():
    cmd = terminal_command("/usr/bin/gnome-terminal", ["ssh", "-p", "1", "debug@127.0.0.1"])
    assert cmd == ["/usr/bin/gnome-terminal", "--", "ssh", "-p", "1", "debug@127.0.0.1"]


def test_classic_terminals_use_dash_e():
    for term in ("/usr/bin/x-terminal-emulator", "/usr/bin/konsole", "/usr/bin/xterm", "/usr/bin/kitty"):
        cmd = terminal_command(term, ["ssh", "x"])
        assert cmd == [term, "-e", "ssh", "x"]


def test_launch_spawns_the_composed_argv():
    spawned: list = []
    argv = launch(
        2222,
        which=lambda name: "/usr/bin/xterm" if name == "xterm" else None,
        environ={},
        spawn=spawned.append,
    )
    assert spawned == [argv]
    assert argv[:2] == ["/usr/bin/xterm", "-e"]
    assert argv[2] == "ssh"
    assert argv[-1] == "debug@127.0.0.1"


def test_launch_without_a_terminal_raises_actionably():
    with pytest.raises(SshLaunchError, match="TERMINAL"):
        launch(2222, which=lambda _n: None, environ={}, spawn=lambda argv: None)
