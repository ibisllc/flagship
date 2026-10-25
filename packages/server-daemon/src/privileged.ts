/**
 * The daemon without root (SECURITY-HARDENING-PLAN.md SEC-DAEMON-001). Once it runs as its own account,
 * everything that needs the host goes to flagship-privd as a typed operation the broker checks again;
 * the few commands that touch only the daemon's own files still run here. As root (before privd is in)
 * or on a developer machine, every command runs locally, as it always did.
 *
 * The command runners (serviceRunner, the update and debug runners, app copies, backups) ask
 * `routePrivileged` first; `null` means "run it yourself".
 */
import { readFile } from "node:fs/promises";
import { PRIVD_SOCKET } from "@flagship/privd/unit";
import { PrivdClient } from "@flagship/privd";
import { FOLDER_FINGERPRINT_SCRIPT } from "./appQuota/loopVolumes.js";

export const DAEMON_USER = "flagship";
/** The daemon's own runtime folder when it runs unprivileged (RuntimeDirectory=flagship-daemon). */
export const DAEMON_RUNTIME_DIR = "/run/flagship-daemon";
/** What the daemon leaves for the broker's server-code step (setup.ts). */
export const SERVER_CODE_REQUEST = `${DAEMON_RUNTIME_DIR}/server-code.json`;

/**
 * Set by the daemon's unit drop-in once privd is in (privdInstall.ts). A developer machine or a test
 * runs without root and without it, and runs everything itself.
 */
export const UNPRIVILEGED_ENV = "FLAGSHIP_DAEMON_UNPRIVILEGED";

export function runsUnprivileged(): boolean {
  return process.env[UNPRIVILEGED_ENV] === "1" && typeof process.getuid === "function" && process.getuid() !== 0;
}

/** Where the daemon puts the runtime files it hands to the host (resolver files, firewall payloads). */
export function runDir(): string {
  return runsUnprivileged() ? DAEMON_RUNTIME_DIR : "/run";
}

let client: PrivdClient | null = null;
export function privd(): PrivdClient {
  client ??= new PrivdClient(process.env.FLAGSHIP_PRIVD_SOCKET ?? PRIVD_SOCKET);
  return client;
}

/** A host binary the broker runs, by the name the daemon's code calls it. */
const HOST_FILES = new Set(["mount", "umount", "chattr", "losetup", "resize2fs", "cp", "chmod", "networkctl", "iptables", "ip6tables", "mkfs.ext4", "fallocate"]);
/** Folders whose sizes need root to read (app-owned files, the engine's volumes). */
const ROOT_READ = [/^\/var\/lib\/flagship-files\//, /^\/var\/lib\/docker\/volumes\//, /^\/var\/lib\/containers\/storage\/volumes\//];

export interface RouteOptions {
  input?: string | Buffer;
  stdinPath?: string;
  stdoutPath?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Run `cmd args` through the broker when the daemon is unprivileged, or return null to run it here.
 * Throws when the command needs root and has no broker operation: better a clear refusal than a
 * half-done change.
 */
export async function routePrivileged(cmd: string, args: readonly string[], o: RouteOptions = {}): Promise<{ stdout: string; stderr: string } | null> {
  if (!runsUnprivileged()) return null;
  const a = [...args];
  const done = (r: { stdout?: string; stderr?: string }) => ({ stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  const base = cmd.split("/").pop()!;
  switch (base) {
    case "docker": {
      // Only the database settings a `-e NAME` forwards into the container; the rest of this process's
      // environment never reaches the root docker client.
      const env: Record<string, string> = {};
      for (const k of ["PGPASSWORD", "PGOPTIONS"]) if (typeof o.env?.[k] === "string") env[k] = o.env[k]!;
      if (o.stdinPath || o.stdoutPath) {
        return done(await privd().dockerFile(a, { ...(o.stdinPath ? { stdinPath: o.stdinPath } : {}), ...(o.stdoutPath ? { stdoutPath: o.stdoutPath } : {}), ...(Object.keys(env).length ? { env } : {}) }));
      }
      return done(await privd().docker(a, o.input === undefined ? undefined : String(o.input), env));
    }
    case "systemctl":
      if (a.length === 1 && (a[0] === "poweroff" || a[0] === "reboot")) return done((await privd().power(a[0])) as { stdout?: string });
      return done(await privd().systemctl(a));
    case "iptables-restore":
    case "ip6tables-restore": {
      const path = a[a.length - 1]!;
      await privd().iptablesRestore(base === "iptables-restore" ? 4 : 6, await readFile(path, "utf8"));
      return { stdout: "", stderr: "" };
    }
    case "sh":
      if (a[0] === "-c" && a[1] === FOLDER_FINGERPRINT_SCRIPT && a[2] === "_" && a.length === 4) return done(await privd().host("fingerprint", [a[3]!]));
      throw new Error("sh is not available to the unprivileged daemon");
    case "du":
      if (a[0] === "-sk" && ROOT_READ.some((re) => re.test(a[1] ?? ""))) return done(await privd().host("du", a));
      return null;
    case "bash": {
      const script = a[0] ?? "";
      if (script.endsWith("/installer/install-box-artifact.sh")) {
        const at = (flag: string) => a[a.indexOf(flag) + 1] ?? "";
        await privd().release("install", at("--expect-commit"), at("--expect-sha256"));
        return { stdout: "", stderr: "" };
      }
      if (script.endsWith("/installer/rollback-box-artifact.sh")) {
        await privd().release("restore", a[1] ?? "");
        return { stdout: "", stderr: "" };
      }
      throw new Error("bash is not available to the unprivileged daemon");
    }
    // Under Podman the daemon owns the sandbox bridges (egress/networks.ts); reading them needs no root.
    case "ip":
      if (a[0] === "-o") return null;
      return done(await privd().host("ip", a));
    case "sysctl":
      return done(await privd().host("sysctl", a));
    case "rm":
      if (a.length === 2 && a[0] === "-rf" && a[1] === "/var/flagship/data") {
        await privd().wipeData();
        return { stdout: "", stderr: "" };
      }
      return null;
    default:
      if (HOST_FILES.has(base)) return done(await privd().host(base, a));
      return null;
  }
}

/** A root step the release does for the daemon (setup.ts), run by the broker; its stdout is the step's JSON result. */
export async function runSetupStep<T = unknown>(step: string): Promise<T | null> {
  const r = await privd().setup(step);
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    return last ? (JSON.parse(last) as T) : null;
  } catch {
    return null;
  }
}
