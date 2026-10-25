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
const BIND_DEVICE = /^device=\/var\/lib\/flagship-files\/(flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128})\/data$/;

/**
 * The engine's binary and argv for a checked docker-form request: Docker as written, or Podman's
 * translation held to the docker rules again (when `dockerRules`) and to Podman's own.
 */
function forEngine(a: string[], engine: EngineKind, dockerRules: boolean): { file: string; args: string[] } {
  if (engine !== "podman") return { file: ENGINE_BINARY.docker, args: a };
  const mapped = podmanArgv(a);
  if (dockerRules) validateDockerArgs(mapped);
  validatePodmanArgs(mapped);
  return { file: ENGINE_BINARY.podman, args: mapped };
}

export function dockerExec(args: Record<string, unknown>, engine: EngineKind = "docker"): Exec {
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
  validateDockerArgs(a);
  const input = typeof args.stdin === "string" ? args.stdin : undefined;
  const env = clientEnv(args.env);
  return {
    ...forEngine(a, engine, true),
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
  if (!EXEC_CONTAINERS.has(a[i] ?? "")) throw new PrivdError("forbidden", "exec reaches only the box's data services");
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

/** Every rule that keeps a container from being the host. Throws on the first violation. */
export function validateDockerArgs(a: readonly string[]): void {
  const helper = isFilesHelperRun(a);
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const lower = x.toLowerCase();
    const name = lower.split("=")[0]!;
    if (lower.includes("docker.sock")) throw new PrivdError("forbidden", "the docker socket is never mounted");
    if (lower.includes("/var/flagship") && !(a[0] === "build" && i === a.length - 1 && BUILD_CONTEXT_RE.test(x))) {
      throw new PrivdError("forbidden", "the box's state directory is never visible to a container");
    }
    // The helper's flags were checked one by one in isFilesHelperRun.
    if (helper) continue;
    if (FORBIDDEN_FLAGS.includes(name)) {
      // Two narrow allowances the app runner itself relies on: dropping the default seccomp is not
      // among them; `--security-opt=no-new-privileges` only tightens.
      if (name === "--security-opt" && /^no-new-privileges(:true)?$/.test(x.includes("=") ? x.split("=")[1]! : a[i + 1] ?? "")) {
        if (!x.includes("=")) i++;
        continue;
      }
      throw new PrivdError("forbidden", `${name} is not allowed`);
    }
    if ((name === "--network" || name === "--net") && (x.includes("=") ? x.split("=")[1] : a[i + 1]) === "host") throw new PrivdError("forbidden", "host networking is not allowed");
    if (name === "-v" || name === "--volume") throw new PrivdError("forbidden", "host-path mounts are not allowed");
    if (name === "--mount") {
      const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : a[++i] ?? "";
      if (a[0] !== "run" || !(FILES_MOUNT_RE.test(v) || RESOLV_MOUNT_RE.test(v))) throw new PrivdError("forbidden", "only an app's files volume may be mounted");
      continue;
    }
    if (name === "--user" || name === "-u") {
      const v = x.includes("=") ? x.split("=")[1]! : a[++i] ?? "";
      if (/^(0|root)(:|$)/.test(v)) throw new PrivdError("forbidden", "a container may not run as root");
    }
    if (name === "--runtime") {
      const v = x.includes("=") ? x.split("=")[1]! : a[++i] ?? "";
      if (v !== "runsc" && v !== "runc") throw new PrivdError("forbidden", "unknown container runtime");
    }
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
const UNIT_VERBS = new Set(["start", "stop", "restart", "reload", "reset-failed", "is-active", "show", "enable", "status"]);

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
  for (const u of units) if (!MANAGED_UNITS.has(u)) throw new PrivdError("forbidden", "that unit is not one the daemon manages");
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

// ── host operations (per-app disk images, volume folders, the egress chains) ─

/** Per-app files images (appQuota/loopVolumes.ts in the daemon). */
export const FILES_IMAGE_ROOT = "/var/lib/flagship-files";
const VOL = "flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128}";
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
      if (a.length === 3 && a[0] === "-l" && /^[0-9]{1,16}$/.test(a[1]!) && IMAGE_BALLAST.test(a[2]!)) return { file: "/usr/bin/fallocate", args: a, timeoutMs: 10 * 60_000 };
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
    case "iptables":
    case "ip6tables":
      return iptablesExec(file, a);
    default:
      throw new PrivdError("unknown-op", "unknown host operation");
  }
  throw new PrivdError("forbidden", `${String(file)} with those arguments is not allowed`);
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
export const SETUP_STEPS = ["gvisor", "health-reporter", "update-guard", "container-links", "data-unit", "debug-access", "debug-access-close", "system-repair", "server-code", "rust-stack"] as const;

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
      return dockerExec(args, ctx.engine);
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
    default:
      throw new PrivdError("unknown-op", "unknown operation");
  }
}

function noExtra(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new PrivdError("bad-request", `unknown field ${k}`);
}
