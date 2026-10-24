/**
 * The box's container engine (docs/architecture-v2/engine-and-rust-path.md §3, plan R03).
 *
 * Every caller in the daemon still writes the engine command as `docker <subcommand> …`. Which
 * program actually runs is decided here, once per process: Docker on boxes that have not moved
 * yet, Podman everywhere else. Podman was chosen over containerd because its CLI takes the same
 * argv the daemon (and the Rust runtime adapter, `oci_cli.rs`) already generate, it builds images
 * itself (buildah) where containerd needs BuildKit and nerdctl on top, it has no long-running root
 * daemon or API socket, it registers runsc as an ordinary OCI runtime, and Debian 13 ships it
 * (5.4) at a version with `host-gateway`. Docker remains only as the migration source.
 *
 * The translation is a closed list: a docker form with no Podman meaning is refused with an
 * error rather than passed through to do something else.
 */
import { readFileSync } from "node:fs";

export type EngineKind = "docker" | "podman";

/** The box-side switch for the architecture v2 path. New boxes are written with both on. */
export const ARCH_V2_CONFIG = "/var/lib/flagship/arch-v2.json";

export interface ArchV2Config {
  version: 1;
  /** Run keyd, broker and core from the release's Rust binaries (with the TS fallback). */
  rust: "on" | "off";
  /** The engine the box should run. "podman" on a box with Docker data migrates it once first. */
  engine: EngineKind;
  /** Who set it: the installer of a new box, or a later owner/maintainer change. */
  source?: "new-box" | "owner" | "maintainer";
  setAt?: string;
}

/** A box with no file is an existing box: everything stays as it was. */
export const LEGACY_DEFAULTS: ArchV2Config = { version: 1, rust: "off", engine: "docker" };

/** The contents an installer writes on a new box. */
export function newBoxArchV2Config(now: Date = new Date()): ArchV2Config {
  return { version: 1, rust: "on", engine: "podman", source: "new-box", setAt: now.toISOString() };
}

export function parseArchV2Config(text: string | null): ArchV2Config {
  if (text === null) return { ...LEGACY_DEFAULTS };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // A damaged switch file falls back to the path that existed before it (never a half state).
    return { ...LEGACY_DEFAULTS };
  }
  if (typeof raw !== "object" || raw === null) return { ...LEGACY_DEFAULTS };
  const r = raw as Record<string, unknown>;
  const cfg: ArchV2Config = {
    version: 1,
    rust: r.rust === "on" ? "on" : "off",
    engine: r.engine === "podman" ? "podman" : "docker",
  };
  if (r.source === "new-box" || r.source === "owner" || r.source === "maintainer") cfg.source = r.source;
  if (typeof r.setAt === "string") cfg.setAt = r.setAt;
  return cfg;
}

export function loadArchV2Config(path: string = process.env.FLAGSHIP_ARCH_V2_CONFIG ?? ARCH_V2_CONFIG): ArchV2Config {
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  const cfg = parseArchV2Config(text);
  const forced = process.env.FLAGSHIP_ENGINE;
  if (forced === "docker" || forced === "podman") cfg.engine = forced;
  return cfg;
}

let active: EngineKind = process.env.FLAGSHIP_ENGINE === "podman" ? "podman" : "docker";

/** Set once at boot, after any migration has finished. */
export function setActiveEngine(kind: EngineKind): void {
  active = kind;
}

export function activeEngine(): EngineKind {
  return active;
}

export class EngineTranslationError extends Error {}

const FORMAT_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  info: {
    "{{.ServerVersion}}": "{{.Version.Version}}",
    "{{.CgroupDriver}}": "{{.Host.CgroupManager}}",
  },
  version: {
    "{{.Server.Version}}": "{{.Client.Version}}",
  },
};

/** Subcommands whose docker argv Podman takes unchanged. */
const SAME_SUBCOMMANDS = new Set([
  "run",
  "create",
  "start",
  "stop",
  "kill",
  "rm",
  "restart",
  "ps",
  "inspect",
  "logs",
  "pull",
  "build",
  "exec",
  "pause",
  "unpause",
  "save",
  "load",
  "rmi",
  "tag",
  "images",
  "wait",
  "image",
  "volume",
  "compose",
]);

const BRIDGE_NAME_OPTION = "com.docker.network.bridge.name";
const ICC_OPTION = "com.docker.network.bridge.enable_icc";
/** Podman has no enable_icc; the label records the intent and the firewall enforces it (bridge family). */
export const PODMAN_ICC_LABEL = "flagship.icc";
/** Docker's --internal, recorded for Podman (see translateNetwork). */
export const PODMAN_INTERNAL_LABEL = "flagship.internal";

function translateFormat(sub: string, args: string[]): string[] {
  const map = FORMAT_MAP[sub];
  const out = [...args];
  for (let i = 1; i < out.length; i++) {
    if ((out[i] === "--format" || out[i] === "-f") && i + 1 < out.length) {
      const want = out[i + 1]!;
      if (map && want in map) out[i + 1] = map[want]!;
      else if (sub === "info" || sub === "version") {
        throw new EngineTranslationError(`podman: docker ${sub} --format ${want} has no translation`);
      }
    }
  }
  return out;
}

function translateNetwork(args: string[]): string[] {
  const verb = args[1];
  if (verb === "inspect" || verb === "ls" || verb === "rm" || verb === "connect" || verb === "disconnect" || verb === "prune") return args;
  if (verb !== "create") throw new EngineTranslationError(`podman: docker network ${verb ?? ""} has no translation`);
  // No aardvark-dns: apps are given the egress gateway with --dns, as under Docker.
  const out: string[] = ["network", "create", "--disable-dns"];
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--internal") {
      // A Podman internal network gets no gateway address, and builds reach their registries
      // through the gateway on it. The bridge stays routable; the egress firewall's forward
      // chain is what keeps it from reaching anything else (as it does for staging and apps).
      out.push("--label", `${PODMAN_INTERNAL_LABEL}=true`);
      continue;
    }
    if ((a === "-o" || a === "--opt") && i + 1 < args.length) {
      const opt = args[++i]!;
      if (opt.startsWith(`${BRIDGE_NAME_OPTION}=`)) {
        // netavark creates a bridge only when the first container joins and deletes it with the
        // last; the egress gateway listens on the bridge address from boot, as under Docker, so
        // the daemon owns the bridge (networks.ts ensureHostBridge) and netavark only uses it.
        out.push("--interface-name", opt.slice(BRIDGE_NAME_OPTION.length + 1), "--opt", "mode=unmanaged");
      } else if (opt === `${ICC_OPTION}=false`) {
        out.push("--label", `${PODMAN_ICC_LABEL}=false`);
      } else if (opt === `${ICC_OPTION}=true`) {
        // Podman's default: containers on a bridge reach each other.
      } else {
        throw new EngineTranslationError(`podman: network option ${opt} has no translation`);
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * The program and argv to run for `cmd args` on the given engine. Anything that is not the
 * engine is returned unchanged.
 */
export function engineArgv(cmd: string, args: readonly string[], engine: EngineKind = active): [string, string[]] {
  if (cmd !== "docker" || engine === "docker") return [cmd, [...args]];
  const sub = args[0] ?? "";
  if (sub === "info" || sub === "version") return ["podman", translateFormat(sub, [...args])];
  if (sub === "network") return ["podman", translateNetwork([...args])];
  if (SAME_SUBCOMMANDS.has(sub)) return ["podman", [...args]];
  throw new EngineTranslationError(`podman: docker ${sub} has no translation`);
}

/** The engine's own systemd units, for health checks and repair. */
export function engineUnits(engine: EngineKind = active): string[] {
  return engine === "docker" ? ["docker.service", "docker.socket", "containerd.service"] : [];
}
