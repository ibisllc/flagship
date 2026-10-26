/**
 * What a new box installs and writes for its container stack. `release/box-release.json`
 * `newBoxStack` picks it per release (the release gym decides, owner 2026-10-24):
 *   arch-v2  Podman in place of Docker and the box switch with the Rust path on
 *            (docs/architecture-v2/engine-and-rust-path.md);
 *   classic  Docker and the TS keyd/privd, as boxes ran before architecture v2.
 * The daemon reads the switch at every start (server-daemon engine/engine.ts); an existing box
 * has no switch file and keeps what it had.
 */
import { BOX_RELEASE } from "./boxReleaseConfig.js";

export type BoxStack = "arch-v2" | "classic";

/**
 * Debian 13 packages for the engine. docker-compose is only the `podman compose` provider. `iptables` is not in a minimal
 * Debian 13: the egress firewall (server-daemon egress/firewall.ts) writes its chains with iptables-restore, and without
 * the binary every app install failed with "its internet firewall isn't running: No such file or directory".
 */
export const ENGINE_APT_PACKAGES = "podman netavark aardvark-dns crun conmon catatonit docker-compose nftables iptables zstd";

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

/** Debian packages for the classic engine. Debian 13 splits the CLI out of docker.io. */
export const CLASSIC_APT_PACKAGES = "docker.io docker-cli docker-compose apparmor";

export const CLASSIC_REQUIRED_COMMANDS = "docker";

export const CLASSIC_SETUP_BLOCK = `# Classic stack: Docker runs the apps, keyd/privd run from the release's TS. No arch-v2 switch file.
mkdir -p /etc/systemd/system/multi-user.target.wants
ln -sf /usr/lib/systemd/system/docker.service /etc/systemd/system/multi-user.target.wants/docker.service
ln -sf /usr/lib/systemd/system/containerd.service /etc/systemd/system/multi-user.target.wants/containerd.service
`;

export const NEW_BOX_STACK: BoxStack = BOX_RELEASE.newBoxStack;

export function stackSetup(stack: BoxStack = NEW_BOX_STACK): { apt: string; required: string; block: string } {
  return stack === "classic"
    ? { apt: CLASSIC_APT_PACKAGES, required: CLASSIC_REQUIRED_COMMANDS, block: CLASSIC_SETUP_BLOCK }
    : { apt: ENGINE_APT_PACKAGES, required: ENGINE_REQUIRED_COMMANDS, block: ENGINE_SETUP_BLOCK };
}
