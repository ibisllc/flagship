"""A hosted server's own health report, read from `.com` by the order that
created it (`GET /api/order/<serial>/health`, control-plane serverHealth.ts).

The account's server list needs a read token Studio doesn't hold; the order
serial is a capability it does. The guest signs these numbers once a minute
from a timer that keeps running when the daemon doesn't, so Studio can say why
a server went quiet. Mirrors apps/builder-mac VMServerHealth.swift; the shared
vm-core-vectors.json "serverHealth" section pins the copy on all three ports.
"""
from __future__ import annotations

from i18n import tr

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

    def proves_box_is_up(self, powered_on_at_ms: int, now_ms: int) -> bool:
        """True when this report shows the guest unlocked and serving after
        THIS boot began. Studio takes it, not a fetch of the server's own
        name, as the sign a sealed guest came up: the name does not exist until
        the box registers it, and a lookup before then is cached as NXDOMAIN
        by home routers for the zone's negative TTL. A report from an earlier
        boot (received before power-on, or with more uptime than this boot has
        had) never counts. Pinned by vm-core-vectors.json "bootEvidence"."""
        return (
            self.daemon_state == "active"
            and self.tunnel
            and self.received_at_ms >= powered_on_at_ms
            and self.uptime_s * 1000 <= (now_ms - powered_on_at_ms) + 60_000
            and now_ms - self.received_at_ms < 300_000
        )

    def verdict(self, now_ms: int) -> HealthVerdict:
        stale_min = int((now_ms - self.received_at_ms) / 60_000)
        if stale_min >= 5:
            return HealthVerdict(False, [
                tr('No health report for {0} min. The server itself may be off or frozen.').format(stale_min)
            ])
        lines: List[str] = []
        if self.oom_kills > 0:
            lines.append(
                tr('Ran out of memory {0}× since it started ({1} MB free of {2} MB now).').format(self.oom_kills, self.mem_avail_mb, self.mem_total_mb)
            )
        if self.daemon_state != "active":
            lines.append(
                tr("The server software isn't running ({0}; restarted {1}×, last exit code {2}).").format(self.daemon_state, self.daemon_restarts, self.daemon_last_exit)
            )
        elif self.daemon_restarts >= 3:
            lines.append(
                tr('The server software restarted {0}× since it started (last exit code {1}).').format(self.daemon_restarts, self.daemon_last_exit)
            )
        if not self.tunnel:
            lines.append(tr("Can't reach the Flagship relay."))
        if self.disk_used_pct >= 90:
            lines.append(tr('Disk is {0}% full.').format(self.disk_used_pct))
        if lines:
            return HealthVerdict(False, lines)
        return HealthVerdict(True, [
            tr('Healthy · {0} MB free of {1} MB · disk {2}% · up {3}').format(self.mem_avail_mb, self.mem_total_mb, self.disk_used_pct, uptime(self.uptime_s))
        ])


def uptime(s: int) -> str:
    d, h, m = s // 86_400, (s % 86_400) // 3_600, (s % 3_600) // 60
    if d >= 1:
        return f"{d}d {h}h"
    if h >= 1:
        return f"{h}h {m}m"
    return f"{m}m"
