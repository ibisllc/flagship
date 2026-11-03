"""A recipe made by a Flagship app older than 0.3 names installerGitRef "main"
(or a tag) in its signed install blob, never an exact commit, and the bootstrap
refuses to install anything but an exact commit. Studio checks this when the
recipe is loaded and refuses with an "update the app" sentence, creating
nothing (owner rule F9).

Mirrors apps/builder-mac OlderAppRecipe.swift and apps/builder-windows
OlderAppRecipe.cs; pinned by vm-core-vectors.json "olderAppRecipe".
"""
from __future__ import annotations

from i18n import tr

import re
from typing import Optional

_COMMIT = re.compile(r"[0-9a-f]{40}")


def message() -> str:
    return tr("This recipe was made by an older version of the Flagship app. Update the Flagship app on your phone, then create the server again.")


def is_from_older_app(installer_git_ref: Optional[str]) -> bool:
    """True when the ref is not an exact 40-character lowercase commit (after
    trimming), absent included."""
    if installer_git_ref is None:
        return True
    return _COMMIT.fullmatch(installer_git_ref.strip()) is None


def refusal(installer_git_ref: Optional[str]) -> Optional[str]:
    """The refusal for a loaded recipe's ref; None when it may go ahead."""
    return message() if is_from_older_app(installer_git_ref) else None
