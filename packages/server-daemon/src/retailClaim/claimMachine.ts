// The claim rules of a retail box (docs/retail-box-setup.md §7.2, §7.4, §7.5, §7.8), pure: the
// service feeds it the clock, the links' requests and the power key's bursts, and sends what it
// returns. Nothing here touches disk, radio or crypto.

import {
  BOX_CLAIM_ADVERTISE_MS,
  BOX_CLAIM_GRANT_MS,
  BOX_CLAIM_MAX_CODE_FAILURES,
  BOX_CLAIM_PRESS_WINDOW_MS,
  BOX_CLAIM_RESET_WINDOW_MS,
  POWER_KEY_BURST_CLAIM,
  POWER_KEY_BURST_RESET,
  POWER_KEY_BURST_SHOW_CODE,
  type BoxClaimAdvertState,
  type BoxClaimBoxMessage,
  type PressRefusal,
} from "@flagship/protocol";
import type { ClaimLifecycle } from "./claimState.js";
import type { PowerKeyBurst } from "./powerKey.js";

export interface MachineOutput {
  /** Messages for links, by link id. */
  send: Array<{ link: string; msg: BoxClaimBoxMessage }>;
  /** Things the service does once. */
  effects: Array<"show-code" | "reset-window-opened" | "reset-window-closed" | "radio-closed">;
}

const none = (): MachineOutput => ({ send: [], effects: [] });

export class BoxClaimMachine {
  private armed: { link: string; at: number } | null = null;
  private lastArm: { link: string; at: number } | null = null;
  private grant: { link: string; until: number; byCode: boolean } | null = null;
  private resetWindowUntil: number | null = null;
  private codeFailures = 0;
  private radioClosed = false;
  private advertiseFrom: number;

  constructor(
    private lifecycleNow: ClaimLifecycle,
    bootAt: number,
  ) {
    this.advertiseFrom = bootAt;
  }

  get lifecycle(): ClaimLifecycle {
    return this.lifecycleNow;
  }

  get resetWindowOpen(): boolean {
    return this.resetWindowUntil !== null;
  }

  /** What to advertise, or null for silence. */
  advertState(now: number): BoxClaimAdvertState | null {
    if (this.radioClosed) return null;
    if (this.resetWindowUntil !== null && now < this.resetWindowUntil) return "reset-window";
    if (this.lifecycleNow === "unclaimed" && now - this.advertiseFrom < BOX_CLAIM_ADVERTISE_MS) return "unclaimed";
    return null;
  }

  /**
   * A claim can be started. Over the radio only inside its windows. A claim by setup code (the
   * sharing method) also works later on an unclaimed box, for as long as the code lives; on a
   * claimed box only inside the reset window, which is what its owner was told.
   */
  claimable(now: number, byCode = false): boolean {
    if (this.advertState(now) !== null) return true;
    return byCode && !this.radioClosed && this.lifecycleNow === "unclaimed";
  }

  arm(link: string, now: number): MachineOutput {
    const out = none();
    if (!this.claimable(now)) {
      out.send.push({ link, msg: { t: "press-result", ok: false, reason: "not-armed" } });
      return out;
    }
    const recent = this.lastArm && this.lastArm.link !== link && now - this.lastArm.at < BOX_CLAIM_PRESS_WINDOW_MS;
    if (recent) {
      const other = this.lastArm!.link;
      this.armed = null;
      if (this.grant && (this.grant.link === other || this.grant.link === link)) this.grant = null;
      this.lastArm = { link, at: now };
      out.send.push({ link: other, msg: { t: "press-result", ok: false, reason: "contention" } });
      out.send.push({ link, msg: { t: "press-result", ok: false, reason: "contention" } });
      return out;
    }
    if (this.armed && this.armed.link === link) {
      out.send.push({ link, msg: { t: "press-result", ok: false, reason: "busy" } });
      return out;
    }
    this.armed = { link, at: now };
    this.lastArm = { link, at: now };
    out.send.push({ link, msg: { t: "armed" } });
    return out;
  }

  onBurst(b: PowerKeyBurst, now: number): MachineOutput {
    const out = none();
    if (this.armed) {
      const a = this.armed;
      if (b.startedAt < a.at) return out;
      this.armed = null;
      const atMs = b.startedAt - a.at;
      out.send.push({ link: a.link, msg: { t: "press", atMs, count: b.count, long: b.long } });
      let refusal: PressRefusal | null = null;
      if (b.count !== POWER_KEY_BURST_CLAIM) refusal = "burst";
      else if (b.long) refusal = "long-press";
      else if (atMs > BOX_CLAIM_PRESS_WINDOW_MS) refusal = "late";
      if (refusal) {
        out.send.push({ link: a.link, msg: { t: "press-result", ok: false, reason: refusal } });
      } else {
        this.grant = { link: a.link, until: now + BOX_CLAIM_GRANT_MS, byCode: false };
        out.send.push({ link: a.link, msg: { t: "press-result", ok: true } });
      }
      return out;
    }
    if (b.long) return out;
    const inWindow = this.claimable(now);
    if (b.count === POWER_KEY_BURST_SHOW_CODE && inWindow) {
      out.effects.push("show-code");
    } else if (b.count === POWER_KEY_BURST_RESET && (this.lifecycleNow === "claimed" || this.lifecycleNow === "locked")) {
      const wasOpen = this.resetWindowUntil !== null;
      this.resetWindowUntil = now + BOX_CLAIM_RESET_WINDOW_MS;
      this.radioClosed = false;
      this.codeFailures = 0;
      if (!wasOpen) out.effects.push("reset-window-opened");
    } else if (b.count === POWER_KEY_BURST_RESET && this.lifecycleNow === "unclaimed") {
      this.advertiseFrom = now;
      this.radioClosed = false;
      this.codeFailures = 0;
    }
    return out;
  }

  tick(now: number): MachineOutput {
    const out = none();
    if (this.armed && now - this.armed.at > BOX_CLAIM_PRESS_WINDOW_MS) {
      out.send.push({ link: this.armed.link, msg: { t: "press-result", ok: false, reason: "no-press" } });
      this.armed = null;
    }
    if (this.grant && now >= this.grant.until) this.grant = null;
    if (this.resetWindowUntil !== null && now >= this.resetWindowUntil) {
      this.resetWindowUntil = null;
      out.effects.push("reset-window-closed");
    }
    return out;
  }

  /** A code-mode session needs no press: the code is the proof (§15.1). */
  grantForCode(link: string, now: number): void {
    this.grant = { link, until: now + BOX_CLAIM_GRANT_MS, byCode: true };
  }

  /** Takes the link's grant if it has a live one; one claim per grant. */
  takeGrant(link: string, now: number): boolean {
    if (!this.grant || this.grant.link !== link || now >= this.grant.until || !this.claimable(now, this.grant.byCode)) return false;
    this.grant = null;
    return true;
  }

  /** A wrong code (radio or mailbox). Too many close the radio until the next power-on. */
  onCodeFailure(): MachineOutput {
    const out = none();
    this.codeFailures++;
    if (this.codeFailures >= BOX_CLAIM_MAX_CODE_FAILURES && !this.radioClosed) {
      this.radioClosed = true;
      this.armed = null;
      this.grant = null;
      out.effects.push("radio-closed");
    }
    return out;
  }

  linkClosed(link: string): void {
    if (this.armed?.link === link) this.armed = null;
    if (this.grant?.link === link) this.grant = null;
  }

  /** The claim completed: the box is claimed and silent. */
  claimed(): void {
    this.lifecycleNow = "claimed";
    this.resetWindowUntil = null;
    this.armed = null;
    this.grant = null;
    this.lastArm = null;
  }

  /** A wipe began (the reset marker is down). */
  locked(): void {
    this.lifecycleNow = "locked";
  }

  /** Released by its owner and wiped: unclaimed, with a fresh window from now. */
  released(now: number): void {
    this.lifecycleNow = "unclaimed";
    this.advertiseFrom = now;
    this.radioClosed = false;
    this.resetWindowUntil = null;
    this.armed = null;
    this.grant = null;
    this.lastArm = null;
    this.codeFailures = 0;
  }
}
