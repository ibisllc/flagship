#!/usr/bin/env -S npx tsx
/**
 * The gym relay mesh's third relay, `gym-c`: the Rust relay on an UpCloud VM (docs/architecture-v2/relay-mesh.md
 * §14.1, docs/runbooks/relay-mesh.md "Gym"). Wrapped by scripts/gym-relay-c.sh; see there for the commands.
 *
 * The VM carries the gym label (flagship-env=gym); the fleet sweep keeps it (title `gym-relay-c`) unless
 * `npx tsx tools/live-e2e/sweep-cli.ts --destroy --include-relays`, so gym runs don't tear the mesh down. Layout on the VM:
 *   :443   raw TCP straight to the relay's SNI router (no PROXY header, as on Fly)
 *   :8443  Caddy, TLS for gym-c.tunnel.<apex> and tunnel.<apex> (Cloudflare DNS-01) → the relay hub on 127.0.0.1:3000
 *   :8444  Caddy layer4, TLS → PROXY v2 → the relay's address echo on 127.0.0.1:3001 (Fly's proxy_proto twin)
 *   nftables lets in only 22, 443, 8443 and 8444; chrony keeps the clock (mesh checks allow 60 s).
 *
 * Local files (never printed, pushed over ssh only):
 *   ~/.config/flagship/gym-relay-c.seed        the relay key seed (node scripts/relay-key.mjs new <file>)
 *   ~/.config/flagship/gym-relay-c-cf-token    Cloudflare token, Zone.DNS:Edit on flagship.services, for Caddy's
 *                                              DNS-01 (falls back to ~/.config/flagship/gym-dns-token)
 *   GYM_USAGE_REPORT_SECRET, else the gym secrets file (GYM_SECRETS_FILE, default <main checkout>/.gym-secrets.env)
 *   ~/.config/flagship/upcloud-token           the UpCloud API token (lib/upcloudVm.ts)
 * State: ~/.config/flagship/gym-relay-c/state.json (+ its ssh key), so `down` destroys exactly this VM.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDebianVm, destroyVm, run, scp, ssh, type Vm } from "./lib/upcloudVm.js";
import { relayName, tunnelName } from "./lib/meshDns.js";
import { RELAY_C_STATE, gymMeshDns } from "./gym-mesh-dns.js";

export const RELAY_ID = "gym-c";
const CONF = join(homedir(), ".config/flagship");
const APEX = process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services";
const CONTROL = process.env.GYM_LIVE_CONTROL_APEX || "gym.flagshipserver.com";
const REPO = resolve(import.meta.dirname, "../..");
const HUB_PORT = 3000;
const ECHO_PORT = 3001;
const CADDY_URL =
  "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com%2Fcaddy-dns%2Fcloudflare&p=github.com%2Fmholt%2Fcaddy-l4";

interface State extends Vm {
  commit: string;
  createdAt: string;
}

const log = (s: string) => console.log(`[gym-c] ${s}`);

/** `MAINTAINER_PINNED_MANDATE_HASH` of a source tree (the gym worktree's is the gym chain's pin). */
export function maintainerPin(maintainerCaTs: string): string {
  const m = maintainerCaTs.match(/MAINTAINER_PINNED_MANDATE_HASH\s*=\s*"([0-9a-f]{64})"/);
  if (!m) throw new Error("no MAINTAINER_PINNED_MANDATE_HASH in packages/protocol/src/maintainerCa.ts");
  return m[1]!;
}

export interface RelayEnvInput {
  seedHex: string;
  logPub: string;
  usageSecret: string;
  pin: string;
  apex: string;
  control: string;
}

/** /etc/flagship-relay.env: the Rust relay as gym-c, mesh on (relay-mesh.md §15.7). */
export function relayEnvFile(i: RelayEnvInput): string {
  for (const [k, v] of [["seed", i.seedHex], ["log key", i.logPub], ["pin", i.pin]] as const) {
    if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`the ${k} must be 64 lowercase hex`);
  }
  if (!i.usageSecret || /\s/.test(i.usageSecret)) throw new Error("USAGE_REPORT_SECRET is empty or has whitespace");
  return [
    `PORT=${HUB_PORT}`,
    "TUNNEL_TCP_PORT=443",
    `RELAY_ECHO_PORT=${ECHO_PORT}`,
    "HOST=0.0.0.0",
    `FLAGSHIP_SERVICES_APEX=${i.apex}`,
    `FLAGSHIP_COM_BASE_URL=https://${i.control}`,
    "FLAGSHIP_MESH=on",
    `FLAGSHIP_RELAY_ID=${RELAY_ID}`,
    "FLAGSHIP_RELAY_KIND=full",
    `FLAGSHIP_RELAY_KEY_SEED=${i.seedHex}`,
    `FLAGSHIP_RELAY_LOG_PUB=${i.logPub}`,
    `FLAGSHIP_RELAY_FEED_URL=https://feed.${i.control}/v1`,
    "FLAGSHIP_RELAY_MAINTAINERS_DIR=/opt/flagship-relay/.maintainers",
    `FLAGSHIP_RELAY_MAINTAINER_PIN=${i.pin}`,
    `USAGE_REPORT_SECRET=${i.usageSecret}`,
    "FLAGSHIP_DRAIN_GRACE_MS=20000",
    // Gym only (§15.7): the live relay-mesh group watches a rebalance and a co-locate move within one run.
    "FLAGSHIP_MESH_REBALANCE_MS=60000",
    "FLAGSHIP_MESH_MIN_MOVE_MS=30000",
    "",
  ].join("\n");
}

/** Caddy: TLS for the direct and balanced names on :8443 (to the hub), TLS + PROXY v2 on :8444 (to the echo). */
export function caddyfile(apex: string): string {
  return `{
\tauto_https disable_redirects
\thttp_port 8081
\tlayer4 {
\t\t:8444 {
\t\t\troute {
\t\t\t\ttls
\t\t\t\tproxy {
\t\t\t\t\tproxy_protocol v2
\t\t\t\t\tupstream 127.0.0.1:${ECHO_PORT}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}

${relayName(RELAY_ID, apex)}:8443, ${tunnelName(apex)}:8443 {
\ttls {
\t\tdns cloudflare {env.CF_API_TOKEN}
\t}
\treverse_proxy 127.0.0.1:${HUB_PORT}
}
`;
}

const RELAY_UNIT = `[Unit]
Description=Flagship relay gym-c (relay mesh, gym)
After=network-online.target
Wants=network-online.target

[Service]
User=relay
EnvironmentFile=/etc/flagship-relay.env
WorkingDirectory=/opt/flagship-relay
ExecStart=/usr/local/bin/flagship-relay
# systemctl stop sends SIGTERM: the relay drains (retire hints, DRAIN_NOTICE, then closes) within its grace.
KillSignal=SIGTERM
TimeoutStopSec=60
Restart=on-failure
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
`;

const CADDY_UNIT = `[Unit]
Description=Caddy for gym-c (TLS on :8443 and :8444)
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
EnvironmentFile=/etc/caddy/env
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy/.config
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

const NFT = `flush ruleset
table inet filter {
\tchain input {
\t\ttype filter hook input priority 0; policy drop;
\t\tct state established,related accept
\t\tiif lo accept
\t\tip protocol icmp accept
\t\tip6 nexthdr icmpv6 accept
\t\ttcp dport { 22, 443, 8443, 8444 } accept
\t}
}
`;

/** The provisioning script run as root on the VM (idempotent: `up` again rebuilds and restarts). */
export function provisionScript(): string {
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq build-essential pkg-config curl ca-certificates chrony nftables >/dev/null
systemctl enable --now chrony
install -m 644 /root/gym-c/nftables.conf /etc/nftables.conf && systemctl enable nftables && systemctl restart nftables
rm -rf /opt/relay-src && mkdir -p /opt/relay-src && tar -xzf /root/gym-c/relay-src.tgz -C /opt/relay-src
command -v rustup >/dev/null 2>&1 || [ -x /root/.cargo/bin/rustup ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
. /root/.cargo/env
cd /opt/relay-src/rust && cargo build -q --release --locked -p flagship-relay --bin flagship-relay
install -D -m 755 target/release/flagship-relay /usr/local/bin/flagship-relay.new
id relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin relay
mkdir -p /opt/flagship-relay && rm -rf /opt/flagship-relay/.maintainers && cp -r /opt/relay-src/.maintainers /opt/flagship-relay/
install -m 640 -o root -g relay /root/gym-c/relay.env /etc/flagship-relay.env
install -m 644 /root/gym-c/flagship-relay.service /etc/systemd/system/flagship-relay.service
[ -x /usr/local/bin/caddy ] || { curl -fsSL -o /usr/local/bin/caddy.new '${CADDY_URL}' && chmod 755 /usr/local/bin/caddy.new && mv /usr/local/bin/caddy.new /usr/local/bin/caddy; }
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy
install -m 644 /root/gym-c/Caddyfile /etc/caddy/Caddyfile
install -m 640 -o root -g caddy /root/gym-c/caddy.env /etc/caddy/env
install -m 644 /root/gym-c/caddy.service /etc/systemd/system/caddy.service
rm -f /root/gym-c/relay.env /root/gym-c/caddy.env
systemctl daemon-reload
systemctl stop flagship-relay 2>/dev/null || true
mv /usr/local/bin/flagship-relay.new /usr/local/bin/flagship-relay
systemctl enable --now flagship-relay caddy
systemctl restart caddy
sleep 3
systemctl is-active flagship-relay caddy
`;
}

function readState(): State | null {
  return existsSync(RELAY_C_STATE) ? (JSON.parse(readFileSync(RELAY_C_STATE, "utf8")) as State) : null;
}

function secretFile(names: string[], what: string): string {
  for (const n of names) {
    const f = join(CONF, n);
    if (existsSync(f)) return readFileSync(f, "utf8").trim();
  }
  throw new Error(`no ${what}: write ${join(CONF, names[0]!)}`);
}

function usageSecret(): string {
  if (process.env.GYM_USAGE_REPORT_SECRET) return process.env.GYM_USAGE_REPORT_SECRET;
  let main = REPO;
  try {
    main = dirname(execFileSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  } catch {
    /* the repo itself */
  }
  const file = process.env.GYM_SECRETS_FILE || join(main, ".gym-secrets.env");
  const m = existsSync(file) ? readFileSync(file, "utf8").match(/^GYM_USAGE_REPORT_SECRET=['"]?([^'"\n]+)['"]?$/m) : null;
  if (!m) throw new Error(`no gym USAGE_REPORT_SECRET: set GYM_USAGE_REPORT_SECRET or add it to ${file}`);
  return m[1]!;
}

/**
 * The tree the relay is built from: the gym worktree gym-refresh deploys gym-a from (same code, and its `.maintainers/`
 * holds the gym-root mandate the gym pin names). A tree without the mesh, or without the gym chain, would never turn
 * ready, so it is refused rather than replaced by this checkout.
 */
export function sourceTree(): string {
  const wt = process.env.GYM_RELAY_C_SRC || process.env.GYM_WORKTREE || join(homedir(), ".cache/flagship/gym-worktree");
  if (!existsSync(join(wt, "rust/crates/flagship-relay/src/mesh"))) {
    throw new Error(`${wt} has no relay mesh code: run \`GYM_BASE_REF=origin/release/0.3 bash scripts/gym-refresh.sh\` (or set GYM_RELAY_C_SRC to a gym tree with the mesh)`);
  }
  if (!existsSync(join(wt, ".maintainers/tracks/ca/mandates/gym-root.json")) && !process.env.GYM_RELAY_C_PIN) {
    throw new Error(`${wt} has no gym CA chain (.maintainers/tracks/ca/mandates/gym-root.json): build from the gym branch, or set GYM_RELAY_C_PIN for this tree's chain`);
  }
  return wt;
}

async function provision(vm: Vm, src: string): Promise<string> {
  const commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  log(`building the relay from ${src} at ${commit.slice(0, 12)}`);
  const logRes = await fetch(`https://${CONTROL}/api/serving/revocation-key`);
  const logPub = String(((await logRes.json().catch(() => ({}))) as { publicKey?: string }).publicKey ?? "").toLowerCase();
  const pin = process.env.GYM_RELAY_C_PIN || maintainerPin(readFileSync(join(src, "packages/protocol/src/maintainerCa.ts"), "utf8"));
  const env = relayEnvFile({ seedHex: secretFile(["gym-relay-c.seed"], "relay key seed").toLowerCase(), logPub, usageSecret: usageSecret(), pin, apex: APEX, control: CONTROL });
  const cfToken = secretFile(["gym-relay-c-cf-token", "gym-dns-token"], "Cloudflare DNS token for Caddy");
  const stage = join(dirname(RELAY_C_STATE), "stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const tar = await run("tar", ["--exclude=rust/target", "-czf", join(stage, "relay-src.tgz"), "-C", src, "rust", ".maintainers"]);
    if (tar.code !== 0) throw new Error(`tar: ${tar.stderr.slice(0, 200)}`);
    writeFileSync(join(stage, "relay.env"), env, { mode: 0o600 });
    writeFileSync(join(stage, "caddy.env"), `CF_API_TOKEN=${cfToken}\n`, { mode: 0o600 });
    writeFileSync(join(stage, "Caddyfile"), caddyfile(APEX));
    writeFileSync(join(stage, "flagship-relay.service"), RELAY_UNIT);
    writeFileSync(join(stage, "caddy.service"), CADDY_UNIT);
    writeFileSync(join(stage, "nftables.conf"), NFT);
    writeFileSync(join(stage, "provision.sh"), provisionScript());
    if ((await ssh(vm, "mkdir -p -m 700 /root/gym-c")).code !== 0) throw new Error("ssh to the VM failed");
    for (const f of ["relay-src.tgz", "relay.env", "caddy.env", "Caddyfile", "flagship-relay.service", "caddy.service", "nftables.conf", "provision.sh"]) {
      const r = await scp(vm, join(stage, f), `/root/gym-c/${f}`);
      if (r.code !== 0) throw new Error(`scp ${f}: ${r.stderr.slice(0, 200)}`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  log("provisioning (apt, rustup, cargo build --release, Caddy); a first run takes several minutes");
  const p = await ssh(vm, "bash /root/gym-c/provision.sh");
  if (p.code !== 0) throw new Error(`provisioning failed: ${(p.stderr || p.stdout).slice(-600)}`);
  log(p.stdout.trim().split("\n").slice(-2).join(" "));
  return commit;
}

async function health(): Promise<string> {
  try {
    const r = await fetch(`https://${relayName(RELAY_ID, APEX)}:8443/api/health`, { signal: AbortSignal.timeout(10_000) });
    const b = (await r.json().catch(() => null)) as { mesh?: unknown } | null;
    return `${r.status} ${JSON.stringify(b?.mesh ?? null)}`;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function main(argv: string[]): Promise<number> {
  const [cmd = "help"] = argv;
  const apply = argv.includes("--apply");
  const dry = argv.includes("--dry-run");
  const state = readState();
  switch (cmd) {
    case "up": {
      let src: string;
      try {
        src = sourceTree();
      } catch (e) {
        if (!dry) throw e;
        src = `(refused: ${(e as Error).message})`;
      }
      if (dry) {
        log(`DRY-RUN: ${state ? `re-provision VM ${state.uuid} (${state.ip})` : "create an UpCloud Debian 13 VM `gym-relay-c` (label flagship-env=gym)"}`);
        log(`DRY-RUN: build the Rust relay from ${src}, install it as gym-c with Caddy on :8443/:8444, then run \`gym-relay-c.sh dns --apply\` yourself`);
        return 0;
      }
      let vm: Vm | null = state;
      if (!vm) {
        mkdirSync(dirname(RELAY_C_STATE), { recursive: true, mode: 0o700 });
        vm = await createDebianVm({ dir: dirname(RELAY_C_STATE), title: "gym-relay-c", zone: process.env.GYM_RELAY_C_ZONE || "de-fra1", log });
        writeFileSync(RELAY_C_STATE, JSON.stringify({ ...vm, commit: "", createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      }
      const commit = await provision(vm, src);
      writeFileSync(RELAY_C_STATE, JSON.stringify({ ...vm, commit, createdAt: state?.createdAt ?? new Date().toISOString() }, null, 2), { mode: 0o600 });
      log(`gym-c is up at ${vm.ip}. Next: bash scripts/gym-relay-c.sh dns --apply (then Caddy gets its certificate)`);
      return 0;
    }
    case "status": {
      if (!state) {
        log(`no state at ${RELAY_C_STATE}: gym-c is not up (a leftover VM is found by: npx tsx tools/live-e2e/sweep-cli.ts)`);
        return 1;
      }
      log(`VM ${state.uuid} at ${state.ip}, relay built from ${state.commit.slice(0, 12) || "?"} on ${state.createdAt}`);
      const s = await ssh(state, "systemctl is-active flagship-relay caddy | paste -sd ' '", 30_000);
      log(`services: ${s.code === 0 || s.stdout ? s.stdout.trim() : `ssh failed (${s.stderr.trim().slice(0, 80)})`}`);
      log(`health: ${await health()}`);
      return 0;
    }
    case "drain":
    case "start": {
      if (!state) throw new Error("gym-c is not up (no state)");
      const r = await ssh(state, cmd === "drain" ? "systemctl stop flagship-relay" : "systemctl start flagship-relay", 120_000);
      if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr.slice(0, 200)}`);
      log(cmd === "drain" ? "relay stopped (SIGTERM: it drained its tunnels within its grace)" : "relay started");
      return 0;
    }
    case "dns":
      await gymMeshDns({ apply, only: [RELAY_ID], log: (s) => log(s) });
      return 0;
    case "down": {
      if (!state) {
        log("no state: nothing to destroy (a leftover gym VM is reaped by: npx tsx tools/live-e2e/sweep-cli.ts --destroy)");
        return 0;
      }
      if (dry) {
        log(`DRY-RUN: remove ${relayName(RELAY_ID, APEX)} from DNS, destroy VM ${state.uuid} (${state.ip}), delete ${RELAY_C_STATE}`);
        return 0;
      }
      try {
        await gymMeshDns({ apply: true, remove: [RELAY_ID], log: (s) => log(s) });
      } catch (e) {
        log(`DNS not removed (${(e as Error).message}); remove ${relayName(RELAY_ID, APEX)} by hand`);
      }
      await destroyVm(state, log);
      rmSync(RELAY_C_STATE, { force: true });
      log(`gone. Retire it on the gym if it is not coming back: FLAGSHIP_BASE_URL=https://${CONTROL} npm run relays -- retire ${RELAY_ID}`);
      return 0;
    }
    default:
      console.log("usage: bash scripts/gym-relay-c.sh up [--dry-run] | status | drain | start | dns [--apply] | down [--dry-run]");
      return cmd === "help" || cmd === "-h" || cmd === "--help" ? 0 : 2;
  }
}

if (process.argv[1]?.endsWith("relay-c-cli.ts")) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`[gym-c] ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
