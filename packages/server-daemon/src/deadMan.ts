import { execFile } from "node:child_process";
import {
  verifyDeadManAffirmation,
  verifySetDeadManPolicy,
  type AdminGrantView,
  type DeadManAffirmation,
  type SetDeadManPolicy,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { keepCorruptAside, readStateFile, writeFileDurable } from "./durableFile.js";

/**
 * Lock & power-off + dead-man heartbeat-lock (docs/lock-and-poweroff.md).
 *
 * One shared host-power primitive — poweroff / reboot — exposed two ways:
 *   1. The manual `power-off` PhoneOrder button.
 *   2. The dead-man enforcement timer, which fires the SAME primitive on
 *      lease lapse.
 *
 * Both paths SUPPRESS the silent auto-unlock BEFORE the host action so a
 * LUKS box lands at the phone-approval boot-unlock prompt rather than
 * quietly self-unlocking on the way back up. Suppression is local to the
 * box (the daemon does not hold the owner IRK and so cannot revoke the
 * `.com` auto-unlock lease itself).
 *
 * Suppression is ONE-SHOT, NOT a permanent mode flip. It drops a one-shot
 * marker file (`/boot/flagship-lock-once`) that boot-stage.sh honours for
 * exactly the NEXT boot — it forces the phone-approval relay for that one
 * power cycle, then CONSUMES (deletes) the marker after a successful
 * unlock, so the box returns to its BASELINE `bootUnlockMode` (the
 * creation-time auto|approve the owner chose, in
 * `/boot/flagship-boot-unlock-mode`) on every boot thereafter. This makes a
 * manual "Lock and restart"/"Lock and turn off" tap a single-power-cycle
 * lock — the box comes back at the approve prompt once, then normal — and
 * never silently converts an `auto` box into a permanently approve-gated
 * one. If the baseline is already `approve`, the box always asks anyway and
 * the marker is a harmless no-op on top. The dead-man re-arms by the user
 * re-affirming the LEASE after coming back (NOT by any boot-mode change),
 * so both the manual button and the dead-man timer use this SAME one-shot
 * suppressor.
 *
 * Everything time-, exec-, and FS-touching is injectable so tests never
 * run real `systemctl` or write the real boot partition.
 */

/** Runs the real host power action. Default spawns systemctl. */
export interface HostPowerRunner {
  /** mode "off" ⇒ `systemctl poweroff`; "restart" ⇒ `systemctl reboot`. */
  power(mode: "off" | "restart"): Promise<void>;
}

/** Suppresses the silent auto-unlock so the NEXT boot needs phone approval. */
export interface AutoUnlockSuppressor {
  suppress(): Promise<void>;
}

/**
 * Default suppressor: drop a ONE-SHOT lock marker at
 * `/boot/flagship-lock-once` (atomic write-then-rename). This does NOT
 * touch the box's baseline `/boot/flagship-boot-unlock-mode` — it is a
 * separate, transient file. boot-stage.sh forces the phone-approval relay
 * for the NEXT boot when the marker is present, then deletes it after a
 * successful unlock, so the box reverts to its baseline mode afterwards.
 * A manual "Lock and restart" or a dead-man lapse therefore locks for
 * exactly one power cycle rather than permanently flipping the box to
 * approve-on-every-boot.
 */
export class BootUnlockModeSuppressor implements AutoUnlockSuppressor {
  constructor(private readonly path = "/boot/flagship-lock-once") {}
  async suppress(): Promise<void> {
    await writeFileDurable(this.path, "approve-once\n", 0o644);
  }
}

/** Default power runner: spawn systemctl. NEVER used in tests. */
export class SystemctlPowerRunner implements HostPowerRunner {
  power(mode: "off" | "restart"): Promise<void> {
    const verb = mode === "off" ? "poweroff" : "reboot";
    return new Promise<void>((resolve, reject) => {
      execFile("systemctl", [verb], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/** Posts the set-only boot suspension (bootSuspensionClient.ts); injected so tests never touch a network. */
export interface BootSuspender {
  suspend(
    reason: "dead-man" | "manual-lock",
    deadlineMs: number,
  ): Promise<{ confirmed: true } | { confirmed: false; why: string }>;
}

/** How long a lock may wait on the boot worker before it stops waiting. */
export const SUSPEND_WAIT_OFF_MS = 3_000;
export const SUSPEND_WAIT_RESTART_MS = 15_000;

export interface LockResult {
  /** What the host was actually told to do. */
  mode: "off" | "restart";
  requestedMode: "off" | "restart";
  /**
   * "confirmed": the boot worker durably recorded the lock before we acted.
   * "unconfirmed": we could not confirm it (unreachable, refused, not durable)
   *   and a restart was therefore turned into a shutdown.
   * "unavailable": no boot-worker client is wired (an older config).
   */
  suspension: "confirmed" | "unconfirmed" | "unavailable";
}

/**
 * The shared lock primitive (SEC-LOCK-001): suppress the silent auto-unlock
 * locally, set the durable boot suspension, THEN run the host power action.
 *
 *  - "off" never waits long for the boot worker: the box shuts down within
 *    SUSPEND_WAIT_OFF_MS whether or not the worker answered, and the result
 *    says which. The owner's phone sets and retries its own suspension.
 *  - "restart" waits for a durable acknowledgement first. If it cannot be
 *    confirmed the box powers OFF instead: a reboot into a lease that was
 *    never revoked is exactly the hole this closes.
 *
 * The local marker stays only as a redundant signal; it is not the lock.
 */
export async function executeLockAndPower(args: {
  mode: "off" | "restart";
  suppressor: AutoUnlockSuppressor;
  runner: HostPowerRunner;
  suspender?: BootSuspender | null;
  reason?: "dead-man" | "manual-lock";
}): Promise<LockResult> {
  await args.suppressor.suppress();
  const reason = args.reason ?? "manual-lock";
  let suspension: LockResult["suspension"] = "unavailable";
  let mode = args.mode;
  if (args.suspender) {
    const attempt = args.suspender
      .suspend(reason, args.mode === "restart" ? SUSPEND_WAIT_RESTART_MS : SUSPEND_WAIT_OFF_MS)
      .catch(() => ({ confirmed: false as const, why: "error" }));
    const result =
      args.mode === "off"
        ? await Promise.race([attempt, new Promise<{ confirmed: false; why: string }>((r) => setTimeout(() => r({ confirmed: false, why: "timeout" }), SUSPEND_WAIT_OFF_MS))])
        : await attempt;
    suspension = result.confirmed ? "confirmed" : "unconfirmed";
    if (!result.confirmed && args.mode === "restart") mode = "off";
  } else if (args.mode === "restart") {
    // No way to lock the boot worker: never reboot into an unrevoked lease.
    mode = "off";
  }
  await args.runner.power(mode);
  return { mode, requestedMode: args.mode, suspension };
}

export interface DeadManPolicyState {
  enabled: boolean;
  windowMs: number;
  graceMs: number;
  lockoutMode: "off" | "restart";
}

interface PersistedDeadManState {
  policy: DeadManPolicyState;
  /** Wall-clock ms after which the lease is lapsed. 0 ⇒ never affirmed. */
  leaseExpiry: number;
  /** Nonces already consumed (hex), newest last; bounded. */
  usedNonces: string[];
}

const DEFAULT_POLICY: DeadManPolicyState = {
  enabled: false,
  windowMs: 24 * 3600_000,
  graceMs: 6 * 3600_000,
  lockoutMode: "off",
};

const MAX_REMEMBERED_NONCES = 256;

export interface DeadManControllerOptions {
  serverId: string;
  /** Owner IRK pubkey from daemon config; affirmations + policy verify against it. */
  irkPub: Uint8Array;
  /** Slice D — the pinned admin master root (`ServerConfig.adminRootPub`);
   *  present ⇒ policy/affirm are gated by `requireMasterAdmin`, absent ⇒ legacy
   *  owner-IRK verification (a strict no-op on pre-wipe boxes). */
  adminRootPub?: Uint8Array;
  /** This box's owner account (cfg.userId) — for the delegated-grant check. */
  username?: string;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
  suppressor: AutoUnlockSuppressor;
  runner: HostPowerRunner;
  /** Posts the STK-signed boot suspension when the switch fires. */
  suspender?: BootSuspender | null;
  /** Where the policy + lease state persist. Default `/var/flagship/deadman.json`. */
  statePath?: string;
  now?: () => number;
  /** Replay window for affirmations (and policy issuedAt). Default 5 min. */
  maxAgeMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  /** Enforcement poll cadence. Default 60s. */
  checkIntervalMs?: number;
}

/**
 * Owns the dead-man policy, the dead-man lease, and the enforcement timer.
 * Default-OFF: with no enabled policy there is NO timer and NO behavior
 * change. Enabling a policy (via a signed `SetDeadManPolicy`) starts the
 * timer; disabling it stops the timer.
 */
export class DeadManController {
  private readonly serverId: string;
  private readonly irkPub: Uint8Array;
  private readonly adminRootPub: Uint8Array | undefined;
  private readonly username: string;
  private readonly activeGrants: readonly AdminGrantView[];
  private readonly suppressor: AutoUnlockSuppressor;
  private readonly runner: HostPowerRunner;
  private readonly suspender: BootSuspender | null;
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly setIntervalImpl: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalImpl: (handle: unknown) => void;
  private readonly checkIntervalMs: number;

  private state: PersistedDeadManState = {
    policy: { ...DEFAULT_POLICY },
    leaseExpiry: 0,
    usedNonces: [],
  };
  private timer: unknown = null;
  private firing = false;
  private fired = false;

  constructor(opts: DeadManControllerOptions) {
    this.serverId = opts.serverId;
    this.irkPub = opts.irkPub;
    this.adminRootPub = opts.adminRootPub;
    this.username = opts.username ?? "";
    this.activeGrants = opts.activeGrants ?? [];
    this.suppressor = opts.suppressor;
    this.runner = opts.runner;
    this.suspender = opts.suspender ?? null;
    this.statePath = opts.statePath ?? "/var/flagship/deadman.json";
    this.now = opts.now ?? (() => Date.now());
    this.maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
    this.setIntervalImpl =
      opts.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalImpl = opts.clearIntervalImpl ?? ((h) => clearInterval(h as never));
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000;
  }

  /** Load persisted state from disk (best-effort) and arm the timer if enabled. */
  async start(): Promise<void> {
    await this.loadState();
    if (this.state.policy.enabled) this.armTimer();
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
  }

  policy(): DeadManPolicyState {
    return { ...this.state.policy };
  }

  leaseExpiry(): number {
    return this.state.leaseExpiry;
  }

  /**
   * Apply a verified `SetDeadManPolicy`. Verifies the IRK signature +
   * replay window, persists, and (re)arms or disarms the timer. Returns
   * false (no mutation) on a bad signature / stale request / bad params.
   *
   * Enabling sets a fresh lease (the owner just affirmed-by-enabling, and
   * the box would otherwise lock itself out immediately).
   */
  async applyPolicy(policy: SetDeadManPolicy, sig: Uint8Array): Promise<boolean> {
    if (policy.serverId !== this.serverId) return false;
    if (!Number.isFinite(policy.windowMs) || policy.windowMs <= 0) return false;
    if (!Number.isFinite(policy.graceMs) || policy.graceMs < 0) return false;
    if (Math.abs(this.now() - policy.issuedAt) > this.maxAgeMs) return false;
    if (
      !authorizeSensitiveOrder({
        order: policy,
        signature: sig,
        verify: verifySetDeadManPolicy,
        ownerIrkPub: this.irkPub,
        adminRootPub: this.adminRootPub,
        username: this.username,
        activeGrants: this.activeGrants,
      })
    ) {
      return false;
    }

    this.state.policy = {
      enabled: policy.enabled,
      windowMs: policy.windowMs,
      graceMs: policy.graceMs,
      lockoutMode: policy.lockoutMode,
    };
    if (policy.enabled) {
      this.state.leaseExpiry = this.now() + policy.windowMs;
      this.fired = false;
    }
    await this.saveState();

    this.stop();
    if (policy.enabled) this.armTimer();
    return true;
  }

  /**
   * Apply a verified `DeadManAffirmation` — extends the lease by the
   * policy window. Refuses a replayed nonce, a stale issuedAt, and a
   * wrong-key signature. No-op (returns false) when the policy is off.
   */
  async affirm(affirm: DeadManAffirmation, sig: Uint8Array): Promise<boolean> {
    if (!this.state.policy.enabled) return false;
    if (affirm.serverId !== this.serverId) return false;
    if (Math.abs(this.now() - affirm.issuedAt) > this.maxAgeMs) return false;
    const nonceHex = bytesToHex(affirm.nonce);
    if (this.state.usedNonces.includes(nonceHex)) return false;
    if (
      !authorizeSensitiveOrder({
        order: affirm,
        signature: sig,
        verify: verifyDeadManAffirmation,
        ownerIrkPub: this.irkPub,
        adminRootPub: this.adminRootPub,
        username: this.username,
        activeGrants: this.activeGrants,
      })
    ) {
      return false;
    }

    this.state.usedNonces.push(nonceHex);
    if (this.state.usedNonces.length > MAX_REMEMBERED_NONCES) {
      this.state.usedNonces = this.state.usedNonces.slice(-MAX_REMEMBERED_NONCES);
    }
    this.state.leaseExpiry = this.now() + this.state.policy.windowMs;
    this.fired = false;
    await this.saveState();
    return true;
  }

  /**
   * One enforcement check. When the policy is enabled and
   * `now > leaseExpiry + graceMs`, suppress-then-power per lockoutMode.
   * Idempotent within a single lapse (won't re-fire while powering off).
   * Exposed for deterministic tests; the timer calls it on each tick.
   */
  async checkOnce(): Promise<void> {
    if (!this.state.policy.enabled) return;
    if (this.firing || this.fired) return;
    const deadline = this.state.leaseExpiry + this.state.policy.graceMs;
    if (this.now() <= deadline) return;
    this.firing = true;
    try {
      await executeLockAndPower({
        mode: this.state.policy.lockoutMode,
        suppressor: this.suppressor,
        runner: this.runner,
        suspender: this.suspender,
        reason: "dead-man",
      });
      this.fired = true;
    } finally {
      this.firing = false;
    }
  }

  private armTimer(): void {
    if (this.timer !== null) return;
    this.timer = this.setIntervalImpl(() => {
      void this.checkOnce();
    }, this.checkIntervalMs);
  }

  private async loadState(): Promise<void> {
    const read = await readStateFile(this.statePath);
    if (read.kind === "missing") return; // never set: keep defaults (disabled)
    let obj: Partial<PersistedDeadManState>;
    try {
      if (read.kind === "unreadable") throw read.error;
      obj = JSON.parse(read.text) as Partial<PersistedDeadManState>;
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not a dead-man state object");
    } catch (e) {
      // The file only exists once the owner set a policy, so an unreadable
      // one means a dead-man switch we can no longer see. Fail closed: treat
      // it as on and lapsed now (restart into phone approval after the
      // default grace unless the owner affirms), and write that back so a
      // restart can't quietly turn it off.
      const now = this.now();
      this.state = {
        policy: { ...DEFAULT_POLICY, enabled: true, lockoutMode: "restart" },
        leaseExpiry: now,
        usedNonces: [],
      };
      const hours = Math.round(DEFAULT_POLICY.graceMs / 3600_000);
      await keepCorruptAside(
        this.statePath,
        e,
        `The dead-man switch is on and counts as missed: affirm it within ${hours} hours or the server restarts and asks your phone to unlock it.`,
      );
      await this.saveState().catch((we: Error) =>
        console.error(`[dead-man] couldn't write the fail-closed state: ${we.message}`),
      );
      return;
    }
    if (obj.policy && typeof obj.policy === "object") {
      this.state.policy = {
        enabled: Boolean(obj.policy.enabled),
        windowMs: Number(obj.policy.windowMs) || DEFAULT_POLICY.windowMs,
        graceMs: Number(obj.policy.graceMs) || DEFAULT_POLICY.graceMs,
        lockoutMode: obj.policy.lockoutMode === "restart" ? "restart" : "off",
      };
    }
    if (typeof obj.leaseExpiry === "number") this.state.leaseExpiry = obj.leaseExpiry;
    if (Array.isArray(obj.usedNonces)) {
      this.state.usedNonces = obj.usedNonces.filter((n): n is string => typeof n === "string");
    }
  }

  private async saveState(): Promise<void> {
    await writeFileDurable(this.statePath, JSON.stringify(this.state));
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
