"""First contact, Studio's half (docs/first-contact.md). A server Studio hosts prints its six-digit code
and its key on a dedicated output-only virtio port; Studio, which got a per-server `studioConfirmKey`
from the phone beside the recipe (never inside it), reports what it saw to `.com` as an HMAC the phone
checks, so the phone can show "Confirmed by Studio" in place of asking the owner to compare the code.
Mirrors `serverSeenMacHex` in packages/protocol/src/enrollment.ts and the Mac and Windows Studios.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from dataclasses import dataclass
from typing import List, Optional

from .inventory import VMBundleLayout

#: The guest sees it as /dev/virtio-ports/<PORT_NAME>. Output only: the host never writes to it.
PORT_NAME = "org.flagshipserver.server-code"
SEEN_TAG = "flagship/server-code-seen/v1"
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class Sighting:
    code: str
    stk_pub_hex: str


def parse(line: str, server_domain: str) -> Optional[Sighting]:
    """`flagship-server-code <domain> <6 digits> <64 lowercase hex>`, for this server only."""
    parts = line.strip().split()
    if len(parts) != 4 or parts[0] != "flagship-server-code":
        return None
    if parts[1].lower() != server_domain.lower():
        return None
    if len(parts[2]) != 6 or not parts[2].isascii() or not parts[2].isdigit():
        return None
    if not _HEX64.fullmatch(parts[3]):
        return None
    return Sighting(parts[2], parts[3])


def mac_hex(studio_confirm_key: bytes, server_domain: str, stk_pub_hex: str) -> Optional[str]:
    if len(studio_confirm_key) != 32 or not _HEX64.fullmatch(stk_pub_hex) or "|" in server_domain:
        return None
    msg = f"{SEEN_TAG}|{server_domain.lower()}|{stk_pub_hex}".encode()
    return hmac.new(studio_confirm_key, msg, hashlib.sha256).hexdigest()


def body(stk_pub_hex: str, mac: str) -> bytes:
    """The JSON body of `POST /api/order/<serial>/server-seen`."""
    return json.dumps({"macHex": mac, "stkPubHex": stk_pub_hex}, sort_keys=True).encode()


def pretty(code: str) -> str:
    """"482 913", the way the box shows it."""
    return f"{code[:3]} {code[3:]}" if len(code) == 6 else code


def port_log_path(layout: VMBundleLayout, name: str) -> str:
    """The file the VM's server-code port writes, beside its bundle."""
    return os.path.join(layout.bundle_dir(name), "server-code.log")


class ConsoleLineSplitter:
    """Splits the port's bytes into lines; a line longer than any real one is dropped, not buffered forever."""

    def __init__(self, max_line: int = 4096) -> None:
        self._buffer = bytearray()
        self._max = max_line

    def feed(self, data: bytes) -> List[str]:
        self._buffer += data
        lines: List[str] = []
        while True:
            nl = self._buffer.find(b"\n")
            if nl < 0:
                break
            raw = bytes(self._buffer[:nl])
            del self._buffer[: nl + 1]
            try:
                lines.append(raw.decode("utf-8"))
            except UnicodeDecodeError:
                pass
        if len(self._buffer) > self._max:
            self._buffer.clear()
        return lines


def key_path(layout: VMBundleLayout, name: str) -> str:
    return os.path.join(layout.bundle_dir(name), "studio-confirm.key")


def write_key(key: bytes, layout: VMBundleLayout, name: str) -> None:
    """Keep the phone's key with the server's bundle (0600) until Studio has reported what it saw."""
    if len(key) != 32:
        return
    path = key_path(layout, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(key)
    os.chmod(path, 0o600)


def read_key(layout: VMBundleLayout, name: str) -> Optional[bytes]:
    try:
        with open(key_path(layout, name), "rb") as f:
            d = f.read()
    except OSError:
        return None
    return d if len(d) == 32 else None


def delete_key(layout: VMBundleLayout, name: str) -> None:
    try:
        os.remove(key_path(layout, name))
    except OSError:
        pass
