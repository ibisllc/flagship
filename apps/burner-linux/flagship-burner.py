#!/usr/bin/env python3
"""Flagship Burner Linux GUI — entry point.

A GTK4 + libadwaita wrapper around the `@flagship/burner` Node CLI.
Mirrors apps/burner-mac/ UX 1:1: one window, 5-step wizard, drag-drop
recipe + ISO, USB picker, big Bake button, log pane.

Run from the repo root with:

    python3 apps/burner-linux/flagship-burner.py

Requires:
  - python3 (3.10+)
  - python3-gi + gir1.2-gtk-4.0 + gir1.2-adw-1
  - node 20+ (same prereq as the Mac GUI)
  - lsblk (always present on Linux)
  - pkexec (PolicyKit; ships on every modern desktop distro)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _bail(msg: str) -> int:
    sys.stderr.write(f"flagship-burner: {msg}\n")
    return 2


def main(argv: list[str]) -> int:
    here = Path(__file__).resolve().parent
    # Make sibling modules importable even when launched via AppImage.
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))
    try:
        import gi
        gi.require_version("Gtk", "4.0")
        gi.require_version("Adw", "1")
        from gi.repository import Adw, Gtk, Gio, GLib  # type: ignore  # noqa: F401
    except (ImportError, ValueError) as e:
        return _bail(
            f"GTK4 + libadwaita not available: {e}\n"
            "  Ubuntu/Debian: sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1\n"
            "  Fedora:        sudo dnf install python3-gobject gtk4 libadwaita\n"
            "  Arch:          sudo pacman -S python-gobject gtk4 libadwaita"
        )

    from wizard import build_window  # noqa: E402

    app = Adw.Application(application_id="com.flagshipserver.Burner")

    def on_activate(application):
        win = build_window(application)
        win.present()

    app.connect("activate", on_activate)
    return app.run(argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
