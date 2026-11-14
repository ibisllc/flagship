// A scripted phone for the claim tests: what the iOS and Android claim screens will do, minus
// the screens. Speaks flagship/box-claim/v1 over any ClaimLink.
import {
  BOX_CLAIM_FRAME_HANDSHAKE,
  BOX_CLAIM_FRAME_RECORD,
  confirmBoxClaim,
  decodeClaimMessage,
  encodeClaimMessage,
  finishBoxClaim,
  startBoxClaim,
  type BoxClaimBoxMessage,
  type BoxClaimChannel,
  type BoxClaimMode,
  type BoxClaimPhoneMessage,
} from "@flagship/protocol";
import type { ClaimLink } from "../../src/retailClaim/transport.js";

export class PhoneDriver {
  private inbox: Array<{ kind: number; payload: Uint8Array }> = [];
  channel: BoxClaimChannel | null = null;
  closed = false;

  constructor(
    readonly link: ClaimLink,
    private readonly pump: () => Promise<void>,
  ) {
    link.onMessage((m) => this.inbox.push(decodeClaimMessage(m)));
    link.onClose(() => {
      this.closed = true;
    });
  }

  private async nextRaw(tries = 60): Promise<{ kind: number; payload: Uint8Array }> {
    for (let i = 0; i < tries; i++) {
      const m = this.inbox.shift();
      if (m) return m;
      if (this.closed) throw new Error("link closed");
      await this.pump();
    }
    throw new Error("no message from the box");
  }

  async handshake(mode: BoxClaimMode, code?: string): Promise<BoxClaimChannel> {
    const start = startBoxClaim({ mode, ...(code !== undefined ? { code } : {}) });
    await this.link.send(encodeClaimMessage(BOX_CLAIM_FRAME_HANDSHAKE, new TextEncoder().encode(JSON.stringify(start.hello))));
    const accept = JSON.parse(new TextDecoder().decode((await this.nextRaw()).payload));
    const { finish, pending } = finishBoxClaim(start, accept);
    await this.link.send(encodeClaimMessage(BOX_CLAIM_FRAME_HANDSHAKE, new TextEncoder().encode(JSON.stringify(finish))));
    const ready = JSON.parse(new TextDecoder().decode((await this.nextRaw()).payload));
    this.channel = confirmBoxClaim(pending, ready);
    return this.channel;
  }

  async send(msg: BoxClaimPhoneMessage): Promise<void> {
    await this.link.send(encodeClaimMessage(BOX_CLAIM_FRAME_RECORD, this.channel!.sealJson(msg)));
  }

  async next(): Promise<BoxClaimBoxMessage> {
    const m = await this.nextRaw();
    if (m.kind !== BOX_CLAIM_FRAME_RECORD) throw new Error("expected a record");
    return this.channel!.openJson(m.payload) as BoxClaimBoxMessage;
  }

  /** Reads until a message of kind `t`, returning everything seen on the way. */
  async until<T extends BoxClaimBoxMessage["t"]>(t: T): Promise<{ msg: Extract<BoxClaimBoxMessage, { t: T }>; seen: BoxClaimBoxMessage[] }> {
    const seen: BoxClaimBoxMessage[] = [];
    for (;;) {
      const m = await this.next();
      seen.push(m);
      if (m.t === t) return { msg: m as Extract<BoxClaimBoxMessage, { t: T }>, seen };
    }
  }

  pending(): number {
    return this.inbox.length;
  }
}
