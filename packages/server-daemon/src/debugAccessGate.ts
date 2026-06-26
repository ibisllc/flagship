import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  verifyDebugAccessGrant,
  type DebugAccessGrant,
} from "@flagship/protocol";

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

/**
 * Enable the `debug` console user and (if the grant carries one) install its SSH
 * authorized key. Each step is best-effort + idempotent at the OS level.
 */
export async function applyDebugAccess(
  grant: DebugAccessGrant,
  opts: ApplyDebugAccessOptions,
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const runner = opts.runner;
  const homeDir = opts.homeDir ?? `/home/${DEBUG_USER}`;

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
}

export interface DebugAccessGateOptions {
  /** This box's canonical FQDN — the grant must name it. */
  serverDomain: string;
  /** The config-pinned owner IRK pubkey — the only trust anchor. */
  ownerIrkPub: Uint8Array;
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
  if (!verifyDebugAccessGrant(carrier.grant, sig, opts.ownerIrkPub)) {
    log("[debug-access] grant signature does not verify under the owner IRK; ignoring");
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
