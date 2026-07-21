"""Lifecycle behavior NOT covered by the shared vectors: labels, the injected
clock, and the live-adapter verdict convenience."""
from __future__ import annotations

import pytest

from vm.lifecycle import (
    COMING_UP_STALL_THRESHOLD_SECONDS,
    VMEvent,
    VMEventKind,
    VMFailurePhase,
    VMLifecycle,
    VMState,
    VMStateKind,
    coming_up_is_stalled,
)


def test_coming_up_stall_advisory():
    below = COMING_UP_STALL_THRESHOLD_SECONDS - 1
    above = COMING_UP_STALL_THRESHOLD_SECONDS + 1
    # Only in the awaiting-unlock state, and only past the threshold.
    assert not coming_up_is_stalled(VMStateKind.AWAITING_PHONE_UNLOCK, below)
    assert coming_up_is_stalled(VMStateKind.AWAITING_PHONE_UNLOCK, above)
    # Exactly at the threshold trips (inclusive).
    assert coming_up_is_stalled(VMStateKind.AWAITING_PHONE_UNLOCK, COMING_UP_STALL_THRESHOLD_SECONDS)
    # Never fires outside the awaiting-unlock state, no matter how long.
    assert not coming_up_is_stalled(VMStateKind.RUNNING, above)
    assert not coming_up_is_stalled(VMStateKind.INSTALLING, above)


def test_labels_are_user_facing():
    assert VMState.created().label == "Created"
    assert VMState.installing().label == "Installing…"
    assert VMState.installed().label == "Installed"
    assert VMState.awaiting_phone_unlock().label == "Waiting for you to unlock"
    assert VMState.running().label == "Running"
    assert VMState.stopped().label == "Stopped"
    assert VMState.failed(VMFailurePhase.INSTALL, "x").label == "Install failed"
    assert VMState.failed(VMFailurePhase.RUN, "x").label == "Stopped unexpectedly"


def test_state_changed_at_tracks_the_injected_clock():
    times = iter([100.0, 250.0])
    lc = VMLifecycle(False, clock=lambda: next(times))
    assert lc.state_changed_at == 100.0
    lc.handle(VMEvent.start_install())
    assert lc.state_changed_at == 250.0


def test_verdict_convenience_uses_state_timestamp():
    lc = VMLifecycle(False, clock=lambda: 1000.0)
    lc.handle(VMEvent.start_install())
    assert lc.verdict_for_clean_install_stop_now(1000.0 + 89).kind == VMEventKind.INSTALL_FAILED
    assert lc.verdict_for_clean_install_stop_now(1000.0 + 90).kind == VMEventKind.INSTALL_SUCCEEDED


def test_verdict_convenience_refuses_outside_installing():
    lc = VMLifecycle(False)
    with pytest.raises(RuntimeError):
        lc.verdict_for_clean_install_stop_now(5.0)


def test_transition_into_failed_pins_the_event_reason():
    lc = VMLifecycle(True, VMState.installing())
    lc.handle(VMEvent.install_failed("guest exploded"))
    assert lc.state.kind == VMStateKind.FAILED
    assert lc.state.failure.reason == "guest exploded"
