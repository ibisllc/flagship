"""The pure QMP conversation, driven against a fake line duplex — no QEMU, no
socket."""
from __future__ import annotations

import json

import pytest

from vm.qmp_client import QmpError, QmpProtocol


class FakeDuplex:
    def __init__(self, script: list) -> None:
        self.sent: list[str] = []
        self._lines = list(script)

    def send(self, text: str) -> None:
        self.sent.append(text)

    def read(self):
        if not self._lines:
            return None
        return self._lines.pop(0)


def proto(script: list) -> tuple[QmpProtocol, FakeDuplex]:
    d = FakeDuplex(script)
    return QmpProtocol(d.send, d.read), d


def test_negotiate_acks_the_greeting():
    p, d = proto(['{"QMP":{"version":{}}}', '{"return":{}}'])
    p.negotiate()
    assert [json.loads(s) for s in d.sent] == [{"execute": "qmp_capabilities"}]


def test_negotiate_rejects_a_non_qmp_greeting():
    p, _ = proto(['{"hello":true}'])
    with pytest.raises(QmpError):
        p.negotiate()


def test_negotiate_rejects_a_closed_stream():
    p, _ = proto([])
    with pytest.raises(QmpError):
        p.negotiate()


def test_execute_skips_async_events_until_return():
    p, d = proto(
        [
            '{"timestamp":{},"event":"POWERDOWN"}',
            "",
            '{"event":"SHUTDOWN"}',
            '{"return":{}}',
        ]
    )
    p.system_powerdown()
    assert json.loads(d.sent[0]) == {"execute": "system_powerdown"}


def test_execute_raises_on_error_reply():
    p, _ = proto(['{"error":{"class":"GenericError","desc":"nope"}}'])
    with pytest.raises(QmpError, match="nope"):
        p.quit()


def test_execute_raises_when_the_stream_closes_mid_command():
    p, _ = proto(['{"event":"noise"}'])
    with pytest.raises(QmpError, match="closed"):
        p.system_powerdown()


def test_tolerates_non_json_noise():
    p, _ = proto(["garbage not json", "[1,2]", '{"return":{}}'])
    p.execute("quit")
