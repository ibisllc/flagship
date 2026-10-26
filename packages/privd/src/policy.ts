/**
 * What the broker will and will not do. Pure: every function maps request arguments to an exact
 * argv for a fixed binary or throws `PrivdError`. Nothing is passed to a shell, and a value the
 * validator does not recognise is a refusal, not a pass-through.
 */
import { ENGINE_BINARY, podmanArgv, validatePodmanArgs, type EngineKind } from "./podman.js";
import { PrivdError, type Op } from "./wire.js";

export interface Exec {
  file: string;
  args: string[];
  /** Kill after this long. */
  timeoutMs: number;
  /** Text for the child's stdin, if any. */
  input?: string;
  /** A file (already checked by the caller) streamed to the child's stdin. */
  stdinFile?: string;
  /** A new file (already checked) the child's stdout is streamed into. */
  stdoutFile?: string;
  /** Extra environment for the child (names from a closed list). */
  env?: Record<string, string>;
  /**
   * Daemon files the broker copies into its own folder before the command starts, so what the
   * command checks is what it then uses (a release the daemon downloaded).
   */
  copyIn?: Array<{ from: string; to: string }>;
}

/** The broker's own folder: root only. */
export const PRIVD_STATE_DIR = "/var/lib/flagship-privd";

const UNITS = new Set(["flagship-daemon.service", "docker.service", "flagship-data-services.service"]);

/** Where the unprivileged daemon keeps files the broker may read or write for it. */
export const DAEMON_TRANSFER_ROOTS = ["/var/flagship/", "/var/tmp/.flagship-"];
/** Never under any of the roots above, whatever a path says. */
const NEVER = [/^\/var\/flagship\/identity(\/|$)/, /^\/var\/flagship\/keyd(\/|$)/, /^\/var\/flagship\/.*\.(hex|pem|key)$/s];

/** The daemon's own runtime folder (RuntimeDirectory=flagship-daemon). */
export const DAEMON_RUNTIME_DIR = "/run/flagship-daemon";

export function powerExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["action"]);
  if (args.action !== "poweroff" && args.action !== "reboot") throw new PrivdError("bad-request", "action must be poweroff or reboot");
  return { file: "/usr/bin/systemctl", args: [args.action], timeoutMs: 15_000 };
}

export function restartExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["unit"]);
  if (typeof args.unit !== "string" || !UNITS.has(args.unit)) throw new PrivdError("forbidden", "that unit cannot be restarted from here");
  return { file: "/usr/bin/systemctl", args: ["restart", args.unit], timeoutMs: 60_000 };
}

// ── docker ────────────────────────────────────────────────────────────────

const SIMPLE_SUBCOMMANDS = new Set(["run", "create", "start", "stop", "kill", "rm", "restart", "ps", "inspect", "logs", "pull", "build", "info", "version", "pause", "unpause", "rmi", "tag", "exec"]);
// `save` and `load` move whole images; they go through `docker.file`, never over the socket.
const FILE_SUBCOMMANDS = new Set(["save", "load", "exec", "run"]);
const SUB_SUBCOMMANDS: Record<string, Set<string>> = {
  image: new Set(["inspect", "ls", "rm", "prune", "tag"]),
  network: new Set(["create", "inspect", "ls", "rm", "connect", "disconnect"]),
  volume: new Set(["create", "inspect", "ls", "rm", "prune"]),
  system: new Set(["df"]),
};
/** The box's data-service containers, the only ones `docker exec` reaches, and what may run in them. */
const EXEC_CONTAINERS = new Set(["flagship-postgres", "flagship-forgejo"]);
/** An app's dedicated database (dataLayer/dedicated.ts dedicatedContainer). */
const DEDICATED_PG_CONTAINER = /^flagship-pgd-[0-9a-f]{24}$/;
const EXEC_COMMANDS = new Set(["pg_dump", "pg_dumpall", "pg_restore", "psql", "pg_isready", "sqlite3", "tar", "rm", "forgejo"]);
const EXEC_ENV = /^PGPASSWORD(=[^\u0000\n]{0,512})?$/;
const COMPOSE_FILE = "/opt/flagship/installer/data-services/docker-compose.yml";
const COMPOSE_ENV = "/var/flagship/data-services.env";
const COMPOSE_SUB = new Set(["up", "down", "ps", "pull", "logs", "start", "stop", "restart"]);
const FILES_MOUNT_RE = /^type=volume,src=flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128},dst=\/data(,readonly)?$/;
const RESOLV_MOUNT_RE = /^type=bind,src=\/run\/(?:flagship-daemon\/)?flagship-resolv-[a-z0-9-]+\.conf,dst=\/etc\/resolv\.conf,readonly$/;
const BUILD_CONTEXT_RE = /^\/var\/flagship\/data\/app-clones\/(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+)*$/;

/** Flags that give a container the host, in either `--flag value` or `--flag=value` form. */
const FORBIDDEN_FLAGS = [
  "--privileged", "--cap-add", "--device", "--device-cgroup-rule", "--pid", "--ipc", "--uts", "--userns", "--cgroupns", "--volumes-from",
  "--security-opt", "--sysctl", "--group-add", "--init-path", "--mount-propagation", "--gpus", "--cgroup-parent",
  // The docker client runs as root here: a flag that makes it read or write a host file would do so as root.
  "--env-file", "--label-file", "--cidfile", "--iidfile", "--metadata-file", "--output", "--secret", "--ssh", "--build-context", "--cache-to", "--cache-from",
];
/** What a build may say besides its tag and context (serviceRunner.ts dockerBuildArgs). */
const BUILD_FLAGS = new Set(["--network", "--add-host", "--memory", "--cpu-period", "--cpu-quota", "--ulimit", "-t", "--tag", "--label"]);
/** A bind volume is only ever an app's own disk image (appQuota/loopVolumes.ts createBindVolume). */
const BIND_DEVICE = /^device=\/var\/lib\/flagship-files\/(flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128}|flagship-pgdata-[0-9a-f]{24})\/data$/;

/**
 * The engine's binary and argv for a checked docker-form request: Docker as written, or Podman's
 * translation held to the docker rules again (when `dockerRules`) and to Podman's own.
 */
function forEngine(a: string[], engine: EngineKind, dockerRules: boolean, gpu: GpuClaimReader = NO_GPU_CLAIMS): { file: string; args: string[] } {
  if (engine !== "podman") return { file: ENGINE_BINARY.docker, args: a };
  const mapped = podmanArgv(a);
  if (dockerRules) validateDockerArgs(mapped, gpu);
  validatePodmanArgs(mapped);
  return { file: ENGINE_BINARY.podman, args: mapped };
}

export function dockerExec(args: Record<string, unknown>, engine: EngineKind = "docker", gpu: GpuClaimReader = NO_GPU_CLAIMS): Exec {
  noExtra(args, ["argv", "stdin", "env"]);
  const argv = args.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256 || !argv.every((a) => typeof a === "string" && a.length <= 4096 && !a.includes("\u0000"))) {
    throw new PrivdError("bad-request", "argv must be a short list of strings");
  }
  const a = argv as string[];
  const sub = a[0]!;
  if (sub === "compose") {
    const c = composeExec(a);
    return { ...c, ...forEngine(c.args, engine, false) };
  }
  const subs = Object.hasOwn(SUB_SUBCOMMANDS, sub) ? SUB_SUBCOMMANDS[sub] : undefined;
  if (subs) {
    if (!subs.has(a[1] ?? "")) throw new PrivdError("forbidden", `docker ${sub} ${a[1] ?? ""} is not allowed`);
  } else if (!SIMPLE_SUBCOMMANDS.has(sub)) {
    throw new PrivdError("forbidden", `docker ${sub} is not allowed`);
  }
  if (sub === "exec") validateDockerExec(a);
  if (sub === "build") validateDockerBuild(a);
  if (sub === "volume" && a[1] === "create") validateVolumeCreate(a);
  if (sub === "network" && a[1] === "create") validateNetworkCreate(a);
  validateDockerArgs(a, gpu);
  const input = typeof args.stdin === "string" ? args.stdin : undefined;
  const env = clientEnv(args.env);
  return {
    ...forEngine(a, engine, true, gpu),
    timeoutMs: sub === "build" ? 20 * 60_000 : 5 * 60_000,
    ...(input !== undefined ? { input } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/** What the docker client may be handed in its environment: the database settings a `-e NAME` forwards, nothing that steers docker itself. */
const CLIENT_ENV = new Set(["PGPASSWORD", "PGOPTIONS"]);
function clientEnv(v: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (v === undefined) return env;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new PrivdError("bad-request", "env must be an object");
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!CLIENT_ENV.has(k) || typeof x !== "string" || x.length > 512 || x.includes("\u0000")) throw new PrivdError("forbidden", "env may carry only PGPASSWORD and PGOPTIONS");
    env[k] = x;
  }
  return env;
}

/** Only the flags the daemon's builds use, and a context under the app clones. */
function validateDockerBuild(a: readonly string[]): void {
  for (let i = 1; i < a.length - 1; i++) {
    const f = a[i]!;
    const name = f.split("=")[0]!;
    if (!BUILD_FLAGS.has(name)) throw new PrivdError("forbidden", `build flag ${name} is not allowed`);
    if (!f.includes("=")) i++;
  }
  if (a.length < 2 || !BUILD_CONTEXT_RE.test(a[a.length - 1]!)) throw new PrivdError("forbidden", "a build's context is an app clone");
}

/** A plain named volume, or a bind of one app's own disk image under its own name: never a host path. */
function validateVolumeCreate(a: readonly string[]): void {
  const opts: string[] = [];
  let driver: string | null = null;
  let name: string | null = null;
  for (let i = 2; i < a.length; i++) {
    const f = a[i]!;
    const eq = f.indexOf("=");
    const flag = f.startsWith("-") ? (eq > 0 ? f.slice(0, eq) : f) : null;
    const value = () => (eq > 0 ? f.slice(eq + 1) : a[++i] ?? "");
    if (flag === "--label" || flag === "-l") value();
    else if (flag === "--driver" || flag === "-d") driver = value();
    else if (flag === "--opt" || flag === "-o") opts.push(value());
    else if (flag === null && name === null) name = f;
    else throw new PrivdError("forbidden", `volume create argument ${f} is not allowed`);
  }
  if (opts.length === 0 && (driver === null || driver === "local")) return;
  const device = opts.map((o) => BIND_DEVICE.exec(o)).find(Boolean);
  const ok = driver === "local" && opts.length === 3 && opts.includes("type=none") && opts.includes("o=bind") && device && device[1] === name;
  if (!ok) throw new PrivdError("forbidden", "a volume binds only its own app's disk image");
}

const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const NETWORK_OPTS = /^com\.docker\.network\.bridge\.(?:name=fs-[a-z0-9-]{1,12}|enable_icc=(?:true|false))$/;

/**
 * A network is a plain bridge, optionally internal, on one of the box's own `fs-` bridges: never a
 * driver (macvlan, ipvlan) or an existing host bridge that would put a container on the host's LAN
 * past the egress fence (networkCreateArgs in the daemon).
 */
function validateNetworkCreate(a: readonly string[]): void {
  let name: string | null = null;
  for (let i = 2; i < a.length; i++) {
    const f = a[i]!;
    const eq = f.indexOf("=");
    const flag = f.startsWith("-") ? (eq > 0 ? f.slice(0, eq) : f) : null;
    const value = () => (eq > 0 ? f.slice(eq + 1) : a[++i] ?? "");
    if (f === "--internal") continue;
    if (flag === "--driver" || flag === "-d") {
      if (value() !== "bridge") throw new PrivdError("forbidden", "a network uses the bridge driver");
      continue;
    }
    if (f === "-o" || f === "--opt") {
      const v = a[++i] ?? "";
      if (!NETWORK_OPTS.test(v)) throw new PrivdError("forbidden", `network option ${v} is not allowed`);
      continue;
    }
    if (flag === "--label") {
      value();
      continue;
    }
    if (flag === null && name === null && NETWORK_NAME.test(f)) {
      name = f;
      continue;
    }
    throw new PrivdError("forbidden", `network create argument ${f} is not allowed`);
  }
  if (name === null) throw new PrivdError("forbidden", "name the network");
}

/**
 * `docker exec` only into the box's own data services, only a dump/restore/query tool, never as root and
 * never privileged: what the daemon's backups and app copies run there.
 */
function validateDockerExec(a: readonly string[]): void {
  let i = 1;
  while (i < a.length && a[i]!.startsWith("-")) {
    const f = a[i]!;
    if (f === "-i") { i++; continue; }
    if (f === "-e") {
      if (!EXEC_ENV.test(a[i + 1] ?? "")) throw new PrivdError("forbidden", "exec may pass only PGPASSWORD");
      i += 2;
      continue;
    }
    throw new PrivdError("forbidden", `exec flag ${f} is not allowed`);
  }
  if (!EXEC_CONTAINERS.has(a[i] ?? "") && !DEDICATED_PG_CONTAINER.test(a[i] ?? "")) throw new PrivdError("forbidden", "exec reaches only the box's data services");
  if (!EXEC_COMMANDS.has(a[i + 1] ?? "")) throw new PrivdError("forbidden", `exec may not run ${a[i + 1] ?? ""}`);
}

/**
 * The same docker rules, with a stream through a file the daemon owns: `save` writes an image into
 * one, `load` reads one, and a dump or archive (`exec`, a helper `run`) goes to or comes from one.
 * The broker opens the files itself (`openForBroker`), so a path is never handed to docker.
 */
export function dockerFileExec(args: Record<string, unknown>, engine: EngineKind = "docker"): Exec {
  noExtra(args, ["argv", "stdinPath", "stdoutPath", "env"]);
  const argv = args.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256 || !argv.every((a) => typeof a === "string" && a.length <= 4096 && !a.includes("\u0000"))) {
    throw new PrivdError("bad-request", "argv must be a short list of strings");
  }
  const a = argv as string[];
  if (!FILE_SUBCOMMANDS.has(a[0]!)) throw new PrivdError("forbidden", `docker ${a[0]} does not stream through a file`);
  if (a[0] === "save" && (a.length !== 2 || !/^[a-z0-9][a-z0-9._/:@-]{0,255}$/.test(a[1]!))) throw new PrivdError("forbidden", "save takes one image");
  if (a[0] === "load" && !(a.length === 2 && a[1] === "-q")) throw new PrivdError("forbidden", "load takes only -q");
  if (a[0] === "exec") validateDockerExec(a);
  validateDockerArgs(a);
  const stdinPath = typeof args.stdinPath === "string" ? transferPath(args.stdinPath) : undefined;
  const stdoutPath = typeof args.stdoutPath === "string" ? transferPath(args.stdoutPath) : undefined;
  if (a[0] === "save" && !stdoutPath) throw new PrivdError("bad-request", "save needs stdoutPath");
  if (a[0] === "load" && !stdinPath) throw new PrivdError("bad-request", "load needs stdinPath");
  const env = clientEnv(args.env);
  return {
    ...forEngine(a, engine, true),
    timeoutMs: 60 * 60_000,
    ...(stdinPath ? { stdinFile: stdinPath } : {}),
    ...(stdoutPath ? { stdoutFile: stdoutPath } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/** A path under the daemon's transfer roots, normalised, never a key file. The broker opens it with O_NOFOLLOW and checks the owner. */
export function transferPath(p: string): string {
  if (!p.startsWith("/") || p.includes("\u0000") || p.length > 1024 || p.split("/").some((c) => c === ".." || c === ".")) throw new PrivdError("forbidden", "bad path");
  if (!DAEMON_TRANSFER_ROOTS.some((r) => p.startsWith(r))) throw new PrivdError("forbidden", "the broker streams only the daemon's own transfer files");
  if (NEVER.some((re) => re.test(p))) throw new PrivdError("forbidden", "that file is never streamed");
  return p;
}

function composeExec(a: string[]): Exec {
  if (a[1] === "version") {
    if (a.length > 4 || a.slice(2).some((x) => !/^(--short|--format|json|\{\{\.Version\}\})$/.test(x))) throw new PrivdError("forbidden", "compose version takes only its format flags");
    return { file: "/usr/bin/docker", args: a, timeoutMs: 30_000 };
  }
  // Only the box's own data-services stack, with its own env file, and a known verb.
  if (a[1] !== "-f" || a[2] !== COMPOSE_FILE) throw new PrivdError("forbidden", "compose may only manage the box's data services");
  let i = 3;
  if (a[i] === "--env-file") {
    if (a[i + 1] !== COMPOSE_ENV) throw new PrivdError("forbidden", "compose env file is fixed");
    i += 2;
  }
  if (!COMPOSE_SUB.has(a[i] ?? "")) throw new PrivdError("forbidden", `compose ${a[i] ?? ""} is not allowed`);
  for (const x of a.slice(i + 1)) if (!/^(-d|-v|-q|--no-color|--remove-orphans|--wait|--format|json|[a-z][a-z0-9_-]{0,63})$/.test(x)) throw new PrivdError("forbidden", `compose argument ${x} is not allowed`);
  return { file: "/usr/bin/docker", args: a, timeoutMs: 10 * 60_000 };
}

// ── docker run / create, read the way the docker CLI reads them ───────────

/**
 * Every flag `docker run` / `docker create` (and Podman's run, for the flags they share) knows, by
 * long name, whether it takes a value, and its one-letter shorthand. The argv is parsed with the
 * CLI's own rules (pflag: `--flag value`, `--flag=value`, `-v value`, `-vVALUE`, `-v=VALUE`, short
 * flags grouped as `-dv VALUE`, flags end at `--` or the image) into one list of (flag, value)
 * pairs, and the policy reads that list: a spelling the CLI would accept cannot slip past it, and
 * a flag this table does not know is refused.
 */
const RUN_BOOL_FLAGS = new Set([
  "detach", "interactive", "tty", "rm", "init", "privileged", "publish-all", "read-only", "no-healthcheck", "oom-kill-disable", "sig-proxy",
  "disable-content-trust", "quiet", "use-api-socket",
]);
const RUN_VALUE_FLAGS = new Set([
  "attach", "add-host", "annotation", "blkio-weight", "blkio-weight-device", "cap-add", "cap-drop", "cgroup-parent", "cgroupns", "cidfile", "cpu-count",
  "cpu-percent", "cpu-period", "cpu-quota", "cpu-rt-period", "cpu-rt-runtime", "cpu-shares", "cpus", "cpuset-cpus", "cpuset-mems", "detach-keys", "device",
  "device-cgroup-rule", "device-read-bps", "device-read-iops", "device-write-bps", "device-write-iops", "dns", "dns-option", "dns-search", "domainname",
  "entrypoint", "env", "env-file", "expose", "gpus", "group-add", "health-cmd", "health-interval", "health-retries", "health-start-interval",
  "health-start-period", "health-timeout", "hostname", "io-maxbandwidth", "io-maxiops", "ip", "ip6", "ipc", "isolation", "kernel-memory", "label",
  "label-file", "link", "link-local-ip", "log-driver", "log-opt", "mac-address", "memory", "memory-reservation", "memory-swap", "memory-swappiness",
  "mount", "name", "network", "network-alias", "oom-score-adj", "pid", "pids-limit", "platform", "publish", "pull", "restart", "runtime",
  "security-opt", "shm-size", "stop-signal", "stop-timeout", "storage-opt", "sysctl", "tmpfs", "ulimit", "user", "userns", "uts", "volume",
  "volume-driver", "volumes-from", "workdir",
]);
/** Second names the CLI gives a flag. */
const RUN_FLAG_ALIASES = new Map([["net", "network"], ["net-alias", "network-alias"], ["dns-opt", "dns-option"]]);
const RUN_SHORTHANDS = new Map([
  ["d", "detach"], ["i", "interactive"], ["t", "tty"], ["P", "publish-all"], ["q", "quiet"], ["a", "attach"], ["c", "cpu-shares"], ["e", "env"],
  ["h", "hostname"], ["l", "label"], ["m", "memory"], ["p", "publish"], ["u", "user"], ["v", "volume"], ["w", "workdir"],
]);
const LONG_FLAG_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface RunFlag {
  /** The flag's long name, without dashes (an alias already resolved). */
  name: string;
  value: string;
}
export interface ParsedRun {
  flags: RunFlag[];
  image: string;
  command: string[];
}

function runFlag(name: string): "bool" | "value" | null {
  if (RUN_BOOL_FLAGS.has(name)) return "bool";
  if (RUN_VALUE_FLAGS.has(name)) return "value";
  return null;
}

/** `docker run|create …` as the CLI parses it; refuses what it cannot classify. */
export function parseRunArgv(a: readonly string[]): ParsedRun {
  const flags: RunFlag[] = [];
  const boolValue = (spelled: string, v: string) => {
    if (v !== "true" && v !== "false") throw new PrivdError("forbidden", `${spelled} takes true or false`);
    return v;
  };
  let i = 1;
  for (; i < a.length; i++) {
    const x = a[i]!;
    if (x === "--") {
      i++;
      break;
    }
    if (!x.startsWith("-") || x === "-") break;
    if (x.startsWith("--")) {
      const body = x.slice(2);
      const eq = body.indexOf("=");
      const spelled = eq >= 0 ? body.slice(0, eq) : body;
      if (!LONG_FLAG_NAME.test(spelled)) throw new PrivdError("forbidden", "a flag the broker cannot read is not allowed");
      const name = RUN_FLAG_ALIASES.get(spelled) ?? spelled;
      const kind = runFlag(name);
      if (kind === null) throw new PrivdError("forbidden", `--${spelled} is not a flag the broker knows`);
      if (kind === "bool") flags.push({ name, value: eq >= 0 ? boolValue(`--${spelled}`, body.slice(eq + 1)) : "true" });
      else if (eq >= 0) flags.push({ name, value: body.slice(eq + 1) });
      else {
        if (i + 1 >= a.length) throw new PrivdError("forbidden", `--${spelled} needs a value`);
        flags.push({ name, value: a[++i]! });
      }
      continue;
    }
    // A group of shorthands: bools until one that takes a value, which takes the rest (or the next argument).
    let j = 1;
    while (j < x.length) {
      const c = x[j]!;
      const name = RUN_SHORTHANDS.get(c);
      if (name === undefined) throw new PrivdError("forbidden", `-${c} is not a flag the broker knows`);
      const kind = runFlag(name)!;
      if (x.length - j > 2 && x[j + 1] === "=") {
        const v = x.slice(j + 2);
        flags.push({ name, value: kind === "bool" ? boolValue(`-${c}`, v) : v });
        break;
      }
      if (kind === "bool") {
        flags.push({ name, value: "true" });
        j++;
        continue;
      }
      if (j + 1 < x.length) flags.push({ name, value: x.slice(j + 1) });
      else {
        if (i + 1 >= a.length) throw new PrivdError("forbidden", `-${c} needs a value`);
        flags.push({ name, value: a[++i]! });
      }
      break;
    }
  }
  if (i >= a.length) throw new PrivdError("forbidden", "name an image");
  return { flags, image: a[i]!, command: a.slice(i + 1) };
}

/** The runtime every app, staging and sandbox container runs under (appSandbox/gvisor.ts GVISOR_RUNTIME). */
export const APP_RUNTIME = "runsc";

/**
 * A GPU allocation flagship-gpud attached for one container (rust/crates/flagship-gpu, attach.rs):
 * the runtime it must run under (`runsc-nvproxy`: runsc with nvproxy; `kata-vfio`: Kata over a VFIO
 * group) and the exact CDI devices the claim journal holds for it. gpud publishes these, root-owned,
 * in /run/flagship-gpu/run-claims.json; the daemon never writes them.
 */
export interface GpuRunClaim {
  allocationId: string;
  appId: string;
  container: string;
  runtime: string;
  devices: string[];
}
export type GpuClaimReader = (allocationId: string) => GpuRunClaim | null;
export const NO_GPU_CLAIMS: GpuClaimReader = () => null;
/** The only runtimes a GPU container may name. */
export const GPU_RUNTIMES = new Set(["runsc-nvproxy", "kata-vfio"]);
const GPU_LABEL = "flagship.gpu.allocation=";
/** A CDI device as gpud names it: an NVIDIA device or MIG partition, or a VFIO group gpud bound. */
const GPU_CDI_DEVICE = /^(?:nvidia\.com\/gpu|flagship\.vfio\/group)=[A-Za-z0-9:._-]{1,32}$/;
/** Run flags that give a container the host, another container, or a host file read or written as root. */
const RUN_FORBIDDEN = new Set([
  "privileged", "cap-add", "device", "device-cgroup-rule", "device-read-bps", "device-read-iops", "device-write-bps", "device-write-iops",
  "blkio-weight-device", "pid", "ipc", "uts", "userns", "cgroupns", "volumes-from", "sysctl", "group-add", "gpus", "cgroup-parent", "env-file",
  "label-file", "cidfile", "volume-driver", "use-api-socket", "annotation", "link", "storage-opt", "log-driver", "log-opt", "isolation",
]);
/** The read-only socket folder of an app's dedicated database, its migration sandbox's one way in (migrationSandbox.ts). */
const PGSOCK_RO_MOUNT_RE = /^type=volume,src=flagship-pgsock-[0-9a-f]{24},dst=\/var\/run\/postgresql,readonly$/;

/**
 * Local AI (packages/server-daemon/src/localAi/catalog.ts LOCAL_AI_IMAGES, byte for byte): llama.cpp
 * build b11541's server and `full` images, by manifest-list digest. Only a run of one of these, named
 * as a local-AI container, gets the mounts below; everything else is the ordinary run's rules.
 */
export const LOCAL_AI_IMAGES: readonly string[] = [
  "ghcr.io/ggml-org/llama.cpp:server-b11541@sha256:bf3da52e92c083472b3d1c9f9da081f423ab9def95a87ec4bba51940382d75fd",
  "ghcr.io/ggml-org/llama.cpp:server-cuda-b11541@sha256:f88fa8d94d872312a4ad117acd490fa997bef81f03f161f0cfe0d74272e5b5bb",
  "ghcr.io/ggml-org/llama.cpp:server-rocm-b11541@sha256:353312d6637cad6a1492d5ab1c0373137163a73d6bce98c821ebcb1abfebcf8c",
  "ghcr.io/ggml-org/llama.cpp:server-intel-b11541@sha256:f74b70ab42a1715a093d67372fdc413a8af671b48bb6f8ae02eb0fb92356f94d",
  "ghcr.io/ggml-org/llama.cpp:full-b11541@sha256:bf349ede99cd7d4e2aa476323da02837a554b609ee02d40e363cf98515f4d640",
  "ghcr.io/ggml-org/llama.cpp:full-cuda-b11541@sha256:12055d1d7d97498f7563837bcb21f4eff05cc15d42c5f8b460afcf53982cdf59",
  "ghcr.io/ggml-org/llama.cpp:full-rocm-b11541@sha256:afb1b28de45ab29a1a2e810da620908c0fb4105fdf05b96d4dd692e7db56cc9c",
  "ghcr.io/ggml-org/llama.cpp:full-intel-b11541@sha256:72ed99a5f846170a479c41979439e61a0db4a6949cdda45422115607b8a1973d",
];
/** The local model server, and a fine-tuning run (its output volume carries the same id). */
const LOCAL_AI_SERVICE_NAME = /^flagship-localai-[0-9a-f]{16}$/;
const LOCAL_AI_TRAIN_NAME = /^flagship-aitrain-([0-9a-f]{16})$/;
/** The installed models, read-only: the only mount the model server has. */
export const LOCAL_AI_MODELS_MOUNT = "type=volume,src=flagship-models,dst=/models,readonly";
/** An app's STAGED sample data (its dev files volume), read-only: never a live app's files. */
const LOCAL_AI_DATASET_MOUNT = /^type=volume,src=flagship-devfiles-[a-z0-9](?:-?[a-z0-9]){0,31}--[a-z0-9](?:-?[a-z0-9]){0,31},dst=\/dataset,readonly$/;

function isLocalAiName(run: ParsedRun): boolean {
  return run.flags.some((f) => f.name === "name" && (LOCAL_AI_SERVICE_NAME.test(f.value) || LOCAL_AI_TRAIN_NAME.test(f.value)));
}

/** Which local-AI mount this is for this run, or null when the run may not have it. */
function localAiMount(run: ParsedRun, value: string): "models" | "out" | "dataset" | null {
  if (!LOCAL_AI_IMAGES.includes(run.image)) return null;
  const names = run.flags.filter((f) => f.name === "name");
  if (names.length !== 1) return null;
  const name = names[0]!.value;
  if (value === LOCAL_AI_MODELS_MOUNT && (LOCAL_AI_SERVICE_NAME.test(name) || LOCAL_AI_TRAIN_NAME.test(name))) return "models";
  const train = LOCAL_AI_TRAIN_NAME.exec(name);
  if (!train) return null;
  if (value === `type=volume,src=flagship-aitrain-${train[1]},dst=/out`) return "out";
  if (LOCAL_AI_DATASET_MOUNT.test(value)) return "dataset";
  return null;
}

/** Whether a `--user` value names uid 0, in any spelling the engine reads as 0. */
function isRootUser(v: string): boolean {
  const uid = v.split(":")[0]!;
  return uid === "root" || /^[+-]?0+$/.test(uid);
}

/** The rules for an ordinary run: an app, a staging copy, a sandbox or a probe. Throws on the first. */
function checkOrdinaryRun(sub: string, run: ParsedRun, gpu: GpuRunClaim | null = null): void {
  let runtime = false;
  const devices = new Set<string>();
  const aiMounts = new Set<string>();
  for (const { name, value } of run.flags) {
    if (RUN_FORBIDDEN.has(name) && !(gpu && name === "device")) throw new PrivdError("forbidden", `--${name} is not allowed`);
    switch (name) {
      case "device":
        if (!GPU_CDI_DEVICE.test(value) || !gpu!.devices.includes(value) || devices.has(value)) {
          throw new PrivdError("forbidden", "a GPU container gets only the devices its allocation holds");
        }
        devices.add(value);
        break;
      case "volume":
        throw new PrivdError("forbidden", "host-path mounts are not allowed");
      case "security-opt":
        if (!/^no-new-privileges(:true)?$/.test(value)) throw new PrivdError("forbidden", "--security-opt is not allowed");
        break;
      case "network":
        if (value === "host") throw new PrivdError("forbidden", "host networking is not allowed");
        if (!NETWORK_NAME.test(value)) throw new PrivdError("forbidden", "a container joins a named network only");
        break;
      case "mount": {
        const ai = sub === "run" ? localAiMount(run, value) : null;
        if (ai) {
          if (aiMounts.has(ai)) throw new PrivdError("forbidden", "a local-AI container mounts each of its volumes once");
          aiMounts.add(ai);
          break;
        }
        // A local-AI container has exactly its own mounts (and the staging resolver), never an app's files.
        if (isLocalAiName(run) && !RESOLV_MOUNT_RE.test(value)) throw new PrivdError("forbidden", "only an app's files volume may be mounted");
        if (sub !== "run" || !(FILES_MOUNT_RE.test(value) || RESOLV_MOUNT_RE.test(value) || PGSOCK_RO_MOUNT_RE.test(value))) {
          throw new PrivdError("forbidden", "only an app's files volume may be mounted");
        }
        break;
      }
      case "user":
        if (isRootUser(value)) throw new PrivdError("forbidden", "a container may not run as root");
        break;
      case "runtime":
        if (gpu ? runtime || value !== gpu.runtime || !GPU_RUNTIMES.has(value) : value !== APP_RUNTIME) {
          throw new PrivdError("forbidden", gpu ? "a GPU container runs under the runtime its allocation names" : "a container runs under gVisor (--runtime runsc)");
        }
        runtime = true;
        break;
    }
  }
  // The unsigned local-AI path (no owner approval) is for the pinned llama.cpp images only.
  if (isLocalAiName(run) && !LOCAL_AI_IMAGES.includes(run.image)) throw new PrivdError("forbidden", "a local-AI container runs one of the pinned images");
  if (!runtime) throw new PrivdError("forbidden", gpu ? "a GPU container runs under the runtime its allocation names" : "a container runs under gVisor (--runtime runsc)");
  if (gpu) {
    if (sub !== "run") throw new PrivdError("forbidden", "a GPU container is started with run");
    if (devices.size !== gpu.devices.length) throw new PrivdError("forbidden", "a GPU container gets only the devices its allocation holds");
    const names = run.flags.filter((f) => f.name === "name");
    if (names.length !== 1 || names[0]!.value !== gpu.container) throw new PrivdError("forbidden", "the GPU allocation was attached for another container");
  }
}

/** The GPU allocation a run names by its label, as gpud attached it; null when it names none. */
function gpuClaimFor(run: ParsedRun, claims: GpuClaimReader): GpuRunClaim | null {
  const labels = run.flags.filter((f) => f.name === "label" && f.value.startsWith(GPU_LABEL));
  if (labels.length === 0) return null;
  if (labels.length > 1) throw new PrivdError("forbidden", "a container holds one GPU allocation");
  const id = labels[0]!.value.slice(GPU_LABEL.length);
  const claim = /^[A-Za-z0-9._-]{1,128}$/.test(id) ? claims(id) : null;
  if (!claim || claim.allocationId !== id) throw new PrivdError("forbidden", "this container holds no attached GPU allocation");
  return claim;
}

/** The pinned Postgres image of an app's dedicated database (dataLayer/dedicated.ts DEDICATED_PG_IMAGE). */
export const DEDICATED_PG_IMAGE =
  "pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c930220cb9bf2f956d10a8f909cf9973d9672ca0278aef2c1e6facccad2e0";
const DEDICATED_CAPS = new Set(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"]);
const DEDICATED_SETTINGS = new Set([
  "listen_addresses", "max_connections", "superuser_reserved_connections", "shared_buffers", "work_mem", "maintenance_work_mem", "temp_file_limit",
  "max_wal_size", "min_wal_size", "statement_timeout", "idle_in_transaction_session_timeout", "max_parallel_workers_per_gather", "log_min_messages",
]);
const DEDICATED_ENV = new Set(["POSTGRES_USER=flagship_admin", "POSTGRES_DB=postgres", "POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256"]);

/**
 * An app's dedicated database (dataLayer/dedicated.ts dedicatedRunArgs): the pinned Postgres image
 * under gVisor, named `flagship-pgd-<key>`, its own data and socket volumes for the same key and
 * nothing else, the capabilities its entrypoint needs to drop to the postgres user, its limits,
 * a loopback port, its fixed settings. The only run that may add capabilities.
 */
function isDedicatedPostgresRun(sub: string, run: ParsedRun): boolean {
  if (sub !== "run" || run.image !== DEDICATED_PG_IMAGE) return false;
  const key = /^flagship-pgd-([0-9a-f]{24})$/.exec(run.flags.find((f) => f.name === "name")?.value ?? "")?.[1];
  if (!key) return false;
  const c = run.command;
  if (c[0] !== "postgres" || c.length % 2 !== 1) return false;
  for (let i = 1; i < c.length; i += 2) {
    const m = /^([a-z_]{1,64})=([A-Za-z0-9*.]{1,32})$/.exec(c[i + 1]!);
    if (c[i] !== "-c" || !m || !DEDICATED_SETTINGS.has(m[1]!)) return false;
  }
  const seen = new Set<string>();
  const mounts = new Set<string>();
  for (const { name, value } of run.flags) {
    let ok: boolean;
    switch (name) {
      case "detach":
        ok = value === "true";
        break;
      case "name":
        ok = !seen.has(name);
        break;
      case "label":
        ok = value === "flagship.role=dedicated-postgres";
        break;
      case "restart":
        ok = value === "unless-stopped";
        break;
      case "runtime":
        ok = value === APP_RUNTIME;
        break;
      case "cap-drop":
        ok = value === "ALL";
        break;
      case "cap-add":
        ok = DEDICATED_CAPS.has(value);
        break;
      case "security-opt":
        ok = value === "no-new-privileges";
        break;
      case "network":
        ok = value !== "host" && NETWORK_NAME.test(value);
        break;
      case "memory":
      case "memory-swap":
        ok = /^[1-9][0-9]{0,5}m$/.test(value);
        break;
      case "cpus":
        ok = /^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(value);
        break;
      case "pids-limit":
        ok = /^[1-9][0-9]{0,4}$/.test(value);
        break;
      case "shm-size":
        ok = value === "64m";
        break;
      case "env":
        ok = DEDICATED_ENV.has(value) || /^POSTGRES_PASSWORD=[A-Za-z0-9_-]{16,128}$/.test(value);
        break;
      case "publish":
        ok = /^127\.0\.0\.1:[1-9][0-9]{3,4}:5432$/.test(value);
        break;
      case "mount":
        ok = value === `type=volume,src=flagship-pgdata-${key},dst=/var/lib/postgresql` || value === `type=volume,src=flagship-pgsock-${key},dst=/var/run/postgresql`;
        if (ok) mounts.add(value);
        break;
      default:
        ok = false;
    }
    if (!ok) return false;
    seen.add(name);
  }
  return mounts.size === 2 && seen.has("runtime") && seen.has("cap-drop") && seen.has("security-opt") && seen.has("memory") && seen.has("pids-limit");
}

/** Every rule that keeps a container from being the host. Throws on the first violation. */
export function validateDockerArgs(a: readonly string[], gpu: GpuClaimReader = NO_GPU_CLAIMS): void {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const lower = x.toLowerCase();
    if (lower.includes("docker.sock")) throw new PrivdError("forbidden", "the docker socket is never mounted");
    if (lower.includes("/var/flagship") && !(a[0] === "build" && i === a.length - 1 && BUILD_CONTEXT_RE.test(x))) {
      throw new PrivdError("forbidden", "the box's state directory is never visible to a container");
    }
  }
  if (a[0] === "run" || a[0] === "create") {
    const run = parseRunArgv(a);
    // The files helper's flags are checked one by one in isFilesHelperRun; it alone runs as uid 0 under runc.
    if (isFilesHelperRun(a) || isDedicatedPostgresRun(a[0], run)) return;
    checkOrdinaryRun(a[0], run, gpuClaimFor(run, gpu));
    return;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const lower = x.toLowerCase();
    const name = lower.split("=")[0]!;
    if (FORBIDDEN_FLAGS.includes(name)) {
      // Two narrow allowances the app runner itself relies on: dropping the default seccomp is not
      // among them; `--security-opt=no-new-privileges` only tightens.
      if (name === "--security-opt" && /^no-new-privileges(:true)?$/.test(x.includes("=") ? x.split("=")[1]! : a[i + 1] ?? "")) {
        if (!x.includes("=")) i++;
        continue;
      }
      throw new PrivdError("forbidden", `${name} is not allowed`);
    }
    if (name === "--network" || name === "--net") {
      const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : a[i + 1] ?? "";
      if (v === "host") throw new PrivdError("forbidden", "host networking is not allowed");
      if (!NETWORK_NAME.test(v)) throw new PrivdError("forbidden", "a container joins a named network only");
    }
    if (name === "-v" || name === "--volume") throw new PrivdError("forbidden", "host-path mounts are not allowed");
    // Outside run and create, these mean nothing safe.
    if (name === "--mount") throw new PrivdError("forbidden", "only an app's files volume may be mounted");
    if (name === "--user" || name === "-u") {
      const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : a[++i] ?? "";
      if (isRootUser(v)) throw new PrivdError("forbidden", "a container may not run as root");
    }
    if (name === "--runtime") throw new PrivdError("forbidden", "--runtime is not allowed");
    // A Dockerfile path would read any file on the host as root.
    if (a[0] === "build" && (name === "-f" || name === "--file")) throw new PrivdError("forbidden", "a build uses the Dockerfile the box wrote, not a path");
  }
}

/**
 * The image the daemon's files helpers run in (volumeDump.ts FILES_HELPER_IMAGE, pinned by digest; a
 * daemon test keeps them equal). Its tar, du, find, head and sh are what the helpers run.
 */
export const FILES_HELPER_IMAGE =
  "pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c930220cb9bf2f956d10a8f909cf9973d9672ca0278aef2c1e6facccad2e0";
const HELPER_CAPS = new Set(["DAC_READ_SEARCH", "DAC_OVERRIDE", "CHOWN", "FOWNER", "FSETID"]);
const HELPER_ENTRYPOINTS = new Set(["tar", "du", "sh", "find", "head"]);
const HELPER_REQUIRED = ["--rm", "--read-only", "--network", "--cap-drop", "--security-opt", "--entrypoint"];

/**
 * A files helper: a throwaway container over exactly one app files volume, no network, no
 * capabilities beyond the file ones it needs, read-only, in the pinned image. It runs as uid 0 inside
 * (an app's files have many owners), which no other container may. Every flag before the image is
 * from this closed list; anything else makes it an ordinary run, held to the ordinary rules.
 */
function isFilesHelperRun(a: readonly string[]): boolean {
  if (a[0] !== "run") return false;
  const at = a.indexOf(FILES_HELPER_IMAGE);
  if (at < 0) return false;
  const seen = new Set<string>();
  let mounts = 0;
  for (let i = 1; i < at; i++) {
    const f = a[i]!;
    const v = a[i + 1] ?? "";
    switch (f) {
      case "--rm":
      case "-i":
      case "--read-only":
        seen.add(f);
        continue;
      case "--network":
        if (v !== "none") return false;
        break;
      case "--cap-drop":
        if (v !== "ALL") return false;
        break;
      case "--cap-add":
        if (!HELPER_CAPS.has(v)) return false;
        break;
      case "--security-opt":
        if (v !== "no-new-privileges") return false;
        break;
      case "--user":
        if (v !== "0:0") return false;
        break;
      case "--memory":
      case "--pids-limit":
        if (!/^[0-9]{1,6}[kmg]?$/.test(v)) return false;
        break;
      case "--mount":
        if (!FILES_MOUNT_RE.test(v)) return false;
        mounts++;
        break;
      case "--entrypoint":
        if (!HELPER_ENTRYPOINTS.has(v)) return false;
        break;
      default:
        return false;
    }
    seen.add(f);
    i++;
  }
  return mounts === 1 && HELPER_REQUIRED.every((r) => seen.has(r));
}

// ── systemctl ─────────────────────────────────────────────────────────────

/** The units the daemon manages, and the verbs it may use on them. */
const MANAGED_UNITS = new Set([
  "docker.service", "docker.socket", "containerd.service", "docker", "ssh", "ssh.service",
  "flagship-daemon.service", "flagship-data-services", "flagship-data-services.service",
  "flagship-keyd.service", "flagship-tlsd.service", "flagship-health.timer",
]);
const UNIT_VERBS = new Set(["start", "stop", "restart", "reload", "reset-failed", "is-active", "show", "enable", "status", "freeze", "thaw"]);
/** One WASI app's worker (server-daemon wasi/unit.ts wasiUnitName): its instance is 16 lowercase hex. */
const WASI_UNIT = /^flagship-wasi@[0-9a-f]{16}\.service$/;
/** What the daemon does to a WASI worker: run it, read its state, and hold it still for a backup. */
const WASI_VERBS = new Set(["start", "stop", "reset-failed", "show", "freeze", "thaw"]);

export function systemctlExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["argv"]);
  const a = stringArgv(args.argv, 16);
  if (a.length === 1 && a[0] === "daemon-reload") return { file: "/usr/bin/systemctl", args: a, timeoutMs: 60_000 };
  const verb = a[0]!;
  if (!UNIT_VERBS.has(verb)) throw new PrivdError("forbidden", `systemctl ${verb} is not allowed`);
  const rest = a.slice(1);
  const units = rest.filter((x) => !x.startsWith("-"));
  const flags = rest.filter((x) => x.startsWith("-"));
  if (units.length === 0) throw new PrivdError("bad-request", "name a unit");
  const wasi = units.filter((u) => WASI_UNIT.test(u)).length;
  for (const u of units) if (!MANAGED_UNITS.has(u) && !WASI_UNIT.test(u)) throw new PrivdError("forbidden", "that unit is not one the daemon manages");
  if (wasi > 0 && (wasi !== units.length || !WASI_VERBS.has(verb))) throw new PrivdError("forbidden", `systemctl ${verb} is not allowed on a WebAssembly app's worker`);
  if ((verb === "freeze" || verb === "thaw") && wasi === 0) throw new PrivdError("forbidden", `systemctl ${verb} is only for a WebAssembly app's worker`);
  for (const f of flags) {
    if (f === "--no-block" || f === "--now" || f === "--quiet" || f === "--no-pager") continue;
    if (verb === "show" && /^--property=[A-Za-z]{1,64}(,[A-Za-z]{1,64})*$/.test(f)) continue;
    throw new PrivdError("forbidden", `systemctl flag ${f} is not allowed`);
  }
  if (verb === "enable" && !units.every((u) => u === "ssh" || u === "ssh.service" || u === "flagship-health.timer" || u === "flagship-keyd.service" || u === "flagship-tlsd.service")) {
    throw new PrivdError("forbidden", "that unit is not enabled from here");
  }
  return { file: "/usr/bin/systemctl", args: a, timeoutMs: 60_000 };
}

// ── WASI app workers (server-daemon wasi/unit.ts) ─────────────────────────

/** The worker binary the release's `wasi-runtime` setup step installs. */
export const WASI_WORKER_BIN = "/usr/local/lib/flagship-wasi/flagship-wasi-worker";
export const WASI_DROPIN_ROOT = "/run/systemd/system";
const WASI_GUEST_CONFIG = "/var/app/pkg/worker.json";
const WASI_GUEST_DATA = "/var/app/data";

export interface WasiDropInFields {
  world: "command" | "http-proxy";
  memoryMiB: number;
  tasks: number;
  cpuPercent: number;
  restart: "always" | "on-failure" | "never";
  filesPath?: string;
}

/**
 * One app's drop-in for its worker unit, rendered here from typed fields: the daemon never hands the
 * broker unit text. Byte for byte what the daemon writes as root (wasi/unit.ts wasiDropIn; a daemon
 * test keeps them equal).
 */
export function renderWasiDropIn(d: WasiDropInFields): string {
  const lines = [
    "# Written by the Flagship daemon (wasi/unit.ts) for one app.",
    "[Service]",
    "ExecStart=",
    `ExecStart=${WASI_WORKER_BIN} ${d.world === "command" ? "run" : "serve"} --config ${WASI_GUEST_CONFIG}`,
    `Restart=${d.restart === "never" ? "no" : d.restart}`,
    `MemoryMax=${d.memoryMiB}M`,
    `TasksMax=${d.tasks}`,
    `CPUQuota=${d.cpuPercent}%`,
  ];
  if (d.filesPath) lines.push(`BindPaths=${d.filesPath}:${WASI_GUEST_DATA}`);
  return lines.join("\n") + "\n";
}

function intIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new PrivdError("bad-request", `${what} must be a whole number from ${min} to ${max}`);
  return v;
}

/**
 * Write or remove one WASI app's drop-in under /run/systemd/system/flagship-wasi@<instance>.service.d/.
 * The instance is 16 lowercase hex; the files folder, when the app has one, is its own volume's.
 */
export function wasiUnitExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["action", "instance", "world", "memoryMiB", "tasks", "cpuPercent", "restart", "filesPath"]);
  if (typeof args.instance !== "string" || !/^[0-9a-f]{16}$/.test(args.instance)) throw new PrivdError("bad-request", "instance is 16 lowercase hex");
  const dir = `${WASI_DROPIN_ROOT}/flagship-wasi@${args.instance}.service.d`;
  if (args.action === "remove") {
    noExtra(args, ["action", "instance"]);
    return { file: "/usr/bin/rm", args: ["-rf", "--", dir], timeoutMs: 30_000 };
  }
  if (args.action !== "write") throw new PrivdError("bad-request", "action is write or remove");
  if (args.world !== "command" && args.world !== "http-proxy") throw new PrivdError("bad-request", "world is command or http-proxy");
  if (args.restart !== "always" && args.restart !== "on-failure" && args.restart !== "never") throw new PrivdError("bad-request", "restart is always, on-failure or never");
  const fields: WasiDropInFields = {
    world: args.world,
    restart: args.restart,
    memoryMiB: intIn(args.memoryMiB, 32, 8192, "memoryMiB"),
    tasks: intIn(args.tasks, 8, 4096, "tasks"),
    cpuPercent: intIn(args.cpuPercent, 5, 800, "cpuPercent"),
  };
  if (args.filesPath !== undefined) {
    if (typeof args.filesPath !== "string" || !(WASI_FILES_IMAGE_DATA.test(args.filesPath) || WASI_FILES_VOLUME_DATA.test(args.filesPath))) {
      throw new PrivdError("forbidden", "a WebAssembly app binds only its own files folder");
    }
    fields.filesPath = args.filesPath;
  }
  return { file: "/usr/bin/install", args: ["-D", "-m", "0644", "/dev/stdin", `${dir}/50-app.conf`], timeoutMs: 30_000, input: renderWasiDropIn(fields) };
}

/**
 * The last lines one WASI app's worker wrote (what `docker logs` is for a container app): that one
 * unit's journal, plain messages only, so the daemon never reads the box's journal itself.
 */
export function wasiLogsExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["instance", "lines"]);
  if (typeof args.instance !== "string" || !/^[0-9a-f]{16}$/.test(args.instance)) throw new PrivdError("bad-request", "instance is 16 lowercase hex");
  const lines = intIn(args.lines, 1, 5000, "lines");
  return { file: "/usr/bin/journalctl", args: ["-u", `flagship-wasi@${args.instance}.service`, "-n", String(lines), "--no-pager", "-o", "cat"], timeoutMs: 30_000 };
}

// ── host operations (per-app disk images, volume folders, the egress chains) ─

/** Per-app files images (appQuota/loopVolumes.ts in the daemon). */
export const FILES_IMAGE_ROOT = "/var/lib/flagship-files";
/** An app's files volume, or a dedicated database's data (dataLayer/dedicated.ts), each in its own quota image. */
const VOL = "(?:flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128}|flagship-pgdata-[0-9a-f]{24})";
/** Only an app's files volume (what a WASI app's unit binds). */
const FILES_VOL = "flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128}";
const IMAGE_MOUNT = new RegExp(`^${FILES_IMAGE_ROOT}/${VOL}$`);
const IMAGE_FILE = new RegExp(`^${FILES_IMAGE_ROOT}/${VOL}\\.img$`);
const IMAGE_DATA = new RegExp(`^${FILES_IMAGE_ROOT}/${VOL}/data/?$`);
const IMAGE_PENDING = new RegExp(`^${FILES_IMAGE_ROOT}/${VOL}\\.pending$`);
const IMAGE_BALLAST = new RegExp(`^${FILES_IMAGE_ROOT}/${VOL}/\\.flagship-ballast$`);
const ORPHAN_DIR = `${FILES_IMAGE_ROOT}/orphaned`;
const ORPHAN_FILE = new RegExp(`^${ORPHAN_DIR}/${VOL}\\.[0-9]{1,16}\\.img$`);
const MKFS_ARGS = ["-q", "-F", "-b", "4096", "-T", "default", "-m", "0", "-E", "lazy_itable_init=1,lazy_journal_init=1,nodiscard"];
/** An app's files volume's own folder, where Docker or Podman keeps it. */
const DOCKER_VOLUME_DATA = new RegExp(`^/var/lib/(?:docker/volumes|containers/storage/volumes)/${VOL}/_data$`);
const MOUNT_OPTS = "loop,nodev,nosuid,discard,noinit_itable";
const WASI_FILES_IMAGE_DATA = new RegExp(`^${FILES_IMAGE_ROOT}/${FILES_VOL}/data$`);
const WASI_FILES_VOLUME_DATA = new RegExp(`^/var/lib/(?:docker/volumes|containers/storage/volumes)/${FILES_VOL}/_data$`);
const LOOP_DEVICE = /^\/dev\/loop[0-9]{1,4}$/;
/** The daemon's folder fingerprint (appQuota/loopVolumes.ts FOLDER_FINGERPRINT_SCRIPT), byte for byte. */
export const FOLDER_FINGERPRINT_SCRIPT =
  `find "$1" \\( -type f -printf 'f %m %s %P\\n' \\) -o \\( -type d -printf 'd %m %P\\n' \\) -o \\( -printf '%y %P\\n' \\) | LC_ALL=C sort | sha256sum | cut -d' ' -f1`;
const EGRESS_CHAIN = /^FLAGSHIP-EGRESS(?:6|-NAT|-FWD|-IN)$/;
/** The sandbox bridges the daemon owns under Podman (egress/networks.ts ensureHostBridge). */
const BOX_BRIDGE = /^fs-[a-z0-9-]{1,12}$/;
const PRIVATE_CIDR = /^(?:10\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){2}\/(?:[89]|[12][0-9]|3[0-2])$/;
const IFACE = /^[a-zA-Z0-9_.-]{1,15}$/;

/**
 * The nft table that keeps containers on one bridge from reaching each other under Podman
 * (egress/firewall.ts renderIccTable in the daemon, byte for byte; a daemon test keeps them equal).
 */
export function iccTable(bridges: readonly string[]): string {
  return [
    "table bridge flagship_icc",
    "delete table bridge flagship_icc",
    "table bridge flagship_icc {",
    "  chain forward {",
    "    type filter hook forward priority -100; policy accept;",
    ...bridges.map((b) => `    meta ibrname "${b}" meta obrname "${b}" counter drop`),
    "  }",
    "}",
    "",
  ].join("\n");
}
const EGRESS_PARENTS = new Set(["PREROUTING", "DOCKER-USER", "INPUT", "FORWARD"]);

/** A loop device the broker can see mounted at one of the box's image folders (its own mount table). */
export type MountsReader = () => string;

export function hostExec(args: Record<string, unknown>, mounts: MountsReader): Exec {
  noExtra(args, ["file", "argv"]);
  const file = args.file;
  const a = stringArgv(args.argv, 32);
  const loopAtImage = (dev: string) => {
    if (!LOOP_DEVICE.test(dev)) return false;
    return mounts().split("\n").some((l) => {
      const f = l.split(" ");
      return f[0] === dev && IMAGE_MOUNT.test(f[1] ?? "");
    });
  };
  switch (file) {
    case "mount":
      if (a.length === 4 && a[0] === "-o" && a[1] === MOUNT_OPTS && IMAGE_FILE.test(a[2]!) && a[3] === a[2]!.replace(/\.img$/, "")) return { file: "/usr/bin/mount", args: a, timeoutMs: 60_000 };
      if (a.length === 3 && a[0] === "-o" && /^remount,(ro|rw)$/.test(a[1]!) && IMAGE_MOUNT.test(a[2]!)) return { file: "/usr/bin/mount", args: a, timeoutMs: 60_000 };
      break;
    case "umount":
      if ((a.length === 1 && IMAGE_MOUNT.test(a[0]!)) || (a.length === 2 && a[0] === "-l" && IMAGE_MOUNT.test(a[1]!))) return { file: "/usr/bin/umount", args: a, timeoutMs: 60_000 };
      break;
    case "chattr":
      if (a.length === 2 && (a[0] === "+i" || a[0] === "-i") && IMAGE_MOUNT.test(a[1]!)) return { file: "/usr/bin/chattr", args: a, timeoutMs: 30_000 };
      break;
    case "losetup":
      if (a.length === 2 && a[0] === "-c" && loopAtImage(a[1]!)) return { file: "/usr/sbin/losetup", args: a, timeoutMs: 60_000 };
      break;
    case "resize2fs":
      if (a.length === 1 && loopAtImage(a[0]!)) return { file: "/usr/sbin/resize2fs", args: a, timeoutMs: 10 * 60_000 };
      break;
    case "cp":
      // Moving an app's existing files volume into its new image (adopt), ownership and modes kept.
      if (a.length === 4 && a[0] === "-a" && a[1] === "--" && DOCKER_VOLUME_DATA.test(a[2]!.replace(/\/\.$/, "")) && a[2]!.endsWith("/.") && IMAGE_DATA.test(a[3]!)) {
        return { file: "/usr/bin/cp", args: a, timeoutMs: 30 * 60_000 };
      }
      break;
    case "du":
      if (a.length === 2 && a[0] === "-sk" && (IMAGE_MOUNT.test(a[1]!) || IMAGE_DATA.test(a[1]!) || DOCKER_VOLUME_DATA.test(a[1]!))) return { file: "/usr/bin/du", args: a, timeoutMs: 10 * 60_000 };
      break;
    case "chmod":
      if (a.length === 2 && a[0] === "0777" && (DOCKER_VOLUME_DATA.test(a[1]!) || IMAGE_DATA.test(a[1]!))) return { file: "/usr/bin/chmod", args: a, timeoutMs: 30_000 };
      break;
    // The images' own folder stays root's, so nothing the daemon plants there is ever mounted or
    // bound into a container: the broker makes, sizes, moves and removes its entries.
    case "mkdir":
      if (a.length === 2 && (a[0] === "0755" || a[0] === "0777") && (a[1] === FILES_IMAGE_ROOT || a[1] === ORPHAN_DIR || IMAGE_MOUNT.test(a[1]!) || IMAGE_DATA.test(a[1]!))) {
        return { file: "/usr/bin/mkdir", args: ["-p", "-m", a[0]!, "--", a[1]!], timeoutMs: 30_000 };
      }
      break;
    case "truncate":
      if (a.length === 2 && /^[0-9]{1,16}$/.test(a[0]!) && (IMAGE_FILE.test(a[1]!) || IMAGE_BALLAST.test(a[1]!))) return { file: "/usr/bin/truncate", args: ["-s", a[0]!, "--", a[1]!], timeoutMs: 60_000 };
      break;
    case "fallocate":
      if (a.length === 3 && a[0] === "-l" && /^[0-9]{1,16}$/.test(a[1]!) && (IMAGE_BALLAST.test(a[2]!) || IMAGE_FILE.test(a[2]!))) return { file: "/usr/bin/fallocate", args: a, timeoutMs: 10 * 60_000 };
      break;
    case "mkfs.ext4":
      if (a.length === MKFS_ARGS.length + 1 && MKFS_ARGS.every((x, i) => a[i] === x) && IMAGE_FILE.test(a[a.length - 1]!)) return { file: "/usr/sbin/mkfs.ext4", args: a, timeoutMs: 10 * 60_000 };
      break;
    case "touch":
      if (a.length === 1 && IMAGE_PENDING.test(a[0]!)) return { file: "/usr/bin/touch", args: ["--", a[0]!], timeoutMs: 30_000 };
      break;
    case "rm":
      if (a.length === 1 && (IMAGE_FILE.test(a[0]!) || IMAGE_PENDING.test(a[0]!) || IMAGE_BALLAST.test(a[0]!) || ORPHAN_FILE.test(a[0]!))) return { file: "/usr/bin/rm", args: ["-f", "--", a[0]!], timeoutMs: 60_000 };
      break;
    case "rmdir":
      if (a.length === 1 && (IMAGE_MOUNT.test(a[0]!) || a[0] === ORPHAN_DIR)) return { file: "/usr/bin/rmdir", args: ["--", a[0]!], timeoutMs: 30_000 };
      break;
    case "mv": {
      const m = a.length === 2 ? new RegExp(`^${ORPHAN_DIR}/(${VOL})\\.[0-9]{1,16}\\.img$`).exec(a[1]!) : null;
      if (m && IMAGE_FILE.test(a[0]!) && a[0] === `${FILES_IMAGE_ROOT}/${m[1]}.img`) return { file: "/usr/bin/mv", args: ["-T", "--", a[0]!, a[1]!], timeoutMs: 60_000 };
      break;
    }
    case "fingerprint":
      if (a.length === 1 && (IMAGE_DATA.test(a[0]!) || DOCKER_VOLUME_DATA.test(a[0]!))) return { file: "/bin/sh", args: ["-c", FOLDER_FINGERPRINT_SCRIPT, "_", a[0]!], timeoutMs: 30 * 60_000 };
      break;
    case "networkctl":
      if (a.length === 1 && a[0] === "reload") return { file: "/usr/bin/networkctl", args: a, timeoutMs: 30_000 };
      break;
    // Under Podman the daemon owns the sandbox bridges: made, addressed and brought up here.
    case "ip":
      if (
        (a.length === 5 && a[0] === "link" && a[1] === "add" && BOX_BRIDGE.test(a[2]!) && a[3] === "type" && a[4] === "bridge") ||
        (a.length === 5 && a[0] === "addr" && a[1] === "add" && PRIVATE_CIDR.test(a[2]!) && a[3] === "dev" && BOX_BRIDGE.test(a[4]!)) ||
        (a.length === 4 && a[0] === "link" && a[1] === "set" && BOX_BRIDGE.test(a[2]!) && a[3] === "up")
      ) {
        return { file: "/usr/sbin/ip", args: a, timeoutMs: 30_000 };
      }
      break;
    case "sysctl": {
      const m = a.length === 3 && a[0] === "-q" && a[1] === "-w" ? /^net\.ipv6\.conf\.([^.=]+)\.disable_ipv6=1$/.exec(a[2]!) : null;
      if (m && BOX_BRIDGE.test(m[1]!)) return { file: "/usr/sbin/sysctl", args: a, timeoutMs: 30_000 };
      break;
    }
    case "icc":
      if (a.length <= 8 && a.every((b) => IFACE.test(b))) return { file: "/usr/sbin/nft", args: ["-f", "-"], timeoutMs: 30_000, input: iccTable(a) };
      break;
    case "localai":
      return localAiHostExec(a);
    case "iptables":
    case "ip6tables":
      return iptablesExec(file, a);
    default:
      throw new PrivdError("unknown-op", "unknown host operation");
  }
  throw new PrivdError("forbidden", `${String(file)} with those arguments is not allowed`);
}

/** Where the engine keeps the models volume, and a fine-tuning job's output volume. */
const MODELS_VOLUME_DATA = /^\/var\/lib\/(?:docker\/volumes|containers\/storage\/volumes)\/flagship-models\/_data$/;
const AITRAIN_VOLUME_DATA = /^\/var\/lib\/(?:docker\/volumes|containers\/storage\/volumes)\/flagship-aitrain-([0-9a-f]{16})\/_data$/;
/** Where the daemon leaves a model it downloaded and checked (localAi/modelStore.ts). */
export const LOCAL_AI_INCOMING = "/var/flagship/data/local-ai/incoming";
/**
 * Installs a model: the broker's own copy must hash to the digest named, then it lands root-owned,
 * read-only, under its digest, by an atomic rename. `$1` digest, `$2` the copy, `$3` the models folder.
 */
export const LOCAL_AI_INSTALL_SCRIPT =
  'set -eu; printf \'%s  %s\\n\' "$1" "$2" | sha256sum -c --status -; install -m 0444 -o root -g root -- "$2" "$3/sha256-$1.gguf.partial"; mv -f -- "$3/sha256-$1.gguf.partial" "$3/sha256-$1.gguf"';

/**
 * Local AI's root steps (packages/server-daemon/src/localAi/containers.ts):
 *  - `model-install <sha256> <models dir>`: copy the daemon's checked download into the broker's folder,
 *    check its digest there, install it 0444 root into the models volume;
 *  - `model-remove <sha256> <models dir>`: delete that one model file;
 *  - `out-prepare <job> <job dir>`: hand a fine-tuning job's own output volume to the container user.
 */
function localAiHostExec(a: readonly string[]): Exec {
  const [verb, id, dir] = a;
  if (a.length === 3 && verb === "model-install" && /^[0-9a-f]{64}$/.test(id!) && MODELS_VOLUME_DATA.test(dir!)) {
    const staged = `${PRIVD_STATE_DIR}/local-ai/sha256-${id}.gguf`;
    return {
      file: "/bin/sh",
      args: ["-c", LOCAL_AI_INSTALL_SCRIPT, "_", id!, staged, dir!],
      copyIn: [{ from: `${LOCAL_AI_INCOMING}/sha256-${id}.gguf`, to: staged }],
      timeoutMs: 30 * 60_000,
    };
  }
  if (a.length === 3 && verb === "model-remove" && /^[0-9a-f]{64}$/.test(id!) && MODELS_VOLUME_DATA.test(dir!)) {
    return { file: "/usr/bin/rm", args: ["-f", "--", `${dir}/sha256-${id}.gguf`], timeoutMs: 60_000 };
  }
  const out = a.length === 3 && verb === "out-prepare" && /^[0-9a-f]{16}$/.test(id!) ? AITRAIN_VOLUME_DATA.exec(dir!) : null;
  if (out && out[1] === id) return { file: "/usr/bin/chown", args: ["10001:10001", "--", dir!], timeoutMs: 30_000 };
  throw new PrivdError("forbidden", "localai with those arguments is not allowed");
}

/** Only the box's own egress chains: create DOCKER-USER, hook, unhook, flush or delete a FLAGSHIP chain. */
function iptablesExec(file: string, a: string[]): Exec {
  const x = a[0] === "-w" ? a.slice(1) : a;
  const ok =
    x.length >= 3 &&
    x[0] === "-t" &&
    (x[1] === "nat" || x[1] === "filter") &&
    ((x.length === 4 && x[2] === "-N" && x[3] === "DOCKER-USER") ||
      (x.length === 6 && (x[2] === "-C" || x[2] === "-D") && EGRESS_PARENTS.has(x[3]!) && x[4] === "-j" && EGRESS_CHAIN.test(x[5]!)) ||
      (x.length === 7 && x[2] === "-I" && EGRESS_PARENTS.has(x[3]!) && x[4] === "1" && x[5] === "-j" && EGRESS_CHAIN.test(x[6]!)) ||
      (x.length === 4 && (x[2] === "-F" || x[2] === "-X") && EGRESS_CHAIN.test(x[3]!)));
  if (!ok) throw new PrivdError("forbidden", `${file} with those arguments is not allowed`);
  return { file: `/usr/sbin/${file}`, args: ["-w", ...x], timeoutMs: 30_000 };
}

/** A full egress ruleset (`iptables-restore --noflush`): tables, the FLAGSHIP chains' declarations and their own rules only. */
export function iptablesRestoreExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["family", "rules"]);
  if (args.family !== 4 && args.family !== 6) throw new PrivdError("bad-request", "family is 4 or 6");
  const rules = args.rules;
  if (typeof rules !== "string" || rules.length === 0 || rules.length > 256 * 1024) throw new PrivdError("bad-request", "rules must be text");
  for (const raw of rules.split("\n")) {
    const line = raw.trim();
    if (!line || line === "COMMIT" || line === "*nat" || line === "*filter") continue;
    if (/^:FLAGSHIP-EGRESS(?:6|-NAT|-FWD|-IN) - \[0:0\]$/.test(line)) continue;
    const m = /^-A (FLAGSHIP-EGRESS(?:6|-NAT|-FWD|-IN)) (.*)$/.exec(line);
    if (m && !/[;`$\\|&<>]/.test(m[2]!) && !/(^|\s)-j\s+(?!REDIRECT|REJECT|RETURN|ACCEPT)\S+/.test(m[2]!) && !/(^|\s)-g\s/.test(m[2]!)) continue;
    throw new PrivdError("forbidden", `rule not allowed: ${line.slice(0, 80)}`);
  }
  return { file: args.family === 4 ? "/usr/sbin/iptables-restore" : "/usr/sbin/ip6tables-restore", args: ["-w", "--noflush"], timeoutMs: 30_000, input: rules };
}

// ── release swap, data wipe, setup steps ──────────────────────────────────

const COMMIT = /^[0-9a-f]{40}$/;
export const RELEASE_REPO = "/opt/flagship";

/**
 * Install a downloaded release (the installer checks its signatures, digest, sequence and Node floor
 * against the trust the RUNNING release pins, never anything the daemon says) or roll back to one already
 * on disk. The staging folder is derived from the commit; the daemon only downloads into it.
 */
export interface ReleaseTrust {
  keys: readonly string[];
  threshold: number;
  nodeFloor: string;
  minSequence: number;
  /** The hybrid PQ pin (release/box-artifact-trust.json `pq`); empty until it names a key. */
  pqKeyIds?: readonly string[];
  legacyManifests?: readonly string[];
}

export function releaseExec(args: Record<string, unknown>, trust: ReleaseTrust, arch: string): Exec {
  noExtra(args, ["action", "commit", "sha256"]);
  if (typeof args.commit !== "string" || !COMMIT.test(args.commit)) throw new PrivdError("bad-request", "commit must be 40 hex");
  if (args.action === "restore") return { file: "/usr/bin/bash", args: [`${RELEASE_REPO}/installer/rollback-box-artifact.sh`, args.commit], timeoutMs: 20 * 60_000 };
  if (args.action !== "install") throw new PrivdError("bad-request", "action is install or restore");
  if (typeof args.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(args.sha256)) throw new PrivdError("bad-request", "sha256 must be 64 hex");
  if (arch !== "amd64" && arch !== "arm64") throw new PrivdError("failed", "unknown architecture");
  const short = args.commit.slice(0, 12);
  const dir = `/var/tmp/.flagship-update-${short}`;
  const name = `flagship-box-${short}-${arch}`;
  const staged = `${PRIVD_STATE_DIR}/release`;
  return {
    file: "/usr/bin/bash",
    copyIn: [
      { from: `${dir}/${name}.manifest.json`, to: `${staged}/${name}.manifest.json` },
      { from: `${dir}/${name}.tar.gz`, to: `${staged}/${name}.tar.gz` },
    ],
    args: [
      `${RELEASE_REPO}/installer/install-box-artifact.sh`,
      "--manifest", `${staged}/${name}.manifest.json`,
      "--artifact", `${staged}/${name}.tar.gz`,
      "--trust-keys", trust.keys.join(","),
      "--threshold", String(trust.threshold),
      "--expect-sha256", args.sha256,
      "--expect-commit", args.commit,
      "--arch", arch,
      "--node-floor", trust.nodeFloor,
      "--min-sequence", String(trust.minSequence),
      // The same PQ pin the root daemon passes (artifactUpdate.ts): once it names a key, every signer
      // needs its hybrid companion here too.
      ...(trust.pqKeyIds?.length ? ["--pq-key-ids", trust.pqKeyIds.join(","), ...(trust.legacyManifests?.length ? ["--legacy-manifests", trust.legacyManifests.join(",")] : [])] : []),
    ],
    timeoutMs: 30 * 60_000,
  };
}

/** Self-delete's last step: the box's data folder, by its fixed name. */
export function wipeExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["target"]);
  if (args.target !== "data") throw new PrivdError("bad-request", "target is data");
  return { file: "/usr/bin/rm", args: ["-rf", "--one-file-system", "/var/flagship/data"], timeoutMs: 30 * 60_000 };
}

/** The root steps the release does for the daemon (packages/server-daemon/src/setup.ts), by name only. */
export const SETUP_STEPS = ["gvisor", "health-reporter", "update-guard", "container-links", "data-unit", "debug-access", "debug-access-close", "system-repair", "server-code", "rust-stack", "wasi-runtime", "gpu-broker", "arch-v2-switch", "arch-v2-settle", "boot-chain"] as const;

export function setupExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["step"]);
  if (typeof args.step !== "string" || !(SETUP_STEPS as readonly string[]).includes(args.step)) throw new PrivdError("forbidden", "unknown setup step");
  return { file: "/usr/local/bin/node", args: [`${RELEASE_REPO}/packages/server-daemon/dist/setup.js`, args.step], timeoutMs: 30 * 60_000 };
}

function stringArgv(v: unknown, max: number): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max || !v.every((a) => typeof a === "string" && a.length <= 4096 && !a.includes("\u0000"))) {
    throw new PrivdError("bad-request", "argv must be a short list of strings");
  }
  return v as string[];
}

// ── nft ───────────────────────────────────────────────────────────────────

const TABLE = "flagship_egress";
const NFT_LINE = [
  new RegExp(`^(?:add|flush|delete) table inet ${TABLE}$`),
  new RegExp(`^add chain inet ${TABLE} [a-z_][a-z0-9_]{0,31}(?: \\{ type (?:filter|nat) hook (?:forward|input|output|prerouting|postrouting) priority -?\\d{1,4}; policy (?:accept|drop); \\})?$`),
  new RegExp(`^add (?:rule|set|element) inet ${TABLE} [a-z_][a-z0-9_ ,.:/{}'"=+<>!-]{0,400}$`),
];

export function nftExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["script"]);
  const script = args.script;
  if (typeof script !== "string" || script.length === 0 || script.length > 256 * 1024) throw new PrivdError("bad-request", "script must be text");
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!NFT_LINE.some((re) => re.test(line))) throw new PrivdError("forbidden", `nft line not allowed: ${line.slice(0, 80)}`);
    if (/[;`$\\]/.test(line.replace(/ priority -?\d{1,4}; policy (?:accept|drop); /, " "))) throw new PrivdError("forbidden", "nft line has a character that is not allowed");
    if (/\b(include|jump to|exec|import|define|flush ruleset|delete table (?!inet flagship_egress))\b/.test(line)) throw new PrivdError("forbidden", "nft line has a word that is not allowed");
  }
  return { file: "/usr/sbin/nft", args: ["-f", "-"], timeoutMs: 30_000, input: script };
}

/** What a request is checked against besides its arguments. */
export interface PolicyContext {
  engine: EngineKind;
  mounts: MountsReader;
  trust: ReleaseTrust;
  arch: string;
  /** flagship-gpud's attached GPU allocations (run-claims.json); none when absent. */
  gpuClaims?: GpuClaimReader;
}

/** The one exact command a request may run, or a refusal: every op the broker answers besides hello. */
export function validateRequest(op: Op, args: Record<string, unknown>, ctx: PolicyContext): Exec {
  switch (op) {
    case "power":
      return powerExec(args);
    case "systemd.restart":
      return restartExec(args);
    case "systemctl":
      return systemctlExec(args);
    case "docker":
      return dockerExec(args, ctx.engine, ctx.gpuClaims ?? NO_GPU_CLAIMS);
    case "docker.file":
      return dockerFileExec(args, ctx.engine);
    case "host":
      return hostExec(args, ctx.mounts);
    case "iptables.restore":
      return iptablesRestoreExec(args);
    case "nft.apply":
      return nftExec(args);
    case "release":
      return releaseExec(args, ctx.trust, ctx.arch);
    case "wipe":
      return wipeExec(args);
    case "setup":
      return setupExec(args);
    case "wasi.unit":
      return wasiUnitExec(args);
    case "wasi.logs":
      return wasiLogsExec(args);
    default:
      throw new PrivdError("unknown-op", "unknown operation");
  }
}

function noExtra(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new PrivdError("bad-request", `unknown field ${k}`);
}
