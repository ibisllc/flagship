import { brokerActive, brokerCall } from "./rustStack/brokerClient.js";
import { execFile } from "node:child_process";
import { privd, runsUnprivileged } from "./privileged.js";
import { writeFileDurable } from "./durableFile.js";

/**
 * Lock & power-off (docs/lock-and-poweroff.md).
 *
 * One shared host-power primitive — poweroff / reboot — exposed two ways:
 *   1. The manual `power-off` PhoneOrder button (`/api/power`).
 *   2. The serving-authority lock (servingLock.ts), which fires the SAME
 *      primitive when the owner's `lock-server` policy lapses.
 *
 * Both paths SUPPRESS the silent auto-unlock BEFORE the host action so a
 * LUKS box lands at the phone-approval boot-unlock prompt rather than
 * quietly self-unlocking on the way back up. Suppression is local to the
 * box (the daemon does not hold the owner IRK and so cannot revoke the
 * `.com` auto-unlock lease itself).
 *
 * Suppression is ONE-SHOT, NOT a permanent mode flip. It drops a one-shot
 * marker file (`/boot/flagship-lock-once`) that the initramfs premount honours for
 * exactly the NEXT boot — it forces the phone-approval relay for that one
 * power cycle, then CONSUMES (deletes) the marker after a successful
 * unlock, so the box returns to its BASELINE `bootUnlockMode` (the
 * creation-time auto|approve the owner chose, in
 * `/boot/flagship-boot-unlock-mode`) on every boot thereafter. This makes a
 * manual "Lock and restart"/"Lock and turn off" tap a single-power-cycle
 * lock — the box comes back at the approve prompt once, then normal — and
 * never silently converts an `auto` box into a permanently approve-gated
 * one. If the baseline is already `approve`, the box always asks anyway and
 * the marker is a harmless no-op on top. The serving lock re-arms through a
 * fresh serving lease after coming back (NOT by any boot-mode change), so
 * both the manual button and the serving lock use this SAME one-shot
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
 * separate, transient file. The premount forces the phone-approval relay
 * for the NEXT boot when the marker is present, then deletes it after a
 * successful unlock, so the box reverts to its baseline mode afterwards.
 * A manual "Lock and restart" or a serving-lock lapse therefore locks for
 * exactly one power cycle rather than permanently flipping the box to
 * approve-on-every-boot.
 */
export class BootUnlockModeSuppressor implements AutoUnlockSuppressor {
  constructor(private readonly path = "/boot/flagship-lock-once") {}
  async suppress(): Promise<void> {
    // /boot is root's: an unprivileged daemon asks the broker for exactly this marker.
    if (runsUnprivileged()) {
      await privd().host("bootlock", []);
      return;
    }
    await writeFileDurable(this.path, "approve-once\n", 0o644);
  }
}

/** Default power runner: spawn systemctl. NEVER used in tests. */
export class SystemctlPowerRunner implements HostPowerRunner {
  async power(mode: "off" | "restart"): Promise<void> {
    const verb = mode === "off" ? "poweroff" : "reboot";
    // On the Rust path the broker owns host power; if it cannot be reached the daemon (still
    // root) does it itself, so a lock never fails for want of the broker.
    if (brokerActive()) {
      try {
        await brokerCall("power", { action: verb });
        return;
      } catch (e) {
        console.warn(`[power] the broker did not ${verb} the box (${(e as Error).message}); doing it directly`);
      }
    }
    if (runsUnprivileged()) return privd().power(verb).then(() => {});
    return await new Promise<void>((resolve, reject) => {
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
  let mode = args.mode;
  try {
    await args.suppressor.suppress();
  } catch (e) {
    // The one-shot marker could not be written (an unprivileged daemon cannot write /boot): a restart would come back
    // up on its auto-unlock lease, so it becomes a shutdown. Never a reboot into an unrevoked lease, never a 500.
    console.warn(`[power] the lock marker was not written (${(e as Error).message}); the box shuts down instead of restarting`);
    mode = "off";
  }
  const reason = args.reason ?? "manual-lock";
  let suspension: LockResult["suspension"] = "unavailable";
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
