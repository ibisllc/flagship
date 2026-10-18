"""The control plane Studio talks to: flagshipserver.com, or the host named by
FLAGSHIP_CONTROL_HOST (the gym, a self-hosted plane). The install-status and
health polls must follow it like pairing does, or a Studio pointed elsewhere
never sees its guest's checkpoints. Mirrors VMManager.cs / ControlPlane.swift.
"""
from __future__ import annotations

import os
import re
from typing import Mapping, Optional

DEFAULT_HOST = "flagshipserver.com"
_HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$")


def control_host(env: Optional[Mapping[str, str]] = None) -> str:
    """The configured host, or production when unset or not a plain host."""
    raw = (os.environ if env is None else env).get("FLAGSHIP_CONTROL_HOST", "").strip()
    return raw if raw and _HOST_RE.fullmatch(raw) else DEFAULT_HOST


def order_url(serial: str, leaf: str, env: Optional[Mapping[str, str]] = None) -> str:
    return f"https://{control_host(env)}/api/order/{serial}/{leaf}"
