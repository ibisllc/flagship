/**
 * Legacy attachments (relay-mesh.md §5.3): a box whose HELLO did not offer `mesh-v1` (or did and sent no attachment
 * within 10 s) is announced by its `full` holder with a relay-signed attachment, TTL 3 min, renewed every 60 s while
 * the tunnel is up. Always beaten by a box-signed attachment; only `full` relays may sign one.
 */
import {
  LEGACY_ATTACH_WAIT_MS,
  LEGACY_RENEW_MS,
  LEGACY_TTL_MS,
  signRelayMeshRecord,
  type LegacyAttachment,
  type LegacyItem,
} from "@flagship/protocol";

export interface LegacySignerOptions {
  selfRelayId: string;
  sign: (msg: Uint8Array) => Uint8Array;
  now?: () => number;
  ttlMs?: number;
  renewMs?: number;
  waitMs?: number;
}

export function signLegacyAttachment(a: LegacyAttachment, sign: (msg: Uint8Array) => Uint8Array): LegacyItem {
  return { kind: "legacy", attachment: a, signature: signRelayMeshRecord("relay-legacy-attachment", a, sign) };
}

/**
 * One tunnel's legacy announcements: `start` after the HELLO_ACK (at once for an old box, after `waitMs` for a mesh
 * box that has not attached), `stop` when the box attaches itself or the tunnel closes.
 */
export class LegacyAnnouncer {
  private wait: ReturnType<typeof setTimeout> | null = null;
  private renew: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  /** The newest legacy item signed for this tunnel (its `issuedAt` names what a withdrawal covers). */
  last: LegacyItem | null = null;

  constructor(
    private readonly opts: LegacySignerOptions,
    private readonly box: { serverFqdn: string; boxPub: string; regGen: number; attachedAt: number },
    private readonly announce: (item: LegacyItem) => void,
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** `meshBox`: the box offered mesh-v1, so wait for its own attachment first. */
  start(meshBox: boolean): void {
    if (meshBox) {
      this.wait = setTimeout(() => this.begin(), this.opts.waitMs ?? LEGACY_ATTACH_WAIT_MS);
      this.wait.unref?.();
    } else this.begin();
  }

  stop(): void {
    if (this.wait) clearTimeout(this.wait);
    if (this.renew) clearInterval(this.renew);
    this.wait = null;
    this.renew = null;
  }

  private begin(): void {
    this.wait = null;
    this.emit();
    this.renew = setInterval(() => this.emit(), this.opts.renewMs ?? LEGACY_RENEW_MS);
    this.renew.unref?.();
  }

  private emit(): void {
    const now = this.now();
    const a: LegacyAttachment = {
      serverFqdn: this.box.serverFqdn,
      boxPub: this.box.boxPub,
      regGen: this.box.regGen,
      relayId: this.opts.selfRelayId,
      attachedAt: Math.min(this.box.attachedAt, now),
      issuedAt: now,
      notAfter: now + (this.opts.ttlMs ?? LEGACY_TTL_MS),
    };
    try {
      this.last = signLegacyAttachment(a, this.opts.sign);
    } catch {
      return;
    }
    this.announce(this.last);
  }
}
