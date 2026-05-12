import {
  deriveAppMemberStableId,
  deriveAppSecret,
  verifyInvite,
  verifyInviteAcceptance,
  verifyMembershipMutation,
  type Bytes,
  type InviteAcceptance,
  type InviteToken,
  type MembershipMutation,
} from "@flagship/protocol";

export interface MembershipEntry {
  /** Hex of the member's IRK pubkey. */
  irkPubHex: string;
  role: string;
  addedAt: number;
  addedBy: string;
}

export type ApplyResult =
  | { ok: true; effect: "added" | "updated" | "removed" }
  | { ok: false; reason: "invalid-signature" | "stale" | "replay" | "no-such-member" | "app-mismatch" };

export type RedeemResult =
  | { ok: true; role: string; accepterIrkPub: Bytes; stableId: string }
  | {
      ok: false;
      reason:
        | "app-mismatch"
        | "invalid-invite-signature"
        | "invalid-acceptance-signature"
        | "nonce-mismatch"
        | "expired"
        | "not-yet-valid"
        | "already-redeemed";
    };

export interface MembershipStoreOptions {
  /** Reject mutations whose issuedAt is older than this (ms). Default: 5 min. */
  maxAgeMs?: number;
  /** Clock for testing. */
  now?: () => number;
}

/**
 * Tracks redeemed invite nonces (single-use). Keys on hex of the nonce.
 */
export class InviteStore {
  private readonly redeemed = new Map<string, { redeemedAt: number; accepterIrkPubHex: string }>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    public readonly appId: string,
    private readonly ownerIrkPub: Bytes,
    opts: MembershipStoreOptions = {},
  ) {
    this.maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  redeem(
    token: InviteToken,
    inviteSig: Bytes,
    acceptance: InviteAcceptance,
    acceptanceSig: Bytes,
  ): RedeemResult {
    if (token.appId !== this.appId) {
      return { ok: false, reason: "app-mismatch" };
    }
    if (!verifyInvite(token, inviteSig, this.ownerIrkPub)) {
      return { ok: false, reason: "invalid-invite-signature" };
    }
    const t = this.now();
    if (t > token.expiresAt) {
      return { ok: false, reason: "expired" };
    }
    if (t < token.issuedAt - 60_000) {
      return { ok: false, reason: "not-yet-valid" };
    }
    if (!equalBytes(acceptance.inviteNonce, token.nonce)) {
      return { ok: false, reason: "nonce-mismatch" };
    }
    if (!verifyInviteAcceptance(acceptance, acceptanceSig, acceptance.accepterIrkPub)) {
      return { ok: false, reason: "invalid-acceptance-signature" };
    }
    const nonceHex = bytesToHex(token.nonce);
    if (this.redeemed.has(nonceHex)) {
      return { ok: false, reason: "already-redeemed" };
    }
    this.redeemed.set(nonceHex, {
      redeemedAt: t,
      accepterIrkPubHex: bytesToHex(acceptance.accepterIrkPub),
    });
    return {
      ok: true,
      role: token.role,
      accepterIrkPub: acceptance.accepterIrkPub,
      stableId: "", // filled in by AppMembership which knows the appSecret
    };
  }

  isRedeemed(nonce: Bytes): boolean {
    return this.redeemed.has(bytesToHex(nonce));
  }

  size(): number {
    return this.redeemed.size;
  }
}

/**
 * Per-app membership store keyed on the member's IRK pubkey.
 *
 * Mutations are signed by the app owner's IRK and ordered by per-target
 * `issuedAt`. Replays of an `issuedAt` already seen for that target are
 * rejected.
 */
export class MembershipStore {
  /** map<irkPubHex, MembershipEntry> */
  private readonly members = new Map<string, MembershipEntry>();
  /** map<irkPubHex, lastSeenIssuedAt> for replay protection */
  private readonly lastSeen = new Map<string, number>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    public readonly appId: string,
    private readonly ownerUserId: string,
    private readonly ownerIrkPub: Bytes,
    opts: MembershipStoreOptions = {},
  ) {
    this.maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  applySignedMutation(m: MembershipMutation, signature: Bytes): ApplyResult {
    if (m.appId !== this.appId) return { ok: false, reason: "app-mismatch" };
    if (!verifyMembershipMutation(m, signature, this.ownerIrkPub)) {
      return { ok: false, reason: "invalid-signature" };
    }
    const age = this.now() - m.issuedAt;
    if (age > this.maxAgeMs || age < -60_000) {
      return { ok: false, reason: "stale" };
    }
    const targetHex = bytesToHex(m.targetIrkPub);
    const last = this.lastSeen.get(targetHex);
    if (last !== undefined && m.issuedAt <= last) {
      return { ok: false, reason: "replay" };
    }
    this.lastSeen.set(targetHex, m.issuedAt);

    if (m.role === null) {
      if (!this.members.has(targetHex)) {
        return { ok: false, reason: "no-such-member" };
      }
      this.members.delete(targetHex);
      return { ok: true, effect: "removed" };
    }

    const existed = this.members.has(targetHex);
    this.members.set(targetHex, {
      irkPubHex: targetHex,
      role: m.role,
      addedAt: this.now(),
      addedBy: this.ownerUserId,
    });
    return { ok: true, effect: existed ? "updated" : "added" };
  }

  /**
   * Direct-add path used by the invite-redemption flow; avoids re-signing the
   * mutation after the invite + acceptance pair has already been verified.
   */
  internalAdd(irkPub: Bytes, role: string): "added" | "updated" {
    const hex = bytesToHex(irkPub);
    const existed = this.members.has(hex);
    this.members.set(hex, {
      irkPubHex: hex,
      role,
      addedAt: this.now(),
      addedBy: this.ownerUserId,
    });
    return existed ? "updated" : "added";
  }

  /**
   * Used by the J.4 post-recovery rewrite (#72). After a row is added
   * under the new IRK, the old IRK row must be removed atomically; we
   * key by hex because the caller is rewriting from a stored snapshot
   * and doesn't necessarily hold the raw pubkey bytes.
   */
  internalRemoveByHex(irkPubHex: string): boolean {
    return this.members.delete(irkPubHex.toLowerCase());
  }

  getRole(irkPub: Bytes): string | null {
    return this.members.get(bytesToHex(irkPub))?.role ?? null;
  }

  isMember(irkPub: Bytes): boolean {
    return this.members.has(bytesToHex(irkPub));
  }

  list(): MembershipEntry[] {
    return Array.from(this.members.values());
  }

  size(): number {
    return this.members.size;
  }
}

/**
 * Combines an InviteStore + MembershipStore for a single app. Provides the
 * end-to-end "redeem invite" flow that the invitation route on the server-
 * daemon's HTTP API calls.
 */
export class AppMembership {
  public readonly invites: InviteStore;
  public readonly members: MembershipStore;
  private readonly appSecret: Bytes;

  constructor(
    public readonly appId: string,
    ownerUserId: string,
    ownerIrkPub: Bytes,
    swk: Bytes,
    opts: MembershipStoreOptions = {},
  ) {
    this.invites = new InviteStore(appId, ownerIrkPub, opts);
    this.members = new MembershipStore(appId, ownerUserId, ownerIrkPub, opts);
    this.appSecret = deriveAppSecret(swk, appId);
  }

  /** Redeem an invite, atomically marking the nonce used and adding the member. */
  redeemInvite(
    token: InviteToken,
    inviteSig: Bytes,
    acceptance: InviteAcceptance,
    acceptanceSig: Bytes,
  ): RedeemResult {
    const r = this.invites.redeem(token, inviteSig, acceptance, acceptanceSig);
    if (!r.ok) return r;
    this.members.internalAdd(r.accepterIrkPub, r.role);
    return { ...r, stableId: deriveAppMemberStableId(this.appSecret, r.accepterIrkPub) };
  }

  /** Apply an owner-signed remove or role-change mutation. */
  applyMutation(m: MembershipMutation, sig: Bytes): ApplyResult {
    return this.members.applySignedMutation(m, sig);
  }

  stableIdFor(irkPub: Bytes): string {
    return deriveAppMemberStableId(this.appSecret, irkPub);
  }
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
