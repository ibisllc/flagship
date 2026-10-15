"""Keeps a live pairing code on screen without anyone pressing a button.

Mirrors the Mac WizardModel's pairing lifecycle: pairing starts at launch,
stops while the PC is offline (so the code doesn't churn against a dead
relay), comes back when the network does, and a session that fails is retried
with a growing delay. A session the owner cancelled, or one that delivered its
recipe, is not restarted: `wants_pairing` says when a new one is wanted.
"""
from __future__ import annotations

import socket
import threading
from typing import Callable, Optional

RETRY_DELAYS = (5.0, 10.0, 20.0, 40.0, 60.0)


class PairingWatch:
    def __init__(
        self,
        wants_pairing: Callable[[], bool],
        start: Callable[[], None],
        stop: Callable[[], None],
        schedule: Callable[[float, Callable[[], None]], Callable[[], None]],
        on_online_change: Callable[[bool], None] = lambda _o: None,
    ) -> None:
        self._wants = wants_pairing
        self._start = start
        self._stop = stop
        self._schedule = schedule
        self._on_online_change = on_online_change
        self.online = True
        self._failures = 0
        self._cancel_retry: Optional[Callable[[], None]] = None

    def launch(self) -> None:
        if self.online and self._wants():
            self._start()

    def on_connectivity(self, online: bool) -> None:
        if online == self.online:
            return
        self.online = online
        self._on_online_change(online)
        if online:
            self._failures = 0
            if self._wants():
                self._start()
        else:
            self._drop_retry()
            self._stop()

    def on_ready(self) -> None:
        """The relay answered: the next failure starts from the short delay."""
        self._failures = 0

    def on_failed(self) -> None:
        if not self.online or self._cancel_retry is not None:
            return
        delay = RETRY_DELAYS[min(self._failures, len(RETRY_DELAYS) - 1)]
        self._failures += 1
        self._cancel_retry = self._schedule(delay, self._retry)

    def _retry(self) -> None:
        self._cancel_retry = None
        if self.online and self._wants():
            self._start()

    def _drop_retry(self) -> None:
        cancel, self._cancel_retry = self._cancel_retry, None
        if cancel is not None:
            cancel()


def timer_schedule(delay: float, fn: Callable[[], None]) -> Callable[[], None]:
    timer = threading.Timer(delay, fn)
    timer.daemon = True
    timer.start()
    return timer.cancel


def relay_reachable(host: str = "flagshipserver.com", port: int = 443, timeout: float = 4.0) -> bool:
    """Whether this PC can open a connection to the pairing relay's host."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


class ConnectivityMonitor:
    """Polls relay reachability on a background thread and reports changes."""

    def __init__(
        self,
        on_change: Callable[[bool], None],
        probe: Callable[[], bool] = relay_reachable,
        interval: float = 10.0,
    ) -> None:
        self._on_change = on_change
        self._probe = probe
        self._interval = interval
        self._stop = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            self._on_change(self._probe())
            self._stop.wait(self._interval)
