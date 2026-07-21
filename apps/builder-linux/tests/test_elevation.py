"""elevation.probe — pkexec first, non-interactive sudo fallback, honest None."""
from __future__ import annotations

import subprocess

import elevation


def _completed(rc: int) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["sudo", "-n", "true"], returncode=rc)


def test_pkexec_wins_when_present():
    e = elevation.probe(
        which=lambda n: "/usr/bin/pkexec" if n == "pkexec" else None,
        run=lambda *a, **k: _completed(1),
    )
    assert e is not None
    assert e.prefix == ["pkexec"]


def test_passwordless_sudo_is_the_fallback():
    e = elevation.probe(
        which=lambda n: "/usr/bin/sudo" if n == "sudo" else None,
        run=lambda *a, **k: _completed(0),
    )
    assert e is not None
    assert e.prefix == ["sudo", "-n"]
    assert "sudo" in e.label


def test_password_prompting_sudo_does_not_qualify():
    # sudo -n exits non-zero when a password would be required — a GUI has no
    # TTY to type it into, so that machine has NO usable elevation.
    e = elevation.probe(
        which=lambda n: "/usr/bin/sudo" if n == "sudo" else None,
        run=lambda *a, **k: _completed(1),
    )
    assert e is None


def test_nothing_available_is_none():
    assert elevation.probe(which=lambda _n: None, run=lambda *a, **k: _completed(0)) is None


def test_sudo_probe_failure_is_treated_as_unavailable():
    def boom(*_a, **_k):
        raise OSError("no exec")

    e = elevation.probe(
        which=lambda n: "/usr/bin/sudo" if n == "sudo" else None,
        run=boom,
    )
    assert e is None
