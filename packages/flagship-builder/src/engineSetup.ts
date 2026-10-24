/**
 * What a new box installs and writes for the architecture v2 path
 * (docs/architecture-v2/engine-and-rust-path.md): Podman in place of Docker, and the box switch
 * with the Rust path on. The daemon reads the switch at every start (server-daemon
 * engine/engine.ts); an existing box has no switch file and keeps what it had.
 */

/** Debian 13 packages for the engine. docker-compose is only the `podman compose` provider. */
export const ENGINE_APT_PACKAGES = "podman netavark aardvark-dns crun conmon catatonit docker-compose nftables zstd";

/** Commands a prebuilt appliance must already have. */
export const ENGINE_REQUIRED_COMMANDS = "podman nft";

export const NEW_BOX_ARCH_V2_JSON = '{"version":1,"rust":"on","engine":"podman","source":"new-box"}';

export const ENGINE_SETUP_BLOCK = `# Architecture v2 on a new box: Podman runs the apps, keyd/broker/core run from the release's
# Rust binaries (each falls back to its TS path on its own; engine-and-rust-path.md).
mkdir -p /var/lib/flagship /etc/containers/containers.conf.d
cat > /var/lib/flagship/arch-v2.json <<'FLAGSHIP_ARCH_V2'
${NEW_BOX_ARCH_V2_JSON}
FLAGSHIP_ARCH_V2
chmod 644 /var/lib/flagship/arch-v2.json
echo podman > /var/lib/flagship/engine-active
cat > /etc/containers/containers.conf.d/40-flagship-compose.conf <<'FLAGSHIP_COMPOSE'
# The data services' compose file runs through docker-compose against Podman's root-only socket.
[engine]
compose_providers = ["/usr/bin/docker-compose"]
compose_warning_logs = false
FLAGSHIP_COMPOSE
mkdir -p /etc/systemd/system/sockets.target.wants
ln -sf /usr/lib/systemd/system/podman.socket /etc/systemd/system/sockets.target.wants/podman.socket
`;
