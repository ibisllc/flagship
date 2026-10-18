"""Studio's version. studio-release.yml stamps the release version into the
AppImage's copy (FLAGSHIP_STUDIO_VERSION in appimage/build.sh); a source
checkout reports a dev version. The release number comes from
release/version.json, as does LABEL (scripts/check-versions.mjs --write)."""
import re

VERSION = "0.0.0-dev"
LABEL = "Beta"


def display_version(version=None):
    """A release such as 0.2.0 reads as 0.2 Beta; a dev build or patch release is shown as is."""
    v = VERSION if version is None else version
    m = re.fullmatch(r"(\d+)\.(\d+)\.0", v)
    return f"{m.group(1)}.{m.group(2)} {LABEL}" if m else v
