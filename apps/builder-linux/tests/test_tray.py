"""The tray menu, without a bus: the same entries as the Windows tray (Open,
each server's Start/Stop/Restart, Stop all, Quit), nothing that can start a
server while quitting, and a dbusmenu tree whose ids dispatch to them."""
from __future__ import annotations

from types import SimpleNamespace

from tray import find, layout, tray_menu


def server(name, can_start=False, can_stop=False, label="Stopped"):
    return SimpleNamespace(name=name, fqdn=name, can_start=can_start, can_stop=can_stop, state_label=label)


def build(servers, status=None):
    calls = []
    items = tray_menu(
        servers, status,
        open_window=lambda: calls.append("open"),
        start=lambda n: calls.append(("start", n)),
        stop=lambda n: calls.append(("stop", n)),
        restart=lambda n: calls.append(("restart", n)),
        stop_all=lambda: calls.append("stop-all"),
        quit_app=lambda: calls.append("quit"),
    )
    return items, calls


def labels(items):
    return [("-" if i.separator else i.label) for i in items]


def test_lists_each_server_with_what_it_can_do():
    items, calls = build([
        server("b.h.flagship.services", can_stop=True, label="Running"),
        server("a.h.flagship.services", can_start=True),
        server("c.h.flagship.services", label="Installing…"),
    ])
    assert labels(items) == [
        "Open Flagship Studio", "-", "a.h.flagship.services", "b.h.flagship.services",
        "c.h.flagship.services", "-", "Stop all running servers", "-", "Quit Flagship Studio",
    ]
    assert labels(items[2].children) == ["Start"]
    assert labels(items[3].children) == ["Stop", "Restart"]
    assert labels(items[4].children) == ["Installing…"] and not items[4].children[0].enabled
    items[3].children[1].action()
    items[2].children[0].action()
    assert calls == [("restart", "b.h.flagship.services"), ("start", "a.h.flagship.services")]
    assert items[6].enabled


def test_with_nothing_running_stop_all_is_off():
    items, _ = build([])
    assert "No servers hosted yet" in labels(items)
    stop_all = next(i for i in items if i.label == "Stop all running servers")
    assert not stop_all.enabled


def test_while_quitting_only_the_status_shows():
    items, _ = build([server("a.h.flagship.services", can_start=True)], status="Shutting down your servers…")
    assert labels(items) == ["Open Flagship Studio", "-", "Shutting down your servers…"]
    assert not items[2].enabled


def test_layout_numbers_every_entry_and_dispatches_by_id():
    items, calls = build([server("a_b.flagship.services", can_stop=True, label="Running")])
    root, by_id = layout(items)
    assert root[0] == 0 and root[1] == {"children-display": "submenu"}
    sub = root[2][2]
    assert sub[1]["label"] == "a__b.flagship.services"
    assert sub[1]["children-display"] == "submenu"
    assert root[2][1][1] == {"type": "separator"}
    stop_id = sub[2][0][0]
    assert find(root, stop_id)[1]["label"] == "Stop"
    by_id[stop_id].action()
    assert calls == [("stop", "a_b.flagship.services")]
    assert len(by_id) == len({n for n in by_id}) and 0 not in by_id
