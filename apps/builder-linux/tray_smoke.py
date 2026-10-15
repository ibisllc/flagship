"""Tray smoke: the StatusNotifierItem and its dbusmenu, over a real bus.

Run under `dbus-run-session` (CI does). A stand-in StatusNotifierWatcher runs
in a child process; the tray registers with it, then `gdbus` (another process,
as a panel would be) reads the menu layout, clicks Stop, and reads the item's
Id. Exits 0 iff all of that worked. The unit suite covers the menu itself;
this covers the D-Bus wiring no unit test can see.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time

WATCHER = r'''
import sys
from gi.repository import Gio, GLib
XML = """<node><interface name="org.kde.StatusNotifierWatcher">
<method name="RegisterStatusNotifierItem"><arg name="service" type="s" direction="in"/></method>
</interface></node>"""
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
def call(conn, sender, path, iface, method, params, inv):
    print("registered", params.unpack()[0], flush=True)
    inv.return_value(None)
reg = getattr(bus, "register_object_with_closures", None) or bus.register_object
reg("/StatusNotifierWatcher", Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], call, None, None)
Gio.bus_own_name_on_connection(bus, "org.kde.StatusNotifierWatcher", Gio.BusNameOwnerFlags.NONE, None, None)
GLib.MainLoop().run()
'''


def main() -> int:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        print("tray smoke: no session bus (run under dbus-run-session)")
        return 1
    from gi.repository import Gio, GLib  # type: ignore

    from tray import MenuItem, start_tray

    watcher = subprocess.Popen([sys.executable, "-c", WATCHER], stdout=subprocess.PIPE, text=True)
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    for _ in range(100):
        owned = bus.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner",
            GLib.Variant("(s)", ("org.kde.StatusNotifierWatcher",)), None, Gio.DBusCallFlags.NONE, 1000, None,
        ).unpack()[0]
        if owned:
            break
        time.sleep(0.05)

    clicks: list = []
    menu = lambda: [  # noqa: E731
        MenuItem("Open Flagship Studio", lambda: clicks.append("open")),
        MenuItem(separator=True),
        MenuItem("home.harry.flagship.services", children=[MenuItem("Stop", lambda: clicks.append("stop"))]),
    ]
    tray = start_tray(menu, lambda: clicks.append("activate"))
    if tray is None:
        print("tray smoke: the tray did not start")
        watcher.kill()
        return 1

    loop = GLib.MainLoop()
    out: dict = {}

    def gdbus(*args: str) -> str:
        return subprocess.run(
            ["gdbus", "call", "--session", "--dest", tray._name, *args],
            capture_output=True, text=True, timeout=10,
        ).stdout

    def client() -> None:
        try:
            out["layout"] = gdbus("--object-path", "/MenuBar", "--method",
                                  "com.canonical.dbusmenu.GetLayout", "0", "-1", "[]")
            m = re.search(r"\((\d+), \{'label': <'Stop'>", out["layout"])
            if m:
                gdbus("--object-path", "/MenuBar", "--method", "com.canonical.dbusmenu.Event",
                      m.group(1), "clicked", "<0>", "0")
            out["id"] = gdbus("--object-path", "/StatusNotifierItem", "--method",
                              "org.freedesktop.DBus.Properties.Get", "org.kde.StatusNotifierItem", "Id")
            gdbus("--object-path", "/StatusNotifierItem", "--method",
                  "org.kde.StatusNotifierItem.Activate", "0", "0")
        finally:
            GLib.timeout_add(300, loop.quit)

    threading.Thread(target=client, daemon=True).start()
    GLib.timeout_add_seconds(30, loop.quit)
    loop.run()
    tray.close()
    watcher.kill()
    registered = watcher.stdout.read() if watcher.stdout else ""

    checks = {
        "registered with the watcher": tray._name in registered,
        "menu lists the server": "home.harry.flagship.services" in out.get("layout", ""),
        "Stop dispatched": "stop" in clicks,
        "item Id readable": "flagship-studio" in out.get("id", ""),
        "Activate opens the window": "activate" in clicks,
    }
    for name, ok in checks.items():
        print(f"{'ok  ' if ok else 'FAIL'} {name}")
    if not all(checks.values()):
        print("layout:", out.get("layout"))
        return 1
    print("tray smoke OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
