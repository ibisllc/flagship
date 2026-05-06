#!/bin/sh
# Chromium entrypoint inside the flagship-chromium container.
#
# Steps:
#   1. Clean stale lock files from a previous unclean shutdown.
#      Without this, Chromium aborts with "Profile directory is in use"
#      every time the container restarts after a kill -9 / OOM.
#   2. Start Xvfb on display :99 in the background. Chromium runs
#      headful against it — same posture as a real desktop browser
#      from a fingerprint POV.
#   3. Exec Chromium with CDP exposed on :9222 (bound 0.0.0.0 inside
#      the container; compose maps to 127.0.0.1 on the host).
#
# Sandbox: --no-sandbox is used because the container is the isolation
# boundary. Chromium's userland sandbox needs caps a default container
# doesn't have; granting SYS_ADMIN to the container would be strictly
# worse than --no-sandbox here.

set -eu

PROFILE_DIR=/home/flagship/profile

mkdir -p "$PROFILE_DIR"

# Lock-file gotcha (see microsoft/playwright issue #35466):
rm -f "$PROFILE_DIR/SingletonLock" \
      "$PROFILE_DIR/SingletonCookie" \
      "$PROFILE_DIR/SingletonSocket" || true

# Start Xvfb on :99
Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
export DISPLAY=:99

# Brief settle. Xvfb is local + fast so this is plenty.
sleep 0.3

# If Xvfb died immediately, surface that as a container failure.
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "fatal: Xvfb failed to start" >&2
    exit 1
fi

# Chromium 113+ ignores --remote-debugging-address=0.0.0.0 for security
# (CVE-2023-2459 — DevTools target validation). It binds to 127.0.0.1
# only regardless of the flag. To expose CDP through the Docker port
# mapping, we run a socat forwarder: external 9222 → loopback 9223.
# The daemon (only legitimate client) reaches us via the host's
# 127.0.0.1:9222 mapping, which Docker forwards to container:9222 →
# socat → chromium's loopback 9223.
socat TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9223 &
SOCAT_PID=$!

# Brief settle so socat is listening before clients connect.
sleep 0.1

if ! kill -0 "$SOCAT_PID" 2>/dev/null; then
    echo "fatal: socat forwarder failed to start" >&2
    exit 1
fi

exec chromium \
    --user-data-dir="$PROFILE_DIR" \
    --remote-debugging-port=9223 \
    --no-sandbox \
    --no-first-run \
    --no-default-browser-check \
    --disable-features=Translate \
    --disable-blink-features=AutomationControlled \
    --window-size=1280,800 \
    --start-maximized \
    "$@"
