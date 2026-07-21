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
