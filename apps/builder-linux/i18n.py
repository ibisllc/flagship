"""Run-time translation for Flagship Studio on Linux (gettext).

`tr("Some text")` returns the text in the language of the session (LC_ALL / LC_MESSAGES / LANGUAGE / LANG,
the usual order) or the English original when there is no translation. The catalogs are
`locale/<lang>/LC_MESSAGES/flagship-studio.mo`, compiled from `po/<lang>.po` by
`node scripts/i18n-linux.mjs build`; they are looked for next to this file (a checkout, the AppImage),
then in the Flatpak and system locations.

The language is picked once, when this module is first imported, so a module-level constant that calls
`tr()` is in the right language too. Python's `gettext.translation` reads the environment itself; this
module only adds where to look.
"""
from __future__ import annotations

import gettext
import os
from pathlib import Path

DOMAIN = "flagship-studio"

_HERE = Path(__file__).resolve().parent
_SEARCH = [
    _HERE / "locale",
    Path(os.environ.get("FLAGSHIP_LOCALE_DIR", "/nonexistent")),
    Path("/app/share/locale"),  # Flatpak
    Path("/usr/local/share/locale"),
    Path("/usr/share/locale"),
]


def _load() -> gettext.NullTranslations:
    for base in _SEARCH:
        try:
            if base.is_dir():
                return gettext.translation(DOMAIN, localedir=str(base), fallback=False)
        except OSError:
            continue
    return gettext.NullTranslations()


_translation = _load()


def tr(message: str) -> str:
    """The message in the session's language, or `message` itself."""
    return _translation.gettext(message)
