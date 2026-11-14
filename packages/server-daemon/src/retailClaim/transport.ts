// How claim messages reach the box (docs/retail-box-setup.md §11.1, §13.2 item 2). The claim
// service only sees `ClaimLink`s: whole messages (`encodeClaimMessage`) in order. A Bluetooth
// transport splits them into BLE-sized frames; the remote claim carries them through the blind
// `.com` mailbox keyed by a hash of the setup code (§15.1).
//
// Built here: the interfaces, an in-memory radio for tests (it runs the real fragmentation at a
// BLE MTU), and the mailbox link. Still to build: the BlueZ GATT peripheral over D-Bus, testable
// on Linux with BlueZ's virtual controller (btvirt over vhci).

import {
  BOX_CLAIM_MAILBOX_ID,
  ClaimFrameReassembler,
  fragmentClaimMessage,
  type BoxClaimAdvertState,
} from "@flagship/protocol";

export interface ClaimLink {
  readonly id: string;
  readonly kind: "ble" | "mailbox";
  send(msg: Uint8Array): Promise<void>;
  onMessage(cb: (msg: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface ClaimAdvert {
  /** Random per boot; never a serial, MAC or model. */
  id: string;
  state: BoxClaimAdvertState;
}

export interface ClaimPeripheral {
  /** Starts or updates the advert. */
  advertise(adv: ClaimAdvert): Promise<void>;
  /** Stops the advert and drops every link. */
  stop(): Promise<void>;
  onLink(cb: (link: ClaimLink) => void): void;
}

/** A default ATT MTU most phones negotiate up from; frames carry one flag byte. */
export const BLE_FRAME_MTU = 185;

class Pipe {
  private handlers: Array<(m: Uint8Array) => void> = [];
  private closers: Array<() => void> = [];
  private queue: Uint8Array[] = [];
  closed = false;

  deliver(m: Uint8Array): void {
    if (this.closed) return;
    if (this.handlers.length === 0) this.queue.push(m);
    for (const h of this.handlers) h(m);
  }
  on(cb: (m: Uint8Array) => void): void {
    this.handlers.push(cb);
    const q = this.queue;
    this.queue = [];
    for (const m of q) cb(m);
  }
  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closers.push(cb);
  }
  shut(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.closers) c();
  }
}

class FramedLink implements ClaimLink {
  readonly kind = "ble" as const;
  private readonly reassembler = new ClaimFrameReassembler();
  constructor(
    readonly id: string,
    private readonly inbox: Pipe,
    private readonly outbox: Pipe,
    private readonly mtu: number,
    private readonly onFrame?: (f: Uint8Array) => void,
  ) {}
  async send(msg: Uint8Array): Promise<void> {
    if (this.outbox.closed) throw new Error("link closed");
    for (const f of fragmentClaimMessage(msg, this.mtu)) {
      this.onFrame?.(f);
      this.outbox.deliver(f);
    }
  }
  onMessage(cb: (msg: Uint8Array) => void): void {
    this.inbox.on((frame) => {
      let whole: Uint8Array | null;
      try {
        whole = this.reassembler.push(frame);
      } catch {
        this.close();
        return;
      }
      if (whole) cb(whole);
    });
  }
  onClose(cb: () => void): void {
    this.inbox.onClose(cb);
  }
  close(): void {
    this.inbox.shut();
    this.outbox.shut();
  }
}

/**
 * A radio in memory: one box peripheral, any number of phones. Adverts are visible to `scan()`
 * like a BLE scan result; `connect` opens a link whose frames go through the real fragmenter.
 * `tap` sees every frame both ways (tests check nothing readable crosses the air).
 */
export class InMemoryBleRadio {
  private advert: ClaimAdvert | null = null;
  private linkCb: ((l: ClaimLink) => void) | null = null;
  private links: FramedLink[] = [];
  private seq = 0;
  readonly frames: Uint8Array[] = [];

  constructor(private readonly mtu = BLE_FRAME_MTU) {}

  peripheral(): ClaimPeripheral {
    return {
      advertise: async (adv) => {
        this.advert = { ...adv };
      },
      stop: async () => {
        this.advert = null;
        for (const l of this.links) l.close();
        this.links = [];
      },
      onLink: (cb) => {
        this.linkCb = cb;
      },
    };
  }

  scan(): ClaimAdvert[] {
    return this.advert ? [{ ...this.advert }] : [];
  }

  connect(advertId: string): ClaimLink {
    if (!this.advert || this.advert.id !== advertId || !this.linkCb) throw new Error("no such advert");
    const id = `ble-${++this.seq}`;
    const toBox = new Pipe();
    const toPhone = new Pipe();
    const tap = (f: Uint8Array) => this.frames.push(f);
    const boxSide = new FramedLink(id, toBox, toPhone, this.mtu, tap);
    const phoneSide = new FramedLink(id, toPhone, toBox, this.mtu, tap);
    this.links.push(boxSide);
    this.linkCb(boxSide);
    return phoneSide;
  }
}

// ── the remote claim through `.com` ─────────────────────────────────────

export type MailboxDir = "to-box" | "to-phone";

export interface MailboxClient {
  post(mailboxId: string, dir: MailboxDir, body: string): Promise<void>;
  /** Messages after `after` (exclusive), oldest first. */
  read(mailboxId: string, dir: MailboxDir, after: number): Promise<Array<{ seq: number; body: string }>>;
}

/** The mailbox over HTTPS at the control apex (`/api/box-claim/mailbox/<id>/<dir>`). */
export function httpMailboxClient(base: string, fetchImpl: typeof fetch = fetch): MailboxClient {
  const url = (id: string, dir: MailboxDir) => {
    if (!BOX_CLAIM_MAILBOX_ID.test(id)) throw new Error("bad mailbox id");
    return `${base.replace(/\/$/, "")}/api/box-claim/mailbox/${id}/${dir}`;
  };
  return {
    async post(id, dir, body) {
      const r = await fetchImpl(url(id, dir), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
      if (!r.ok) throw new Error(`mailbox post ${r.status}`);
    },
    async read(id, dir, after) {
      const r = await fetchImpl(`${url(id, dir)}?after=${after}`);
      if (!r.ok) throw new Error(`mailbox read ${r.status}`);
      const j = (await r.json()) as { messages?: Array<{ seq: number; body: string }> };
      return Array.isArray(j.messages) ? j.messages : [];
    },
  };
}

/**
 * One end of a mailbox session. Messages travel base64; `.com` sees only that a mailbox with this
 * hashed name exchanged some bytes. The box end reads `to-box` and writes `to-phone`.
 */
export class MailboxLink implements ClaimLink {
  readonly kind = "mailbox" as const;
  private after = 0;
  private handlers: Array<(m: Uint8Array) => void> = [];
  private closers: Array<() => void> = [];
  private closed = false;

  constructor(
    readonly id: string,
    private readonly client: MailboxClient,
    private readonly mailboxId: string,
    private readonly side: "box" | "phone",
  ) {}

  async send(msg: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("link closed");
    await this.client.post(this.mailboxId, this.side === "box" ? "to-phone" : "to-box", Buffer.from(msg).toString("base64"));
  }

  /** Reads what arrived since the last poll; the service calls it on its timer. */
  async poll(): Promise<number> {
    if (this.closed) return 0;
    const msgs = await this.client.read(this.mailboxId, this.side === "box" ? "to-box" : "to-phone", this.after);
    for (const m of msgs) {
      if (m.seq <= this.after) continue;
      this.after = m.seq;
      const bytes = Uint8Array.from(Buffer.from(m.body, "base64"));
      for (const h of this.handlers) h(bytes);
    }
    return msgs.length;
  }

  onMessage(cb: (msg: Uint8Array) => void): void {
    this.handlers.push(cb);
  }
  onClose(cb: () => void): void {
    this.closers.push(cb);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.closers) c();
  }
}
