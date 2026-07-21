"""Phone pairing: drive `flagship-build pair --emit-events` and surface its
milestones as callbacks.

The heavy lifting (the relay handshake, SAS derivation, recipe decrypt +
signature verify) is the SHARED TypeScript implementation
(packages/flagship-builder/src/pair.ts) — this is thin glue, exactly like the
remaster/write path. Mirrors apps/builder-windows/src/PairSession.cs.

The parser is pure and unit-tested; the event shape must track the PairEvent
union in pair.ts. NOTE the field asymmetry in the TS union: the mid-session
`debug-result` event carries `granted`, while the terminal `done` event carries
`debugGranted` — both are parsed (the Windows parser misses `granted`; see the
session report).
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import uuid
from dataclasses import dataclass
from typing import Callable, Optional

from cli_runner import CLIRunner, LogLine, Resolved, args_pair, locate

PAIR_EVENT_PREFIX = "FLAGSHIP_PAIR "


@dataclass(frozen=True)
class PairEvent:
    """One phone-pairing milestone, parsed from a `FLAGSHIP_PAIR <json>` line
    the subprocess prints."""

    event: str
    # ready
    human_code: Optional[str] = None
    qr_terminal: Optional[str] = None
    payload: Optional[str] = None
    debug_requested: bool = False
    # phone-connected
    sas: Optional[str] = None
    # delivered / done
    server_domain: Optional[str] = None
    # debug-result
    granted: bool = False
    # done
    recipe_path: Optional[str] = None
    debug_granted: bool = False
    # error
    message: Optional[str] = None


def parse_pair_event(line: str) -> Optional[PairEvent]:
    """Pure parser for the subprocess's structured stdout. A line that isn't a
    well-formed `FLAGSHIP_PAIR <json>` returns None (ordinary human log
    line)."""
    if line is None:
        return None
    trimmed = line.lstrip()
    if not trimmed.startswith(PAIR_EVENT_PREFIX):
        return None
    try:
        obj = json.loads(trimmed[len(PAIR_EVENT_PREFIX):])
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    event = obj.get("event")
    if not isinstance(event, str):
        return None

    def s(name: str) -> Optional[str]:
        v = obj.get(name)
        return v if isinstance(v, str) else None

    def b(name: str) -> bool:
        return obj.get(name) is True

    return PairEvent(
        event=event,
        human_code=s("humanCode"),
        qr_terminal=s("qrTerminal"),
        payload=s("payload"),
        debug_requested=b("debugRequested"),
        sas=s("sas"),
        server_domain=s("serverDomain"),
        granted=b("granted"),
        recipe_path=s("recipePath"),
        debug_granted=b("debugGranted"),
        message=s("message"),
    )


class PairSession:
    """Spawn the pairing subprocess and route its output: milestone lines to
    `on_event`, everything else to `on_log`. On the terminal `done` event the
    recipe JSON has been written to `recipe_out_path`; the caller loads it
    (identical to a dropped-in recipe file) and proceeds to the destination
    chooser."""

    def __init__(
        self,
        debug: bool,
        out_path: Optional[str] = None,
        locate_fn: Callable[[], Resolved] = locate,
    ) -> None:
        self._debug = debug
        self._locate_fn = locate_fn
        self._runner: Optional[CLIRunner] = None
        self._cancelled = threading.Event()
        self.recipe_out_path = out_path or os.path.join(
            tempfile.gettempdir(), f"flagship-pair-{uuid.uuid4().hex}.json"
        )

    def run(
        self,
        on_event: Callable[[PairEvent], None],
        on_log: Callable[[LogLine], None],
    ) -> int:
        """Blocking: spawn, stream until exit (after `done` or an error).
        Callbacks fire on the runner's reader threads — callers marshal to
        their UI loop themselves. Raises only if the CLI can't be
        located/spawned."""
        resolved = self._locate_fn()
        args = args_pair(resolved.entry_path, self.recipe_out_path, self._debug)
        runner = CLIRunner(node_path=resolved.node_path, arguments=args)
        self._runner = runner

        def route(line: LogLine) -> None:
            ev = parse_pair_event(line.text) if line.stream == "stdout" else None
            if ev is not None:
                on_event(ev)
            else:
                on_log(line)

        try:
            runner.start(on_line=route)
            return runner.wait()
        finally:
            self._runner = None

    def cancel(self) -> None:
        self._cancelled.set()
        runner = self._runner
        if runner is not None:
            try:
                runner.terminate()
            except Exception:
                pass
