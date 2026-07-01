import { execFile } from "node:child_process";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  verifyDeadManAffirmation,
  verifySetDeadManPolicy,
  type AdminGrantView,
  type DeadManAffirmation,
  type SetDeadManPolicy,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";

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
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, "approve-once\n", { mode: 0o644 });
    await rename(tmp, this.path);
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

/**
 * The shared lock primitive: suppress the silent auto-unlock, THEN run the
 * host power action. The ordering is load-bearing — if the power action
 * raced ahead of suppression, a LUKS box could re-unlock silently. Callers
 * (the order executor + the dead-man timer) MUST go through this so the
 * ordering is enforced in one place.
 */
export async function executeLockAndPower(args: {
  mode: "off" | "restart";
  suppressor: AutoUnlockSuppressor;
  runner: HostPowerRunner;
}): Promise<void> {
  await args.suppressor.suppress();
  await args.runner.power(args.mode);
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
    try {
      const raw = await readFile(this.statePath, "utf8");
      const obj = JSON.parse(raw) as Partial<PersistedDeadManState>;
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
    } catch {
      // No prior state — keep defaults (disabled).
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(tmp, this.statePath);
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
