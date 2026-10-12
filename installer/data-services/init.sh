#!/bin/sh
# Initialize the unified data-layer on a Flagship box.
#
# Idempotent, and run on every boot by flagship-data-services.service:
# existing secrets are kept, missing ones are filled in, and compose never
# destroys the data volumes. The daemon runs the same bring-up at boot when
# it finds the stack down (dataLayer/stack.ts).
#
# Steps:
#   1. Ensure /var/flagship/{data,secrets} exist with strict perms.
#   2. Fill in any missing secret in the secrets file: the Postgres admin
#      credentials and DATA_NAME_KEY (keys the opaque per-app database and
#      role names, dataLayer/naming.ts).
#   3. Bring up the CORE store (Postgres) and wait for its healthcheck.
#      Apps' data needs exactly this (their files are per-app Docker
#      volumes). Failing here exits non-zero, so systemd retries
#      (Restart=on-failure).
#   4. Write the ready marker, then bring up the OPTIONAL services (forgejo,
#      chromium), removing containers of services this compose file no
#      longer has (an older box's minio, redis, adminer, redis-commander).
#      A failure there is logged and never takes Postgres down or fails the
#      unit.
#
# Compose lives at /opt/flagship/installer/data-services/docker-compose.yml
# (the box's own checkout).

set -eu

LOG=/var/log/flagship-data-services-init.log
mkdir -p /var/log
exec >>"$LOG" 2>&1
date

DATA_DIR=/var/flagship/data
SECRETS_DIR=/var/flagship
SECRETS_FILE="$SECRETS_DIR/data-services.env"
READY_MARKER="$SECRETS_DIR/data-services.ready"
COMPOSE=${FLAGSHIP_DATA_COMPOSE:-/opt/flagship/installer/data-services/docker-compose.yml}
CORE="postgres"

mkdir -p "$DATA_DIR/postgres" "$DATA_DIR/forgejo" "$DATA_DIR/chromium/profile"
# An older box's object and key-value stores: gone with their services. An
# empty directory goes too; one that still holds data is left for the owner.
rmdir "$DATA_DIR/minio" "$DATA_DIR/redis" 2>/dev/null || true
# Postgres 18 keeps its cluster in $DATA_DIR/postgres/18/docker. An older
# box's Postgres 16 cluster sat directly in $DATA_DIR/postgres: move it into
# a subdirectory so it is kept, not mistaken for the new layout.
if [ -f "$DATA_DIR/postgres/PG_VERSION" ]; then
    old="$DATA_DIR/postgres/old-pg$(cat "$DATA_DIR/postgres/PG_VERSION")"
    mkdir -p "$old"
    for f in "$DATA_DIR/postgres"/* "$DATA_DIR/postgres"/.[!.]*; do
        [ -e "$f" ] || continue
        case "$f" in "$old"|"$DATA_DIR/postgres"/old-pg*|"$DATA_DIR/postgres"/1[0-9]) continue ;; esac
        mv "$f" "$old/"
    done
    echo "flagship: moved the old Postgres $(cat "$old/PG_VERSION") cluster to $old"
fi
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
chmod 700 "$DATA_DIR"

# Forgejo's `:9-rootless` image runs as UID/GID 1000 inside the container.
# The volume bind-mount preserves host ownership; without this chown the
# container can't create /var/lib/gitea/git and crashloops on startup.
chown -R 1000:1000 "$DATA_DIR/forgejo"

# Chromium runs as UID 1000 (matches our `flagship` user inside the image).
# It needs to read+write its profile dir; it also needs the dir to NOT
# contain a stale SingletonLock from a previous unclean shutdown — the
# container's start.sh removes those, but if we ever pre-seed the profile
# we want the right perms ready to go.
chown -R 1000:1000 "$DATA_DIR/chromium"
rm -f "$DATA_DIR/chromium/profile/SingletonLock" \
      "$DATA_DIR/chromium/profile/SingletonCookie" \
      "$DATA_DIR/chromium/profile/SingletonSocket" || true

gen_secret() {
    head -c 32 /dev/urandom | base64 | tr -d '+/=\n' | head -c 40
}

ensure_var() {
    var="$1"
    if ! grep -q "^${var}=" "$SECRETS_FILE" 2>/dev/null; then
        value="$(gen_secret)"
        echo "${var}=${value}" >> "$SECRETS_FILE"
    fi
}

ensure_literal() {
    var="$1"
    value="$2"
    if ! grep -q "^${var}=" "$SECRETS_FILE" 2>/dev/null; then
        echo "${var}=${value}" >> "$SECRETS_FILE"
    fi
}

[ -f "$SECRETS_FILE" ] || touch "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

ensure_literal POSTGRES_ADMIN_USER flagship_admin
ensure_var POSTGRES_ADMIN_PASSWORD
ensure_var DATA_NAME_KEY

echo "flagship: data-services secrets ensured at $SECRETS_FILE"

if [ ! -f "$COMPOSE" ]; then
    echo "flagship: missing $COMPOSE (the box's checkout should have it)"
    exit 1
fi

# Debian's docker-compose package provides `docker compose`; older installs
# may only have the standalone binary.
if docker compose version >/dev/null 2>&1; then
    compose() { docker compose -f "$COMPOSE" --env-file "$SECRETS_FILE" "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
    compose() { docker-compose -f "$COMPOSE" --env-file "$SECRETS_FILE" "$@"; }
else
    echo "flagship: neither 'docker compose' nor 'docker-compose' is installed"
    exit 1
fi

health() {
    docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo missing
}

echo "flagship: starting the core store ($CORE)"
# shellcheck disable=SC2086
if ! compose up -d $CORE; then
    echo "flagship: compose could not start the core store"
    compose ps || true
    exit 1
fi

echo "flagship: waiting for the core healthcheck"
deadline=$(( $(date +%s) + ${FLAGSHIP_DATA_HEALTH_TIMEOUT:-300} ))
while :; do
    pg=$(health flagship-postgres)
    if [ "$pg" = "healthy" ]; then
        echo "flagship: core store healthy (pg=$pg)"
        break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "flagship: timeout waiting for the core store (pg=$pg)"
        compose ps || true
        exit 1
    fi
    echo "flagship: waiting (pg=$pg)"
    sleep 3
done

date -u +%Y-%m-%dT%H:%M:%SZ > "$READY_MARKER"
echo "flagship: data layer ready"

# Optional services: Postgres is up and stays up whatever happens here.
echo "flagship: starting optional services"
if compose up -d --remove-orphans; then
    echo "flagship: optional services started"
else
    echo "flagship: WARNING: some optional services failed to start (Postgres unaffected)"
    compose ps || true
fi
exit 0
