"""A hosted server's own health report, read from `.com` by the order that
created it (`GET /api/order/<serial>/health`, control-plane serverHealth.ts).

The account's server list needs a read token Studio doesn't hold; the order
serial is a capability it does. The guest signs these numbers once a minute
from a timer that keeps running when the daemon doesn't, so Studio can say why
a server went quiet. Mirrors apps/builder-mac VMServerHealth.swift; the shared
vm-core-vectors.json "serverHealth" section pins the copy on all three ports.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import List, Optional

from .control_plane import order_url

_SERIAL_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


@dataclass(frozen=True)
class HealthVerdict:
    ok: bool
    lines: List[str]


def _int(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("not an integer")
    return value


@dataclass(frozen=True)
class VMServerHealth:
    uptime_s: int
    mem_total_mb: int
    mem_avail_mb: int
    oom_kills: int
    daemon_state: str
    daemon_restarts: int
    daemon_last_exit: int
    tunnel: bool
    disk_used_pct: int
    received_at_ms: int

    @staticmethod
    def order_health_url(serial: str) -> Optional[str]:
        if not _SERIAL_RE.fullmatch(serial or ""):
            return None
        return order_url(serial, "health")

    @staticmethod
    def from_order_health(body: bytes | str, server_domain: str) -> Optional["VMServerHealth"]:
        """The report out of an order-health response; None when the response
        names another server or its box doesn't report yet."""
        try:
            doc = json.loads(body)
            if not isinstance(doc, dict):
                return None
            domain = doc.get("serverDomain")
            if not isinstance(domain, str) or domain.lower() != server_domain.lower():
                return None
            h = doc.get("health")
            if not isinstance(h, dict):
                return None
            daemon = h["daemon"]
            if not isinstance(daemon, dict) or not isinstance(daemon["state"], str):
                return None
            if not isinstance(h["tunnel"], bool):
                return None
            return VMServerHealth(
                uptime_s=_int(h["uptimeS"]),
                mem_total_mb=_int(h["memTotalMB"]),
                mem_avail_mb=_int(h["memAvailMB"]),
                oom_kills=_int(h["oomKills"]),
                daemon_state=daemon["state"],
                daemon_restarts=_int(daemon["restarts"]),
                daemon_last_exit=_int(daemon["lastExit"]),
                tunnel=h["tunnel"],
                disk_used_pct=_int(h["diskUsedPct"]),
                received_at_ms=_int(h["receivedAt"]),
            )
        except (ValueError, KeyError, TypeError):
            return None

    def verdict(self, now_ms: int) -> HealthVerdict:
        stale_min = int((now_ms - self.received_at_ms) / 60_000)
        if stale_min >= 5:
            return HealthVerdict(False, [
                f"No health report for {stale_min} min. The server itself may be off or frozen."
            ])
        lines: List[str] = []
        if self.oom_kills > 0:
            lines.append(
                f"Ran out of memory {self.oom_kills}× since it started "
                f"({self.mem_avail_mb} MB free of {self.mem_total_mb} MB now)."
            )
        if self.daemon_state != "active":
            lines.append(
                f"The server software isn't running ({self.daemon_state}; restarted "
                f"{self.daemon_restarts}×, last exit code {self.daemon_last_exit})."
            )
        elif self.daemon_restarts >= 3:
            lines.append(
                f"The server software restarted {self.daemon_restarts}× since it started "
                f"(last exit code {self.daemon_last_exit})."
            )
        if not self.tunnel:
            lines.append("Can't reach the Flagship relay.")
        if self.disk_used_pct >= 90:
            lines.append(f"Disk is {self.disk_used_pct}% full.")
        if lines:
            return HealthVerdict(False, lines)
        return HealthVerdict(True, [
            f"Healthy · {self.mem_avail_mb} MB free of {self.mem_total_mb} MB · "
            f"disk {self.disk_used_pct}% · up {uptime(self.uptime_s)}"
        ])


def uptime(s: int) -> str:
    d, h, m = s // 86_400, (s % 86_400) // 3_600, (s % 3_600) // 60
    if d >= 1:
        return f"{d}d {h}h"
    if h >= 1:
        return f"{h}h {m}m"
    return f"{m}m"
