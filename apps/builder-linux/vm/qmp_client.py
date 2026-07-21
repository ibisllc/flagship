"""Minimal QMP (QEMU Machine Protocol) client over loopback TCP.

Capability negotiation + the two commands the appliance needs: system_powerdown
(a clean ACPI shutdown the guest daemon can flush on) and quit (the hard stop).
Line-delimited JSON. Mirrors apps/builder-windows/src/VM/QmpClient.cs.

The PROTOCOL is factored out of the socket (QmpProtocol) so the parsing — read
the greeting, skip async events, return on "return", raise on "error" — is
fully unit-testable against a fake duplex without a running QEMU.
"""
from __future__ import annotations

import json
import socket
from typing import Callable, Optional


class QmpError(Exception):
    pass


class QmpProtocol:
    """The pure QMP conversation over an injected line duplex.

    send_line(text) writes one line (no trailing newline needed — the protocol
    adds it); read_line() returns the next line WITHOUT its newline, or None at
    end-of-stream."""

    def __init__(self, send_line: Callable[[str], None], read_line: Callable[[], Optional[str]]) -> None:
        self._send_line = send_line
        self._read_line = read_line

    def negotiate(self) -> None:
        """Server greets with {"QMP":{…}}; ack it before any command."""
        greeting = self._read_object()
        if greeting is None:
            raise QmpError("QMP: connection closed before greeting.")
        if "QMP" not in greeting:
            raise QmpError("QMP: unexpected greeting.")
        self.execute("qmp_capabilities")

    def execute(self, command: str) -> None:
        """Send a command, read until its matching "return" (skipping async
        events); raise on an {"error":…} reply."""
        self._send_line(json.dumps({"execute": command}))
        while True:
            obj = self._read_object()
            if obj is None:
                raise QmpError(f"QMP: connection closed during '{command}'.")
            if "return" in obj:
                return
            if "error" in obj:
                raise QmpError(f"QMP '{command}' failed: {json.dumps(obj['error'])}")
            # else: an async event — skip.

    def system_powerdown(self) -> None:
        self.execute("system_powerdown")

    def quit(self) -> None:
        self.execute("quit")

    def _read_object(self) -> Optional[dict]:
        while True:
            line = self._read_line()
            if line is None:
                return None
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue  # tolerate noise
            if isinstance(obj, dict):
                return obj
            # non-object JSON — tolerate + keep reading


class QmpClient:
    """Socket-backed QMP client. `connect` opens the loopback TCP socket + runs
    the greeting handshake; then call system_powerdown() / quit()."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._buf = b""
        self._proto = QmpProtocol(self._send_line, self._read_line)

    @classmethod
    def connect(cls, port: int, host: str = "127.0.0.1", timeout: float = 5.0) -> "QmpClient":
        s = socket.create_connection((host, port), timeout=timeout)
        s.settimeout(timeout)
        client = cls(s)
        client._proto.negotiate()
        return client

    def system_powerdown(self) -> None:
        self._proto.system_powerdown()

    def quit(self) -> None:
        self._proto.quit()

    def close(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass

    def __enter__(self) -> "QmpClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _send_line(self, text: str) -> None:
        self._sock.sendall((text + "\n").encode("utf-8"))

    def _read_line(self) -> Optional[str]:
        while b"\n" not in self._buf:
            chunk = self._sock.recv(4096)
            if not chunk:
                if self._buf:
                    line, self._buf = self._buf, b""
                    return line.decode("utf-8", "replace")
                return None
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b"\n")
        return line.decode("utf-8", "replace")
