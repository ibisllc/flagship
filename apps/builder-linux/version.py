"""Studio's version. studio-release.yml stamps the release version into the
AppImage's copy (FLAGSHIP_STUDIO_VERSION in appimage/build.sh); a source
checkout reports a dev version. The release number comes from
release/version.json, as does LABEL (scripts/check-versions.mjs --write)."""
import re

from i18n import tr  # the label is a msgid of its own (i18n/studio-linux "Beta")

VERSION = "0.0.0-dev"
LABEL = "Beta"
# STUDIO_EXPERIMENTAL.linux in apps/web/public/app-stores.js, the website's switch for the
# "Experimental" tag (scripts/check-versions.mjs --write keeps it in step).
EXPERIMENTAL = True


def display_version(version=None):
    """A release such as 0.2.0 reads as 0.2 Beta; a dev build or patch release is shown as is."""
    v = VERSION if version is None else version
    m = re.fullmatch(r"(\d+)\.(\d+)\.0", v)
    return f"{m.group(1)}.{m.group(2)} {tr(LABEL)}" if m else v


def window_title(experimental=None):
    """The main window's title: the brand, tagged while this platform is Experimental."""
    tagged = EXPERIMENTAL if experimental is None else experimental
    return tr("Flagship Studio (Experimental)") if tagged else "Flagship Studio"
