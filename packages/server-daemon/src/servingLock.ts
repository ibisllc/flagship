/**
 * The box's half of the owner's one dead-man setting (docs/architecture-v2/issuance-and-lease-records.md §5,
 * serving-wiring.md §3). Under a `lock-server` policy, once no admin device has renewed within the grace, the box
 * restarts with its disk locked: the one-shot auto-unlock suppression and the boot worker's suspension, then a
 * restart into the phone-approval prompt (`executeLockAndPower`; a restart whose suspension the boot worker can't
 * confirm becomes a shutdown, as for the manual lock, because rebooting into an unrevoked auto-unlock lease would
 * not lock anything).
 *
 * The decision is `servingDecision` over the owner's verified records (servingStore.ts), never a flag from `.com`.
 * Two box-side rules sit on top of it:
 *
 *  - Arming: the box never locks sooner than one grace after the owner signed the policy (signing it is admin
 *    presence). A policy that reaches the box a moment before its first lease therefore doesn't lock it.
 *  - After an approved unlock: a lock writes `serving-lock.json` before it acts. The next boot came up only through
 *    an admin's phone approval (the suppression is one-shot), and the approving app signs a fresh lease at the same
 *    time, which reaches the box directly or on the next heartbeat. So the first time a box finds the marker it
 *    waits `approvalWindowMs` for that lease instead of locking at once; the start of that wait is written down, so
 *    a reboot can't start another one. A fresh lease clears the marker; without one the box locks again when the
 *    wait ends and needs another approval. No approval is granted a wait when the lock wasn't confirmed by the boot
 *    worker (the next boot may then not have needed an approval at all).
 */
import { servingDecision, type ServingGrace } from "@flagship/protocol";
import { executeLockAndPower, type AutoUnlockSuppressor, type BootSuspender, type HostPowerRunner } from "./hostPower.js";
import { keepCorruptAside, readStateFile, removeDurable, writeFileDurable } from "./durableFile.js";
import { policyGraceEnd, type ServingStore } from "./servingStore.js";

export const SERVING_LOCK_KIND = "server.serving.locked";
export const SERVING_APPROVAL_WINDOW_MS = 15 * 60_000;

interface LockMarker {
  lockedAt: number;
  regGen: number;
  policyGen: number;
  /** The boot worker durably recorded the suspension before the restart. */
  confirmed: boolean;
  /** When this box first ran after the lock (the post-approval wait starts here); null until then. */
  resumedAt: number | null;
}

export interface ServingLockOptions {
  store: Pick<ServingStore, "decisionInput" | "policy">;
  suppressor: AutoUnlockSuppressor;
  runner: HostPowerRunner;
  suspender: BootSuspender | null;
  /** `<dataDir>/serving-lock.json`. */
  markerPath: string;
  /** Writes the Activity entry (and should flush it: the box restarts next). */
  note: (kind: string, detail: string) => Promise<void> | void;
  now?: () => number;
  approvalWindowMs?: number;
  checkIntervalMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (h: unknown) => void;
  log?: (m: string) => void;
}

const GRACE_WORDS: Record<Exclude<ServingGrace, "indefinite">, string> = { "7d": "7 days", "30d": "30 days" };

export class ServingLockController {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly log: (m: string) => void;
  private marker: LockMarker | null = null;
  private loaded = false;
  private firing = false;
  private fired = false;
  private waitingLogged = false;
  private timer: unknown = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ServingLockOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.approvalWindowMs ?? SERVING_APPROVAL_WINDOW_MS;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  async start(): Promise<void> {
    await this.load();
    await this.checkOnce();
    if (this.timer !== null) return;
    const set = this.opts.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
    this.timer = set(() => void this.checkOnce(), this.opts.checkIntervalMs ?? 60_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    (this.opts.clearIntervalImpl ?? ((h) => clearInterval(h as never)))(this.timer);
    this.timer = null;
  }

  /** The marker this box holds after a serving lock (tests, diagnostics). */
  lockMarker(): Readonly<LockMarker> | null {
    return this.marker;
  }

  /** One check; the timer and every store change call it. Serialised, so overlapping calls never fire twice. */
  checkOnce(): Promise<void> {
    const run = this.chain.then(() => this.check());
    this.chain = run.catch((e) => this.log(`[serving] lock check failed: ${(e as Error).message}`));
    return this.chain;
  }

  private async check(): Promise<void> {
    if (!this.loaded) await this.load();
    if (this.firing || this.fired) return;
    const now = this.now();
    const input = this.opts.store.decisionInput(now);
    const policy = this.opts.store.policy()?.record ?? null;
    const d = input ? servingDecision(input) : null;
    if (!d || !policy || d.apps || !d.lock) {
      if (this.marker) await this.clearMarker(d?.apps ? "a fresh lease arrived" : "the policy no longer locks");
      return;
    }
    if (now < policyGraceEnd(policy, now)) return;

    if (this.marker) {
      if (this.marker.resumedAt === null) {
        if (!this.marker.confirmed) {
          this.log("[serving] the last lock wasn't confirmed by the boot worker: locking again without a wait");
        } else {
          this.marker = { ...this.marker, resumedAt: now };
          await writeFileDurable(this.opts.markerPath, JSON.stringify(this.marker));
          this.log(`[serving] back after a lock: waiting up to ${Math.round(this.windowMs / 60_000)} min for the approving admin's lease`);
          return;
        }
      } else if (now < this.marker.resumedAt + this.windowMs) {
        if (!this.waitingLogged) this.log("[serving] waiting for the approving admin's lease");
        this.waitingLogged = true;
        return;
      }
    }
    await this.fire(now, policy.regGen, policy.policyGen, policy.grace);
  }

  private async fire(now: number, regGen: number, policyGen: number, grace: ServingGrace): Promise<void> {
    this.firing = true;
    try {
      this.marker = { lockedAt: now, regGen, policyGen, confirmed: false, resumedAt: null };
      await writeFileDurable(this.opts.markerPath, JSON.stringify(this.marker));
      const span = grace === "indefinite" ? "its time limit" : GRACE_WORDS[grace];
      const line = `No admin opened Flagship for ${span}: the server restarts with its disk locked and starts again when an admin approves on their phone.`;
      this.log(`[serving] ${line}`);
      try {
        await this.opts.note(SERVING_LOCK_KIND, line);
      } catch {
        /* the lock never waits on its own log */
      }
      const suspender: BootSuspender | null = this.opts.suspender
        ? {
            suspend: async (reason, deadlineMs) => {
              const r = await this.opts.suspender!.suspend(reason, deadlineMs);
              if (r.confirmed && this.marker) {
                this.marker = { ...this.marker, confirmed: true };
                await writeFileDurable(this.opts.markerPath, JSON.stringify(this.marker)).catch(() => {});
              }
              return r;
            },
          }
        : null;
      const result = await executeLockAndPower({
        mode: "restart",
        suppressor: this.opts.suppressor,
        runner: this.opts.runner,
        suspender,
        reason: "dead-man",
      });
      this.fired = true;
      if (result.mode !== "restart") this.log("[serving] the boot worker couldn't confirm the lock: the server shuts down instead of restarting");
    } finally {
      this.firing = false;
    }
  }

  private async clearMarker(why: string): Promise<void> {
    this.marker = null;
    this.waitingLogged = false;
    await removeDurable(this.opts.markerPath).catch(() => {});
    this.log(`[serving] lock cleared: ${why}`);
  }

  private async load(): Promise<void> {
    this.loaded = true;
    const read = await readStateFile(this.opts.markerPath);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const o = JSON.parse(read.text) as Partial<LockMarker>;
      if (!o || typeof o.lockedAt !== "number") throw new Error("not a serving lock marker");
      this.marker = {
        lockedAt: o.lockedAt,
        regGen: Number(o.regGen) || 0,
        policyGen: Number(o.policyGen) || 0,
        confirmed: o.confirmed === true,
        resumedAt: typeof o.resumedAt === "number" ? o.resumedAt : null,
      };
    } catch (e) {
      // A marker we can't read grants no wait: the box locks again at once if the lease is still lapsed.
      await keepCorruptAside(this.opts.markerPath, e, "If no admin renewed in time, the server locks again at once.");
      this.marker = { lockedAt: 0, regGen: 0, policyGen: 0, confirmed: false, resumedAt: null };
    }
  }
}
