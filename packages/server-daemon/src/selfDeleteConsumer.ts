import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  verifyServersSelfDelete,
  type AdminGrantView,
  type ServersSelfDelete,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";

const execFileP = promisify(execFile);

/**
 * Box-side execution of the account-death content-wipe order
 * (docs/account-deletion-and-name-reclaim.md §5).
 *
 * When the owner deletes their account from their LAST device and opts in to
 * "ask all my servers to delete their content", `.com` deposits an
 * owner-IRK-signed `servers-self-delete` order into the box's `self-delete`
 * mailbox lane (one per owned server) during the bundle commit. This module is
 * the box's consumer: it polls that lane on the daemon heartbeat cadence,
 * RE-VERIFIES the order under the config-pinned owner IRK (`.com` is never a
 * trust anchor — invariants I1–I3), and on success wipes the box's content.
 *
 * Safety:
 *   - The carrier is the PUBLIC owner-IRK-signed order, so a public consume-once
 *     GET reveals nothing forgeable — a relay holds no IRK.
 *   - We act ONLY when the signature verifies under OUR owner IRK AND the order
 *     names OUR account. A forged/mismatched/stale order is ignored (best-effort
 *     — never a crash, never a wipe-on-bad-input).
 *   - Idempotent: a local marker records that a wipe ran, so a re-poll (or a
 *     reboot mid-wipe) never re-wipes. `.com`'s consume-once is the primary
 *     guard; the marker is belt-and-suspenders.
 */

const HEX = /^[0-9a-f]+$/;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decode the deposited `self-delete` carrier hex (UTF-8 JSON of the
 * `{request:{username,issuedAt},signature}` envelope) into a VERIFIED
 * `servers-self-delete` order. Throws with a specific reason on any defect —
 * the caller maps that to "ignore, don't wipe".
 *
 * Verifies, in order: the carrier is valid hex → UTF-8 → JSON with the expected
 * fields; the order names THIS account (case-insensitive); the signature
 * verifies under the OWNER IRK (never anything `.com` asserts).
 */
export function decodeAndVerifySelfDeleteCarrier(args: {
  sealedHex: string;
  ownerIrkPub: Uint8Array;
  username: string;
  /** Slice D — pinned admin master root; present ⇒ authority gate, absent ⇒ legacy owner-IRK. */
  adminRootPub?: Uint8Array;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
}): ServersSelfDelete {
  const hex = args.sealedHex.toLowerCase();
  if (!HEX.test(hex) || hex.length % 2 !== 0) {
    throw new Error("self-delete carrier is not valid hex");
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(hex));
  } catch {
    throw new Error("self-delete carrier hex is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`self-delete carrier is not valid JSON: ${(e as Error).message}`);
  }
  const p = parsed as {
    request?: { username?: unknown; issuedAt?: unknown };
    signature?: unknown;
  };
  if (
    !p.request ||
    typeof p.request.username !== "string" ||
    typeof p.request.issuedAt !== "number" ||
    typeof p.signature !== "string" ||
    !HEX.test(p.signature.toLowerCase())
  ) {
    throw new Error("self-delete carrier is missing required fields");
  }
  // Bind to THIS account — a relay can't aim a different account's order at us
  // (the signature would fail anyway, but this is a cheap explicit guard).
  if (p.request.username.toLowerCase() !== args.username.toLowerCase()) {
    throw new Error(
      `self-delete order names ${p.request.username}, not this box's owner ${args.username}`,
    );
  }
  const order: ServersSelfDelete = {
    username: p.request.username,
    issuedAt: p.request.issuedAt,
  };
  let sig: Uint8Array;
  try {
    sig = hexToBytes(p.signature.toLowerCase());
  } catch {
    throw new Error("self-delete signature is not valid hex");
  }
  if (
    !authorizeSensitiveOrder({
      order,
      signature: sig,
      verify: verifyServersSelfDelete,
      ownerIrkPub: args.ownerIrkPub,
      adminRootPub: args.adminRootPub,
      username: args.username,
      activeGrants: args.activeGrants,
    })
  ) {
    throw new Error("self-delete signature is not authorized (admin root / owner IRK)");
  }
  return order;
}

/** Records that a wipe already ran, so the consumer never re-wipes. */
export interface SelfDeleteMarkerStore {
  has(): Promise<boolean>;
  mark(order: ServersSelfDelete): Promise<void>;
}

/** Default file-backed marker (a small JSON sentinel under the data dir). */
export function fileMarkerStore(markerPath: string): SelfDeleteMarkerStore {
  return {
    async has() {
      try {
        await readFile(markerPath, "utf-8");
        return true;
      } catch {
        return false;
      }
    },
    async mark(order) {
      await writeFile(
        markerPath,
        JSON.stringify({ wipedAt: order.issuedAt, username: order.username }),
        { mode: 0o600 },
      );
    },
  };
}

export interface ClaimAndRunSelfDeleteOptions {
  /** This box's canonical FQDN. */
  serverDomain: string;
  /** The owner IRK pubkey (baked into the config) — the order is verified
   *  against THIS, never against anything `.com` asserts. */
  ownerIrkPub: Uint8Array;
  /** Slice D — the pinned admin master root (`ServerConfig.adminRootPub`);
   *  present ⇒ the order is gated by `requireMasterAdmin`, absent ⇒ legacy
   *  owner-IRK verification (a strict no-op on pre-wipe boxes). */
  adminRootPub?: Uint8Array;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
  /** This box's owner account (cfg.userId) — the order must name it. */
  username: string;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /**
   * The destructive content wipe. Best-effort + idempotent. Injected so the
   * consume/verify logic is testable without touching disk; the daemon wires a
   * real data-services teardown (see index.ts).
   */
  wipeContent: () => Promise<void>;
  /** Optional power-off after a successful wipe (e.g. lock + poweroff). */
  powerOff?: () => Promise<void>;
  /** Idempotency marker store (default file-backed at markerPath). */
  markerStore: SelfDeleteMarkerStore;
  fetchImpl?: typeof fetch;
  onLog?: (m: string) => void;
}

export type SelfDeleteOutcome =
  | { wiped: false; reason: "already-wiped" | "no-order" | "rejected" | "error" }
  | { wiped: true };

/**
 * One poll: claim a deposited self-delete order, verify it, and (on success)
 * wipe + mark + optionally power off. Never throws — returns an outcome.
 */
export async function claimAndRunSelfDelete(
  opts: ClaimAndRunSelfDeleteOptions,
): Promise<SelfDeleteOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});

  // Belt-and-suspenders: if a prior boot already wiped, never do it again.
  try {
    if (await opts.markerStore.has()) return { wiped: false, reason: "already-wiped" };
  } catch {
    /* a missing/unreadable marker is treated as "not yet wiped" */
  }

  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/self-delete`;

  let sealedHex: string | undefined;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { wiped: false, reason: "no-order" };
    if (!res.ok) {
      log(`[self-delete] GET ${res.status}; ignoring`);
      return { wiped: false, reason: "error" };
    }
    const body = (await res.json()) as { sealed?: string };
    sealedHex = body?.sealed;
  } catch (e) {
    log(`[self-delete] GET failed: ${(e as Error).message}`);
    return { wiped: false, reason: "error" };
  }

  if (typeof sealedHex !== "string" || sealedHex.length === 0) {
    log("[self-delete] order missing carrier; ignoring");
    return { wiped: false, reason: "rejected" };
  }

  let order: ServersSelfDelete;
  try {
    order = decodeAndVerifySelfDeleteCarrier({
      sealedHex,
      ownerIrkPub: opts.ownerIrkPub,
      username: opts.username,
      ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
      ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
    });
  } catch (e) {
    log(`[self-delete] order rejected: ${(e as Error).message}`);
    return { wiped: false, reason: "rejected" };
  }

  log(
    `[self-delete] verified owner-IRK content-wipe order for ${opts.username}; wiping content`,
  );
  try {
    await opts.wipeContent();
  } catch (e) {
    // The wipe is best-effort; record the marker anyway so we don't loop, and
    // surface the failure in the log. (A partial wipe is acceptable — the
    // account is already dead and the box will be reburned.)
    log(`[self-delete] wipeContent failed (continuing): ${(e as Error).message}`);
  }
  try {
    await opts.markerStore.mark(order);
  } catch (e) {
    log(`[self-delete] failed to write wipe marker: ${(e as Error).message}`);
  }
  if (opts.powerOff) {
    try {
      await opts.powerOff();
    } catch (e) {
      log(`[self-delete] powerOff failed: ${(e as Error).message}`);
    }
  }
  return { wiped: true };
}

/**
 * The production content wipe: stop the data-services stack and tear it down
 * WITH its volumes (`docker compose down -v` removes the postgres/minio/redis/
 * forgejo data that IS the box's content), then drop the per-app data dir. Each
 * step is independent + best-effort via execFile (argv, no shell) — a missing
 * docker / already-stopped unit is not an error. The encrypted root volume +
 * the LUKS re-seal/reburn are out of scope here (deferred to transfer-a-box);
 * this wipes the live content, which is what the §5 order asks for.
 */
export async function realWipeContent(
  composePath = "/opt/flagship/installer/data-services/docker-compose.yml",
  dataDir = process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship",
): Promise<void> {
  const run = async (cmd: string, args: string[]): Promise<void> => {
    try {
      await execFileP(cmd, args, { timeout: 120_000 });
    } catch (e) {
      console.log(`[self-delete] ${cmd} ${args.join(" ")} failed (continuing): ${(e as Error).message}`);
    }
  };
  await run("systemctl", ["stop", "flagship-data-services"]);
  await run("docker", ["compose", "-f", composePath, "down", "-v", "--remove-orphans"]);
  // Best-effort prune of any dangling app volumes the compose teardown missed.
  await run("docker", ["volume", "prune", "-f"]);
  // Remove the daemon's per-app data tree (sealed creds, build workspaces, …).
  await run("rm", ["-rf", `${dataDir}/data`]);
}

export interface SelfDeletePoller {
  pollOnce(): Promise<SelfDeleteOutcome>;
  start(): void;
  stop(): void;
}

/**
 * Poll the self-delete lane on the daemon heartbeat cadence (default 5 min).
 * Stops itself after a wipe (there is nothing more to do) or after an
 * already-wiped result. Mirrors buildRevocationPoller's start/stop shape; the
 * timer is unref'd so it never keeps the process alive on its own.
 */
export function buildSelfDeletePoller(
  opts: ClaimAndRunSelfDeleteOptions & { intervalMs?: number },
): SelfDeletePoller {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<SelfDeleteOutcome> {
    const out = await claimAndRunSelfDelete(opts);
    if (out.wiped || (!out.wiped && out.reason === "already-wiped")) stop();
    return out;
  }
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  return {
    pollOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop,
  };
}
