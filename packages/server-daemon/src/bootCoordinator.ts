import {
  verifyBootApproval,
  type BootChallenge,
  type Bytes,
  type ServerId,
} from "@flagship/protocol";

export type ApprovalResult =
  | { ok: true }
  | { ok: false; reason: "challenge-not-found" | "challenge-expired" | "invalid-signature" };

export interface BootCoordinatorOptions {
  challengeTtlMs?: number;
  now?: () => number;
}

export class BootCoordinator {
  private readonly pending = new Map<string, { challenge: BootChallenge; createdAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly serverId: ServerId,
    private readonly bakPublicKey: Bytes,
    opts: BootCoordinatorOptions = {},
  ) {
    this.ttlMs = opts.challengeTtlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  createChallenge(): { challenge: BootChallenge; nonceId: string } {
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const issuedAt = this.now();
    const challenge: BootChallenge = { serverId: this.serverId, nonce, issuedAt };
    const nonceId = this.hex(nonce).slice(0, 16);
    this.pending.set(nonceId, { challenge, createdAt: issuedAt });
    return { challenge, nonceId };
  }

  submitApproval(nonceId: string, signature: Bytes): ApprovalResult {
    const entry = this.pending.get(nonceId);
    if (!entry) return { ok: false, reason: "challenge-not-found" };
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.pending.delete(nonceId);
      return { ok: false, reason: "challenge-expired" };
    }
    if (!verifyBootApproval(entry.challenge, signature, this.bakPublicKey)) {
      return { ok: false, reason: "invalid-signature" };
    }
    this.pending.delete(nonceId);
    return { ok: true };
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private hex(b: Bytes): string {
    let s = "";
    for (const x of b) s += x.toString(16).padStart(2, "0");
    return s;
  }
}
