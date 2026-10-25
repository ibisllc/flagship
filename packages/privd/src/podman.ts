/**
 * The engine the broker runs a `docker` op on. The daemon always writes the docker form; on a box
 * that moved to Podman (architecture v2) the broker runs the same request under Podman, translated
 * exactly as the daemon translates it as root (server-daemon engine/engine.ts `engineArgv`, kept equal
 * by a test), and then checks the Podman argv again: Podman runs as root inside the broker, with no
 * daemon between it and the host, and it reads flags and image references Docker would refuse.
 */
import { readFileSync } from "node:fs";
import { PrivdError } from "./wire.js";

export type EngineKind = "docker" | "podman";

/** Written by the box's installer and the Docker-to-Podman move (engine/migrate.ts). */
export const ENGINE_ACTIVE_FILE = "/var/lib/flagship/engine-active";

/** The engine to run now: the box's own record, Docker when there is none. */
export function readActiveEngine(path = ENGINE_ACTIVE_FILE): EngineKind {
  try {
    return readFileSync(path, "utf8").replace(/[^a-z]/g, "") === "podman" ? "podman" : "docker";
  } catch {
    return "docker";
  }
}

export const ENGINE_BINARY: Record<EngineKind, string> = { docker: "/usr/bin/docker", podman: "/usr/bin/podman" };

const FORMAT_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  info: { "{{.ServerVersion}}": "{{.Version.Version}}", "{{.CgroupDriver}}": "{{.Host.CgroupManager}}" },
  version: { "{{.Server.Version}}": "{{.Client.Version}}" },
};
const SAME_SUBCOMMANDS = new Set(["run", "create", "start", "stop", "kill", "rm", "restart", "ps", "inspect", "logs", "pull", "build", "exec", "pause", "unpause", "save", "load", "rmi", "tag", "images", "wait", "image", "volume", "compose"]);
const BRIDGE_NAME_OPTION = "com.docker.network.bridge.name";
const ICC_OPTION = "com.docker.network.bridge.enable_icc";

function noTranslation(what: string): PrivdError {
  return new PrivdError("forbidden", `podman: ${what} has no translation`);
}

function translateFormat(sub: string, args: string[]): string[] {
  const map = Object.hasOwn(FORMAT_MAP, sub) ? FORMAT_MAP[sub] : undefined;
  const out = [...args];
  for (let i = 1; i < out.length; i++) {
    if ((out[i] === "--format" || out[i] === "-f") && i + 1 < out.length) {
      const want = out[i + 1]!;
      if (map && Object.hasOwn(map, want)) out[i + 1] = map[want]!;
      else if (sub === "info" || sub === "version") throw noTranslation(`docker ${sub} --format ${want}`);
    }
  }
  return out;
}

function translateNetwork(args: string[]): string[] {
  const verb = args[1];
  if (verb === "inspect" || verb === "ls" || verb === "rm" || verb === "connect" || verb === "disconnect" || verb === "prune") return args;
  if (verb !== "create") throw noTranslation(`docker network ${verb ?? ""}`);
  const out: string[] = ["network", "create", "--disable-dns"];
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--internal") {
      out.push("--label", "flagship.internal=true");
      continue;
    }
    if ((a === "-o" || a === "--opt") && i + 1 < args.length) {
      const opt = args[++i]!;
      if (opt.startsWith(`${BRIDGE_NAME_OPTION}=`)) out.push("--interface-name", opt.slice(BRIDGE_NAME_OPTION.length + 1), "--opt", "mode=unmanaged");
      else if (opt === `${ICC_OPTION}=false`) out.push("--label", "flagship.icc=false");
      else if (opt !== `${ICC_OPTION}=true`) throw noTranslation(`network option ${opt}`);
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `engineArgv("docker", args, "podman")`: the Podman argv for a docker-form request. */
export function podmanArgv(args: readonly string[]): string[] {
  const sub = args[0] ?? "";
  if (sub === "info" || sub === "version") return translateFormat(sub, [...args]);
  if (sub === "network") return translateNetwork([...args]);
  if (SAME_SUBCOMMANDS.has(sub)) return [...args];
  throw noTranslation(`docker ${sub}`);
}

/**
 * Podman flags Docker has no form of, and Podman's global flags (which it reads after any subcommand):
 * each makes the root engine read, write or run a host path, or loosens the container.
 */
const PODMAN_FORBIDDEN = new Set([
  "--rootfs", "--conmon-pidfile", "--pidfile", "--log-opt", "--log-driver", "--hooks-dir", "--annotation", "--cgroup-conf", "--cgroups",
  "--uidmap", "--gidmap", "--subuidname", "--subgidname", "--pod", "--pod-id-file", "--preserve-fds", "--preserve-fd", "--personality",
  "--seccomp-policy", "--chrootdirs", "--env-host", "--decryption-key", "--authfile", "--cert-dir", "--creds", "--signature-policy",
  "--tls-verify", "--image-volume", "--sdnotify", "--init-ctr", "--hostuser", "--passwd-entry", "--group-entry", "--requires", "--rdt-class",
  "--blkio-weight-device", "--device-read-bps", "--device-write-bps", "--device-read-iops", "--device-write-iops", "--volumepath",
  "--root", "--runroot", "--storage-driver", "--storage-opt", "--conmon", "--runtime-flag", "--network-cmd-path", "--network-config-dir",
  "--network-backend", "--module", "--config", "--connection", "--url", "--identity", "--remote", "--ssh", "--syslog", "--tmpdir",
  "--transient-store", "--imagestore", "--db-backend", "--cdi-spec-dir", "--registries-conf", "--out", "--noout", "--events-backend",
  "--cgroup-manager",
]);
/** Image references that make Podman read a host path as root instead of pulling from a registry. */
const PODMAN_TRANSPORT = /^(?:docker-archive|oci-archive|oci|dir|docker-daemon|containers-storage|sif|ostree|tarball):/i;
const PODMAN_BRIDGE = /^fs-[a-z0-9-]{1,12}$/;

/** What only Podman would do with an argv the docker rules already passed. Throws on the first. */
export function validatePodmanArgs(a: readonly string[]): void {
  const exec = a[0] === "exec";
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const name = x.toLowerCase().split("=")[0]!.replace(/_/g, "-");
    if (PODMAN_FORBIDDEN.has(name)) throw new PrivdError("forbidden", `${name} is not allowed`);
    if (!exec && PODMAN_TRANSPORT.test(x)) throw new PrivdError("forbidden", "an image comes from a registry or the box's own store, never a host path");
    if (name === "--network" || name === "--net") {
      const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : a[i + 1] ?? "";
      if (v.includes(":") || v.includes("/")) throw new PrivdError("forbidden", "a container joins a named network only");
    }
    if (name === "--interface-name" && !PODMAN_BRIDGE.test(x.includes("=") ? x.slice(x.indexOf("=") + 1) : a[i + 1] ?? "")) {
      throw new PrivdError("forbidden", "a network uses only the box's own bridges");
    }
  }
}
