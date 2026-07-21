#!/usr/bin/env bash
# Build a relocatable AppImage for the Flagship Studio Linux GUI.
#
# Output: apps/builder-linux/dist/FlagshipBuilder-x86_64.AppImage
#
# Requirements on the build host:
#   - Linux x86_64 (other arches: edit ARCH below)
#   - python3 (>=3.10)
#   - wget or curl
#   - file
#   - GTK4 + libadwaita installed so the AppImage can verify-link the
#     bundled Python's gi imports during a smoke run (`--appimage-extract`
#     + an import test). On Ubuntu 24.04:
#       sudo apt install python3 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1
#
# What we ship inside the AppImage:
#   - flagship-builder.py + wizard.py + cli_runner.py + disk_enumerator.py
#   - the polkit policy XML (operator installs this themselves on first run)
#   - a copy of packages/flagship-builder/dist/cli.js (built with `tsc -b`)
#   - a desktop file pointing to the AppImage entry
#   - an icon
#
# The user must still have:
#   - node (>=20) installed system-wide (`apt install nodejs` or via nvm)
#   - pkexec (ships on every modern desktop distro)
#
# Both are runtime prereqs — bundling Node ~80MB into the AppImage would
# triple the binary size for a constant we can find in /usr/bin.

set -euo pipefail

ARCH="${ARCH:-x86_64}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINUX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${LINUX_DIR}/../.." && pwd)"
DIST_DIR="${LINUX_DIR}/dist"
APPDIR="${DIST_DIR}/FlagshipBuilder.AppDir"

echo ">> repo:    ${REPO_ROOT}"
echo ">> linux:   ${LINUX_DIR}"
echo ">> appdir:  ${APPDIR}"

rm -rf "${APPDIR}"
mkdir -p "${APPDIR}/usr/bin"
mkdir -p "${APPDIR}/usr/share/flagship-builder"
mkdir -p "${APPDIR}/usr/share/applications"
mkdir -p "${APPDIR}/usr/share/icons/hicolor/256x256/apps"
mkdir -p "${APPDIR}/usr/share/polkit-1/actions"

# ---- python sources ----
install -Dm755 "${LINUX_DIR}/flagship-builder.py"   "${APPDIR}/usr/bin/flagship-builder"
install -Dm644 "${LINUX_DIR}/wizard.py"            "${APPDIR}/usr/share/flagship-builder/wizard.py"
install -Dm644 "${LINUX_DIR}/cli_runner.py"        "${APPDIR}/usr/share/flagship-builder/cli_runner.py"
# Simple-mode server-manifest base-ISO cache (manifest client + cache).
install -Dm644 "${LINUX_DIR}/iso_manifest_client.py" "${APPDIR}/usr/share/flagship-builder/iso_manifest_client.py"
install -Dm644 "${LINUX_DIR}/iso_base_cache.py"    "${APPDIR}/usr/share/flagship-builder/iso_base_cache.py"
install -Dm644 "${LINUX_DIR}/disk_enumerator.py"   "${APPDIR}/usr/share/flagship-builder/disk_enumerator.py"
install -Dm644 "${LINUX_DIR}/container_env.py"     "${APPDIR}/usr/share/flagship-builder/container_env.py"
install -Dm644 "${LINUX_DIR}/elevation.py"         "${APPDIR}/usr/share/flagship-builder/elevation.py"
# The phone-pairing session + the VM appliance host layer — wizard.py imports
# both at module scope, so a bundle without them dies at startup.
install -Dm644 "${LINUX_DIR}/pair_session.py"      "${APPDIR}/usr/share/flagship-builder/pair_session.py"
mkdir -p "${APPDIR}/usr/share/flagship-builder/vm"
install -m644 -t "${APPDIR}/usr/share/flagship-builder/vm" "${LINUX_DIR}"/vm/*.py
# disk_write.py is the script pkexec elevates for the raw write — install it
# 0755 so the polkit-launched python3 can read+exec it.
install -Dm755 "${LINUX_DIR}/disk_write.py"        "${APPDIR}/usr/share/flagship-builder/disk_write.py"

# ---- node CLI (built dist, copied into the AppImage) ----
CLI_SRC="${REPO_ROOT}/packages/flagship-builder/dist"
if [ -d "${CLI_SRC}" ]; then
  echo ">> bundling ${CLI_SRC}"
  cp -r "${CLI_SRC}" "${APPDIR}/usr/share/flagship-builder/cli-dist"
else
  echo "!! ${CLI_SRC} does not exist — running tsc -b first"
  ( cd "${REPO_ROOT}" && npx tsc -b packages/flagship-builder )
  cp -r "${CLI_SRC}" "${APPDIR}/usr/share/flagship-builder/cli-dist"
fi

# ---- polkit policies (operator installs these separately on first run) ----
# The Node-CLI write action + the local-flasher action
# (pkexec python3 disk_write.py).
install -Dm644 "${LINUX_DIR}/polkit/com.flagshipserver.builder.policy" \
  "${APPDIR}/usr/share/polkit-1/actions/com.flagshipserver.builder.policy"
install -Dm644 "${LINUX_DIR}/polkit/com.flagshipserver.builder.write-image.policy" \
  "${APPDIR}/usr/share/polkit-1/actions/com.flagshipserver.builder.write-image.policy"

# ---- desktop file ----
cat > "${APPDIR}/usr/share/applications/com.flagshipserver.Builder.desktop" <<'DESK'
[Desktop Entry]
Type=Application
Name=Flagship Studio
GenericName=USB Image Writer
Comment=Flash a Flagship pod onto a USB drive
Exec=flagship-builder %F
Terminal=false
Icon=com.flagshipserver.Builder
Categories=Utility;System;
StartupNotify=true
StartupWMClass=com.flagshipserver.Builder
DESK
cp "${APPDIR}/usr/share/applications/com.flagshipserver.Builder.desktop" "${APPDIR}/"

# ---- icon (placeholder — replace with the real flagship icon later) ----
if [ ! -f "${APPDIR}/com.flagshipserver.Builder.png" ]; then
  # 1x1 transparent PNG as a placeholder so appimagetool doesn't refuse.
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\x2d\xb4\x00\x00\x00\x00IEND\xaeB`\x82' \
    > "${APPDIR}/com.flagshipserver.Builder.png"
fi
cp "${APPDIR}/com.flagshipserver.Builder.png" \
  "${APPDIR}/usr/share/icons/hicolor/256x256/apps/com.flagshipserver.Builder.png"

# ---- AppRun shim ----
cat > "${APPDIR}/AppRun" <<'RUN'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "${0}")")"
export PATH="${HERE}/usr/bin:${PATH}"
export FLAGSHIP_BURN_ENTRY="${FLAGSHIP_BURN_ENTRY:-${HERE}/usr/share/flagship-builder/cli-dist/cli.js}"
export PYTHONPATH="${HERE}/usr/share/flagship-builder:${PYTHONPATH:-}"
exec python3 "${HERE}/usr/bin/flagship-builder" "$@"
RUN
chmod +x "${APPDIR}/AppRun"

# ---- fetch appimagetool (cached in dist/) ----
APPIMAGETOOL="${DIST_DIR}/appimagetool-${ARCH}.AppImage"
if [ ! -x "${APPIMAGETOOL}" ]; then
  URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${ARCH}.AppImage"
  echo ">> downloading ${URL}"
  if command -v wget >/dev/null 2>&1; then
    wget -O "${APPIMAGETOOL}" "${URL}"
  else
    curl -L -o "${APPIMAGETOOL}" "${URL}"
  fi
  chmod +x "${APPIMAGETOOL}"
fi

# ---- build ----
OUT="${DIST_DIR}/FlagshipBuilder-${ARCH}.AppImage"
ARCH="${ARCH}" "${APPIMAGETOOL}" "${APPDIR}" "${OUT}"
echo ">> built ${OUT}"
