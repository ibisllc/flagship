"""Drives the pure VM core against the SHARED golden vectors
(apps/desktop-shared/golden/vm-core-vectors.json) — the cross-language contract
that keeps this Python core, the Windows C# core, and the Mac Swift core
identical, the way engine/golden/preseed-vectors.json pins the preseed engine.
If a vector fails here, the fix is byte-parity with the vectors, never editing
the vectors to match the code (unless ALL platforms change together).

Mirrors apps/burner-windows/tests/VMCoreVectorTests.cs.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from vm import resource_plan
from vm.host_resources import HostResources
from vm.inventory import VMInventoryStore
from vm.lifecycle import (
    MIN_PLAUSIBLE_INSTALL_SECONDS,
    VMEffect,
    VMEvent,
    VMEventKind,
    VMFailurePhase,
    VMLifecycle,
    VMLifecycleError,
    VMState,
    VMStateKind,
    verdict_for_clean_install_stop,
)

VECTORS_PATH = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "desktop-shared"
    / "golden"
    / "vm-core-vectors.json"
)
VECTORS = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


# ---- token codecs ----


def parse_state(token: str) -> VMState:
    return {
        "created": VMState.created(),
        "installing": VMState.installing(),
        "installed": VMState.installed(),
        "awaitingPhoneUnlock": VMState.awaiting_phone_unlock(),
        "running": VMState.running(),
        "stopped": VMState.stopped(),
        "failed:install": VMState.failed(VMFailurePhase.INSTALL, "x"),
        "failed:run": VMState.failed(VMFailurePhase.RUN, "x"),
    }[token]


def parse_event(token: str, reason) -> VMEvent:
    return {
        "startInstall": VMEvent.start_install(),
        "installSucceeded": VMEvent.install_succeeded(),
        "installFailed": VMEvent.install_failed(reason or ""),
        "powerOn": VMEvent.power_on(),
        "guestUnlocked": VMEvent.guest_unlocked(),
        "powerOff": VMEvent.power_off(),
        "runtimeFailed": VMEvent.runtime_failed(reason or ""),
    }[token]


def parse_effect(token: str) -> VMEffect:
    return VMEffect(token)


def assert_state_matches(expected_token: str, expected_reason, actual: VMState) -> None:
    """Compare ignoring the placeholder failure reason baked into start-state
    tokens; a transition INTO failed pins the real reason."""
    expected = parse_state(expected_token)
    assert expected.kind == actual.kind
    if expected.kind == VMStateKind.FAILED:
        assert actual.failure is not None
        assert expected.failure.phase == actual.failure.phase
        if expected_reason is not None:
            assert expected_reason == actual.failure.reason


# ---- lifecycle ----


def test_all_vector_transitions_hold():
    count = 0
    for t in VECTORS["lifecycle"]["transitions"]:
        reason = t.get("reason")
        effects = [parse_effect(e) for e in t["effects"]]
        # No "sealed" key => the transition must hold for BOTH values.
        sealed_values = [t["sealed"]] if "sealed" in t else [True, False]
        for sealed_at_boot in sealed_values:
            lc = VMLifecycle(sealed_at_boot, parse_state(t["start"]), clock=lambda: 0.0)
            got = lc.handle(parse_event(t["event"], reason))
            assert_state_matches(t["next"], reason, lc.state)
            assert effects == got, f"effects mismatch for {t}"
            count += 1
    assert count >= 15, "vector file must actually contain transitions"


def test_all_vector_invalid_transitions_raise_and_leave_state_untouched():
    count = 0
    for t in VECTORS["lifecycle"]["invalid"]:
        for sealed_at_boot in (True, False):
            start_state = parse_state(t["start"])
            lc = VMLifecycle(sealed_at_boot, start_state, clock=lambda: 0.0)
            with pytest.raises(VMLifecycleError):
                lc.handle(parse_event(t["event"], "r"))
            assert lc.state == start_state  # state must not change on a rejected event
            count += 1
    assert count >= 20, "vector file must actually contain invalid cases"


# ---- duration-gated install verdict ----


def test_install_verdict_matches_vectors():
    section = VECTORS["installVerdict"]
    assert section["minPlausibleInstallSeconds"] == MIN_PLAUSIBLE_INSTALL_SECONDS
    for c in section["cases"]:
        verdict = verdict_for_clean_install_stop(float(c["elapsedSeconds"]))
        expected = (
            VMEventKind.INSTALL_SUCCEEDED
            if c["verdict"] == "installSucceeded"
            else VMEventKind.INSTALL_FAILED
        )
        assert verdict.kind == expected, f"verdict mismatch at {c['elapsedSeconds']}s"
        if verdict.kind == VMEventKind.INSTALL_FAILED:
            assert verdict.reason and verdict.reason.strip(), (
                "failure verdicts carry an actionable reason"
            )


# ---- resource plan ----


def test_resource_plan_matches_vectors():
    for c in VECTORS["resourcePlan"]["cases"]:
        host = HostResources(c["hostCpus"], c["hostRamGiB"] * resource_plan.GIB)
        label = f"cpus={host.cpu_count} ramGiB={c['hostRamGiB']}"
        assert c["vmCpus"] == resource_plan.vm_cpu_count(host), f"vmCpus mismatch for {label}"
        assert c["vmMemGiB"] * resource_plan.GIB == resource_plan.vm_memory_bytes(host), (
            f"vmMemGiB mismatch for {label}"
        )
        assert c["maxVMs"] == resource_plan.max_vm_count(host), f"maxVMs mismatch for {label}"


# ---- bundle-name validation ----


def test_name_validation_matches_vectors():
    section = VECTORS["nameValidation"]
    for n in section["valid"]:
        assert VMInventoryStore.is_valid_name(n), f"'{n}' should be valid"
    for n in section["invalid"]:
        assert not VMInventoryStore.is_valid_name(n), f"'{n}' should be invalid"
