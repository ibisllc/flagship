/**
 * What the broker will and will not do. Pure: every function maps request arguments to an exact
 * argv for a fixed binary or throws `PrivdError`. Nothing is passed to a shell, and a value the
 * validator does not recognise is a refusal, not a pass-through.
 */
import { PrivdError } from "./wire.js";

export interface Exec {
  file: string;
  args: string[];
  /** Kill after this long. */
  timeoutMs: number;
  /** Text for the child's stdin, if any. */
  input?: string;
}

const UNITS = new Set(["flagship-daemon.service", "docker.service", "flagship-data-services.service"]);

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

const SIMPLE_SUBCOMMANDS = new Set(["run", "create", "start", "stop", "kill", "rm", "restart", "ps", "inspect", "logs", "pull", "build", "info", "version"]);
// Not brokered yet: `save`, `load` and `cp` move large streams and host paths, which need a stream channel of their own.
const SUB_SUBCOMMANDS: Record<string, Set<string>> = {
  image: new Set(["inspect", "ls", "rm", "prune"]),
  network: new Set(["create", "inspect", "ls", "rm", "connect", "disconnect"]),
  volume: new Set(["create", "inspect", "ls", "rm"]),
};
const COMPOSE_FILE = "/opt/flagship/installer/data-services/docker-compose.yml";
const COMPOSE_ENV = "/var/flagship/data-services.env";
const COMPOSE_SUB = new Set(["up", "down", "ps", "pull", "logs", "start", "stop", "restart"]);
const FILES_MOUNT_RE = /^type=volume,src=flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128},dst=\/data(,readonly)?$/;
const RESOLV_MOUNT_RE = /^type=bind,src=\/run\/flagship-resolv-[a-z0-9-]+\.conf,dst=\/etc\/resolv\.conf,readonly$/;
const BUILD_CONTEXT_RE = /^\/var\/flagship\/data\/app-clones\/(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+)*$/;

/** Flags that give a container the host, in either `--flag value` or `--flag=value` form. */
const FORBIDDEN_FLAGS = ["--privileged", "--cap-add", "--device", "--device-cgroup-rule", "--pid", "--ipc", "--uts", "--userns", "--cgroupns", "--volumes-from", "--security-opt", "--sysctl", "--group-add", "--init-path", "--mount-propagation"];

export function dockerExec(args: Record<string, unknown>): Exec {
  noExtra(args, ["argv", "stdin"]);
  const argv = args.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256 || !argv.every((a) => typeof a === "string" && a.length <= 4096 && !a.includes("\u0000"))) {
    throw new PrivdError("bad-request", "argv must be a short list of strings");
  }
  const a = argv as string[];
  const sub = a[0]!;
  if (sub === "compose") return composeExec(a);
  if (SUB_SUBCOMMANDS[sub]) {
    if (!SUB_SUBCOMMANDS[sub]!.has(a[1] ?? "")) throw new PrivdError("forbidden", `docker ${sub} ${a[1] ?? ""} is not allowed`);
  } else if (!SIMPLE_SUBCOMMANDS.has(sub)) {
    throw new PrivdError("forbidden", `docker ${sub} is not allowed`);
  }
  validateDockerArgs(a);
  const input = typeof args.stdin === "string" ? args.stdin : undefined;
  return { file: "/usr/bin/docker", args: a, timeoutMs: sub === "build" ? 20 * 60_000 : 5 * 60_000, ...(input !== undefined ? { input } : {}) };
}

function composeExec(a: string[]): Exec {
  // Only the box's own data-services stack, with its own env file, and a known verb.
  if (a[1] !== "-f" || a[2] !== COMPOSE_FILE) throw new PrivdError("forbidden", "compose may only manage the box's data services");
  let i = 3;
  if (a[i] === "--env-file") {
    if (a[i + 1] !== COMPOSE_ENV) throw new PrivdError("forbidden", "compose env file is fixed");
    i += 2;
  }
  if (!COMPOSE_SUB.has(a[i] ?? "")) throw new PrivdError("forbidden", `compose ${a[i] ?? ""} is not allowed`);
  for (const x of a.slice(i + 1)) if (!/^(-d|--no-color|--remove-orphans|--wait|[a-z][a-z0-9_-]{0,63})$/.test(x)) throw new PrivdError("forbidden", `compose argument ${x} is not allowed`);
  return { file: "/usr/bin/docker", args: a, timeoutMs: 10 * 60_000 };
}

/** Every rule that keeps a container from being the host. Throws on the first violation. */
export function validateDockerArgs(a: readonly string[]): void {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const lower = x.toLowerCase();
    const name = lower.split("=")[0]!;
    if (lower.includes("docker.sock")) throw new PrivdError("forbidden", "the docker socket is never mounted");
    if (lower.includes("/var/flagship") && !(a[0] === "build" && i === a.length - 1 && BUILD_CONTEXT_RE.test(x))) {
      throw new PrivdError("forbidden", "the box's state directory is never visible to a container");
    }
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

function noExtra(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new PrivdError("bad-request", `unknown field ${k}`);
}
