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
const TAG_REGISTER_SERVER = "flagship/register-server/v1";
const TAG_ACCOUNT_RECOVERY = "flagship/account-recovery/v1";
const TAG_PB_ANNOUNCE = "pb/announce/v1";
const TAG_PB_REQUEST_PEERS = "pb/request-peers/v1";
const TAG_PB_PEER_CONFIRM = "pb/peer-confirm/v1";
// Promo proxy was removed (we refuse to be in the prompt path). The new
// promo flow is one-shot issuance — see TAG_LLM_PROMO_ISSUE_* below.
const TAG_LLM_PROMO_ISSUE_START = "flagship/llm-promo-issue-start/v1";
const TAG_LLM_PROMO_ISSUE_COMPLETE = "flagship/llm-promo-issue-complete/v1";
const TAG_BACKUP_TOGGLE = "flagship/backup-toggle/v1";

/**
 * Phone-signed server-registration payload posted to the control plane at
 * image-build time. Binds the new server's `serverId` to its STK pubkey
 * (which the phone derives from UMK + serverId). Tunnel hub's authLookup
 * reads from this registration to verify HELLO signatures.
 */
export interface RegisterServer {
  userId: UserId;
  serverId: ServerId;
  stkPub: Bytes;
  issuedAt: number;
}

/**
 * IRK-signed claim posted by a recovered phone after iCloud/Google Block
 * Store sync. The IRK is unchanged (it's deterministically derived from UMK),
 * so the same signature scheme that proves account ownership is reused. The
 * `newPushTokenHash` lets the phone publish a fresh push token without
 * leaking the previous one to the control plane.
 */
export interface AccountRecovery {
  userId: UserId;
  /** SHA-256 of the new push token, lowercased hex (32 bytes). */
  newPushTokenHash: Bytes;
  /** Claim of which platform the new device is running ('apns' | 'fcm'). */
  platform: "apns" | "fcm";
  issuedAt: number;
}

/**
 * IRK-signed promo-issuance start. The user proves account ownership and
 * commits to ONE specific phone number (or other identity proof). The
 * server stores `sha256(phoneNumber + serverPepper)` keyed on this user's
 * IRK so the same number can't be used to mint a second promo key.
 */
export interface LlmPromoIssueStart {
  userId: UserId;
  /** "phone-otp" for v1; "stripe-zero-auth" later. */
  method: "phone-otp" | "stripe-zero-auth";
  /**
   * SHA-256 of the verifier-input — for phone-otp this is sha256(E.164 number).
   * The server hashes its own pepper in too before storage; the *signature*
   * commits to the unsalted hash so the user cannot swap numbers between
   * /start and /complete.
   */
  identityHash: Bytes;
  issuedAt: number;
}

/**
 * IRK-signed promo-issuance completion. The signature commits to the
 * verification ticket the server returned from /start AND the OTP code.
 * The OTP itself is sent in plaintext alongside the signature; the
 * canonical-bytes hash of it prevents a man-in-the-middle from swapping
 * the OTP after we sign.
 */
export interface LlmPromoIssueComplete {
  userId: UserId;
  ticket: string;
  /** SHA-256 of the OTP / verification code — hex 32 bytes. */
  otpHash: Bytes;
  issuedAt: number;
}

/**
 * IRK-signed phone command to flip a server's per-server backup participation.
 * The signature commits to (serverId, enabled, issuedAt) so a captured
 * "enable" signature can't be replayed against a different server, and a
 * captured "disable" can't be reused to flip back on without a fresh
 * biometric prompt on the phone.
 */
export interface BackupToggle {
  serverId: ServerId;
  enabled: boolean;
  issuedAt: number;
}

/** Peer-backup announce: STK-signed by an opted-in server. */
export interface PbAnnounce {
  serverId: ServerId;
  pledgedBytes: number;
  shareRatio: number;
  maxShardSize: number;
  /** ISO 3166 hint (optional). */
  region?: string;
  /** STUN-resolved hint, populated by the server. */
  tunnelEndpoint: string;
  issuedAt: number;
}

/** Peer-backup request-peers: STK-signed by the requester. */
export interface PbRequestPeers {
  requesterServerId: ServerId;
  n: number;
  shardSizeBytes: number;
  durabilityHint: "high" | "best-effort";
  issuedAt: number;
}

/** Peer-backup peer-confirm: STK-signed by the peer that accepted a placement. */
export interface PbPeerConfirm {
  peerServerId: ServerId;
  requesterServerId: ServerId;
  shardId: string;
  issuedAt: number;
}

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

function canonicalRegisterServer(r: RegisterServer): Bytes {
  return new TextEncoder().encode(
    `${TAG_REGISTER_SERVER}|${r.userId}|${r.serverId}|${hex(r.stkPub)}|${r.issuedAt}`,
  );
}

function canonicalAccountRecovery(r: AccountRecovery): Bytes {
  return new TextEncoder().encode(
    `${TAG_ACCOUNT_RECOVERY}|${r.userId}|${hex(r.newPushTokenHash)}|${r.platform}|${r.issuedAt}`,
  );
}

function canonicalPbAnnounce(a: PbAnnounce): Bytes {
  return new TextEncoder().encode(
    [
      TAG_PB_ANNOUNCE,
      a.serverId,
      a.pledgedBytes,
      a.shareRatio,
      a.maxShardSize,
      a.region ?? "",
      a.tunnelEndpoint,
      a.issuedAt,
    ].join("|"),
  );
}

function canonicalPbRequestPeers(r: PbRequestPeers): Bytes {
  return new TextEncoder().encode(
    [
      TAG_PB_REQUEST_PEERS,
      r.requesterServerId,
      r.n,
      r.shardSizeBytes,
      r.durabilityHint,
      r.issuedAt,
    ].join("|"),
  );
}

function canonicalPbPeerConfirm(c: PbPeerConfirm): Bytes {
  return new TextEncoder().encode(
    [TAG_PB_PEER_CONFIRM, c.peerServerId, c.requesterServerId, c.shardId, c.issuedAt].join("|"),
  );
}

function canonicalLlmPromoIssueStart(r: LlmPromoIssueStart): Bytes {
  return new TextEncoder().encode(
    [TAG_LLM_PROMO_ISSUE_START, r.userId, r.method, hex(r.identityHash), r.issuedAt].join("|"),
  );
}

function canonicalLlmPromoIssueComplete(r: LlmPromoIssueComplete): Bytes {
  return new TextEncoder().encode(
    [TAG_LLM_PROMO_ISSUE_COMPLETE, r.userId, r.ticket, hex(r.otpHash), r.issuedAt].join("|"),
  );
}

function canonicalBackupToggle(r: BackupToggle): Bytes {
  return new TextEncoder().encode(
    `${TAG_BACKUP_TOGGLE}|${r.serverId}|${r.enabled ? "1" : "0"}|${r.issuedAt}`,
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

export function signRegisterServer(r: RegisterServer, irk: Keypair): Bytes {
  return ed.sign(canonicalRegisterServer(r), irk.privateKey);
}

export function verifyRegisterServer(r: RegisterServer, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRegisterServer(r), irkPub);
  } catch {
    return false;
  }
}

export function signAccountRecovery(r: AccountRecovery, irk: Keypair): Bytes {
  return ed.sign(canonicalAccountRecovery(r), irk.privateKey);
}

export function verifyAccountRecovery(r: AccountRecovery, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalAccountRecovery(r), irkPub);
  } catch {
    return false;
  }
}

export function signPbAnnounce(a: PbAnnounce, stk: Keypair): Bytes {
  return ed.sign(canonicalPbAnnounce(a), stk.privateKey);
}

export function verifyPbAnnounce(a: PbAnnounce, sig: Bytes, stkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPbAnnounce(a), stkPub);
  } catch {
    return false;
  }
}

export function signPbRequestPeers(r: PbRequestPeers, stk: Keypair): Bytes {
  return ed.sign(canonicalPbRequestPeers(r), stk.privateKey);
}

export function verifyPbRequestPeers(r: PbRequestPeers, sig: Bytes, stkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPbRequestPeers(r), stkPub);
  } catch {
    return false;
  }
}

export function signPbPeerConfirm(c: PbPeerConfirm, stk: Keypair): Bytes {
  return ed.sign(canonicalPbPeerConfirm(c), stk.privateKey);
}

export function verifyPbPeerConfirm(c: PbPeerConfirm, sig: Bytes, stkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPbPeerConfirm(c), stkPub);
  } catch {
    return false;
  }
}

export function signLlmPromoIssueStart(r: LlmPromoIssueStart, irk: Keypair): Bytes {
  return ed.sign(canonicalLlmPromoIssueStart(r), irk.privateKey);
}

export function verifyLlmPromoIssueStart(r: LlmPromoIssueStart, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalLlmPromoIssueStart(r), irkPub);
  } catch {
    return false;
  }
}

export function signLlmPromoIssueComplete(r: LlmPromoIssueComplete, irk: Keypair): Bytes {
  return ed.sign(canonicalLlmPromoIssueComplete(r), irk.privateKey);
}

export function verifyLlmPromoIssueComplete(r: LlmPromoIssueComplete, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalLlmPromoIssueComplete(r), irkPub);
  } catch {
    return false;
  }
}

export function signBackupToggle(r: BackupToggle, irk: Keypair): Bytes {
  return ed.sign(canonicalBackupToggle(r), irk.privateKey);
}

export function verifyBackupToggle(r: BackupToggle, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalBackupToggle(r), irkPub);
  } catch {
    return false;
  }
}
