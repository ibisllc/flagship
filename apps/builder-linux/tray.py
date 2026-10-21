"""A tray icon for the hosted servers: Open, Start / Stop / Restart each
server, Stop all, Quit. The Linux counterpart of the Windows notification-
area icon and the Mac menu-bar extra.

GTK 4 has no tray API, so this speaks the StatusNotifierItem protocol (KDE,
Ubuntu's AppIndicator extension, Cinnamon, XFCE, LXQt, ...) and its
com.canonical.dbusmenu menu directly over D-Bus with Gio. Where no
StatusNotifierWatcher runs (stock GNOME), there is simply no tray icon; the
window carries every action too.

The menu is built by pure functions (tray_menu, layout) so it is tested
without a bus.
"""
from __future__ import annotations

from i18n import tr

import os
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple


@dataclass
class MenuItem:
    label: str = ""
    action: Optional[Callable[[], None]] = None
    enabled: bool = True
    separator: bool = False
    children: List["MenuItem"] = field(default_factory=list)


def tray_menu(
    servers,
    status: Optional[str],
    open_window: Callable[[], None],
    start: Callable[[str], None],
    stop: Callable[[str], None],
    restart: Callable[[str], None],
    stop_all: Callable[[], None],
    quit_app: Callable[[], None],
) -> List[MenuItem]:
    """Mirrors the Windows TrayIcon.RebuildMenu. While quitting, nothing may
    start a server the quit would abandon, so only the status shows."""
    items = [MenuItem(tr("Open Flagship Studio"), open_window), MenuItem(separator=True)]
    if status is not None:
        items.append(MenuItem(status, enabled=False))
        return items
    for s in sorted(servers, key=lambda s: s.fqdn.lower()):
        sub: List[MenuItem] = []
        if s.can_start:
            sub.append(MenuItem(tr("Start"), lambda n=s.name: start(n)))
        if s.can_stop:
            sub.append(MenuItem(tr("Stop"), lambda n=s.name: stop(n)))
            sub.append(MenuItem(tr("Restart"), lambda n=s.name: restart(n)))
        if not sub:
            sub.append(MenuItem(s.state_label, enabled=False))
        items.append(MenuItem(s.fqdn, children=sub))
    if not servers:
        items.append(MenuItem(tr("No servers hosted yet"), enabled=False))
    running = [s for s in servers if s.can_stop]
    items += [
        MenuItem(separator=True),
        MenuItem(tr("Stop all running servers"), stop_all, enabled=bool(running)),
        MenuItem(separator=True),
        MenuItem(tr("Quit Flagship Studio"), quit_app),
    ]
    return items


Node = Tuple[int, Dict[str, object], list]


def layout(items: List[MenuItem]) -> Tuple[Node, Dict[int, MenuItem]]:
    """The dbusmenu tree (id 0 is the root) as plain tuples, plus id -> item
    for dispatching clicks."""
    by_id: Dict[int, MenuItem] = {}
    counter = [0]

    def node(item: MenuItem) -> Node:
        counter[0] += 1
        ident = counter[0]
        by_id[ident] = item
        props: Dict[str, object] = {}
        if item.separator:
            props["type"] = "separator"
        else:
            props["label"] = item.label.replace("_", "__")
            props["enabled"] = item.enabled
        if item.children:
            props["children-display"] = "submenu"
        return (ident, props, [node(c) for c in item.children])

    root: Node = (0, {"children-display": "submenu"}, [node(i) for i in items])
    return root, by_id


def find(root: Node, ident: int) -> Optional[Node]:
    if root[0] == ident:
        return root
    for child in root[2]:
        hit = find(child, ident)
        if hit is not None:
            return hit
    return None


_SNI_XML = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg type="s"/></signal>
  </interface>
</node>
"""

_MENU_XML = """
<node>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg name="parentId" type="i" direction="in"/>
      <arg name="recursionDepth" type="i" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="revision" type="u" direction="out"/>
      <arg name="layout" type="(ia{sv}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="properties" type="a(ia{sv})" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg name="id" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="Event">
      <arg name="id" type="i" direction="in"/>
      <arg name="eventId" type="s" direction="in"/>
      <arg name="data" type="v" direction="in"/>
      <arg name="timestamp" type="u" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg name="events" type="a(isvu)" direction="in"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg name="id" type="i" direction="in"/>
      <arg name="needUpdate" type="b" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="updatesNeeded" type="ai" direction="out"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
  </interface>
</node>
"""


class Tray:
    """The live D-Bus side. `build_menu()` returns fresh MenuItems; call
    refresh() whenever the servers change."""

    ITEM_PATH = "/StatusNotifierItem"
    MENU_PATH = "/MenuBar"

    def __init__(self, build_menu: Callable[[], List[MenuItem]], on_activate: Callable[[], None]) -> None:
        from gi.repository import Gio, GLib  # type: ignore

        self._Gio = Gio
        self._GLib = GLib
        self._build_menu = build_menu
        self._on_activate = on_activate
        self._revision = 1
        self._root, self._by_id = layout(build_menu())
        self._bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self._name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        self._ids: list = []
        register = getattr(self._bus, "register_object_with_closures", None) or self._bus.register_object
        self._ids.append(register(
            self.ITEM_PATH, Gio.DBusNodeInfo.new_for_xml(_SNI_XML).interfaces[0],
            self._item_call, self._item_get, None))
        self._ids.append(register(
            self.MENU_PATH, Gio.DBusNodeInfo.new_for_xml(_MENU_XML).interfaces[0],
            self._menu_call, self._menu_get, None))
        self._owner = Gio.bus_own_name_on_connection(
            self._bus, self._name, Gio.BusNameOwnerFlags.NONE, None, None)
        try:
            self._bus.call_sync(
                "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
                "org.kde.StatusNotifierWatcher", "RegisterStatusNotifierItem",
                GLib.Variant("(s)", (self._name,)), None, Gio.DBusCallFlags.NONE, 2000, None)
        except Exception:
            self.close()
            raise

    def refresh(self) -> None:
        root, self._by_id = layout(self._build_menu())
        if root == self._root:
            return
        self._root = root
        self._revision += 1
        self._bus.emit_signal(None, self.MENU_PATH, "com.canonical.dbusmenu", "LayoutUpdated",
                              self._GLib.Variant("(ui)", (self._revision, 0)))

    def close(self) -> None:
        for ident in self._ids:
            self._bus.unregister_object(ident)
        self._Gio.bus_unown_name(self._owner)

    # ---- org.kde.StatusNotifierItem ----

    def _item_get(self, _conn, _sender, _path, _iface, name):
        V = self._GLib.Variant
        values = {
            "Category": V("s", "ApplicationStatus"),
            "Id": V("s", "flagship-studio"),
            "Title": V("s", "Flagship Studio"),
            "Status": V("s", tr("Active")),
            "IconName": V("s", "network-server"),
            "ToolTip": V("(sa(iiay)ss)", ("network-server", [], "Flagship Studio", "")),
            "ItemIsMenu": V("b", False),
            "Menu": V("o", self.MENU_PATH),
        }
        return values.get(name)

    def _item_call(self, _conn, _sender, _path, _iface, method, _params, invocation):
        if method in (tr("Activate"), "SecondaryActivate"):
            self._GLib.idle_add(lambda: self._on_activate() and False)
        invocation.return_value(None)

    # ---- com.canonical.dbusmenu ----

    def _props(self, props: Dict[str, object]) -> dict:
        V = self._GLib.Variant
        return {k: (V("b", v) if isinstance(v, bool) else V("s", v)) for k, v in props.items()}

    def _layout_value(self, node: Node) -> tuple:
        ident, props, children = node
        return (ident, self._props(props),
                [self._GLib.Variant("(ia{sv}av)", self._layout_value(c)) for c in children])

    def _menu_get(self, _conn, _sender, _path, _iface, name):
        V = self._GLib.Variant
        return {
            "Version": V("u", 3),
            "TextDirection": V("s", "ltr"),
            "Status": V("s", "normal"),
            "IconThemePath": V("as", []),
        }.get(name)

    def _menu_call(self, _conn, _sender, _path, _iface, method, params, invocation):
        V = self._GLib.Variant
        if method == "GetLayout":
            parent = params.unpack()[0]
            node = find(self._root, parent) or self._root
            invocation.return_value(V("(u(ia{sv}av))", (self._revision, self._layout_value(node))))
        elif method == "GetGroupProperties":
            ids = params.unpack()[0]
            out = []
            for ident in ids:
                node = find(self._root, ident)
                if node is not None:
                    out.append((ident, self._props(node[1])))
            invocation.return_value(V("(a(ia{sv}))", (out,)))
        elif method == "GetProperty":
            ident, name = params.unpack()
            node = find(self._root, ident)
            value = node[1].get(name) if node is not None else None
            if value is None:
                invocation.return_dbus_error("com.canonical.dbusmenu.Error", "no such property")
                return
            invocation.return_value(V("(v)", (V("b", value) if isinstance(value, bool) else V("s", value),)))
        elif method == "Event":
            ident, event = params.unpack()[0], params.unpack()[1]
            self._click(ident, event)
            invocation.return_value(None)
        elif method == "EventGroup":
            for ident, event, _data, _ts in params.unpack()[0]:
                self._click(ident, event)
            invocation.return_value(V("(ai)", ([],)))
        elif method == "AboutToShow":
            invocation.return_value(V("(b)", (False,)))
        elif method == "AboutToShowGroup":
            invocation.return_value(V("(aiai)", ([], [])))
        else:
            invocation.return_value(None)

    def _click(self, ident: int, event: str) -> None:
        item = self._by_id.get(ident)
        if event == "clicked" and item is not None and item.enabled and item.action is not None:
            action = item.action
            self._GLib.idle_add(lambda: action() and False)


def start_tray(build_menu: Callable[[], List[MenuItem]], on_activate: Callable[[], None]) -> Optional[Tray]:
    """The tray, or None where no StatusNotifierWatcher runs (stock GNOME)."""
    try:
        return Tray(build_menu, on_activate)
    except Exception:
        return None
