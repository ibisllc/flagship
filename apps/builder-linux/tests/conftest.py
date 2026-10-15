"""Pytest config — add the parent directory to sys.path so unit tests can
import `disk_enumerator`, `cli_runner`, and the GUI-agnostic parts of
`wizard` without an editable install."""
from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PARENT = _HERE.parent
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _no_published_appliance(monkeypatch):
    """No test reaches flagshipserver.com: by default nothing is published,
    so hosting takes the installer path. Appliance tests inject their own."""
    import wizard
    from vm.appliance_cache import ApplianceCacheError

    def unavailable(*_a, **_k):
        raise ApplianceCacheError("unavailable", "No prebuilt server image is published yet.")

    monkeypatch.setattr(wizard, "_live_ensure_appliance", unavailable)
