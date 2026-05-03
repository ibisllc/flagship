import { ed } from "./edSync.js";
import type { Bytes, Keypair, ServerId, UserId } from "./types.js";

export interface BootChallenge {
  serverId: ServerId;
  nonce: Bytes;
  issuedAt: number;
}

export interface ImageRebuildRequest {
  userId: UserId;
  newServerId: ServerId;
  wifiSsid: string;
  wifiPskHash: Bytes;
  shareRatio: number;
  issuedAt: number;
}

export type RevocationReason = "lost" | "stolen" | "decommissioned";

export interface ServerRevocation {
  userId: UserId;
  revokedServerId: ServerId;
  reason: RevocationReason;
  issuedAt: number;
}

const TAG_BOOT = "flagship/boot/v1";
const TAG_REBUILD = "flagship/rebuild/v1";
const TAG_REVOKE = "flagship/revoke/v1";
const TAG_MEMBERSHIP = "flagship/membership/v1";
const TAG_MIGRATION = "flagship/migration/v1";
const TAG_INVITE = "flagship/invite/v1";
const TAG_INVITE_ACCEPT = "flagship/invite-accept/v1";
const TAG_TUNNEL_HELLO = "flagship/tunnel-hello/v1";

/** HELLO frame signed by the Flagship server's BAK on tunnel connect. */
export interface TunnelHello {
  serverId: ServerId;
  subdomains: string[];
  /** Random nonce supplied by the control plane (issued at WS upgrade time). */
  nonce: Bytes;
  issuedAt: number;
}

export interface MembershipMutation {
  appId: string;
  /** Recipient's IRK pubkey (32 bytes). The platform identifies members by this, never by username/contact. */
  targetIrkPub: Bytes;
  /** Role to assign, or null to remove the member. */
  role: string | null;
  issuedAt: number;
}

export type MigrationMode = "cut" | "copy";

export interface MigrationRequest {
  appId: string;
  fromUser: UserId;
  toUser: UserId;
  mode: MigrationMode;
  withData: boolean;
  issuedAt: number;
}

/**
 * An invitation to join an app. Created and signed by the owner's IRK; the
 * resulting (token, signature) pair is shared out-of-band (SMS, email, paper)
 * by the owner. Recipient redeems by signing an InviteAcceptance.
 *
 * The platform never sees the recipient's contact information. The token's
 * `nonce` is the unforgeable capability; possession of (token + sig) plus the
 * ability to sign an acceptance with an IRK is what grants membership.
 */
export interface InviteToken {
  appId: string;
  /** Role the recipient is invited to (e.g. "member", "parent", "admin"). */
  role: string;
  /** 32 random bytes; doubles as the invite identifier and anti-replay handle. */
  nonce: Bytes;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Recipient's signed acceptance. Binds the invite (by nonce) to the recipient's
 * IRK pubkey. Once redeemed, the membership store keys on accepterIrkPub for
 * all future operations on this app.
 */
export interface InviteAcceptance {
  inviteNonce: Bytes;
  accepterIrkPub: Bytes;
  acceptedAt: number;
}

function hex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function canonicalBoot(c: BootChallenge): Bytes {
  return new TextEncoder().encode(
    `${TAG_BOOT}|${c.serverId}|${hex(c.nonce)}|${c.issuedAt}`,
  );
}

function canonicalRebuild(r: ImageRebuildRequest): Bytes {
  return new TextEncoder().encode(
    `${TAG_REBUILD}|${r.userId}|${r.newServerId}|${r.wifiSsid}|${hex(r.wifiPskHash)}|${r.shareRatio}|${r.issuedAt}`,
  );
}

function canonicalRevoke(r: ServerRevocation): Bytes {
  return new TextEncoder().encode(
    `${TAG_REVOKE}|${r.userId}|${r.revokedServerId}|${r.reason}|${r.issuedAt}`,
  );
}

function canonicalMembership(m: MembershipMutation): Bytes {
  return new TextEncoder().encode(
    `${TAG_MEMBERSHIP}|${m.appId}|${hex(m.targetIrkPub)}|${m.role ?? "REMOVE"}|${m.issuedAt}`,
  );
}

function canonicalMigration(m: MigrationRequest): Bytes {
  return new TextEncoder().encode(
    `${TAG_MIGRATION}|${m.appId}|${m.fromUser}|${m.toUser}|${m.mode}|${m.withData ? "1" : "0"}|${m.issuedAt}`,
  );
}

function canonicalInvite(t: InviteToken): Bytes {
  return new TextEncoder().encode(
    `${TAG_INVITE}|${t.appId}|${t.role}|${hex(t.nonce)}|${t.issuedAt}|${t.expiresAt}`,
  );
}

function canonicalInviteAcceptance(a: InviteAcceptance): Bytes {
  return new TextEncoder().encode(
    `${TAG_INVITE_ACCEPT}|${hex(a.inviteNonce)}|${hex(a.accepterIrkPub)}|${a.acceptedAt}`,
  );
}

function canonicalTunnelHello(h: TunnelHello): Bytes {
  // sort subdomains so signing is independent of array ordering
  const subs = [...h.subdomains].sort().join(",");
  return new TextEncoder().encode(
    `${TAG_TUNNEL_HELLO}|${h.serverId}|${subs}|${hex(h.nonce)}|${h.issuedAt}`,
  );
}

export function signBootApproval(c: BootChallenge, bak: Keypair): Bytes {
  return ed.sign(canonicalBoot(c), bak.privateKey);
}

export function verifyBootApproval(c: BootChallenge, sig: Bytes, bakPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalBoot(c), bakPub);
  } catch {
    return false;
  }
}

export function signRebuildRequest(r: ImageRebuildRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalRebuild(r), irk.privateKey);
}

export function verifyRebuildRequest(
  r: ImageRebuildRequest,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRebuild(r), irkPub);
  } catch {
    return false;
  }
}

export function signRevocation(r: ServerRevocation, irk: Keypair): Bytes {
  return ed.sign(canonicalRevoke(r), irk.privateKey);
}

export function verifyRevocation(
  r: ServerRevocation,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRevoke(r), irkPub);
  } catch {
    return false;
  }
}

export function signMembershipMutation(m: MembershipMutation, irk: Keypair): Bytes {
  return ed.sign(canonicalMembership(m), irk.privateKey);
}

export function verifyMembershipMutation(
  m: MembershipMutation,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalMembership(m), irkPub);
  } catch {
    return false;
  }
}

export function signMigrationRequest(m: MigrationRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalMigration(m), irk.privateKey);
}

export function verifyMigrationRequest(
  m: MigrationRequest,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalMigration(m), irkPub);
  } catch {
    return false;
  }
}

export function signInvite(t: InviteToken, ownerIrk: Keypair): Bytes {
  return ed.sign(canonicalInvite(t), ownerIrk.privateKey);
}

export function verifyInvite(t: InviteToken, sig: Bytes, ownerIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalInvite(t), ownerIrkPub);
  } catch {
    return false;
  }
}

export function signInviteAcceptance(a: InviteAcceptance, accepterIrk: Keypair): Bytes {
  return ed.sign(canonicalInviteAcceptance(a), accepterIrk.privateKey);
}

export function verifyInviteAcceptance(
  a: InviteAcceptance,
  sig: Bytes,
  accepterIrkPub: Bytes,
): boolean {
  // Acceptance is verified against the IRK pubkey carried in the acceptance
  // itself — this is what binds the invite to that specific IRK going forward.
  // Caller must additionally check `a.accepterIrkPub` matches the supplied pubkey.
  if (a.accepterIrkPub.length !== accepterIrkPub.length) return false;
  for (let i = 0; i < a.accepterIrkPub.length; i++) {
    if (a.accepterIrkPub[i] !== accepterIrkPub[i]) return false;
  }
  try {
    return ed.verify(sig, canonicalInviteAcceptance(a), accepterIrkPub);
  } catch {
    return false;
  }
}

/**
 * Generate a fresh 32-byte invite nonce. Owner uses this when creating an invite.
 */
export function newInviteNonce(): Bytes {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

export function signTunnelHello(h: TunnelHello, bak: Keypair): Bytes {
  return ed.sign(canonicalTunnelHello(h), bak.privateKey);
}

export function verifyTunnelHello(h: TunnelHello, sig: Bytes, bakPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalTunnelHello(h), bakPub);
  } catch {
    return false;
  }
}
