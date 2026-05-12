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
const TAG_PUBLISH_SERVER_DNS = "flagship/publish-server-dns/v1";
const TAG_DNS01_PUBLISH = "flagship/dns01-publish/v1";
const TAG_DNS01_DELETE = "flagship/dns01-delete/v1";
const TAG_CLAIM_USERNAME = "flagship/claim-username/v1";
const TAG_AUTH_CODE = "flagship/auth-code/v1";
const TAG_INSTALL_BLOB = "flagship/install-blob/v1";
const TAG_SERVER_REGISTER = "flagship/server-register/v1";
const TAG_AUTH_CODE_REVOKE = "flagship/auth-code-revoke/v1";
const TAG_USER_PUBKEY_BINDING = "flagship-ca-binding/v1";
const TAG_RCK_REGISTER = "flagship/rck-register/v1";
const TAG_RCK_SET_TARGET = "flagship/rck-set-target/v1";

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
export interface AuthCode {
  version: 1;
  serial: string;
  username: string;
  serverName: string;
  serverDomain: string;
  delegatedPubKey: Bytes;
  userPubKey: Bytes;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthCodeRevocation {
  serial: string;
  username: string;
  issuedAt: number;
}

export interface InstallBlob {
  version: 1;
  serverDomain: string;
  username: string;
  serverName: string;
  phoneDelegatedPubKey: Bytes;
  registrationUrl: string;
  authCode: AuthCode;
  authCodeUserSignature: Bytes;
  issuedAt: number;
  expiresAt: number;
  /**
   * Git ref the apkovl will pull installer/ from at first boot. Tag is
   * preferred (`v0.1.0`); branch (`main`) acceptable for early releases.
   * Empty string is treated as "main" by the bootstrap. The phone signs
   * over this so a compromised network/control-plane cannot swap the
   * installer revision.
   */
  installerGitRef: string;
  /**
   * Routing-Control-Key public key for this server's subdomain. Daemon
   * uses it to verify SetRoutingTarget mutations it sees in the routing
   * record (defense-in-depth against a compromised .com).
   */
  rckPubKey: Bytes;
}

/**
 * Routing-Control-Key registration. Phone signs with IRK to establish a
 * keypair that controls "where does this subdomain's traffic go right now?"
 * — separate from the server identity that's *currently* handling it. Lets
 * the phone re-route on failover / migration / delegation without having
 * to rotate any other key.
 */
export interface RegisterRck {
  username: string;
  subdomain: string;
  rckPubKey: Bytes;
  issuedAt: number;
}

/**
 * Routing target update — phone re-aims a subdomain at a different server
 * identity. Signed with the RCK private key. .com mutates the routing
 * record; .services's SNI passthrough router reads the new target on the
 * next lookup.
 */
export interface SetRoutingTarget {
  subdomain: string;
  newTargetIdentityPubKey: Bytes;
  issuedAt: number;
  nonce: Bytes;
}

export interface UserPubKeyBinding {
  version: 1;
  username: string;
  pubKey: Bytes;
  issuedAt: number;
  expiresAt: number;
  /** CA identifier — versioned so we can rotate the CA later. */
  issuer: string;
}

export interface ServerRegisterRequest {
  authCode: AuthCode;
  authCodeUserSignature: Bytes;
  serverIdentityPubKey: Bytes;
  issuedAt: number;
  nonce: Bytes;
}

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
  // Sort the FQDN list so signing is independent of array ordering.
  const list = [...h.controlledDomains].sort().join(",");
  return new TextEncoder().encode(
    `${TAG_TUNNEL_HELLO}|${h.serverId}|${list}|${hex(h.nonce)}|${h.issuedAt}`,
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

function canonicalPublishServerDns(r: PublishServerDns): Bytes {
  return new TextEncoder().encode(
    [TAG_PUBLISH_SERVER_DNS, r.userId, r.serverId, r.mode, r.directIp, r.issuedAt].join("|"),
  );
}

function canonicalDns01Publish(r: Dns01PublishRequest): Bytes {
  return new TextEncoder().encode(
    [TAG_DNS01_PUBLISH, r.serverId, r.recordName, hex(r.recordValueHash), r.issuedAt].join("|"),
  );
}

function canonicalDns01Delete(r: Dns01DeleteRequest): Bytes {
  return new TextEncoder().encode(
    [TAG_DNS01_DELETE, r.serverId, r.recordId, r.issuedAt].join("|"),
  );
}

function canonicalClaimUsername(c: ClaimUsername): Bytes {
  return new TextEncoder().encode(
    [TAG_CLAIM_USERNAME, c.username, hex(c.irkPub), c.issuedAt].join("|"),
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

function canonicalAuthCode(c: AuthCode): Bytes {
  return new TextEncoder().encode(
    [
      TAG_AUTH_CODE,
      c.version,
      c.serial,
      c.username,
      c.serverName,
      c.serverDomain,
      hex(c.delegatedPubKey),
      hex(c.userPubKey),
      c.issuedAt,
      c.expiresAt,
    ].join("|"),
  );
}

function canonicalInstallBlob(b: InstallBlob): Bytes {
  return new TextEncoder().encode(
    [
      TAG_INSTALL_BLOB,
      b.version,
      b.serverDomain,
      b.username,
      b.serverName,
      hex(b.phoneDelegatedPubKey),
      b.registrationUrl,
      b.authCode.serial,
      hex(b.authCode.userPubKey),
      hex(b.authCodeUserSignature),
      b.issuedAt,
      b.expiresAt,
      b.installerGitRef,
      hex(b.rckPubKey),
    ].join("|"),
  );
}

function canonicalServerRegister(r: ServerRegisterRequest): Bytes {
  return new TextEncoder().encode(
    [
      TAG_SERVER_REGISTER,
      r.authCode.serial,
      r.authCode.serverDomain,
      hex(r.serverIdentityPubKey),
      r.issuedAt,
      hex(r.nonce),
    ].join("|"),
  );
}

function canonicalAuthCodeRevoke(r: AuthCodeRevocation): Bytes {
  return new TextEncoder().encode(
    [TAG_AUTH_CODE_REVOKE, r.serial, r.username, r.issuedAt].join("|"),
  );
}

export function signAuthCode(c: AuthCode, irk: Keypair): Bytes {
  return ed.sign(canonicalAuthCode(c), irk.privateKey);
}

export function verifyAuthCode(c: AuthCode, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalAuthCode(c), irkPub);
  } catch {
    return false;
  }
}

export function signInstallBlob(b: InstallBlob, irk: Keypair): Bytes {
  return ed.sign(canonicalInstallBlob(b), irk.privateKey);
}

export function verifyInstallBlob(b: InstallBlob, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalInstallBlob(b), irkPub);
  } catch {
    return false;
  }
}

export function signServerRegister(r: ServerRegisterRequest, identity: Keypair): Bytes {
  return ed.sign(canonicalServerRegister(r), identity.privateKey);
}

export function verifyServerRegister(
  r: ServerRegisterRequest,
  sig: Bytes,
  identityPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServerRegister(r), identityPub);
  } catch {
    return false;
  }
}

export function signAuthCodeRevocation(r: AuthCodeRevocation, irk: Keypair): Bytes {
  return ed.sign(canonicalAuthCodeRevoke(r), irk.privateKey);
}

export function verifyAuthCodeRevocation(
  r: AuthCodeRevocation,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalAuthCodeRevoke(r), irkPub);
  } catch {
    return false;
  }
}

function canonicalUserPubKeyBinding(b: UserPubKeyBinding): Bytes {
  return new TextEncoder().encode(
    [
      TAG_USER_PUBKEY_BINDING,
      b.version,
      b.username,
      hex(b.pubKey),
      b.issuedAt,
      b.expiresAt,
      b.issuer,
    ].join("|"),
  );
}

export function signUserPubKeyBinding(b: UserPubKeyBinding, ca: Keypair): Bytes {
  return ed.sign(canonicalUserPubKeyBinding(b), ca.privateKey);
}

export function verifyUserPubKeyBinding(
  b: UserPubKeyBinding,
  sig: Bytes,
  caPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalUserPubKeyBinding(b), caPub);
  } catch {
    return false;
  }
}

function canonicalRegisterRck(r: RegisterRck): Bytes {
  return new TextEncoder().encode(
    [TAG_RCK_REGISTER, r.username, r.subdomain, hex(r.rckPubKey), r.issuedAt].join("|"),
  );
}

function canonicalSetRoutingTarget(r: SetRoutingTarget): Bytes {
  return new TextEncoder().encode(
    [
      TAG_RCK_SET_TARGET,
      r.subdomain,
      hex(r.newTargetIdentityPubKey),
      r.issuedAt,
      hex(r.nonce),
    ].join("|"),
  );
}

export function signRegisterRck(r: RegisterRck, irk: Keypair): Bytes {
  return ed.sign(canonicalRegisterRck(r), irk.privateKey);
}
export function verifyRegisterRck(r: RegisterRck, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRegisterRck(r), irkPub);
  } catch {
    return false;
  }
}

export function signSetRoutingTarget(r: SetRoutingTarget, rck: Keypair): Bytes {
  return ed.sign(canonicalSetRoutingTarget(r), rck.privateKey);
}
export function verifySetRoutingTarget(r: SetRoutingTarget, sig: Bytes, rckPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalSetRoutingTarget(r), rckPub);
  } catch {
    return false;
  }
}

/**
 * Phone-server order. Signed by the per-server PSK private key (held on
 * the phone); the daemon verifies against the PSK pubkey baked into the
 * install trailer.
 *
 * Each order is a discriminated union; the canonical-bytes function
 * tags by type so a captured signature for one variant can't be
 * replayed as a different variant.
 */
export type PhoneOrder =
  | { type: "noop"; serverId: ServerId; issuedAt: number }
  | { type: "set-backup-policy"; serverId: ServerId; enabled: boolean; issuedAt: number }
  | { type: "shut-down"; serverId: ServerId; issuedAt: number }
  | { type: "revoke-self"; serverId: ServerId; reason: string; issuedAt: number }
  | { type: "rotate-server-identity"; serverId: ServerId; newIdentityPubKey: Bytes; issuedAt: number }
  | { type: "deliver-bak"; serverId: ServerId; bakPubKey: Bytes; issuedAt: number }
  | {
      /**
       * Phone-supplied input bound for the pod-resident browser. Sent
       * after the daemon emits a `browser-input-needed` alert for a
       * focused password / OTP / text field. The canonical bytes
       * cover everything including `value` so a captured response
       * cannot be diverted to a different field or tab.
       *
       * `screenshotRef` correlates back to a specific alert — the
       * daemon rejects responses whose ref doesn't match a live alert
       * (replay defense within the alert lifecycle).
       */
      type: "browser-input-response";
      serverId: ServerId;
      tabId: string;
      inputKind: "password" | "otp" | "text";
      value: string;
      screenshotRef: string;
      issuedAt: number;
    }
  | {
      /**
       * Add an FQDN to an app's update-pack subscriber list. Affects
       * `/.flagship/update`'s authorization check the next time the
       * named subscriber pulls. `fqdn` is normalized to lowercase by
       * the daemon.
       */
      type: "add-subscriber";
      serverId: ServerId;
      appId: string;
      fqdn: string;
      issuedAt: number;
    }
  | {
      type: "remove-subscriber";
      serverId: ServerId;
      appId: string;
      fqdn: string;
      issuedAt: number;
    }
  | {
      /**
       * Mint a paired-session token. The phone supplies the token bytes
       * (random 32 bytes is the usual choice — typed as hex) and the
       * daemon stores it in its PairedSessionStore so subsequent calls
       * carrying `Authorization: Flagship-Session <token>` are accepted.
       *
       * `label` is a human-readable name the host can use to revoke a
       * specific paired browser later (e.g. "Harry's iPhone").
       */
      type: "add-paired-session";
      serverId: ServerId;
      token: string;
      label: string;
      issuedAt: number;
    }
  | {
      type: "remove-paired-session";
      serverId: ServerId;
      token: string;
      issuedAt: number;
    }
  | {
      /**
       * Phone-driven app backup. Daemon bundles the app's source +
       * (optionally) its user data into a tar.gz, optionally encrypts
       * with a password-derived key, holds it on disk, and returns a
       * one-shot fetch URL the phone pulls bytes from. Phone owns the
       * archive afterwards — store it however, share it however.
       *
       * Modes:
       *   - includeUserData: false → manifest + source + Dockerfile
       *     only. Sharable archive (no user data).
       *   - includeUserData: true → adds dumped Postgres/MinIO/Redis
       *     namespaces. Personal restore archive only.
       *
       * `password` is an optional UTF-8 passphrase. Daemon derives an
       * AES-GCM key via PBKDF2 and encrypts the archive end-to-end.
       * Phone-side import recomputes the key from the same password.
       */
      type: "backup-app";
      serverId: ServerId;
      creator: string;
      slug: string;
      includeUserData: boolean;
      password?: string;
      issuedAt: number;
    };

const TAG_ORDER_NOOP = "flagship/order/noop/v1";
const TAG_ORDER_SET_BACKUP_POLICY = "flagship/order/set-backup-policy/v1";
const TAG_ORDER_SHUT_DOWN = "flagship/order/shut-down/v1";
const TAG_ORDER_REVOKE_SELF = "flagship/order/revoke-self/v1";
const TAG_ORDER_ROTATE_IDENTITY = "flagship/order/rotate-server-identity/v1";
const TAG_ORDER_DELIVER_BAK = "flagship/order/deliver-bak/v1";
const TAG_ORDER_BROWSER_INPUT = "flagship/order/browser-input-response/v1";
const TAG_ORDER_ADD_SUBSCRIBER = "flagship/order/add-subscriber/v1";
const TAG_ORDER_REMOVE_SUBSCRIBER = "flagship/order/remove-subscriber/v1";
const TAG_ORDER_ADD_PAIRED_SESSION = "flagship/order/add-paired-session/v1";
const TAG_ORDER_REMOVE_PAIRED_SESSION = "flagship/order/remove-paired-session/v1";
const TAG_ORDER_BACKUP_APP = "flagship/order/backup-app/v1";

function canonicalPhoneOrder(o: PhoneOrder): Bytes {
  const enc = new TextEncoder();
  switch (o.type) {
    case "noop":
      return enc.encode([TAG_ORDER_NOOP, o.serverId, o.issuedAt].join("|"));
    case "set-backup-policy":
      return enc.encode(
        [TAG_ORDER_SET_BACKUP_POLICY, o.serverId, o.enabled ? "1" : "0", o.issuedAt].join("|"),
      );
    case "shut-down":
      return enc.encode([TAG_ORDER_SHUT_DOWN, o.serverId, o.issuedAt].join("|"));
    case "revoke-self":
      return enc.encode([TAG_ORDER_REVOKE_SELF, o.serverId, o.reason, o.issuedAt].join("|"));
    case "rotate-server-identity":
      return enc.encode(
        [TAG_ORDER_ROTATE_IDENTITY, o.serverId, hex(o.newIdentityPubKey), o.issuedAt].join("|"),
      );
    case "deliver-bak":
      return enc.encode(
        [TAG_ORDER_DELIVER_BAK, o.serverId, hex(o.bakPubKey), o.issuedAt].join("|"),
      );
    case "browser-input-response":
      return enc.encode(
        [
          TAG_ORDER_BROWSER_INPUT,
          o.serverId,
          o.tabId,
          o.inputKind,
          o.value,
          o.screenshotRef,
          o.issuedAt,
        ].join("|"),
      );
    case "add-subscriber":
      return enc.encode(
        [TAG_ORDER_ADD_SUBSCRIBER, o.serverId, o.appId, o.fqdn, o.issuedAt].join("|"),
      );
    case "remove-subscriber":
      return enc.encode(
        [TAG_ORDER_REMOVE_SUBSCRIBER, o.serverId, o.appId, o.fqdn, o.issuedAt].join("|"),
      );
    case "add-paired-session":
      return enc.encode(
        [TAG_ORDER_ADD_PAIRED_SESSION, o.serverId, o.token, o.label, o.issuedAt].join("|"),
      );
    case "remove-paired-session":
      return enc.encode(
        [TAG_ORDER_REMOVE_PAIRED_SESSION, o.serverId, o.token, o.issuedAt].join("|"),
      );
    case "backup-app":
      return enc.encode(
        [
          TAG_ORDER_BACKUP_APP,
          o.serverId,
          o.creator,
          o.slug,
          o.includeUserData ? "1" : "0",
          o.password ?? "",
          o.issuedAt,
        ].join("|"),
      );
  }
}

export function signPhoneOrder(o: PhoneOrder, psk: Keypair): Bytes {
  return ed.sign(canonicalPhoneOrder(o), psk.privateKey);
}
export function verifyPhoneOrder(o: PhoneOrder, sig: Bytes, pskPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPhoneOrder(o), pskPub);
  } catch {
    return false;
  }
}

/**
 * LUKS-unlock-on-boot endpoints.
 *
 * Flow:
 *   1. At install time, the daemon seals the LUKS root key with the
 *      user's BAK pubkey and POSTs `PutSealedLuksKey` to .com (signed
 *      by the server identity key).
 *   2. At boot, the unencrypted boot stage GETs the sealed blob (anyone
 *      can — sealed against BAK is useless without the phone).
 *   3. Phone, when present + biometric-authenticated, unseals locally
 *      and POSTs `DepositUnlockKey` to .com (signed by IRK).
 *   4. Boot stage POSTs `ConsumeUnlockKey` (signed by server identity)
 *      to fetch the unsealed key and atomically clear the entry.
 */
export interface PutSealedLuksKey {
  serverId: ServerId;
  sealedKey: Bytes;
  issuedAt: number;
}

export interface DepositUnlockKey {
  serverId: ServerId;
  unlockKey: Bytes;
  /** Wall-clock ms after which the deposit is considered expired. */
  expiresAt: number;
  issuedAt: number;
}

export interface ConsumeUnlockKey {
  serverId: ServerId;
  /** 32-byte nonce; rejected if it matches the previous accepted one. */
  nonce: Bytes;
  issuedAt: number;
}

/**
 * Auto-unlock lease — the unified shape that subsumes both
 * "one-shot reactive deposit" (default per-boot) and "out-and-about
 * long-lived lease" (opt-in toggle).
 *
 * `multiUse=false`: behaves like a `DepositUnlockKey` — the boot
 *   stage's first `/consume` returns the key and `.com` deletes the
 *   row. `expiresAt` typically a few minutes after `issuedAt`.
 *
 * `multiUse=true`: persists across multiple `/consume` calls until
 *   `expiresAt`. Lets a server reboot freely while the lease is
 *   live; once it expires, the next boot waits for a fresh lease
 *   (one-shot or renewed long-lived). `expiresAt` typically days
 *   out, with the user's device renewing while it's online.
 *
 * `leaseId` is a unique identifier (16+ hex chars, generated by the
 * signing device) used as the revoke handle. Multiple long-lived
 * leases can coexist for the same server (e.g., user's phone AND
 * webapp both signed); each is independently revocable.
 *
 * Signed by IRK (any device-class IRK is accepted — phone or webapp;
 * the webapp is a peer device, not a phone-remote).
 */
export interface AutoUnlockLease {
  serverId: ServerId;
  /** Unique handle for this lease (16+ hex chars). */
  leaseId: string;
  /** Wall-clock ms after which the lease is no longer valid. */
  expiresAt: number;
  unlockKey: Bytes;
  /** When true, surviving across multiple consume calls until expiry. */
  multiUse: boolean;
  issuedAt: number;
}

/**
 * Revoke a previously-deposited auto-unlock lease (kill switch from
 * the user's device). The signature must be from the same IRK that
 * signed the lease, but `.com` only stores the IRK pubkey indirectly
 * (via the username record), so we accept any IRK signature for the
 * server's owning user — this matches the trust model: any device of
 * yours can revoke any lease on any of your servers.
 */
export interface RevokeAutoUnlockLease {
  serverId: ServerId;
  leaseId: string;
  issuedAt: number;
}

const TAG_PUT_SEALED_LUKS_KEY = "flagship/put-sealed-luks-key/v1";
const TAG_DEPOSIT_UNLOCK_KEY = "flagship/deposit-unlock-key/v1";
const TAG_CONSUME_UNLOCK_KEY = "flagship/consume-unlock-key/v1";
const TAG_AUTO_UNLOCK_LEASE = "flagship/auto-unlock-lease/v1";
const TAG_REVOKE_AUTO_UNLOCK_LEASE = "flagship/revoke-auto-unlock-lease/v1";
const TAG_RE_PAIR_INITIATE = "flagship/re-pair-initiate/v1";
const TAG_RE_PAIR_OBJECT = "flagship/re-pair-object/v1";
const TAG_MARKETPLACE_SCAN_RESULT = "flagship/marketplace-scan-result/v1";

/**
 * Result of the marketplace security scan, posted by the scanner
 * service to .com. Signed by a SCANNER_SIGNING_PUBKEY held by the
 * Flagship-operated scanner — `.com` env carries the corresponding
 * pubkey so the verify gate is centralized. Listings stay
 * scan_grade=NULL until a verifying scan result lands.
 */
export interface MarketplaceScanResult {
  creator: string;
  slug: string;
  grade: "A" | "B" | "C" | "D" | "F";
  /** R2 object key for the full Trivy + custom-checks report. */
  reportKey: string;
  /** sha256 of the docker image scanned, hex. Pins WHICH image got the grade. */
  imageDigestHex: string;
  scannedAt: number;
}

function canonicalMarketplaceScanResult(r: MarketplaceScanResult): Bytes {
  return new TextEncoder().encode(
    [
      TAG_MARKETPLACE_SCAN_RESULT,
      r.creator,
      r.slug,
      r.grade,
      r.reportKey,
      r.imageDigestHex,
      r.scannedAt,
    ].join("|"),
  );
}

export function signMarketplaceScanResult(r: MarketplaceScanResult, scanner: Keypair): Bytes {
  return ed.sign(canonicalMarketplaceScanResult(r), scanner.privateKey);
}
export function verifyMarketplaceScanResult(
  r: MarketplaceScanResult,
  sig: Bytes,
  scannerPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalMarketplaceScanResult(r), scannerPub);
  } catch {
    return false;
  }
}

/**
 * Recovery re-pair (J.3) — after the user has lost their old UMK
 * and generated a fresh one (so a NEW IRK), they POST this
 * envelope to claim ownership of their existing username + servers.
 * .com starts a 24h grace timer; the OLD IRK can sign a
 * `RePairObject` to cancel. After the grace expires with no
 * objection, .com swaps the username's IRK pubkey atomically.
 *
 * Signed by the NEW IRK (the one taking over).
 */
export interface RePairInitiate {
  username: string;
  newIrkPub: Bytes;
  /** Old IRK pubkey, included so .com can show "is this old key really yours to retire?" copy on the objection prompt. */
  oldIrkPub: Bytes;
  issuedAt: number;
}

/**
 * Cancel a pending re-pair. Signed by the OLD IRK — the one being
 * displaced. If the old IRK is still in the user's possession, this
 * is the kill switch for an unauthorized takeover attempt.
 */
export interface RePairObject {
  username: string;
  /** Pinned to the new IRK pubkey from the pending row, so a leaked old objection can't cancel a future re-pair. */
  newIrkPub: Bytes;
  issuedAt: number;
}

function canonicalRePairInitiate(r: RePairInitiate): Bytes {
  return new TextEncoder().encode(
    [TAG_RE_PAIR_INITIATE, r.username, hex(r.newIrkPub), hex(r.oldIrkPub), r.issuedAt].join("|"),
  );
}

function canonicalRePairObject(r: RePairObject): Bytes {
  return new TextEncoder().encode(
    [TAG_RE_PAIR_OBJECT, r.username, hex(r.newIrkPub), r.issuedAt].join("|"),
  );
}

export function signRePairInitiate(r: RePairInitiate, newIrk: Keypair): Bytes {
  return ed.sign(canonicalRePairInitiate(r), newIrk.privateKey);
}
export function verifyRePairInitiate(r: RePairInitiate, sig: Bytes, newIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRePairInitiate(r), newIrkPub);
  } catch {
    return false;
  }
}

export function signRePairObject(r: RePairObject, oldIrk: Keypair): Bytes {
  return ed.sign(canonicalRePairObject(r), oldIrk.privateKey);
}
export function verifyRePairObject(r: RePairObject, sig: Bytes, oldIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRePairObject(r), oldIrkPub);
  } catch {
    return false;
  }
}

function canonicalPutSealedLuksKey(r: PutSealedLuksKey): Bytes {
  return new TextEncoder().encode(
    [TAG_PUT_SEALED_LUKS_KEY, r.serverId, hex(r.sealedKey), r.issuedAt].join("|"),
  );
}

function canonicalDepositUnlockKey(r: DepositUnlockKey): Bytes {
  return new TextEncoder().encode(
    [TAG_DEPOSIT_UNLOCK_KEY, r.serverId, hex(r.unlockKey), r.expiresAt, r.issuedAt].join("|"),
  );
}

function canonicalConsumeUnlockKey(r: ConsumeUnlockKey): Bytes {
  return new TextEncoder().encode(
    [TAG_CONSUME_UNLOCK_KEY, r.serverId, hex(r.nonce), r.issuedAt].join("|"),
  );
}

export function signPutSealedLuksKey(r: PutSealedLuksKey, identity: Keypair): Bytes {
  return ed.sign(canonicalPutSealedLuksKey(r), identity.privateKey);
}
export function verifyPutSealedLuksKey(r: PutSealedLuksKey, sig: Bytes, identityPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPutSealedLuksKey(r), identityPub);
  } catch {
    return false;
  }
}

export function signDepositUnlockKey(r: DepositUnlockKey, irk: Keypair): Bytes {
  return ed.sign(canonicalDepositUnlockKey(r), irk.privateKey);
}
export function verifyDepositUnlockKey(r: DepositUnlockKey, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalDepositUnlockKey(r), irkPub);
  } catch {
    return false;
  }
}

export function signConsumeUnlockKey(r: ConsumeUnlockKey, identity: Keypair): Bytes {
  return ed.sign(canonicalConsumeUnlockKey(r), identity.privateKey);
}
export function verifyConsumeUnlockKey(r: ConsumeUnlockKey, sig: Bytes, identityPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalConsumeUnlockKey(r), identityPub);
  } catch {
    return false;
  }
}

function canonicalAutoUnlockLease(r: AutoUnlockLease): Bytes {
  // Field order is part of the canonical-bytes contract; do NOT reorder.
  // multiUse is encoded "1" / "0" rather than the JS string of a boolean
  // because the canonical-bytes layer is language-neutral.
  return new TextEncoder().encode(
    [
      TAG_AUTO_UNLOCK_LEASE,
      r.serverId,
      r.leaseId,
      r.expiresAt,
      hex(r.unlockKey),
      r.multiUse ? "1" : "0",
      r.issuedAt,
    ].join("|"),
  );
}

function canonicalRevokeAutoUnlockLease(r: RevokeAutoUnlockLease): Bytes {
  return new TextEncoder().encode(
    [TAG_REVOKE_AUTO_UNLOCK_LEASE, r.serverId, r.leaseId, r.issuedAt].join("|"),
  );
}

/**
 * Webapp cloud-shard recovery — upload a wrapped-UMK ciphertext to
 * flagshipserver.com, encrypted under a WebAuthn passkey's PRF
 * output. `.com` only stores the ciphertext + the credentialId
 * pointer; the unwrap key never leaves the user's browser.
 *
 * The signed envelope binds the upload to the user's IRK so squatting
 * "I am alice" is impossible — `.com` cross-checks the signature
 * against the IRK pubkey stored against `username` in the usernames
 * table.
 *
 * Field shape:
 *   - username:        identifier under which the record is keyed
 *                      (matches the existing usernames table; ASCII,
 *                      lowercased)
 *   - credentialIdHex: WebAuthn credential ID (hex), used by the
 *                      recovering browser to scope the get() call
 *   - wrappedUmkHash:  SHA-256 of the wrapped-UMK ciphertext, hex.
 *                      We sign the hash (not the blob) to keep
 *                      canonical-bytes small and to let `.com` check
 *                      the upload-time hash matches the stored blob
 *                      bytes.
 */
export interface UploadRecoveryRecord {
  username: string;
  credentialIdHex: string;
  wrappedUmkHashHex: string;
  issuedAt: number;
}

const TAG_UPLOAD_RECOVERY_RECORD = "flagship/upload-recovery-record/v1";

function canonicalUploadRecoveryRecord(r: UploadRecoveryRecord): Bytes {
  return new TextEncoder().encode(
    [
      TAG_UPLOAD_RECOVERY_RECORD,
      r.username,
      r.credentialIdHex,
      r.wrappedUmkHashHex,
      r.issuedAt,
    ].join("|"),
  );
}

export function signUploadRecoveryRecord(r: UploadRecoveryRecord, irk: Keypair): Bytes {
  return ed.sign(canonicalUploadRecoveryRecord(r), irk.privateKey);
}
export function verifyUploadRecoveryRecord(
  r: UploadRecoveryRecord,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalUploadRecoveryRecord(r), irkPub);
  } catch {
    return false;
  }
}

export function signAutoUnlockLease(r: AutoUnlockLease, irk: Keypair): Bytes {
  return ed.sign(canonicalAutoUnlockLease(r), irk.privateKey);
}
export function verifyAutoUnlockLease(r: AutoUnlockLease, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalAutoUnlockLease(r), irkPub);
  } catch {
    return false;
  }
}

export function signRevokeAutoUnlockLease(r: RevokeAutoUnlockLease, irk: Keypair): Bytes {
  return ed.sign(canonicalRevokeAutoUnlockLease(r), irk.privateKey);
}
export function verifyRevokeAutoUnlockLease(
  r: RevokeAutoUnlockLease,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRevokeAutoUnlockLease(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * A server revoking *itself* — typically in response to a phone
 * `revoke-self` order or a local "I've been compromised" signal. The
 * IRK-signed `ServerRevocation` is the user's path; this is the
 * server's own.
 *
 * Trust model: if the server identity key is leaked, the attacker
 * could revoke the server. That's a small downside (denial of service
 * against the server's own subdomain) compared to the alternative of
 * not letting a daemon shed itself when it knows it should.
 */
export interface ServerRevokeBySelf {
  serverId: ServerId;
  reason: string;
  issuedAt: number;
}

const TAG_SERVER_REVOKE_BY_SELF = "flagship/server-revoke-by-self/v1";

function canonicalServerRevokeBySelf(r: ServerRevokeBySelf): Bytes {
  return new TextEncoder().encode(
    [TAG_SERVER_REVOKE_BY_SELF, r.serverId, r.reason, r.issuedAt].join("|"),
  );
}

export function signServerRevokeBySelf(r: ServerRevokeBySelf, identity: Keypair): Bytes {
  return ed.sign(canonicalServerRevokeBySelf(r), identity.privateKey);
}
export function verifyServerRevokeBySelf(r: ServerRevokeBySelf, sig: Bytes, identityPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalServerRevokeBySelf(r), identityPub);
  } catch {
    return false;
  }
}

/**
 * Phone request to install an app on this server.
 *
 * Signed by the **host's** IRK — the user whose box will run the
 * app. (Not the app's `creator` — when Bob installs Alice's `game1`
 * on his box, Bob's IRK is the authority because the data lives on
 * Bob's hardware.)
 *
 * The manifest is sent inline (`manifestJson`) so the daemon never
 * has to fetch from a network the phone doesn't trust. The phone
 * either composed the manifest itself, fetched + reviewed it from
 * the LLM harness, or pulled it from a Forgejo repo and is shipping
 * it over.
 *
 * `addOwnerToMembership` defaults to true — the user installing an
 * app generally wants to be a member of it. The phone install screen
 * exposes the toggle so a host installing on behalf of others (e.g.,
 * for the family) can leave themselves out of the membership list.
 */
export interface InstallAppRequest {
  serverId: ServerId;
  creator: string;
  slug: string;
  /** Stringified `flagship.app.json` — the manifest as the phone reviewed it. */
  manifestJson: string;
  addOwnerToMembership: boolean;
  issuedAt: number;
}

/**
 * Phone request to uninstall an app. IRK-signed by the host. Removes
 * the container, drops the data namespace, and forgets the membership
 * store. Idempotent against an already-uninstalled app.
 */
export interface UninstallAppRequest {
  serverId: ServerId;
  creator: string;
  slug: string;
  issuedAt: number;
}

const TAG_INSTALL_APP = "flagship/install-app/v1";
const TAG_UNINSTALL_APP = "flagship/uninstall-app/v1";

function canonicalInstallApp(r: InstallAppRequest): Bytes {
  return new TextEncoder().encode(
    [
      TAG_INSTALL_APP,
      r.serverId,
      r.creator,
      r.slug,
      // The manifest is included in the canonical bytes so a MITM can't
      // swap the manifest body against a captured signature.
      r.manifestJson,
      r.addOwnerToMembership ? "1" : "0",
      r.issuedAt,
    ].join("|"),
  );
}

function canonicalUninstallApp(r: UninstallAppRequest): Bytes {
  return new TextEncoder().encode(
    [TAG_UNINSTALL_APP, r.serverId, r.creator, r.slug, r.issuedAt].join("|"),
  );
}

export function signInstallApp(r: InstallAppRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalInstallApp(r), irk.privateKey);
}
export function verifyInstallApp(r: InstallAppRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalInstallApp(r), irkPub);
  } catch {
    return false;
  }
}

export function signUninstallApp(r: UninstallAppRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalUninstallApp(r), irk.privateKey);
}
export function verifyUninstallApp(r: UninstallAppRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalUninstallApp(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * Pull-request envelope for the app update-pack distribution layer.
 *
 * Signed by the **puller's server identity key** (not the phone). The
 * canonical-home daemon resolves `pullerServerId` to its identity
 * pubkey via `flagshipserver.com /api/server/by-domain/<id>` and then
 * verifies. No phone activity is needed for routine update pulls — the
 * trust grant happened earlier when the puller's host accepted the
 * app share (an IRK-signed membership mutation).
 *
 * `since` is the commit hash the puller already has at HEAD. The home
 * returns a pack of commits between `since` and current `main` tip.
 * Empty string means "first pull, send the full history."
 */
export interface UpdatePullRequest {
  pullerServerId: ServerId;
  /** App identity (creator,slug) — the home cross-checks the puller is in this app's subscriber list. */
  creator: string;
  slug: string;
  /** Commit hash the puller already has, or "" for an initial pull. */
  since: string;
  issuedAt: number;
}

const TAG_UPDATE_PULL = "flagship/update-pull/v1";

function canonicalUpdatePull(r: UpdatePullRequest): Bytes {
  return new TextEncoder().encode(
    [
      TAG_UPDATE_PULL,
      r.pullerServerId,
      r.creator,
      r.slug,
      r.since,
      r.issuedAt,
    ].join("|"),
  );
}

export function signUpdatePull(r: UpdatePullRequest, identity: Keypair): Bytes {
  return ed.sign(canonicalUpdatePull(r), identity.privateKey);
}

export function verifyUpdatePull(r: UpdatePullRequest, sig: Bytes, identityPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalUpdatePull(r), identityPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Marketplace listing
// ──────────────────────────────────────────────────────────────────────

/**
 * Phone-signed marketplace listing request. .com stores ONLY the metadata
 * here — never code or data. `manifestHashHex` commits to the manifest
 * the listing claims; phone clients re-check before installing.
 *
 * `descriptionMd` is markdown, capped at 10_000 chars on the .com side.
 * `screenshotKeys` is a list of R2 keys uploaded via a separate route;
 * the listing references them.
 */
export interface MarketplaceListRequest {
  creator: string;        // username
  slug: string;
  name: string;           // display name
  tagline: string;        // ≤ 80 chars
  descriptionMd: string;
  category: string;       // free text on .com side; UI offers a curated set
  tagsCsv: string;        // comma-separated lowercase tags
  canonicalUrl: string;   // <slug>.<creator>.flagship.services
  manifestHashHex: string;
  screenshotKeys: string[];
  publicDistribution: boolean;
  status: "listed" | "private";
  issuedAt: number;
}

const TAG_MARKETPLACE_LIST = "flagship/marketplace-list/v1";

function canonicalMarketplaceList(r: MarketplaceListRequest): Bytes {
  return new TextEncoder().encode(
    [
      TAG_MARKETPLACE_LIST,
      r.creator,
      r.slug,
      r.name,
      r.tagline,
      r.descriptionMd,
      r.category,
      r.tagsCsv,
      r.canonicalUrl,
      r.manifestHashHex,
      r.screenshotKeys.join(","),
      r.publicDistribution ? "1" : "0",
      r.status,
      r.issuedAt,
    ].join("|"),
  );
}

export function signMarketplaceList(r: MarketplaceListRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalMarketplaceList(r), irk.privateKey);
}

export function verifyMarketplaceList(r: MarketplaceListRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalMarketplaceList(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// User registration (RegisterUser canonical-bytes)
//
// Adjacent to the existing `username/claim` flow. Whereas claim is for
// the very first IRK→username binding, RegisterUser is the same envelope
// but kept as a stable name across mobile clients. Functionally a thin
// alias. v2 may extend with display-name + push-token fields.
// ──────────────────────────────────────────────────────────────────────

export interface RegisterUser {
  username: string;
  irkPub: Bytes;
  issuedAt: number;
}

const TAG_REGISTER_USER = "flagship/register-user/v1";

function canonicalRegisterUser(r: RegisterUser): Bytes {
  return new TextEncoder().encode(
    [TAG_REGISTER_USER, r.username, hex(r.irkPub), r.issuedAt].join("|"),
  );
}

export function signRegisterUser(r: RegisterUser, irk: Keypair): Bytes {
  return ed.sign(canonicalRegisterUser(r), irk.privateKey);
}

export function verifyRegisterUser(r: RegisterUser, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRegisterUser(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Push-token registration
//
// The phone registers a device push token (APNs / FCM / WebPush) with
// .com so other devices can reach it. The phone also pre-shares an
// X25519 pubkey at register time; later relays seal payloads to it
// so the Worker forwards opaque ciphertext (cannot read).
// ──────────────────────────────────────────────────────────────────────

export type PushPlatform = "apns" | "fcm" | "webpush";

export interface PushTokenRegister {
  username: string;
  platform: PushPlatform;
  providerToken: string;        // opaque to .com
  pushX25519Pub: Bytes;         // 32 bytes — encryption key for relays
  issuedAt: number;
}

const TAG_PUSH_TOKEN_REGISTER = "flagship/push-token-register/v1";

function canonicalPushTokenRegister(r: PushTokenRegister): Bytes {
  return new TextEncoder().encode(
    [
      TAG_PUSH_TOKEN_REGISTER,
      r.username,
      r.platform,
      r.providerToken,
      hex(r.pushX25519Pub),
      r.issuedAt,
    ].join("|"),
  );
}

export function signPushTokenRegister(r: PushTokenRegister, irk: Keypair): Bytes {
  return ed.sign(canonicalPushTokenRegister(r), irk.privateKey);
}

export function verifyPushTokenRegister(r: PushTokenRegister, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPushTokenRegister(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// LLM promo-key issue
//
// Phone-signed request from a user to mint a one-shot scoped LLM API
// key. The Worker checks tier + daily/lifetime caps + asks the
// upstream provider for a scoped key, returns it sealed against the
// phone's pre-shared pubkey so the box receives it without the
// Worker storing the plaintext.
// ──────────────────────────────────────────────────────────────────────

export type LlmProvider = "anthropic" | "openai" | "google";

export interface LlmPromoIssueRequest {
  username: string;
  serverFqdn: string;          // which box will use the key
  provider: LlmProvider;
  /** Hint for daily token cap; .com clamps to tier-allowed max. */
  desiredDailyInputTokenCap: number;
  desiredDailyOutputTokenCap: number;
  issuedAt: number;
}

const TAG_LLM_PROMO_ISSUE = "flagship/llm-promo-issue/v1";

function canonicalLlmPromoIssue(r: LlmPromoIssueRequest): Bytes {
  return new TextEncoder().encode(
    [
      TAG_LLM_PROMO_ISSUE,
      r.username,
      r.serverFqdn,
      r.provider,
      r.desiredDailyInputTokenCap,
      r.desiredDailyOutputTokenCap,
      r.issuedAt,
    ].join("|"),
  );
}

export function signLlmPromoIssue(r: LlmPromoIssueRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalLlmPromoIssue(r), irk.privateKey);
}

export function verifyLlmPromoIssue(r: LlmPromoIssueRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalLlmPromoIssue(r), irkPub);
  } catch {
    return false;
  }
}

// (ClaimUrlCapability + ClaimUrlCapabilityRevocationList removed in
//  N12d. The hub-side per-pod entitlement cert is the new authority;
//  see RootEntitlement / AppEntitlement above.)

// ──────────────────────────────────────────────────────────────────────
// Pod entitlement certs — two-tier model.
//
// RootEntitlement: never-expires. Signed by the user's IRK. Authorizes
// the pod's own canonical (e.g. `kitchen.john.flagship.services`).
// Without this, a long-offline pod couldn't reconnect even to fetch
// fresh app entitlements — chicken-and-egg.
//
// AppEntitlement: 90-day default TTL. Signed by the user's IRK. Lists
// every app-canonical the pod is currently entitled to serve (e.g.
// `messenger-facebook.kitchen.john.flagship.services`,
// `shittygame.woodshed.john.flagship.services`). Phone re-issues
// opportunistically (on app install/uninstall, on rolling refresh).
//
// `.services` validates both at HELLO time. Shortened slots (the
// user-zone and host-zone collapsed forms like
// `messenger.john.flagship.services`) are AUTOMATICALLY DERIVED from
// the cert's canonicals — not separately listed. Multiple pods may
// derive overlapping shortened slots → collision is normal → FCFS
// resolves at the hub.
//
// Each cert has a stable `certId` = SHA-256 hex of its canonical
// bytes. Revocation lists reference certs by id.
// ──────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use AppGrant (see below). RootEntitlement and
 * AppEntitlement are subsumed by AppGrant under the Thread-C model.
 * Existing signed RootEntitlements remain verifiable for back-compat;
 * new pods issue AppGrants instead, which carry a 7-day TTL by
 * convention (#51 cadence — long-offline pods naturally lose authority
 * without depending on revocation-list propagation).
 *
 * Perpetual cert authorizing a single pod canonical. Issued once at
 * pod registration, never re-issued. Phone retains the ability to
 * REVOKE it (via the cert revocation list — see below) for compromise
 * scenarios.
 */
export interface RootEntitlement {
  /** User-zone owner — middle label of the pod canonical. */
  username: string;
  /** Pod identity pubkey (the STK). 32 bytes. */
  podPubKey: Bytes;
  /** Pod's canonical FQDN, e.g. `kitchen.john.flagship.services`. */
  podCanonical: string;
  /** ms since epoch when this cert was minted. */
  issuedAt: number;
}

const TAG_ROOT_ENTITLEMENT = "flagship/root-entitlement/v1";

function canonicalRootEntitlement(c: RootEntitlement): Bytes {
  return new TextEncoder().encode(
    [
      TAG_ROOT_ENTITLEMENT,
      c.username,
      hex(c.podPubKey),
      c.podCanonical,
      c.issuedAt,
    ].join("|"),
  );
}

export function signRootEntitlement(c: RootEntitlement, irk: Keypair): Bytes {
  return ed.sign(canonicalRootEntitlement(c), irk.privateKey);
}

export function verifyRootEntitlement(
  c: RootEntitlement,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRootEntitlement(c), irkPub);
  } catch {
    return false;
  }
}

/**
 * Time-limited cert authorizing a list of app-canonicals on a pod.
 * Re-issued by the phone whenever the canonicals change OR before
 * `expiresAt` lapses (default TTL 90 days).
 *
 * Canonicals listed here are FQDNs of the form
 * `<slug>[-<author>].<host>.<user>.flagship.services`. The hub uses
 * them to derive the shortened slots the pod can compete for; the
 * pod doesn't list shortened slots explicitly.
 *
 * FUTURE: extend with `customDomains: Array<{ host: string; appId:
 * { slug: string; author: string } }>`. A user-purchased domain
 * (e.g., `notes.alice.com` pointed at .services) MUST be bound to a
 * specific (slug, author, user) tuple — never free-floating. The
 * binding goes in the cert so the hub can route the SNI through the
 * same allocator state. This expansion is wire-only on AppEntitlement;
 * the allocator already keys per-(slug, author, user) so custom
 * domains slot in alongside derived shorteneds in the same set.
 */
/**
 * @deprecated Use AppGrant. AppEntitlement was the per-pod listing of
 * canonicals; AppGrant inverts the axis (per-app listing of pods) for
 * cleaner multi-pod failover.
 */
export interface AppEntitlement {
  username: string;
  podPubKey: Bytes;
  /** Lower-cased FQDNs the pod is entitled to serve. */
  canonicals: string[];
  issuedAt: number;
  expiresAt: number;
}

const TAG_APP_ENTITLEMENT = "flagship/app-entitlement/v1";

function canonicalAppEntitlement(c: AppEntitlement): Bytes {
  // Sort canonicals so signing is order-independent.
  const list = [...c.canonicals].map((s) => s.toLowerCase()).sort().join(",");
  return new TextEncoder().encode(
    [
      TAG_APP_ENTITLEMENT,
      c.username,
      hex(c.podPubKey),
      list,
      c.issuedAt,
      c.expiresAt,
    ].join("|"),
  );
}

export function signAppEntitlement(c: AppEntitlement, irk: Keypair): Bytes {
  return ed.sign(canonicalAppEntitlement(c), irk.privateKey);
}

export function verifyAppEntitlement(
  c: AppEntitlement,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalAppEntitlement(c), irkPub);
  } catch {
    return false;
  }
}

/**
 * Stable identifier for an entitlement cert — SHA-256 hex of its
 * canonical bytes. Used as the lookup key in revocation lists.
 *
 * The discriminator argument selects which canonical-bytes function
 * to hash, since the two cert types share an `issuedAt` and could
 * otherwise collide (extremely unlikely in practice, but guard
 * cheaply).
 */
export async function rootEntitlementCertId(c: RootEntitlement): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalRootEntitlement(c));
  return hex(new Uint8Array(digest));
}

export async function appEntitlementCertId(c: AppEntitlement): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalAppEntitlement(c));
  return hex(new Uint8Array(digest));
}

/**
 * Phone-signed revocation list. The phone publishes this to .com on
 * change; .services pulls per-user with a small cache TTL (default
 * 5 min) to honor revocations promptly without hammering the Worker.
 *
 * Monotonic `issuedAt` defends against replay of an older list (which
 * would un-revoke certs).
 */
export interface EntitlementRevocationList {
  username: string;
  /** Cert ids (SHA-256 hex) that are revoked. */
  certIds: string[];
  issuedAt: number;
}

const TAG_ENTITLEMENT_REVOKE = "flagship/entitlement-revoke/v1";

function canonicalEntitlementRevocationList(r: EntitlementRevocationList): Bytes {
  return new TextEncoder().encode(
    [
      TAG_ENTITLEMENT_REVOKE,
      r.username,
      [...r.certIds].sort().join(","),
      r.issuedAt,
    ].join("|"),
  );
}

export function signEntitlementRevocationList(
  r: EntitlementRevocationList,
  irk: Keypair,
): Bytes {
  return ed.sign(canonicalEntitlementRevocationList(r), irk.privateKey);
}

export function verifyEntitlementRevocationList(
  r: EntitlementRevocationList,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalEntitlementRevocationList(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * TunnelHello v2 — the HELLO frame envelope sent over the .services
 * tunnel WS. Replaces v1's `subdomains` / `controlledDomains` model
 * with entitlement-cert-driven allocation.
 *
 * The pod's STK signs `canonicalTunnelHelloV2` (which references the
 * cert ids, not the certs themselves). This binds the STK signature
 * to the specific certs being presented; a captured signature can't
 * be replayed against a different cert set.
 *
 * The wire payload (sent as the FRAME_HELLO body) carries the certs +
 * their IRK signatures alongside this signed envelope so the hub can
 * verify both (STK on envelope, IRK on certs) without an extra
 * round-trip.
 */
export interface TunnelHelloV2 {
  serverId: ServerId;
  /** SHA-256 hex of the RootEntitlement's canonical bytes. */
  rootEntitlementCertId: string;
  /**
   * SHA-256 hex of the AppEntitlement's canonical bytes, or empty
   * string when no app entitlement is presented (initial provisioning).
   */
  appEntitlementCertId: string;
  /** 32-byte random nonce for replay defense. */
  nonce: Bytes;
  issuedAt: number;
}

const TAG_TUNNEL_HELLO_V2 = "flagship/tunnel-hello/v2";

function canonicalTunnelHelloV2(h: TunnelHelloV2): Bytes {
  return new TextEncoder().encode(
    [
      TAG_TUNNEL_HELLO_V2,
      h.serverId,
      h.rootEntitlementCertId,
      h.appEntitlementCertId,
      hex(h.nonce),
      h.issuedAt,
    ].join("|"),
  );
}

export function signTunnelHelloV2(h: TunnelHelloV2, stk: Keypair): Bytes {
  return ed.sign(canonicalTunnelHelloV2(h), stk.privateKey);
}

export function verifyTunnelHelloV2(
  h: TunnelHelloV2,
  sig: Bytes,
  stkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalTunnelHelloV2(h), stkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// AppGrant — the unified envelope replacing RootEntitlement +
// AppEntitlement + ClaimUrlCapability.
//
// One grant covers all four authorization concerns for a single app:
//   - WHO authorized: the user, via IRK signature
//   - WHO may run: one or more pod identities (failover/sibling group)
//   - WHAT they may run: an app, identified by appName@authorStableId
//   - WHERE they may serve from: a list of serverDomains + routes
//   - HOW LONG: issuedAt → expiresAt (7 days by convention)
//
// Renewal is a fresh AppGrant with a new grantId, distributed to
// siblings via the sibling-WS routine sync. Individual revocation by
// grantId is supported via the revocation list (see #88).
//
// Discrimination from older entitlements:
//   - 7-day TTL (vs 90-day AppEntitlement) → phone-loss blast radius
//     bounded to one week
//   - per-app rather than per-pod-listing-many-apps → multi-pod
//     failover is natural
//   - explicit allowedPodIdentities → cross-pod cert escalation closed
//     at the AppGrant verification layer
// ──────────────────────────────────────────────────────────────────────

export type AppGrantRouteScope = "canonical" | "non-canonical" | "subpath";

export interface AppGrantRoute {
  /** Lower-case FQDN (and optional path prefix for "subpath" scope). */
  url: string;
  scope: AppGrantRouteScope;
}

export interface AppGrant {
  /** Fresh v4 UUID; consumers reject duplicates within the active window. */
  grantId: string;
  /** Username at issuance time. Renames produce new grants under the new name. */
  username: string;
  /**
   * App canonical name in the form `appName@authorStableId` where
   * authorStableId is a 12-char SHA-256 prefix of the author's IRK pubkey.
   * Stable across author renames.
   */
  appCanonical: string;
  /** Optional discriminator for multi-instance installs of the same app. */
  appInstanceId?: string;
  /** Pod canonical FQDNs covered by this grant (sorted at canonicalization). */
  serverDomains: string[];
  /** Pod identity pubkeys authorized to serve (sorted at canonicalization). */
  serverIdentities: Bytes[];
  /** Explicit list of URLs (canonical + non-canonical + subpath) covered. */
  routes: AppGrantRoute[];
  /** ms since epoch. */
  issuedAt: number;
  /** ms since epoch; SHOULD be issuedAt + 7*24*3600*1000 by convention. */
  expiresAt: number;
}

const TAG_APP_GRANT = "flagship/app-grant/v1";

/**
 * Validate that no string field in an AppGrant contains the
 * canonical-bytes separator '|' or any control byte (H1 hardening).
 * Throws on violation.
 */
function validateAppGrantFields(g: AppGrant): void {
  const fields: Array<[string, string]> = [
    ["grantId", g.grantId],
    ["username", g.username],
    ["appCanonical", g.appCanonical],
  ];
  if (g.appInstanceId) fields.push(["appInstanceId", g.appInstanceId]);
  for (const d of g.serverDomains) fields.push(["serverDomain", d]);
  for (const r of g.routes) fields.push([`route(${r.scope})`, r.url]);
  for (const [name, value] of fields) {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 0x7c) throw new Error(`AppGrant field "${name}" contains separator '|'`);
      if (c <= 0x1f || c === 0x7f) {
        throw new Error(
          `AppGrant field "${name}" contains control char 0x${c.toString(16)} at index ${i}`,
        );
      }
    }
  }
  if (g.expiresAt <= g.issuedAt) {
    throw new Error("AppGrant: expiresAt must be strictly after issuedAt");
  }
  if (g.serverIdentities.length === 0) {
    throw new Error("AppGrant: serverIdentities must have at least one entry");
  }
  if (g.routes.length === 0) {
    throw new Error("AppGrant: routes must have at least one entry");
  }
}

function canonicalAppGrant(g: AppGrant): Bytes {
  validateAppGrantFields(g);
  const domains = [...g.serverDomains].map((d) => d.toLowerCase()).sort().join(",");
  const identities = [...g.serverIdentities].map((b) => hex(b)).sort().join(",");
  const routes = [...g.routes]
    .map((r) => `${r.scope}:${r.url.toLowerCase()}`)
    .sort()
    .join(",");
  return new TextEncoder().encode(
    [
      TAG_APP_GRANT,
      g.grantId,
      g.username,
      g.appCanonical,
      g.appInstanceId ?? "",
      domains,
      identities,
      routes,
      g.issuedAt,
      g.expiresAt,
    ].join("|"),
  );
}

export function signAppGrant(g: AppGrant, irk: Keypair): Bytes {
  return ed.sign(canonicalAppGrant(g), irk.privateKey);
}

export function verifyAppGrant(g: AppGrant, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalAppGrant(g), irkPub);
  } catch {
    return false;
  }
}

/**
 * Stable identifier for an AppGrant — SHA-256 hex of its canonical
 * bytes. Used as the lookup key in revocation lists and the cert-sync
 * inventory.
 */
export async function appGrantId(g: AppGrant): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalAppGrant(g));
  return hex(new Uint8Array(digest));
}

/**
 * Check whether a specific pod identity is authorized under this grant.
 * The verifier MUST also confirm the grant's signature, that it is not
 * revoked, and that the current time is within [issuedAt, expiresAt).
 */
export function appGrantAuthorizesPod(g: AppGrant, podPubKey: Bytes): boolean {
  const target = hex(podPubKey);
  for (const id of g.serverIdentities) {
    if (hex(id) === target) return true;
  }
  return false;
}

/**
 * Check whether a URL is in the grant's routes list.
 * Comparison is case-insensitive on the host portion.
 */
export function appGrantAuthorizesUrl(g: AppGrant, url: string): boolean {
  const target = url.toLowerCase();
  for (const r of g.routes) {
    if (r.url.toLowerCase() === target) return true;
    if (r.scope === "subpath" && target.startsWith(r.url.toLowerCase() + "/")) return true;
  }
  return false;
}

/**
 * Check whether `now` falls inside the grant's active window. The
 * window is half-open: [issuedAt, expiresAt).
 */
export function appGrantActiveAt(g: AppGrant, now: number): boolean {
  return now >= g.issuedAt && now < g.expiresAt;
}

/**
 * Derive the author stable ID (12-char SHA-256 prefix) from an IRK
 * pubkey. The author identifier is what survives username renames.
 */
export async function authorStableId(authorIrkPub: Bytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", authorIrkPub);
  return hex(new Uint8Array(digest).slice(0, 6)); // 6 bytes = 12 hex chars
}

// ──────────────────────────────────────────────────────────────────────
// PodIdentityBinding (#89) — IRK-signed attestation that a pod identity
// pubkey is one of the user's pods. Issued at registration and stored
// on the pod's encrypted disk; presented at sibling-WS handshakes so
// other pods can verify locally (they know the same IRK pubkey via
// their shared UMK derivation) without round-tripping .com.
// ──────────────────────────────────────────────────────────────────────

export interface PodIdentityBinding {
  username: string;
  podIdentityPubKey: Bytes;
  serverDomain: string;
  registeredAt: number;
}

const TAG_POD_BINDING = "flagship/pod-binding/v1";

function canonicalPodIdentityBinding(b: PodIdentityBinding): Bytes {
  validateNoSepCtrl("username", b.username);
  validateNoSepCtrl("serverDomain", b.serverDomain);
  return new TextEncoder().encode(
    [TAG_POD_BINDING, b.username, hex(b.podIdentityPubKey), b.serverDomain, b.registeredAt].join("|"),
  );
}

export function signPodIdentityBinding(b: PodIdentityBinding, irk: Keypair): Bytes {
  return ed.sign(canonicalPodIdentityBinding(b), irk.privateKey);
}

export function verifyPodIdentityBinding(b: PodIdentityBinding, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPodIdentityBinding(b), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// AppAccessInvite (#79) — single-use access secret for inviting
// specific people to a pod-resident app. Distinct from the legacy
// InviteToken (used for membership / cross-pod app collaboration). The
// access invite uses an opaqueTag to keep the recipient's identity off
// the server; the owner's phone keeps the tag→displayName map locally.
//
// expectedIrkPubKey is optional: when set, only that exact IRK can
// consume the invite. When null, first-IRK-to-redeem wins (bearer
// model; combined with short TTL + atomic single-use, this is the
// pattern users invoke when they don't yet know the recipient's IRK).
// ──────────────────────────────────────────────────────────────────────

export interface AppAccessInvite {
  /** Fresh UUID; consumers reject duplicates. */
  inviteId: string;
  /** App canonical (appName@authorStableId). */
  appCanonical: string;
  /** SHA-256 hex of the random secret embedded in the share-link fragment. */
  secretHash: string;
  /** Role granted on consumption (e.g. "admin", "reader"). */
  role: string;
  /** 16-byte opaque tag — issuer-private mapping to a human label. */
  opaqueTag: Bytes;
  /** Optional pre-binding to a known recipient. null = bearer. */
  expectedIrkPubKey: Bytes | null;
  /** Optional context note the consumer sees before consuming. */
  contextNote: string | null;
  issuedAt: number;
  expiresAt: number;
}

const TAG_APP_INVITE = "flagship/app-invite/v1";

function canonicalAppAccessInvite(i: AppAccessInvite): Bytes {
  validateNoSepCtrl("inviteId", i.inviteId);
  validateNoSepCtrl("appCanonical", i.appCanonical);
  validateNoSepCtrl("role", i.role);
  validateNoSepCtrl("secretHash", i.secretHash);
  if (i.contextNote !== null) validateNoSepCtrl("contextNote", i.contextNote);
  return new TextEncoder().encode(
    [
      TAG_APP_INVITE,
      i.inviteId,
      i.appCanonical,
      i.secretHash,
      i.role,
      hex(i.opaqueTag),
      i.expectedIrkPubKey ? hex(i.expectedIrkPubKey) : "",
      i.contextNote ?? "",
      i.issuedAt,
      i.expiresAt,
    ].join("|"),
  );
}

export function signAppAccessInvite(i: AppAccessInvite, irk: Keypair): Bytes {
  return ed.sign(canonicalAppAccessInvite(i), irk.privateKey);
}

export function verifyAppAccessInvite(i: AppAccessInvite, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalAppAccessInvite(i), irkPub);
  } catch {
    return false;
  }
}

export interface AppAccessAcceptance {
  inviteId: string;
  /** SHA-256 hex of the actual secret bytes (must match invite.secretHash). */
  secretHash: string;
  /** Consumer's IRK pubkey — bound to the access record at consumption. */
  consumerIrkPubKey: Bytes;
  acceptedAt: number;
  nonce: Bytes;
}

const TAG_APP_INVITE_ACCEPT = "flagship/app-invite-accept/v1";

function canonicalAppAccessAcceptance(a: AppAccessAcceptance): Bytes {
  validateNoSepCtrl("inviteId", a.inviteId);
  validateNoSepCtrl("secretHash", a.secretHash);
  return new TextEncoder().encode(
    [
      TAG_APP_INVITE_ACCEPT,
      a.inviteId,
      a.secretHash,
      hex(a.consumerIrkPubKey),
      a.acceptedAt,
      hex(a.nonce),
    ].join("|"),
  );
}

export function signAppAccessAcceptance(a: AppAccessAcceptance, consumerIrk: Keypair): Bytes {
  return ed.sign(canonicalAppAccessAcceptance(a), consumerIrk.privateKey);
}

export function verifyAppAccessAcceptance(
  a: AppAccessAcceptance,
  sig: Bytes,
  consumerIrkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalAppAccessAcceptance(a), consumerIrkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// RCK rotation (#75) — two envelopes per Thread B:
//
// RotateRck: routine rotation. Signed by BOTH the old RCK AND the IRK
// (batched under one biometric prompt on the phone). Takes effect
// immediately. Used when the phone still holds the old RCK.
//
// RecoverRck: recovery-grace rotation. Signed by the new IRK only.
// .com holds it pending for 24h; the old IRK (if recoverable) can
// revoke during grace. Used after J.3 when the phone holding the old
// RCK is gone.
// ──────────────────────────────────────────────────────────────────────

export interface RotateRck {
  subdomain: string;
  newRckPubKey: Bytes;
  oldRckPubKey: Bytes;
  issuedAt: number;
  nonce: Bytes;
}

const TAG_ROTATE_RCK = "flagship/rotate-rck/v1";

function canonicalRotateRck(r: RotateRck): Bytes {
  validateNoSepCtrl("subdomain", r.subdomain);
  return new TextEncoder().encode(
    [
      TAG_ROTATE_RCK,
      r.subdomain,
      hex(r.newRckPubKey),
      hex(r.oldRckPubKey),
      r.issuedAt,
      hex(r.nonce),
    ].join("|"),
  );
}

/** Sign with BOTH oldRck and IRK; both signatures returned. */
export function signRotateRck(
  r: RotateRck,
  oldRck: Keypair,
  irk: Keypair,
): { sigOldRck: Bytes; sigIrk: Bytes } {
  const b = canonicalRotateRck(r);
  return { sigOldRck: ed.sign(b, oldRck.privateKey), sigIrk: ed.sign(b, irk.privateKey) };
}

export function verifyRotateRck(
  r: RotateRck,
  sigOldRck: Bytes,
  sigIrk: Bytes,
  oldRckPub: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    const b = canonicalRotateRck(r);
    return ed.verify(sigOldRck, b, oldRckPub) && ed.verify(sigIrk, b, irkPub);
  } catch {
    return false;
  }
}

export interface RecoverRck {
  subdomain: string;
  newRckPubKey: Bytes;
  newIrkPubKey: Bytes;
  declaredAt: number;
  /** = declaredAt + 24h hard minimum; .com enforces. */
  effectiveAt: number;
  nonce: Bytes;
}

const TAG_RECOVER_RCK = "flagship/recover-rck/v1";

function canonicalRecoverRck(r: RecoverRck): Bytes {
  validateNoSepCtrl("subdomain", r.subdomain);
  return new TextEncoder().encode(
    [
      TAG_RECOVER_RCK,
      r.subdomain,
      hex(r.newRckPubKey),
      hex(r.newIrkPubKey),
      r.declaredAt,
      r.effectiveAt,
      hex(r.nonce),
    ].join("|"),
  );
}

export function signRecoverRck(r: RecoverRck, newIrk: Keypair): Bytes {
  return ed.sign(canonicalRecoverRck(r), newIrk.privateKey);
}

export function verifyRecoverRck(r: RecoverRck, sig: Bytes, newIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRecoverRck(r), newIrkPub);
  } catch {
    return false;
  }
}

export interface RevokeRecoverRck {
  subdomain: string;
  /** References the RecoverRck.declaredAt that should be cancelled. */
  pendingDeclaredAt: number;
  revokedAt: number;
  nonce: Bytes;
}

const TAG_REVOKE_RECOVER_RCK = "flagship/revoke-recover-rck/v1";

function canonicalRevokeRecoverRck(r: RevokeRecoverRck): Bytes {
  validateNoSepCtrl("subdomain", r.subdomain);
  return new TextEncoder().encode(
    [
      TAG_REVOKE_RECOVER_RCK,
      r.subdomain,
      r.pendingDeclaredAt,
      r.revokedAt,
      hex(r.nonce),
    ].join("|"),
  );
}

export function signRevokeRecoverRck(r: RevokeRecoverRck, oldIrk: Keypair): Bytes {
  return ed.sign(canonicalRevokeRecoverRck(r), oldIrk.privateKey);
}

export function verifyRevokeRecoverRck(
  r: RevokeRecoverRck,
  sig: Bytes,
  oldIrkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRevokeRecoverRck(r), oldIrkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// MergeBack (#76) — for 7 days after a J.3 recovery binds, the old
// IRK retains authority to sign exactly one envelope kind: a
// MergeBack that surrenders to the new IRK and self-revokes. Handles
// "I recovered then found my phone in the couch cushions." After 7
// days, the old IRK is hard-revoked unconditionally.
// ──────────────────────────────────────────────────────────────────────

export interface MergeBack {
  username: string;
  newIrkPubKey: Bytes;
  /** Devices surrendering authority. */
  surrenderingDevices: Bytes[];
  issuedAt: number;
}

const TAG_MERGE_BACK = "flagship/merge-back/v1";

function canonicalMergeBack(m: MergeBack): Bytes {
  validateNoSepCtrl("username", m.username);
  const devices = [...m.surrenderingDevices].map((b) => hex(b)).sort().join(",");
  return new TextEncoder().encode(
    [TAG_MERGE_BACK, m.username, hex(m.newIrkPubKey), devices, m.issuedAt].join("|"),
  );
}

export function signMergeBack(m: MergeBack, oldIrk: Keypair): Bytes {
  return ed.sign(canonicalMergeBack(m), oldIrk.privateKey);
}

export function verifyMergeBack(m: MergeBack, sig: Bytes, oldIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalMergeBack(m), oldIrkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helper: reject '|' or control chars in any string field. Used by the
// new envelopes above. (The legacy envelopes pre-date this guard; the
// v2 framing migration #96 will harden them comprehensively.)
// ──────────────────────────────────────────────────────────────────────

function validateNoSepCtrl(name: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x7c) {
      throw new Error(`canonical-bytes field "${name}" contains separator '|' at index ${i}`);
    }
    if (c <= 0x1f || c === 0x7f) {
      throw new Error(
        `canonical-bytes field "${name}" contains control char 0x${c.toString(16)} at index ${i}`,
      );
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// UsernameRename (#93) — IRK-signed account rename. Records a
// permanent alias in .com's usernames_aliases table so old invite
// links + URLs resolve indefinitely. The OLD name is forever consumed
// — never re-issuable to anyone else (closes the "stolen-name →
// someone-else-gets-it" attack).
// ──────────────────────────────────────────────────────────────────────

export interface UsernameRename {
  oldUsername: string;
  newUsername: string;
  effectiveAt: number;
}

const TAG_USERNAME_RENAME = "flagship/username-rename/v1";

function canonicalUsernameRename(r: UsernameRename): Bytes {
  validateNoSepCtrl("oldUsername", r.oldUsername);
  validateNoSepCtrl("newUsername", r.newUsername);
  return new TextEncoder().encode(
    [TAG_USERNAME_RENAME, r.oldUsername, r.newUsername, r.effectiveAt].join("|"),
  );
}

export function signUsernameRename(r: UsernameRename, irk: Keypair): Bytes {
  return ed.sign(canonicalUsernameRename(r), irk.privateKey);
}

export function verifyUsernameRename(r: UsernameRename, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalUsernameRename(r), irkPub);
  } catch {
    return false;
  }
}
