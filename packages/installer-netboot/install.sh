#!/bin/bash
# Flagship netboot install.sh — W12.
#
# Marker / no-op script. In the netboot install path, the heavy lifting
# is split between:
#   /cdrom/preseed.cfg            — d-i automation
#   /cdrom/flagship/parse-trailer.sh — trailer reader + signature verify
#   /cdrom/flagship/late-command.sh — port of installer/install.sh logic
#
# This file is kept for two reasons:
#
#   1. The build-flagship-netboot-iso.sh script expects every script
#      under packages/installer-netboot/ to be injected onto the ISO at
#      /flagship/<name>. Symmetry with the apkovl + Alpine installer
#      layout (installer/install.sh on the Alpine path) keeps the
#      mental model identical across both ISO families.
#
#   2. Future operator-recovery hooks can land here without re-cutting
#      the parse-trailer + late-command split. E.g., a forced
#      "reinstall but keep /var" path would call this from a d-i
#      rescue console.
#
# For now it just prints a "hello from netboot install.sh" line and
# exits. The late-command.sh covers everything the first install needs.
set -eu
echo "[flagship-netboot-install] hello from $(realpath "$0") at $(date)"
echo "[flagship-netboot-install] this script is a placeholder; late-command.sh does the install"
exit 0
