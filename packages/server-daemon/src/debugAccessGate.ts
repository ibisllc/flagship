import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  verifyDebugAccessGrant,
  type AdminGrantView,
  type DebugAccessGrant,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";

const execFileP = promisify(execFile);

/**
 * Box-side enforcement of the owner-authorized debug-access grant
 * (`flagship/debug-access/v1`; docs/recipe-delivery-and-remote-install.md).
 *
 * Enabling the box's `debug` console user / SSH is NOT a burner checkbox — it
 * requires an owner-IRK-signed grant that the BOX verifies before turning
 * anything on. The phone signs the grant behind Face ID when the user approves
 * the burner's "Debug mode" toggle; the burner embeds it (+ the authorized SSH
 * key) into the recipe as an UNSIGNED top-level sibling `debugGrant` (a JSON
 * string of `{grant,signatureHex}`, exactly like `swkHex` / `pairingOrder` —
 * NOT part of the signed install-blob canonical bytes); this gate verifies it.
 *
 * This REPLACES the old unconditional debug-user baking: the burner no longer
 * bakes a `debug` user into the preseed. With no valid grant the box stays a
 * production image — no debug user, no installed SSH key.
 *
 * Safety / self-healing:
 *   - We act ONLY when the signature verifies under OUR config-pinned owner IRK
 *     AND the grant names OUR box (`.com` / the burner are never trust anchors).
 *     An absent / forged / wrong-owner / wrong-box / junk grant is ignored —
 *     never a crash, never a debug-user-on-bad-input.
 *   - Idempotent: a local marker records that the gate ran, so a reboot never
 *     re-applies. Each system mutation is best-effort (a `debug` user that
 *     already exists is not an error).
 */

const DEBUG_USER = "debug";
/**
 * Known bring-up password for the `debug` sudo user, set ONLY when a verified
 * owner grant is present (and only if the grant carries no SSH key). This is the
 * "anyone with physical/LAN access can log in" affordance the toggle warns about
 * — it lets the owner `ssh debug@<box-lan-ip>` (password auth) without the phone
 * needing to know an SSH key. It is the load-bearing constant the GA release
 * guard (scripts/release-guard.sh) deliberately trips on.
 */
const DEBUG_PASSWORD = "flagship";

const HEX = /^[0-9a-f]+$/;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** An execFile-style command runner, injected so the gate is unit-testable
 *  (mirrors serviceRunner's CommandRunner). Mutations are argv-only (no shell). */
export interface DebugCommandRunner {
  run(cmd: string, args: string[]): Promise<void>;
}

export const realDebugCommandRunner: DebugCommandRunner = {
  async run(cmd, args) {
    await execFileP(cmd, args, { timeout: 30_000 });
  },
};

/**
 * The verified-grant carrier as it sits on disk: the UNSIGNED `debugGrant`
 * install-blob sibling is a JSON string of this shape.
 */
export interface DebugGrantCarrier {
  grant: DebugAccessGrant;
  signatureHex: string;
}

/**
 * Read + parse the OPTIONAL `debugGrant` sibling from the on-disk install blob.
 * Returns the RAW (un-verified) carrier or null when absent/malformed — the
 * caller verifies. Accepts either the embedded JSON STRING (what the burner
 * writes) or an already-parsed object. Never throws.
 */
export async function debugGrantFromInstallBlob(
  blobPath = process.env.FLAGSHIP_INSTALL_BLOB ?? "/var/flagship/install-blob.json",
): Promise<DebugGrantCarrier | null> {
  let raw: string;
  try {
    raw = await readFile(blobPath, "utf8");
  } catch {
    return null;
  }
  let sibling: unknown;
  try {
    const b = JSON.parse(raw) as { debugGrant?: unknown };
    sibling = b.debugGrant;
  } catch {
    return null;
  }
  let obj: unknown;
  if (typeof sibling === "string" && sibling.length > 0) {
    try {
      obj = JSON.parse(sibling);
    } catch {
      return null;
    }
  } else if (sibling && typeof sibling === "object") {
    obj = sibling;
  } else {
    return null;
  }
  const c = obj as {
    grant?: { serverDomain?: unknown; sshAuthorizedKey?: unknown; issuedAt?: unknown };
    signatureHex?: unknown;
  };
  if (
    !c.grant ||
    typeof c.grant.serverDomain !== "string" ||
    typeof c.grant.sshAuthorizedKey !== "string" ||
    typeof c.grant.issuedAt !== "number" ||
    typeof c.signatureHex !== "string" ||
    !HEX.test(c.signatureHex.toLowerCase())
  ) {
    return null;
  }
  return {
    grant: {
      serverDomain: c.grant.serverDomain,
      sshAuthorizedKey: c.grant.sshAuthorizedKey,
      issuedAt: c.grant.issuedAt,
    },
    signatureHex: c.signatureHex.toLowerCase(),
  };
}

/** Records that the gate already enabled debug access (idempotency). */
export interface DebugMarkerStore {
  has(): Promise<boolean>;
  mark(grant: DebugAccessGrant): Promise<void>;
}

/** Default file-backed marker (a small JSON sentinel under the data dir). */
export function fileDebugMarkerStore(markerPath: string): DebugMarkerStore {
  return {
    async has() {
      try {
        await readFile(markerPath, "utf-8");
        return true;
      } catch {
        return false;
      }
    },
    async mark(grant) {
      await writeFile(
        markerPath,
        JSON.stringify({ enabledAt: grant.issuedAt, serverDomain: grant.serverDomain }),
        { mode: 0o600 },
      );
    },
  };
}

export interface ApplyDebugAccessOptions {
  runner: DebugCommandRunner;
  /** The debug user's home dir (default /home/debug). */
  homeDir?: string;
  /**
   * Write the SSH authorized key file content. Injected for testability; the
   * default writes `${homeDir}/.ssh/authorized_keys` (0600) via fs. Ownership +
   * perms are then set through the runner so a root-written file ends up owned
   * by the debug user on a real box.
   */
  installAuthorizedKey?: (key: string, authKeysPath: string) => Promise<void>;
  /**
   * Write a small system config/banner file (sshd drop-in, /etc/issue.d). Injected
   * for testability; the default does a best-effort `mkdir -p` + write and never
   * throws. Routed separately from the runner because these carry file CONTENT.
   */
  writeConfigFile?: (path: string, content: string, mode?: number) => Promise<void>;
  onLog?: (m: string) => void;
}

async function tryRun(
  runner: DebugCommandRunner,
  cmd: string,
  args: string[],
  log: (m: string) => void,
): Promise<void> {
  try {
    await runner.run(cmd, args);
  } catch (e) {
    // Best-effort: a `debug` user that already exists, a missing group, etc. are
    // not fatal — the marker still records that the gate ran.
    log(`[debug-access] ${cmd} ${args.join(" ")} failed (continuing): ${(e as Error).message}`);
  }
}

async function defaultInstallAuthorizedKey(key: string, authKeysPath: string): Promise<void> {
  await mkdir(dirname(authKeysPath), { recursive: true, mode: 0o700 });
  await writeFile(authKeysPath, key.trim() + "\n", { mode: 0o600 });
}

async function defaultWriteConfigFile(path: string, content: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode });
}

async function tryWriteConfig(
  write: (p: string, c: string, m?: number) => Promise<void>,
  path: string,
  content: string,
  log: (m: string) => void,
  mode?: number,
): Promise<void> {
  try {
    await write(path, content, mode);
  } catch (e) {
    log(`[debug-access] could not write ${path} (continuing): ${(e as Error).message}`);
  }
}

/**
 * Enable the `debug` sudo user and make it LAN-SSH-able. On a verified grant we:
 *   1. create/unlock the `debug` sudoer (matching the old bring-up backdoor);
 *   2. install the grant's SSH key if it carries one;
 *   3. ALWAYS set the known `debug:flagship` password so the owner can
 *      `ssh debug@<box-lan-ip>` (or log in at the console) even with no key —
 *      the phone doesn't hold the user's SSH key, so password auth is the easy path;
 *   4. ensure sshd is enabled + accepts password auth (Debian default already
 *      does; this is belt-and-suspenders against a hardened base);
 *   5. write a console banner showing the box's live LAN IP + the debug creds so
 *      it's genuinely one-command to find + log in.
 * All of this is LOCAL box state (no `.com`, no tunnel) → it works on a box whose
 * public tunnel is down. Every step is best-effort + idempotent; it runs ONLY
 * inside the verified-grant path, so a production (no-grant) box gets none of it.
 */
export async function applyDebugAccess(
  grant: DebugAccessGrant,
  opts: ApplyDebugAccessOptions,
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const runner = opts.runner;
  const homeDir = opts.homeDir ?? `/home/${DEBUG_USER}`;
  const writeConfig = opts.writeConfigFile ?? defaultWriteConfigFile;

  // Create the debug user (best-effort — may already exist) and ensure it is
  // unlocked + a sudoer, matching the bring-up backdoor the burner used to bake.
  await tryRun(runner, "useradd", ["-m", "-s", "/bin/bash", "-G", "sudo", DEBUG_USER], log);
  await tryRun(runner, "usermod", ["-U", "-aG", "sudo", DEBUG_USER], log);

  const key = grant.sshAuthorizedKey.trim();
  if (key.length > 0) {
    const sshDir = join(homeDir, ".ssh");
    const authKeysPath = join(sshDir, "authorized_keys");
    const installKey = opts.installAuthorizedKey ?? defaultInstallAuthorizedKey;
    try {
      await installKey(key, authKeysPath);
    } catch (e) {
      log(`[debug-access] failed to write authorized_keys (continuing): ${(e as Error).message}`);
    }
    // Lock down ownership + perms on a real box (the daemon writes as root).
    await tryRun(runner, "chown", ["-R", `${DEBUG_USER}:${DEBUG_USER}`, sshDir], log);
    await tryRun(runner, "chmod", ["700", sshDir], log);
    await tryRun(runner, "chmod", ["600", authKeysPath], log);
  }

  // (3) Known password so password-auth SSH + console login work with no key.
  // The shell `echo '…' | chpasswd` form is the load-bearing line the GA release
  // guard targets — that's intentional (debug must be removed at GA).
  await tryRun(runner, "bash", ["-c", `echo '${DEBUG_USER}:${DEBUG_PASSWORD}' | chpasswd`], log);

  // (4) Make sure sshd is up + accepts password auth on the LAN (tunnel-independent).
  await tryWriteConfig(
    writeConfig,
    "/etc/ssh/sshd_config.d/10-flagship-debug.conf",
    "# Flagship debug-access (owner-grant-gated). Remove for production.\nPasswordAuthentication yes\n",
    log,
  );
  await tryRun(runner, "systemctl", ["enable", "--now", "ssh"], log);
  await tryRun(runner, "systemctl", ["reload", "ssh"], log);

  // (5) Console banner: surface the LAN IP (\4 expands to the live IPv4 at login
  // time) + the debug creds so finding + logging into the box is one command.
  await tryWriteConfig(
    writeConfig,
    "/etc/issue.d/99-flagship-debug.issue",
    "\n*** FLAGSHIP DEBUG MODE — anyone on this network can log in ***\n" +
      `SSH:  ssh ${DEBUG_USER}@\\4    password: ${DEBUG_PASSWORD}   (sudo enabled)\n\n`,
    log,
  );
}

export interface DebugAccessGateOptions {
  /** This box's canonical FQDN — the grant must name it. */
  serverDomain: string;
  /**
   * The config-pinned MEMBERSHIP owner IRK — the LEGACY (fallback) anchor, used
   * ONLY when no admin master root is pinned (a pre-admin-tier box).
   */
  ownerIrkPub: Uint8Array;
  /**
   * Slice D — the config-pinned ADMIN MASTER ROOT (`ServerConfig.adminRootPub`).
   * When present, the debug grant (which yields a LAN/console ROOT shell) is
   * held to the SAME authority boundary as wipe/transfer/decommission: it must
   * be admin-root-signed. A membership-IRK-only grant is rejected. Absent ⇒
   * legacy owner-IRK path (v1-sec GAP 2).
   */
  adminRootPub?: Uint8Array;
  /** The account name (for the delegated-admin-grant username check). */
  username?: string;
  /**
   * The account's ACTIVE admin device grants (box-local snapshot). Box-side today
   * this is `[]` (bare-admin-root only), mirroring the decommission consumer.
   */
  activeGrants?: readonly AdminGrantView[];
  /** Idempotency marker store. */
  markerStore: DebugMarkerStore;
  /** Command runner for the OS mutations (injected for tests). */
  runner: DebugCommandRunner;
  /** Override the install-blob path (defaults to FLAGSHIP_INSTALL_BLOB / well-known). */
  blobPath?: string;
  /** The debug user's home dir (default /home/debug). */
  homeDir?: string;
  /** Override the authorized-keys writer (injected for tests). */
  installAuthorizedKey?: (key: string, authKeysPath: string) => Promise<void>;
  /** Override the config/banner writer (injected for tests). */
  writeConfigFile?: (path: string, content: string, mode?: number) => Promise<void>;
  onLog?: (m: string) => void;
}

export type DebugGateOutcome =
  | { enabled: false; reason: "already-enabled" | "no-grant" | "rejected" | "error" }
  | { enabled: true };

/**
 * Run the debug-access gate once at boot. Verifies the recipe's owner-IRK-signed
 * `debugGrant` against the config-pinned owner IRK + this box's FQDN, and ONLY
 * on success enables the debug user + installs the SSH key. Never throws.
 */
export async function runDebugAccessGate(
  opts: DebugAccessGateOptions,
): Promise<DebugGateOutcome> {
  const log = opts.onLog ?? (() => {});

  // Idempotent: a prior boot already ran the gate.
  try {
    if (await opts.markerStore.has()) return { enabled: false, reason: "already-enabled" };
  } catch {
    /* an unreadable marker is treated as "not yet run" */
  }

  let carrier: DebugGrantCarrier | null;
  try {
    carrier = await debugGrantFromInstallBlob(opts.blobPath);
  } catch (e) {
    log(`[debug-access] could not read grant: ${(e as Error).message}`);
    return { enabled: false, reason: "error" };
  }
  if (!carrier) {
    // The default production recipe carries NO debugGrant → stay a production
    // image (no debug user). This is the common, expected path.
    return { enabled: false, reason: "no-grant" };
  }

  // Bind to THIS box (case-insensitive FQDN) — a relay/burner can't aim another
  // box's grant at us (the signature would fail too, but this is explicit).
  if (carrier.grant.serverDomain.toLowerCase() !== opts.serverDomain.toLowerCase()) {
    log(
      `[debug-access] grant names ${carrier.grant.serverDomain}, not this box (${opts.serverDomain}); ignoring`,
    );
    return { enabled: false, reason: "rejected" };
  }

  let sig: Uint8Array;
  try {
    sig = hexToBytes(carrier.signatureHex);
  } catch {
    log("[debug-access] grant signature is not valid hex; ignoring");
    return { enabled: false, reason: "rejected" };
  }
  // A debug grant creates a passworded `debug` sudoer + password-auth SSH = a
  // LAN/console ROOT shell, so it must clear the SAME authority boundary as
  // wipe/transfer/decommission. Route it through the shared Slice-D gate:
  //   - admin root pinned ⇒ the grant MUST be admin-root-signed (a
  //     membership-IRK-only grant is rejected — no escalation around the tier);
  //   - no admin root pinned ⇒ legacy owner-IRK verification, unchanged.
  if (
    !authorizeSensitiveOrder({
      order: carrier.grant,
      signature: sig,
      verify: verifyDebugAccessGrant,
      ownerIrkPub: opts.ownerIrkPub,
      ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
      username: opts.username ?? "",
      ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
    })
  ) {
    log("[debug-access] grant is not authorized (admin root / owner IRK); ignoring");
    return { enabled: false, reason: "rejected" };
  }

  log(
    `[debug-access] verified owner-IRK debug grant for ${opts.serverDomain}; enabling the ${DEBUG_USER} user`,
  );
  try {
    await applyDebugAccess(carrier.grant, {
      runner: opts.runner,
      homeDir: opts.homeDir,
      installAuthorizedKey: opts.installAuthorizedKey,
      writeConfigFile: opts.writeConfigFile,
      onLog: log,
    });
  } catch (e) {
    // applyDebugAccess is best-effort internally, but guard anyway: never throw.
    log(`[debug-access] apply failed (continuing): ${(e as Error).message}`);
    return { enabled: false, reason: "error" };
  }
  try {
    await opts.markerStore.mark(carrier.grant);
  } catch (e) {
    log(`[debug-access] failed to write marker: ${(e as Error).message}`);
  }
  return { enabled: true };
}
