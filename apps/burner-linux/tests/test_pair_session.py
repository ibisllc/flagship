"""The pure parser for the `FLAGSHIP_PAIR <json>` milestone lines
`flagship-burn pair --emit-events` prints. The shape must track the PairEvent
union in packages/flagship-burner/src/pair.ts. Mirrors the Windows
PairEventParserTests, plus the `granted` field the TS `debug-result` event
actually carries (the Windows parser reads only `debugGranted` — see the
session report)."""
from __future__ import annotations

import pytest

from cli_runner import args_pair
from pair_session import parse_pair_event


def test_parses_ready():
    line = (
        'FLAGSHIP_PAIR {"event":"ready","sessionId":"abc","humanCode":"ABCD-1234",'
        '"payload":"flagship://pair?...","qrTerminal":"█▀█\\n▀▀▀","debugRequested":false}'
    )
    ev = parse_pair_event(line)
    assert ev is not None
    assert ev.event == "ready"
    assert ev.human_code == "ABCD-1234"
    assert "█" in ev.qr_terminal
    assert ev.payload == "flagship://pair?..."
    assert ev.debug_requested is False


def test_parses_phone_connected_sas():
    ev = parse_pair_event('FLAGSHIP_PAIR {"event":"phone-connected","sas":"418 902"}')
    assert ev.event == "phone-connected"
    assert ev.sas == "418 902"


def test_parses_done_with_debug_granted():
    ev = parse_pair_event(
        'FLAGSHIP_PAIR {"event":"done","recipePath":"/tmp/r.json",'
        '"serverDomain":"home.harry.flagship.services","debugGranted":true}'
    )
    assert ev.event == "done"
    assert ev.recipe_path == "/tmp/r.json"
    assert ev.server_domain == "home.harry.flagship.services"
    assert ev.debug_granted is True


def test_parses_debug_result_granted_field():
    # pair.ts emits `granted` on debug-result (NOT `debugGranted` — that's the
    # done event's field).
    assert parse_pair_event('FLAGSHIP_PAIR {"event":"debug-result","granted":true}').granted is True
    assert parse_pair_event('FLAGSHIP_PAIR {"event":"debug-result","granted":false}').granted is False


def test_parses_error():
    ev = parse_pair_event('FLAGSHIP_PAIR {"event":"error","message":"pairing session timed out"}')
    assert ev.event == "error"
    assert "timed out" in ev.message


def test_debug_granted_defaults_false_when_absent_or_false():
    assert (
        parse_pair_event(
            'FLAGSHIP_PAIR {"event":"delivered","serverDomain":"x.y.flagship.services"}'
        ).debug_granted
        is False
    )
    assert parse_pair_event('FLAGSHIP_PAIR {"event":"done","debugGranted":false}').debug_granted is False


@pytest.mark.parametrize(
    "line",
    [
        "plain human log line",
        "  Waiting for your phone…",
        "FLAGSHIP_PAIR not-json",
        "FLAGSHIP_PAIR [1,2,3]",
        'FLAGSHIP_PAIR {"nope":1}',
        "",
    ],
)
def test_non_event_lines_return_none(line):
    assert parse_pair_event(line) is None


def test_tolerates_leading_whitespace():
    ev = parse_pair_event('   FLAGSHIP_PAIR {"event":"paired"}')
    assert ev is not None
    assert ev.event == "paired"


def test_args_pair_mirror_the_shared_cli():
    assert args_pair("/cli.ts", "/tmp/out.json", debug=False) == [
        "/cli.ts", "pair", "--out", "/tmp/out.json", "--emit-events",
    ]
    assert args_pair("/cli.ts", "/tmp/out.json", debug=True) == [
        "/cli.ts", "pair", "--out", "/tmp/out.json", "--emit-events", "--debug",
    ]
