"""Render smoke: construct the full GTK window and exit.

The unit suite is deliberately headless (no gi), so a view-layer API break —
a widget from a newer libadwaita, a GTK3-ism — only surfaces when a window is
actually built. Both bugs the first live render caught (Adw.ToolbarView on
adw 1.2; ScrolledWindow.set_hscrollbar_policy on any GTK4) would have failed
this script in CI. Run under `xvfb-run` headlessly; exits 0 iff build_window
completed on this machine's GTK/adw.
"""
from __future__ import annotations

import os
import sys
import traceback


def main() -> int:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import gi

    gi.require_version("Gtk", "4.0")
    gi.require_version("Adw", "1")
    from gi.repository import Adw, GLib  # type: ignore

    from wizard import build_window

    result = {"code": 1}
    app = Adw.Application(application_id="com.flagshipserver.Burner.RenderSmoke")

    def on_activate(a) -> None:
        try:
            win = build_window(a)
            win.present()
            result["code"] = 0
            print(
                f"render smoke OK (adw {Adw.get_major_version()}."
                f"{Adw.get_minor_version()})"
            )
        except Exception:
            traceback.print_exc()
        # One breath of main loop so the window realizes before quitting.
        GLib.timeout_add(500, a.quit)

    app.connect("activate", on_activate)
    app.run([])
    return result["code"]


if __name__ == "__main__":
    raise SystemExit(main())
