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

const TAG_PUT_SEALED_LUKS_KEY = "flagship/put-sealed-luks-key/v1";
const TAG_DEPOSIT_UNLOCK_KEY = "flagship/deposit-unlock-key/v1";
const TAG_CONSUME_UNLOCK_KEY = "flagship/consume-unlock-key/v1";

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

// ──────────────────────────────────────────────────────────────────────
// ClaimUrlCapability — phone-issued, IRK-signed authorization for a
// specific app instance to claim a specific FQDN.
//
// The harness's `/api/url/claim` endpoint MUST enforce that all three
// of (appId, siblingId, fqdn) match the calling instance. The capability
// alone is not a bearer token: it is a stored authorization the daemon
// looks up by tuple. Possession of the capability bytes does not grant
// claiming rights — only their presence in the daemon's capability store
// for the calling (appId, siblingId, fqdn) tuple does.
//
// Why username on the capability: makes verification self-contained
// against the user's registered IRK pubkey.
// ──────────────────────────────────────────────────────────────────────

export interface ClaimUrlCapability {
  username: string;
  appId: string;
  siblingId: ServerId;
  /** Lower-cased FQDN — the URL this capability authorizes claiming. */
  fqdn: string;
  /** ms since epoch when the capability was minted. */
  issuedAt: number;
  /** ms since epoch after which the capability is invalid. */
  expiresAt: number;
}

const TAG_CLAIM_URL_CAP = "flagship/claim-url-capability/v1";

function canonicalClaimUrlCapability(c: ClaimUrlCapability): Bytes {
  return new TextEncoder().encode(
    [
      TAG_CLAIM_URL_CAP,
      c.username,
      c.appId,
      c.siblingId,
      c.fqdn,
      c.issuedAt,
      c.expiresAt,
    ].join("|"),
  );
}

export function signClaimUrlCapability(c: ClaimUrlCapability, irk: Keypair): Bytes {
  return ed.sign(canonicalClaimUrlCapability(c), irk.privateKey);
}

export function verifyClaimUrlCapability(
  c: ClaimUrlCapability,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalClaimUrlCapability(c), irkPub);
  } catch {
    return false;
  }
}

/**
 * Stable identifier for a capability — deterministic SHA-256 over the
 * canonical bytes, lower-cased hex. Used as the lookup key in the
 * daemon's capability store and on the revocation list.
 */
export async function claimUrlCapabilityId(c: ClaimUrlCapability): Promise<string> {
  const bytes = canonicalClaimUrlCapability(c);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

/**
 * Phone-signed revocation list for a user. The phone broadcasts this on
 * change; daemons cache it with a TTL (default 60s) and refuse to honor
 * any capability whose `id` (canonical-SHA-256 hex) appears in the list.
 *
 * `issuedAt` lets the daemon discard older lists when a newer one
 * arrives (monotonic).
 */
export interface ClaimUrlCapabilityRevocationList {
  username: string;
  capabilityIds: string[];
  issuedAt: number;
}

const TAG_CLAIM_URL_CAP_REVOKE = "flagship/claim-url-capability-revoke/v1";

function canonicalClaimUrlCapabilityRevocationList(
  r: ClaimUrlCapabilityRevocationList,
): Bytes {
  return new TextEncoder().encode(
    [
      TAG_CLAIM_URL_CAP_REVOKE,
      r.username,
      r.capabilityIds.join(","),
      r.issuedAt,
    ].join("|"),
  );
}

export function signClaimUrlCapabilityRevocationList(
  r: ClaimUrlCapabilityRevocationList,
  irk: Keypair,
): Bytes {
  return ed.sign(canonicalClaimUrlCapabilityRevocationList(r), irk.privateKey);
}

export function verifyClaimUrlCapabilityRevocationList(
  r: ClaimUrlCapabilityRevocationList,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalClaimUrlCapabilityRevocationList(r), irkPub);
  } catch {
    return false;
  }
}
