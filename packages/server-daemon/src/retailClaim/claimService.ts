// The retail claim service (docs/retail-box-setup.md §4, §7, §15): the radio window, the
// handshake, the timed press, the recipe, the receipt, the network and the reset window, wired
// to injectable parts so the whole claim runs on a VM or in a test with a fake radio and button.
//
// Order on the box, from the phone's point of view (§4):
//   hello/accept/finish/ready  the session (mode open: Bluetooth only; mode code: radio or mailbox)
//   arm → press                one short press inside the window (mode open only)
//   claim                      the recipe; the box verifies it, wipes a previous owner if any,
//                              makes its new key and answers with a receipt; from now on it is claimed
//   network                    only after the phone registered the box's key at `.com`; the box
//                              joins, reports the exact failure or goes online and registers

import { randomBytes } from "node:crypto";
import {
  BOX_CLAIM_FRAME_HANDSHAKE,
  BOX_CLAIM_FRAME_RECORD,
  BoxClaimError,
  acceptBoxClaim,
  completeBoxClaim,
  decodeClaimMessage,
  encodeClaimMessage,
  parsePhoneMessage,
  signBoxClaimReceipt,
  type BoxClaimAdvertState,
  type BoxClaimBoxMessage,
  type BoxClaimBoxPending,
  type BoxClaimChannel,
  type BoxClaimMode,
  type BoxClaimRefusal,
  type WiFiConfig,
  type WifiNetwork,
} from "@flagship/protocol";
import type { ClaimLifecycle, ClaimStateStore } from "./claimState.js";
import { BoxClaimMachine, type MachineOutput } from "./claimMachine.js";
import type { CodeDisplay } from "./codeDisplay.js";
import type { NetworkResult } from "./network.js";
import { PowerKeyBursts, type PowerKeySource } from "./powerKey.js";
import { RESET_LOCK_POINT, clearsResetMarkerOnWindowEnd, writesResetMarkerAt, type ResetLockPoint } from "./resetPolicy.js";
import { checkEntropy, type EntropyReader } from "./rngGate.js";
import type { SetupCodeStore } from "./setupCode.js";
import { MailboxLink, type ClaimLink, type ClaimPeripheral, type MailboxClient } from "./transport.js";

export type RecipeCheck = { ok: true; serverDomain: string; serial: string } | { ok: false; reason: "recipe-invalid" | "recipe-expired" };

/** The box's new server key, made at claim (keyd on a real box). */
export interface ClaimIdentity {
  stkHybridPubHex: string;
  bootKeyBindingSha256: string;
  sign(purpose: string, payload: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export type ClaimEvent = "reset-window-opened" | "reset-window-closed" | "claimed" | "radio-closed" | "locked";

export interface ClaimServiceDeps {
  now: () => number;
  bootAt: number;
  store: ClaimStateStore;
  codes: SetupCodeStore;
  peripheral: ClaimPeripheral;
  keys: PowerKeySource;
  display: CodeDisplay;
  /** Present when the box has internet without the phone (Ethernet): remote claims by code. */
  mailbox?: MailboxClient;
  entropy?: EntropyReader;
  verifyRecipe(text: string, now: number): RecipeCheck;
  createIdentity(recipe: { serverDomain: string; serial: string }): Promise<ClaimIdentity>;
  /** Crypto-erases the previous owner's volume and puts the factory image back. */
  wipe(): Promise<void>;
  network: { scan(): Promise<WifiNetwork[]>; connect(wifi: WiFiConfig | null): Promise<NetworkResult> };
  /** What an appliance does after reading its seed: per-box LUKS key, register at `.com`, first update. */
  provision(recipeText: string, identity: ClaimIdentity): Promise<void>;
  notify?(e: ClaimEvent): void;
  model: string;
  imageVersion: string;
  advertId?: string;
  resetLockPoint?: ResetLockPoint;
  /** After a receipt, a box whose phone went away provisions on its own after this long (Ethernet). */
  provisionFallbackMs?: number;
  codeDisplayMs?: number;
  mailboxPollMs?: number;
  log?: (m: string) => void;
}

interface Session {
  link: ClaimLink;
  mode: BoxClaimMode | null;
  pending: BoxClaimBoxPending | null;
  channel: BoxClaimChannel | null;
  recipe: string | null;
  identity: ClaimIdentity | null;
  receiptAt: number | null;
  online: boolean;
  queue: Promise<void>;
}

const MAX_LINKS = 4;

export class RetailClaimService {
  private machine!: BoxClaimMachine;
  private bursts!: PowerKeyBursts;
  private sessions = new Map<string, Session>();
  private advertising: BoxClaimAdvertState | null = null;
  private readonly advertId: string;
  private mailboxLink: MailboxLink | null = null;
  private lastMailboxPoll = 0;
  private displayUntil: number | null = null;
  private provisioned = false;
  private claimedSession: Session | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> = Promise.resolve();
  private readonly log: (m: string) => void;

  constructor(private readonly d: ClaimServiceDeps) {
    this.advertId = d.advertId ?? randomBytes(16).toString("hex");
    this.log = d.log ?? (() => {});
  }

  get lifecycle(): ClaimLifecycle {
    return this.machine.lifecycle;
  }

  get advertState(): BoxClaimAdvertState | null {
    return this.advertising;
  }

  async start(opts: { timer?: boolean } = {}): Promise<void> {
    const s = await this.d.store.load();
    this.machine = new BoxClaimMachine(s.lifecycle, this.d.bootAt);
    if (s.lifecycle === "locked") this.d.notify?.("locked");
    this.bursts = new PowerKeyBursts(this.d.bootAt, (b) => {
      this.enqueue(() => this.apply(this.machine.onBurst(b, this.d.now())));
    });
    this.d.peripheral.onLink((link) => this.attach(link));
    await this.d.keys.start((edge) => (edge === "down" ? this.bursts.keyDown(this.d.now()) : this.bursts.keyUp(this.d.now())));
    await this.tick();
    if (opts.timer !== false) this.timer = setInterval(() => void this.tick(), 250);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.d.keys.stop();
    await this.d.peripheral.stop();
    for (const s of this.sessions.values()) s.link.close();
  }

  /** Waits for every queued step (tests). */
  async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await this.busy;
      await Promise.all([...this.sessions.values()].map((s) => s.queue));
      await new Promise((r) => setImmediate(r));
    }
  }

  private enqueue(fn: () => Promise<void>): void {
    this.busy = this.busy.then(fn, fn).catch((e) => this.log(`[retail] ${(e as Error).message}`));
  }

  async tick(): Promise<void> {
    const now = this.d.now();
    this.bursts?.tick(now);
    await this.busy;
    await this.apply(this.machine.tick(now));
    await this.syncAdvert(now);
    if (this.displayUntil !== null && now >= this.displayUntil) {
      this.displayUntil = null;
      await this.d.display.clear().catch(() => {});
    }
    await this.pollMailbox(now);
    const c = this.claimedSession;
    if (c && !this.provisioned && c.receiptAt !== null && now - c.receiptAt >= (this.d.provisionFallbackMs ?? 120_000) && !this.sessions.has(c.link.id)) {
      await this.goOnline(c, null);
    }
  }

  private async syncAdvert(now: number): Promise<void> {
    const want = this.machine.advertState(now);
    if (want === this.advertising) return;
    this.advertising = want;
    if (want) {
      await this.d.peripheral.advertise({ id: this.advertId, state: want });
    } else {
      await this.d.peripheral.stop();
      for (const s of [...this.sessions.values()]) if (s !== this.claimedSession && s.link.kind === "ble") s.link.close();
    }
  }

  private async pollMailbox(now: number): Promise<void> {
    if (!this.d.mailbox) return;
    if (!this.machine.claimable(now, true)) {
      this.mailboxLink?.close();
      return;
    }
    if (now - this.lastMailboxPoll < (this.d.mailboxPollMs ?? 2_000)) return;
    this.lastMailboxPoll = now;
    const live = await this.d.codes.current(now);
    if (!live) {
      this.mailboxLink?.close();
      return;
    }
    if (!this.mailboxLink || this.mailboxLink.id !== `mailbox-${live.mailboxId.slice(0, 16)}`) {
      this.mailboxLink?.close();
      this.mailboxLink = new MailboxLink(`mailbox-${live.mailboxId.slice(0, 16)}`, this.d.mailbox, live.mailboxId, "box");
      const link = this.mailboxLink;
      link.onClose(() => {
        if (this.mailboxLink === link) this.mailboxLink = null;
      });
      this.attach(link);
    }
    await this.mailboxLink.poll().catch((e) => this.log(`[retail] mailbox: ${(e as Error).message}`));
  }

  private attach(link: ClaimLink): void {
    if (this.sessions.size >= MAX_LINKS) {
      link.close();
      return;
    }
    const s: Session = { link, mode: null, pending: null, channel: null, recipe: null, identity: null, receiptAt: null, online: false, queue: Promise.resolve() };
    this.sessions.set(link.id, s);
    link.onMessage((msg) => {
      s.queue = s.queue.then(() => this.onMessage(s, msg)).catch((e) => {
        this.log(`[retail] link ${link.id}: ${(e as Error).message}`);
        link.close();
      });
    });
    link.onClose(() => {
      this.sessions.delete(link.id);
      this.machine.linkClosed(link.id);
    });
  }

  private async sendRecord(s: Session, msg: BoxClaimBoxMessage): Promise<void> {
    if (!s.channel) return;
    await s.link.send(encodeClaimMessage(BOX_CLAIM_FRAME_RECORD, s.channel.sealJson(msg)));
  }

  private async sendHandshake(s: Session, obj: unknown): Promise<void> {
    await s.link.send(encodeClaimMessage(BOX_CLAIM_FRAME_HANDSHAKE, new TextEncoder().encode(JSON.stringify(obj))));
  }

  private refuse(s: Session, reason: BoxClaimRefusal): Promise<void> {
    return this.sendRecord(s, { t: "refused", reason });
  }

  private async onMessage(s: Session, raw: Uint8Array): Promise<void> {
    const now = this.d.now();
    const { kind, payload } = decodeClaimMessage(raw);
    if (kind === BOX_CLAIM_FRAME_HANDSHAKE) {
      const obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as { t?: unknown; mode?: unknown };
      if (obj.t === "hello") return this.onHello(s, obj, now);
      if (obj.t === "finish") return this.onFinish(s, obj, now);
      throw new Error("unexpected handshake message");
    }
    if (!s.channel) throw new Error("record before the session opened");
    const m = parsePhoneMessage(s.channel.openJson(payload));
    switch (m.t) {
      case "arm":
        if (s.mode === "code") return this.sendRecord(s, { t: "press-result", ok: true });
        return this.apply(this.machine.arm(s.link.id, now));
      case "wifi-scan":
        return this.sendRecord(s, { t: "wifi-list", networks: await this.d.network.scan().catch(() => []) });
      case "claim":
        return this.onClaim(s, m.recipe, now);
      case "network":
        if (s.receiptAt === null || s !== this.claimedSession) return this.refuse(s, "out-of-order");
        return this.goOnline(s, m.wifi);
      case "abort":
        s.link.close();
        return;
    }
  }

  private async onHello(s: Session, hello: unknown, now: number): Promise<void> {
    if (s.receiptAt !== null) throw new Error("hello after the claim");
    const mode = (hello as { mode?: unknown }).mode;
    if (s.link.kind === "mailbox" && mode !== "code") throw new Error("the mailbox takes only mode code");
    if (!this.machine.claimable(now, mode === "code")) throw new Error("not claimable now");
    const state = this.machine.advertState(now) ?? (this.machine.lifecycle === "unclaimed" ? "unclaimed" : "reset-window");
    if (this.d.entropy && !checkEntropy(this.d.entropy).ok) throw new Error("entropy below the gate");
    const live = await this.d.codes.current(now);
    try {
      const { accept, pending } = acceptBoxClaim({ hello, state, codeKey: live?.codeKey ?? null });
      s.pending = pending;
      s.channel = null;
      s.mode = pending.mode;
      await this.sendHandshake(s, accept);
    } catch (e) {
      if (e instanceof BoxClaimError) throw new Error(`hello refused: ${e.code}`);
      throw e;
    }
  }

  private async onFinish(s: Session, finish: unknown, now: number): Promise<void> {
    const p = s.pending;
    if (!p) throw new Error("finish without hello");
    s.pending = null;
    try {
      const { ready, channel } = completeBoxClaim(p, finish);
      s.channel = channel;
      await this.sendHandshake(s, ready);
      if (s.mode === "code") this.machine.grantForCode(s.link.id, now);
    } catch (e) {
      if (e instanceof BoxClaimError && e.code === "wrong-code") await this.apply(this.machine.onCodeFailure());
      throw e;
    }
  }

  private async onClaim(s: Session, recipe: string, now: number): Promise<void> {
    if (s.receiptAt !== null) return this.refuse(s, "out-of-order");
    if (!this.machine.takeGrant(s.link.id, now)) return this.refuse(s, "no-grant");
    const check = this.d.verifyRecipe(recipe, now);
    if (!check.ok) return this.refuse(s, check.reason);
    const point = this.d.resetLockPoint ?? RESET_LOCK_POINT;
    const previous = this.machine.lifecycle;
    if (previous !== "unclaimed") {
      if (writesResetMarkerAt("wipe-start", point)) await this.d.store.writeResetMarker({ v: 1, startedAt: now, step: "wipe-start" });
      this.machine.locked();
      this.d.notify?.("locked");
      await this.d.wipe();
      await this.d.codes.ratchet("wipe");
    }
    const identity = await this.d.createIdentity({ serverDomain: check.serverDomain, serial: check.serial });
    const receipt = await signBoxClaimReceipt(
      {
        mode: s.mode!,
        serverDomain: check.serverDomain,
        serial: check.serial,
        stkHybridPub: identity.stkHybridPubHex,
        bootKeyBindingSha256: identity.bootKeyBindingSha256,
        model: this.d.model,
        imageVersion: this.d.imageVersion,
        transcript: s.channel!.transcriptHex,
        issuedAt: now,
      },
      identity.sign,
    );
    await this.d.store.markClaimed(now);
    if (previous !== "unclaimed") await this.d.store.clearResetMarker();
    this.machine.claimed();
    await this.d.codes.ratchet("claim");
    s.recipe = recipe;
    s.identity = identity;
    s.receiptAt = now;
    this.claimedSession = s;
    this.provisioned = false;
    this.d.notify?.("claimed");
    await this.sendRecord(s, { t: "receipt", receipt });
    await this.syncAdvert(now);
  }

  private async goOnline(s: Session, wifi: WiFiConfig | null): Promise<void> {
    if (s.online) return;
    const via = wifi ? "wifi" : "ethernet";
    if (this.sessions.has(s.link.id)) await this.sendRecord(s, { t: "network-status", stage: "connecting", via });
    const r = await this.d.network.connect(wifi);
    if (!r.ok) {
      if (this.sessions.has(s.link.id)) await this.sendRecord(s, { t: "network-status", stage: "failed", via: r.via, failure: r.failure });
      if (!this.sessions.has(s.link.id)) s.receiptAt = this.d.now();
      return;
    }
    s.online = true;
    if (this.sessions.has(s.link.id)) await this.sendRecord(s, { t: "network-status", stage: "online", via: r.via });
    if (!this.provisioned && s.recipe && s.identity) {
      this.provisioned = true;
      await this.d.provision(s.recipe, s.identity);
    }
  }

  private async apply(out: MachineOutput): Promise<void> {
    for (const { link, msg } of out.send) {
      const s = this.sessions.get(link);
      if (s) await this.sendRecord(s, msg).catch(() => s.link.close());
    }
    const point = this.d.resetLockPoint ?? RESET_LOCK_POINT;
    for (const e of out.effects) {
      const now = this.d.now();
      switch (e) {
        case "show-code": {
          const { code, live } = await this.d.codes.issue(now);
          await this.d.display.show(code, live.expiresAt).catch(() => {});
          this.displayUntil = now + (this.d.codeDisplayMs ?? 10 * 60_000);
          this.lastMailboxPoll = 0;
          break;
        }
        case "reset-window-opened":
          await this.d.codes.ratchet("reset");
          if (writesResetMarkerAt("reset-gesture", point)) await this.d.store.writeResetMarker({ v: 1, startedAt: now, step: "reset-gesture" });
          this.d.notify?.("reset-window-opened");
          break;
        case "reset-window-closed":
          if (clearsResetMarkerOnWindowEnd(point) && this.machine.lifecycle === "claimed") await this.d.store.clearResetMarker();
          this.d.notify?.("reset-window-closed");
          break;
        case "radio-closed":
          this.advertising = null;
          await this.d.peripheral.stop();
          this.mailboxLink?.close();
          this.d.notify?.("radio-closed");
          break;
      }
    }
  }
}
