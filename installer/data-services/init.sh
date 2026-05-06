#!/bin/sh
# Initialize the unified data-layer on a fresh Flagship box.
#
# Idempotent: re-running is safe — existing secrets are kept, missing
# ones are filled in. Compose will not destroy data volumes on
# subsequent invocations.
#
# Steps:
#   1. Ensure /var/flagship/{data,secrets} exist with strict perms.
#   2. Generate random admin credentials (postgres, minio, redis) if
#      the secrets file doesn't already exist.
#   3. Bring the compose stack up (postgres + minio + redis + adminer).
#   4. Wait for healthchecks before exiting.
#
# Compose lives at /opt/flagship/installer/data-services/docker-compose.yml
# (copied there by install.sh from the cloned repo).

set -eu

LOG=/var/log/flagship-data-services-init.log
mkdir -p /var/log
exec >>"$LOG" 2>&1
date

DATA_DIR=/var/flagship/data
SECRETS_DIR=/var/flagship
SECRETS_FILE="$SECRETS_DIR/data-services.env"
COMPOSE=/opt/flagship/installer/data-services/docker-compose.yml

mkdir -p "$DATA_DIR/postgres" "$DATA_DIR/minio" "$DATA_DIR/redis" "$DATA_DIR/forgejo" \
         "$DATA_DIR/chromium/profile"
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
ensure_literal MINIO_ROOT_USER flagship_root
ensure_var MINIO_ROOT_PASSWORD
ensure_var REDIS_ADMIN_PASSWORD

echo "flagship: data-services secrets ensured at $SECRETS_FILE"

if [ ! -f "$COMPOSE" ]; then
    echo "flagship: missing $COMPOSE — install.sh should have copied it"
    exit 1
fi

# MinIO admin operations (service-account create/drop, policy attach)
# require the `mc` CLI — the `minio` npm SDK doesn't expose those
# endpoints. Install once into /usr/local/bin if not already present.
if [ ! -x /usr/local/bin/mc ]; then
    echo "flagship: installing mc CLI"
    curl -fsSL -o /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/mc
    chmod +x /usr/local/bin/mc
fi

echo "flagship: starting compose stack"
docker compose -f "$COMPOSE" --env-file "$SECRETS_FILE" up -d

echo "flagship: waiting for healthchecks"
deadline=$(( $(date +%s) + 120 ))
while :; do
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
        echo "flagship: timeout waiting for data services to become healthy"
        docker compose -f "$COMPOSE" --env-file "$SECRETS_FILE" ps
        exit 1
    fi
    pg=$(docker inspect -f '{{.State.Health.Status}}' flagship-postgres 2>/dev/null || echo starting)
    mn=$(docker inspect -f '{{.State.Health.Status}}' flagship-minio 2>/dev/null || echo starting)
    rd=$(docker inspect -f '{{.State.Health.Status}}' flagship-redis 2>/dev/null || echo starting)
    fg=$(docker inspect -f '{{.State.Health.Status}}' flagship-forgejo 2>/dev/null || echo starting)
    cr=$(docker inspect -f '{{.State.Health.Status}}' flagship-chromium 2>/dev/null || echo starting)
    if [ "$pg" = "healthy" ] && [ "$mn" = "healthy" ] && [ "$rd" = "healthy" ] \
       && [ "$fg" = "healthy" ] && [ "$cr" = "healthy" ]; then
        echo "flagship: data services healthy (pg=$pg minio=$mn redis=$rd forgejo=$fg chromium=$cr)"
        break
    fi
    echo "flagship: waiting (pg=$pg minio=$mn redis=$rd forgejo=$fg chromium=$cr)"
    sleep 3
done

echo "flagship: data layer ready"
