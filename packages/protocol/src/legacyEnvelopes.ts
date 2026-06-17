/**
 * Legacy canonical-bytes envelopes — the original `flagship/*` signed
 * messages (server rebuild/revoke, app membership/migration/invite, tunnel
 * HELLO v1, server-register, account-recovery, device-disconnect,
 * peer-backup announce/request/confirm, the LLM-promo issue start/complete
 * pair, backup-toggle, DNS publish, and username claim).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; field order,
 * tags, guards, and hex encoding are unchanged, so all canonical bytes and
 * signatures remain byte-identical.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId, UserId } from "./types.js";

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

const TAG_REBUILD = "flagship/rebuild/v1";
const TAG_REVOKE = "flagship/revoke/v1";
const TAG_MEMBERSHIP = "flagship/membership/v1";
const TAG_MIGRATION = "flagship/migration/v1";
const TAG_INVITE = "flagship/invite/v1";
const TAG_INVITE_ACCEPT = "flagship/invite-accept/v1";
const TAG_TUNNEL_HELLO = "flagship/tunnel-hello/v1";
const TAG_REGISTER_SERVER = "flagship/register-server/v1";
const TAG_ACCOUNT_RECOVERY = "flagship/account-recovery/v1";
const TAG_DEVICE_DISCONNECT = "flagship/device-disconnect/v1";
const TAG_PB_ANNOUNCE = "pb/announce/v1";
const TAG_PB_REQUEST_PEERS = "pb/request-peers/v1";
const TAG_PB_PEER_CONFIRM = "pb/peer-confirm/v1";
// Promo proxy was removed (we refuse to be in the prompt path). The new
// promo flow is one-shot issuance — see TAG_LLM_PROMO_ISSUE_* below.
const TAG_LLM_PROMO_ISSUE_START = "flagship/llm-promo-issue-start/v1";
const TAG_LLM_PROMO_ISSUE_COMPLETE = "flagship/llm-promo-issue-complete/v1";
const TAG_BACKUP_TOGGLE = "flagship/backup-toggle/v1";
const TAG_PUBLISH_SERVER_DNS = "flagship/publish-server-dns/v1";
const TAG_DNS01_PUBLISH = "flagship/dns01-publish/v1";
const TAG_DNS01_DELETE = "flagship/dns01-delete/v1";
const TAG_CLAIM_USERNAME = "flagship/claim-username/v1";

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
 * IRK-signed request for one device to kick a SIBLING device off the
 * account (`POST /api/users/:u/devices/:id/disconnect`). The signing
 * device proves account ownership with the user's current IRK; the
 * canonical bytes bind the username, the target token being removed,
 * and the caller's own token, so a captured signature can't be replayed
 * against a different target or a different account, and `issuedAt`
 * bounds the replay window the handler enforces.
 */
export interface DeviceDisconnect {
  /** Lowercased account username. */
  username: string;
  /** push_tokens id of the device being kicked off. */
  targetTokenId: string;
  /** push_tokens id of the device issuing the request. */
  callerTokenId: string;
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
 * IRK-signed phone command that tells `.services` how to publish DNS for
 * `<server>.<user>.flagship.services`. Two modes:
 *
 *   - mode="tunnel": point at the tunnel ingress (default; works for NATed servers).
 *   - mode="direct": point at the user-supplied A record (their VPS / port-forwarded box).
 *
 * The signature commits to (serverId, mode, directIp ?? "", issuedAt).
 * directIp must be IPv4 dotted-quad or IPv6 in `::` form. Empty when mode=tunnel.
 */
export interface PublishServerDns {
  userId: UserId;
  serverId: ServerId;
  mode: "tunnel" | "direct";
  directIp: string;
  issuedAt: number;
}

/**
 * IRK-signed claim of a username on flagshipserver.com. The control plane
 * stores `username → irkPub` keyed on the username; mutations require an
 * IRK signature that matches the existing pubkey. The signature commits to
 * (username, irkPub, issuedAt) so a captured signature can't be re-aimed
 * at a different name.
 */
export interface ClaimUsername {
  username: string;
  irkPub: Bytes;
  issuedAt: number;
}

/**
 * STK-signed request from a Flagship server to publish a DNS-01 challenge
 * TXT record under its namespace. The signature commits to (serverId,
 * recordName, recordValueHash, issuedAt) so a captured publish can't be
 * re-aimed at a different name. Used by the per-server ACME flow.
 *
 * recordValueHash is `sha256(recordValue)` — the actual value lives in the
 * request body alongside; the hash inside the canonical bytes prevents a
 * man-in-the-middle from swapping the value after we sign.
 */
export interface Dns01PublishRequest {
  serverId: ServerId;
  recordName: string;
  recordValueHash: Bytes;
  issuedAt: number;
}

/** STK-signed companion to delete a previously-published DNS-01 record. */
export interface Dns01DeleteRequest {
  serverId: ServerId;
  recordId: string;
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

/**
 * HELLO frame signed by the Flagship server's STK on tunnel connect.
 *
 * `controlledDomains` is the explicit list of FQDNs this pod claims to
 * serve right now. The .services tunnel hub treats this list as the only
 * source of truth for SNI routing — there is no D1 mirror. A subsequent
 * HELLO on the same WS replaces the list atomically (see N0b).
 *
 * Each FQDN must end with `<pod_username>.flagship.services` (where
 * `pod_username` is the middle label of `serverId`). The hub enforces
 * this so a compromised STK can only claim FQDNs under its own user's
 * zone.
 */
export interface TunnelHello {
  serverId: ServerId;
  controlledDomains: string[];
  /** Random nonce supplied by the control plane (issued at WS upgrade time). */
  nonce: Bytes;
  issuedAt: number;
}

export interface MembershipMutation {
  serviceId: string;
  /** Recipient's IRK pubkey (32 bytes). The platform identifies members by this, never by username/contact. */
  targetIrkPub: Bytes;
  /** Role to assign, or null to remove the member. */
  role: string | null;
  issuedAt: number;
}

export type MigrationMode = "cut" | "copy";

export interface MigrationRequest {
  serviceId: string;
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
  serviceId: string;
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
  legacyFieldGuard("serviceId", m.serviceId);
  legacyFieldGuard("role", m.role ?? "REMOVE");
  return new TextEncoder().encode(
    `${TAG_MEMBERSHIP}|${m.serviceId}|${hex(m.targetIrkPub)}|${m.role ?? "REMOVE"}|${m.issuedAt}`,
  );
}

function canonicalMigration(m: MigrationRequest): Bytes {
  legacyFieldGuard("serviceId", m.serviceId);
  legacyFieldGuard("fromUser", m.fromUser);
  legacyFieldGuard("toUser", m.toUser);
  legacyFieldGuard("mode", m.mode);
  return new TextEncoder().encode(
    `${TAG_MIGRATION}|${m.serviceId}|${m.fromUser}|${m.toUser}|${m.mode}|${m.withData ? "1" : "0"}|${m.issuedAt}`,
  );
}

function canonicalInvite(t: InviteToken): Bytes {
  legacyFieldGuard("serviceId", t.serviceId);
  legacyFieldGuard("role", t.role);
  return new TextEncoder().encode(
    `${TAG_INVITE}|${t.serviceId}|${t.role}|${hex(t.nonce)}|${t.issuedAt}|${t.expiresAt}`,
  );
}

function canonicalInviteAcceptance(a: InviteAcceptance): Bytes {
  return new TextEncoder().encode(
    `${TAG_INVITE_ACCEPT}|${hex(a.inviteNonce)}|${hex(a.accepterIrkPub)}|${a.acceptedAt}`,
  );
}

function canonicalTunnelHello(h: TunnelHello): Bytes {
  legacyFieldGuard("serverId", h.serverId);
  for (const d of h.controlledDomains) legacyFieldGuard("controlledDomain", d);
  // Sort the FQDN list so signing is independent of array ordering.
  const list = [...h.controlledDomains].sort().join(",");
  return new TextEncoder().encode(
    `${TAG_TUNNEL_HELLO}|${h.serverId}|${list}|${hex(h.nonce)}|${h.issuedAt}`,
  );
}

function canonicalRegisterServer(r: RegisterServer): Bytes {
  legacyFieldGuard("userId", r.userId);
  legacyFieldGuard("serverId", r.serverId);
  return new TextEncoder().encode(
    `${TAG_REGISTER_SERVER}|${r.userId}|${r.serverId}|${hex(r.stkPub)}|${r.issuedAt}`,
  );
}

function canonicalAccountRecovery(r: AccountRecovery): Bytes {
  legacyFieldGuard("userId", r.userId);
  legacyFieldGuard("platform", r.platform);
  return new TextEncoder().encode(
    `${TAG_ACCOUNT_RECOVERY}|${r.userId}|${hex(r.newPushTokenHash)}|${r.platform}|${r.issuedAt}`,
  );
}

function canonicalDeviceDisconnect(d: DeviceDisconnect): Bytes {
  legacyFieldGuard("username", d.username);
  legacyFieldGuard("targetTokenId", d.targetTokenId);
  legacyFieldGuard("callerTokenId", d.callerTokenId);
  return new TextEncoder().encode(
    `${TAG_DEVICE_DISCONNECT}|${d.username.toLowerCase()}|${d.targetTokenId}|${d.callerTokenId}|${d.issuedAt}`,
  );
}

function canonicalPbAnnounce(a: PbAnnounce): Bytes {
  if (a.region !== undefined) legacyFieldGuard("region", a.region);
  legacyFieldGuard("tunnelEndpoint", a.tunnelEndpoint);
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
  legacyFieldGuard("shardId", c.shardId);
  return new TextEncoder().encode(
    [TAG_PB_PEER_CONFIRM, c.peerServerId, c.requesterServerId, c.shardId, c.issuedAt].join("|"),
  );
}

function canonicalLlmPromoIssueStart(r: LlmPromoIssueStart): Bytes {
  legacyFieldGuard("userId", r.userId);
  return new TextEncoder().encode(
    [TAG_LLM_PROMO_ISSUE_START, r.userId, r.method, hex(r.identityHash), r.issuedAt].join("|"),
  );
}

function canonicalLlmPromoIssueComplete(r: LlmPromoIssueComplete): Bytes {
  legacyFieldGuard("userId", r.userId);
  legacyFieldGuard("ticket", r.ticket);
  return new TextEncoder().encode(
    [TAG_LLM_PROMO_ISSUE_COMPLETE, r.userId, r.ticket, hex(r.otpHash), r.issuedAt].join("|"),
  );
}

function canonicalBackupToggle(r: BackupToggle): Bytes {
  return new TextEncoder().encode(
    `${TAG_BACKUP_TOGGLE}|${r.serverId}|${r.enabled ? "1" : "0"}|${r.issuedAt}`,
  );
}

function canonicalPublishServerDns(r: PublishServerDns): Bytes {
  legacyFieldGuard("userId", r.userId);
  legacyFieldGuard("serverId", r.serverId);
  legacyFieldGuard("directIp", r.directIp);
  return new TextEncoder().encode(
    [TAG_PUBLISH_SERVER_DNS, r.userId, r.serverId, r.mode, r.directIp, r.issuedAt].join("|"),
  );
}

function canonicalDns01Publish(r: Dns01PublishRequest): Bytes {
  legacyFieldGuard("serverId", r.serverId);
  legacyFieldGuard("recordName", r.recordName);
  return new TextEncoder().encode(
    [TAG_DNS01_PUBLISH, r.serverId, r.recordName, hex(r.recordValueHash), r.issuedAt].join("|"),
  );
}

function canonicalDns01Delete(r: Dns01DeleteRequest): Bytes {
  legacyFieldGuard("serverId", r.serverId);
  legacyFieldGuard("recordId", r.recordId);
  return new TextEncoder().encode(
    [TAG_DNS01_DELETE, r.serverId, r.recordId, r.issuedAt].join("|"),
  );
}

function canonicalClaimUsername(c: ClaimUsername): Bytes {
  legacyFieldGuard("username", c.username);
  return new TextEncoder().encode(
    [TAG_CLAIM_USERNAME, c.username, hex(c.irkPub), c.issuedAt].join("|"),
  );
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

export function signDeviceDisconnect(d: DeviceDisconnect, irk: Keypair): Bytes {
  return ed.sign(canonicalDeviceDisconnect(d), irk.privateKey);
}

export function verifyDeviceDisconnect(d: DeviceDisconnect, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalDeviceDisconnect(d), irkPub);
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

export function signPublishServerDns(r: PublishServerDns, irk: Keypair): Bytes {
  return ed.sign(canonicalPublishServerDns(r), irk.privateKey);
}

export function verifyPublishServerDns(r: PublishServerDns, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPublishServerDns(r), irkPub);
  } catch {
    return false;
  }
}

export function signDns01Publish(r: Dns01PublishRequest, stk: Keypair): Bytes {
  return ed.sign(canonicalDns01Publish(r), stk.privateKey);
}

export function verifyDns01Publish(r: Dns01PublishRequest, sig: Bytes, stkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalDns01Publish(r), stkPub);
  } catch {
    return false;
  }
}

export function signDns01Delete(r: Dns01DeleteRequest, stk: Keypair): Bytes {
  return ed.sign(canonicalDns01Delete(r), stk.privateKey);
}

export function verifyDns01Delete(r: Dns01DeleteRequest, sig: Bytes, stkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalDns01Delete(r), stkPub);
  } catch {
    return false;
  }
}

export function signClaimUsername(c: ClaimUsername, irk: Keypair): Bytes {
  return ed.sign(canonicalClaimUsername(c), irk.privateKey);
}

export function verifyClaimUsername(c: ClaimUsername, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalClaimUsername(c), irkPub);
  } catch {
    return false;
  }
}
