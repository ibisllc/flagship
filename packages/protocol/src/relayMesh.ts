/**
 * The relay mesh (docs/architecture-v2/relay-mesh.md, release 0.3, chunk A): every signed record relays, `.com`, boxes
 * and phones exchange so several relays share one data plane, the public relay log a relay derives its state from,
 * and the pure rules every relay (TS `apps/web/src/tunnel/mesh/`, Rust `flagship-relay/src/mesh/`) and every box
 * (`server-daemon/src/tunnel/relayMesh.ts`) apply to them. Rust twin: `rust/crates/flagship-crypto/src/relay_mesh.rs`;
 * shared vectors: `packages/protocol/test-vectors/relay-mesh/vectors.json` (`npx tsx tools/relay-mesh-vectors.ts`).
 *
 * Canonical bytes (UTF-8 of `tag|field|…`; numbers decimal ms or counters; keys lowercase hex; an absent field is the
 * empty string; lists sorted bytewise, joined by `,`):
 *
 *   flagship/relay-blessing/v1|<relayId>|<relayKey>|<servicesApex>|<tunnelHost>|<relayKind>|<nonce>|<issuedAt>|<expiresAt>
 *   flagship/relay-blessing-request/v1|<relayId>|<relayKey>|<servicesApex>|<issuedAt>
 *   flagship/relay-directory/v1|<servicesApex>|<directoryVersion>|<issuedAt>|<expiresAt>|<entriesSha256>
 *     entry line: `<relayId> <relayKey> <tunnelHost> <relayKind> <region> <ipv4,… or -> <ipv6,… or ->`
 *   flagship/relay-log/v1|<servicesApex>|<sequence>|<kind>|<at>|<f1>|<f2>|<f3>|<f4>
 *   flagship/relay-log-head/v1|<servicesApex>|<sequence>|<tipSha256>|<directoryVersion>|<issuedAt>
 *   flagship/relay-attachment/v1|<serverFqdn>|<boxPub>|<regGen>|<relayId>|<attachedAt>|<issuedAt>|<notAfter>
 *   flagship/relay-legacy-attachment/v1|<serverFqdn>|<boxPub>|<regGen>|<relayId>|<attachedAt>|<issuedAt>|<notAfter>
 *   flagship/relay-withdraw/v1|<subjectKind>|<subject>|<relayId>|<withdrawnIssuedAt>|<at>
 *   flagship/relay-bridge-auth/v2|<role>|<signerRelayId>|<peerRelayId>|<serverNonce>|<clientNonce>|<at>|<kx>
 *   flagship/relay-move-hint/v1|<serverFqdn>|<boxPub>|<fromRelayId>|<toRelayId>|<reason>|<issuedAt>|<notAfter>
 *   flagship/relay-account-move/v1|<accountHash>|<fromRelayId>|<toRelayId>|<issuedAt>|<notAfter>
 *   flagship/phone-route-grant/v1|<hostname>|<phoneRoutePub>|<generation>|<holderRelayId>|<ledgerRelayId>|<issuedAt>|<notAfter>
 *
 * Signers: the blessing and the directory by `.com`'s hot CA key (verified against the authorized CA keys the caller
 * resolved from the maintainer chain: `relayMeshCaKeys`); the log entries and heads by the log key; the box attachment
 * by the box's STK; the blessing request, legacy attachment, withdrawal, bridge auth, move hint and account move by a
 * relay key; the phone route grant by the phone ledger relay's key. Every signature is strict Ed25519, 128 hex.
 *
 * Public API (names fixed by the spec; chunks C, D and E import them):
 *   constants            ATTACH_TTL_MS … PHONE_ROUTE_GRANT_TTL_MS (§15.8), RELAY_LOG_ZERO_TIP
 *   hashes               nameHash, accountHash, relayLogEntryHash
 *   shape helpers        isRelayId, isPodName, isBarePhoneName, accountOfPodName, relayTunnelHost
 *   canonical/sign/verify canonicalRelayBlessing, signRelayBlessing, verifyRelayBlessing, verifyRelayBlessingWithChain,
 *                        canonicalRelayBlessingRequest, checkRelayBlessingRequest,
 *                        relayDirectoryEntryLine, relayDirectoryEntriesSha256, canonicalRelayDirectory,
 *                        signRelayDirectory, verifyRelayDirectory, verifyRelayDirectoryWithChain, newerRelayDirectory,
 *                        directoryRelay, makeRelayLogEntry, parseRelayLogEntry, canonicalRelayLogEntry,
 *                        canonicalRelayLogHead, canonicalBoxAttachment, canonicalLegacyAttachment, canonicalRelayWithdraw,
 *                        canonicalBridgeAuth, canonicalMoveHint, canonicalAccountMove, canonicalPhoneRouteGrant,
 *                        signRelayMeshRecord, verifyRelayMeshRecord, relayMeshCaKeys
 *   the log              RelayLogState, emptyRelayLogState, applyRelayLog, relayLogHeadStatus, relayLogFresh, newerRelayLogHead,
 *                        relayLogBox, relayLogAdminKey, relayLogPolicyHead, relayLogRevocations
 *   checks               checkBoxAttachment, checkLegacyAttachment, checkAttachmentItem, attachmentRefusalCode,
 *                        compareAttachments, checkWithdraw, withdrawCovers, checkBridgeAuth, checkMoveHint,
 *                        emptyMoveHintRateState, recordMoveHint, recordMoveTargetFailed, checkAccountMove,
 *                        checkPhoneItem, comparePhoneItems, phoneItemGrants, checkPhoneEligibilityProof
 *   routing              accountHome, phoneLedgerRanking, isPhoneLedgerFor, rebalanceDecision
 *
 * The relay log's confidentiality is an open owner decision (public, or encrypted to a mesh key): nothing here assumes
 * either. The records below are the plaintext a relay verifies; an encryption layer, if chosen, wraps the published
 * files (chunk B) and never these canonical forms.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import { authorizedCaKeysOrFailClosed, MAINTAINER_PINNED_MANDATE_HASH, type CaArtifactReject, type CaTrustChain } from "./maintainerCa.js";
import { requireMasterAdmin } from "./adminAuthority.js";
import { PHONE_BEGIN_MAX_GRANTS, PHONE_ROUTE_LEASE_MS, type PhoneBeginGrant } from "./phoneRoute.js";
import { canonicalRouteClaim, type RouteClaim, type ServingRevocations } from "./servingAuthority.js";
import type { Bytes, Keypair } from "./types.js";

// ── tags ──────────────────────────────────────────────────────────────────

export const TAG_RELAY_BLESSING = "flagship/relay-blessing/v1";
export const TAG_RELAY_BLESSING_REQUEST = "flagship/relay-blessing-request/v1";
export const TAG_RELAY_DIRECTORY = "flagship/relay-directory/v1";
export const TAG_RELAY_LOG = "flagship/relay-log/v1";
export const TAG_RELAY_LOG_HEAD = "flagship/relay-log-head/v1";
export const TAG_RELAY_ATTACHMENT = "flagship/relay-attachment/v1";
export const TAG_RELAY_LEGACY_ATTACHMENT = "flagship/relay-legacy-attachment/v1";
export const TAG_RELAY_WITHDRAW = "flagship/relay-withdraw/v1";
export const TAG_RELAY_BRIDGE_AUTH = "flagship/relay-bridge-auth/v2";
/** HKDF info prefix for the per-direction bridge MAC keys (§6.2). */
export const TAG_RELAY_BRIDGE_MAC = "flagship/relay-bridge-mac/v1";
export const TAG_RELAY_MOVE_HINT = "flagship/relay-move-hint/v1";
export const TAG_RELAY_ACCOUNT_MOVE = "flagship/relay-account-move/v1";
export const TAG_PHONE_ROUTE_GRANT = "flagship/phone-route-grant/v1";
/** Hash domains (no signature): §1. */
export const TAG_RELAY_NAME = "flagship/relay-name/v1";
export const TAG_RELAY_ACCOUNT = "flagship/relay-account/v1";

// ── constants (§15.8) ─────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A box attachment lives at most this long past its `issuedAt`… */
export const ATTACH_TTL_MS = 30 * MIN;
/** …and the box renews it this often. */
export const ATTACH_RENEW_MS = 10 * MIN;
/** A relay-signed legacy attachment (old boxes) lives at most this long; renewed every `LEGACY_RENEW_MS`. */
export const LEGACY_TTL_MS = 3 * MIN;
export const LEGACY_RENEW_MS = 60_000;
/** A `mesh-v1` box that sent no attachment this long after HELLO_ACK is announced as legacy. */
export const LEGACY_ATTACH_WAIT_MS = 10_000;
/** How far a signer's clock may run ahead of (or a bridge peer's `at` differ from) the verifier's. */
export const MESH_CLOCK_SKEW_MS = 60_000;
export const MESH_QUERY_TIMEOUT_MS = 1_500;
export const MESH_NEG_CACHE_MS = 10_000;
export const MESH_NEG_CACHE_MAX = 50_000;
/** A query that skipped a refusing relay and found nothing is remembered this long per (name, excluded relays). */
export const MESH_NEG_CACHE_EXCLUDE_MS = 2_000;
/** Withdrawal tombstones kept per withdrawing relay (§5.4); over it, that relay's oldest goes. */
export const MESH_TOMBSTONES_PER_RELAY_MAX = 100_000;
/** A tombstone outlives every item it can cover (the longest TTL is 30 min). */
export const MESH_TOMBSTONE_KEEP_MS = 60 * MIN;
/** Accepted account moves (and their 6 h spacing) remembered at most (§10.3). */
export const MESH_ACCOUNT_MOVES_MAX = 200_000;
export const MESH_STORE_MAX_BOX_ITEMS = 200_000;
export const MESH_STORE_MAX_PER_RELAY = 100_000;
export const MESH_STORE_MAX_PHONE_ITEMS = 20_000;
/** Per-peer limits. */
export const MESH_PEER_QUERY_RATE = 500;
export const MESH_PEER_QUERY_BURST = 1_000;
export const MESH_PEER_OPEN_RATE = 2_000;
export const MESH_PEER_OPEN_BURST = 4_000;
export const MESH_PEER_MAX_STREAMS = 20_000;
export const MESH_PEER_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
/** A peer over its limit this long straight is cut for `MESH_PEER_CUT_MS`. */
export const MESH_PEER_OVER_LIMIT_MS = 60_000;
export const MESH_PEER_CUT_MS = 10 * MIN;
/** Bridges. */
export const MESH_DIAL_TIMEOUT_MS = 5_000;
export const MESH_HANDSHAKE_STEP_MS = 5_000;
/** `/mesh` handshakes not yet authenticated, across the relay and from one client address (§6.1). */
export const MESH_HANDSHAKE_MAX_PENDING = 64;
export const MESH_HANDSHAKE_MAX_PENDING_PER_IP = 4;
/** Extra pending handshakes only a known peer address may use when the 64 are taken (§6.1). */
export const MESH_HANDSHAKE_RESERVED = 16;
/** The acceptor waits this long for the dialer's `mesh-auth` (the first message), not a whole step (§6.1). */
export const MESH_HANDSHAKE_FIRST_MS = 2_000;
/** An address a peer authenticated from is "known" this long; at most this many are kept (oldest out). */
export const MESH_KNOWN_ADDRESS_TTL_MS = 24 * 60 * MIN;
export const MESH_KNOWN_ADDRESSES_MAX = 256;
/** A bridge that lived less than this does not reset the dialer's backoff (§6.1). */
export const MESH_BRIDGE_STABLE_MS = 30_000;
/** The holder waits this long for a bridged stream's first DATA (the visitor's ClientHello), then closes it (§6.4). */
export const MESH_FIRST_DATA_WAIT_MS = 10_000;
export const MESH_PING_MS = 10_000;
export const MESH_PEER_DOWN_MS = 30_000;
export const MESH_BACKOFF_MIN_MS = 1_000;
export const MESH_BACKOFF_MAX_MS = 60_000;
/** Bridge control messages (JSON text) are at most this big. */
export const MESH_CONTROL_MAX_BYTES = 1024 * 1024;
export const MESH_ANNOUNCE_DELAY_MS = 1_000;
export const MESH_ANNOUNCE_BATCH_MAX = 500;
export const MESH_LOG_PUSH_MAX = 256;
export const MESH_LOG_SINCE_MAX = 1_024;
export const MESH_LOAD_INTERVAL_MS = 30_000;
/** A peer's last `load` message older than this makes it unfit as a rebalancing target. */
export const MESH_LOAD_FRESH_MS = 60_000;
/** Bridged streams use stream-credit-v1 with this initial window per direction. */
export const MESH_STREAM_INITIAL_WINDOW = 256 * 1024;
/** The feed. */
export const FEED_HEAD_MINT_MS = 5_000;
export const FEED_POLL_MS = 5_000;
export const FEED_PAGE_ENTRIES = 512;
/** A relay is fresh while its applied head is at most this old (§4.6). */
export const HEAD_FRESH_MS = 60_000;
/** Not fresh this long: refuse new tunnels and phone begins (1013), 503 to the load balancer. */
export const HEAD_REFUSE_NEW_MS = 60_000;
/** Not fresh this long: close every tunnel (1013 `serving-feed-lost`). */
export const HEAD_CLOSE_ALL_MS = 10 * MIN;
/** The directory. */
export const DIRECTORY_TTL_MS = 7 * DAY;
export const DIRECTORY_REMINT_MS = DAY;
/** An expired directory still routes; this long past its expiry `/api/health` turns 503. */
export const DIRECTORY_EXPIRED_UNHEALTHY_MS = DAY;
/** A box re-checks its relay (blessing, directory) this often, and needs a directory at most this old to follow a hint. */
export const BOX_RELAY_CHECK_MS = HOUR;
export const BOX_DIRECTORY_MAX_AGE_MS = DAY;
/** Relay blessings. */
export const RELAY_BLESSING_TTL_MS = 30 * DAY;
export const RELAY_BLESSING_REFRESH_MS = 24 * HOUR;
/** Rebalancing (§10.2). */
export const REBALANCE_INTERVAL_MS = HOUR;
export const REBALANCE_JITTER_MS = 10 * MIN;
export const REBALANCE_WINDOW_MS = HOUR;
export const REBALANCE_BUCKET_MS = MIN;
export const REBALANCE_MIN_BYTES = 64 * 1024 * 1024;
export const REBALANCE_MIN_STREAMS = 500;
/** One client key's bytes count toward the rebalancing window at most this much (§10.1). */
export const REBALANCE_CLIENT_BYTES_CAP = 8 * 1024 * 1024;
/** Distinct client keys kept per (account, minute, entry relay); later ones share one overflow key. */
export const REBALANCE_CLIENTS_PER_BUCKET_MAX = 1_024;
/** share(T) ≥ 6/10, share(T) − share(home) ≥ 3/10, target tunnels/capacity < 8/10 (integer arithmetic, §10.2). */
export const REBALANCE_MIN_SHARE_TENTHS = 6;
export const REBALANCE_MIN_LEAD_TENTHS = 3;
export const REBALANCE_MAX_LOAD_TENTHS = 8;
/** Moves (§9.3, §10.3). */
export const ACCOUNT_MOVE_TTL_MS = 10 * MIN;
export const ACCOUNT_MOVE_MIN_INTERVAL_MS = 6 * HOUR;
export const MOVE_HINT_TTL_MS = 10 * MIN;
export const MOVE_LOCALITY_MIN_MS = 6 * HOUR;
export const MOVE_COLOCATE_MIN_MS = 10 * MIN;
export const MOVE_COLOCATE_MAX_PER_DAY = 6;
export const MOVE_DIAL_TIMEOUT_MS = 10_000;
export const MOVE_OLD_TUNNEL_GRACE_MS = 30_000;
export const MOVE_FAILED_TARGET_MS = HOUR;
/** Accounts moves send each box its locality hint this far apart. */
export const ACCOUNT_MOVE_HINT_SPACING_MS = 2_000;
/** A phone route grant lives exactly the ledger lease (`PHONE_ROUTE_LEASE_MS`); renewed every `PHONE_ROUTE_RENEW_MS`. */
export const PHONE_ROUTE_GRANT_TTL_MS = PHONE_ROUTE_LEASE_MS;
/** Only the first `PHONE_LEDGER_TOP_K` relays of an account's ledger ranking may sign its phone route grants (§8.1). */
export const PHONE_LEDGER_TOP_K = 3;
/** A phone item's generation may be at most this far above the highest live one a relay holds for the name (§8.4). */
export const PHONE_GENERATION_MAX_JUMP = 8;
/** No phone item's generation may exceed this (so a ledger can always offer the next one). */
export const PHONE_GENERATION_MAX = 2 ** 40;
/** A relay forgets a hostname's highest seen generation this long after the last item for it lapsed (§8.2). */
export const PHONE_GENERATION_MEMORY_MS = HOUR;
/** The relay log's tip before any entry. */
export const RELAY_LOG_ZERO_TIP = "0".repeat(64);
/** How many recent entry hashes a `RelayLogState` keeps to match a head that is behind its tip. */
export const RELAY_LOG_TIP_HISTORY = 1_024;

// ── field rules ───────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const P256_PUB = /^0[23][0-9a-f]{64}$/;
/**
 * A device grant's id as the log carries it: the client chooses grant ids (the apps use UUIDs, some tools 32 or 64 hex),
 * so `.com` appends them lowercased and the relays compare lowercased (`relayLogGrantId`). Any id outside this shape
 * would never reach the relays, so it stays as wide as the ids `.com` stores in practice.
 */
export const RELAY_LOG_GRANT_ID = /^[0-9a-f][0-9a-f-]{0,63}$/;

/** The form a grant id takes in the relay log (and in every relay's revoked-grant set). */
export function relayLogGrantId(grantId: string): string {
  return grantId.toLowerCase();
}
const RELAY_ID = /^[a-z][a-z0-9-]{1,30}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCOUNT = LABEL;
const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IPV4 = /^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/;

const te = new TextEncoder();
const enc = (parts: ReadonlyArray<string | number>): Bytes => te.encode(parts.join("|"));
const sha256hex = (s: string): string => hex(sha256(te.encode(s)));

function bad(name: string, why: string): never {
  throw new Error(`${name} ${why}`);
}
function hexField(name: string, v: unknown, re = HEX64): asserts v is string {
  if (typeof v !== "string" || !re.test(v)) bad(name, "must be lowercase hex of the right length");
}
function intField(name: string, v: unknown, min = 0): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) bad(name, `must be a safe integer ≥ ${min}`);
}
function relayIdField(name: string, v: unknown): asserts v is string {
  if (typeof v !== "string" || !RELAY_ID.test(v)) bad(name, "must be a relay id");
}

/** A relay id: `^[a-z][a-z0-9-]{1,30}$`. */
export function isRelayId(s: unknown): s is string {
  return typeof s === "string" && RELAY_ID.test(s);
}

/** A services apex in canonical form: lowercase DNS labels, at least two. */
export function isServicesApex(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > 200) return false;
  const labels = s.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l));
}
function apexField(name: string, v: unknown): asserts v is string {
  if (!isServicesApex(v)) bad(name, "must be a lowercase services apex");
}

/** `<server>.<user>.<apex>`, lowercase: exactly two labels under the apex. */
export function isPodName(fqdn: unknown, apex: string): fqdn is string {
  if (typeof fqdn !== "string" || !isServicesApex(apex) || !fqdn.endsWith(`.${apex}`)) return false;
  const head = fqdn.slice(0, -(apex.length + 1)).split(".");
  return head.length === 2 && head.every((l) => LABEL.test(l));
}

/** The account a pod name belongs to, or null. */
export function accountOfPodName(fqdn: string, apex: string): string | null {
  return isPodName(fqdn, apex) ? (fqdn.split(".")[1] ?? null) : null;
}

/** `<account>.<apex>`, lowercase: the phone's bare name. */
export function isBarePhoneName(hostname: unknown, apex: string): hostname is string {
  if (typeof hostname !== "string" || !isServicesApex(apex) || !hostname.endsWith(`.${apex}`)) return false;
  return ACCOUNT.test(hostname.slice(0, -(apex.length + 1)));
}

/** A relay's direct name: `<relayId>.tunnel.<servicesApex>` (§2). */
export function relayTunnelHost(relayId: string, servicesApex: string): string {
  return `${relayId}.tunnel.${servicesApex}`;
}

function fromHex(h: string): Bytes {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Strict Ed25519; false for anything malformed. */
function edVerify(sigHex: unknown, msg: Bytes, pubHex: unknown): boolean {
  try {
    if (typeof sigHex !== "string" || typeof pubHex !== "string" || !HEX128.test(sigHex) || !HEX64.test(pubHex)) return false;
    return ed.verify(fromHex(sigHex), msg, fromHex(pubHex));
  } catch {
    return false;
  }
}

// ── hashes (§1) ───────────────────────────────────────────────────────────

/**
 * `sha256hex("flagship/relay-name/v1|" + lowercase(fqdn))`. The name must be 1–253 printable ASCII characters without
 * `|` (so ASCII lowercasing is the same in every port).
 */
export function nameHash(fqdn: string): string {
  if (typeof fqdn !== "string" || !/^[\x21-\x7b\x7d\x7e]{1,253}$/.test(fqdn)) bad("fqdn", "must be a host name");
  return sha256hex(`${TAG_RELAY_NAME}|${fqdn.toLowerCase()}`);
}

/** `sha256hex("flagship/relay-account/v1|" + u)` for a lowercase account name. */
export function accountHash(account: string): string {
  if (typeof account !== "string" || !ACCOUNT.test(account)) bad("account", "must be a lowercase account name");
  return sha256hex(`${TAG_RELAY_ACCOUNT}|${account}`);
}

// ── relay blessing (§3.2) ─────────────────────────────────────────────────

export type RelayKind = "full" | "entry";
function kindField(v: unknown): asserts v is RelayKind {
  if (v !== "full" && v !== "entry") bad("relayKind", "must be full or entry");
}

export interface RelayBlessingBody {
  relayId: string;
  relayKey: string;
  servicesApex: string;
  /** Exactly `<relayId>.tunnel.<servicesApex>`. */
  tunnelHost: string;
  relayKind: RelayKind;
  /** 32 lowercase hex, minted by `.com` per blessing. */
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface RelayBlessing extends RelayBlessingBody {
  kind: "RelayBlessing";
  version: 1;
  /** The CA key that signed (must also appear in `signatures`). */
  signedBy: string;
  signatures: Array<{ pubkey: string; sig: string }>;
}

export function canonicalRelayBlessing(b: RelayBlessingBody): Bytes {
  relayIdField("relayId", b.relayId);
  hexField("relayKey", b.relayKey);
  apexField("servicesApex", b.servicesApex);
  if (b.tunnelHost !== relayTunnelHost(b.relayId, b.servicesApex)) bad("tunnelHost", "must be <relayId>.tunnel.<servicesApex>");
  kindField(b.relayKind);
  hexField("nonce", b.nonce, HEX32);
  intField("issuedAt", b.issuedAt);
  intField("expiresAt", b.expiresAt);
  if (b.expiresAt <= b.issuedAt) bad("expiresAt", "must be after issuedAt");
  return enc([TAG_RELAY_BLESSING, b.relayId, b.relayKey, b.servicesApex, b.tunnelHost, b.relayKind, b.nonce, b.issuedAt, b.expiresAt]);
}

function caEnvelope<K extends string>(kind: K, msg: Bytes, ca: Keypair) {
  const signedBy = hex(ca.publicKey);
  return { kind, version: 1 as const, signedBy, signatures: [{ pubkey: signedBy, sig: hex(ed.sign(msg, ca.privateKey)) }] };
}

/** `.com`: mint a blessing with the hot CA key. */
export function signRelayBlessing(body: RelayBlessingBody, ca: Keypair): RelayBlessing {
  const env = caEnvelope("RelayBlessing", canonicalRelayBlessing(body), ca);
  return {
    kind: env.kind,
    version: env.version,
    relayId: body.relayId,
    relayKey: body.relayKey,
    servicesApex: body.servicesApex,
    tunnelHost: body.tunnelHost,
    relayKind: body.relayKind,
    nonce: body.nonce,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    signedBy: env.signedBy,
    signatures: env.signatures,
  };
}

export type CaSignedReject = "malformed" | "wrong-apex" | "no-authorized-ca-keys" | "signature-unverified";
export type RelayBlessingReject = CaSignedReject | "artifact-expired";

/** `signedBy` is an authorized key, appears in `signatures`, and its signature verifies. */
function caSigned(env: { signedBy?: unknown; signatures?: unknown }, msg: Bytes, caKeys: readonly string[]): boolean {
  if (typeof env.signedBy !== "string" || !Array.isArray(env.signatures)) return false;
  const signer = env.signedBy;
  if (!caKeys.some((k) => k.toLowerCase() === signer)) return false;
  return env.signatures.some((s: unknown) => {
    const e = s as { pubkey?: unknown; sig?: unknown } | null;
    return !!e && e.pubkey === signer && edVerify(e.sig, msg, signer);
  });
}

/**
 * Verify a relay blessing against the CA keys authorized now (`relayMeshCaKeys`): well-formed, for `servicesApex`,
 * within its TTL (`issuedAt` may be up to `MESH_CLOCK_SKEW_MS` ahead of `now`), signed by `signedBy`.
 */
export function verifyRelayBlessing(
  b: RelayBlessing,
  caKeys: readonly string[],
  now: number,
  servicesApex: string,
): { ok: true } | { ok: false; reason: RelayBlessingReject } {
  let msg: Bytes;
  try {
    if (b?.kind !== "RelayBlessing" || b.version !== 1) bad("kind", "must be RelayBlessing v1");
    msg = canonicalRelayBlessing(b);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (b.servicesApex !== servicesApex) return { ok: false, reason: "wrong-apex" };
  if (caKeys.length === 0) return { ok: false, reason: "no-authorized-ca-keys" };
  if (now + MESH_CLOCK_SKEW_MS < b.issuedAt || now >= b.expiresAt) return { ok: false, reason: "artifact-expired" };
  if (!caSigned(b, msg, caKeys)) return { ok: false, reason: "signature-unverified" };
  return { ok: true };
}

/** The CA keys a relay-mesh verifier may trust now, from the maintainer chain; empty when it fails closed. */
export function relayMeshCaKeys(chain: CaTrustChain | null, now: number, pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH): string[] {
  const g = authorizedCaKeysOrFailClosed(chain, now, pinnedMandateHash);
  return g.ok ? g.keys.map((k) => k.toLowerCase()) : [];
}

/** `verifyRelayBlessing` behind the maintainer chain, with the chain's own refusal reasons. */
export function verifyRelayBlessingWithChain(
  b: RelayBlessing,
  chain: CaTrustChain | null,
  now: number,
  servicesApex: string,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): { ok: true } | { ok: false; reason: RelayBlessingReject | CaArtifactReject } {
  const g = authorizedCaKeysOrFailClosed(chain, now, pinnedMandateHash);
  if (!g.ok) return g;
  return verifyRelayBlessing(b, g.keys.map((k) => k.toLowerCase()), now, servicesApex);
}

// ── blessing request (§3.2, proof of possession) ──────────────────────────

export interface RelayBlessingRequest {
  relayId: string;
  relayKey: string;
  servicesApex: string;
  issuedAt: number;
}

export function canonicalRelayBlessingRequest(r: RelayBlessingRequest): Bytes {
  relayIdField("relayId", r.relayId);
  hexField("relayKey", r.relayKey);
  apexField("servicesApex", r.servicesApex);
  intField("issuedAt", r.issuedAt);
  return enc([TAG_RELAY_BLESSING_REQUEST, r.relayId, r.relayKey, r.servicesApex, r.issuedAt]);
}

/**
 * `.com`'s check of a blessing request: well-formed, for its apex, `|issuedAt − now| ≤ 60 s`, signed by `relayKey`.
 * Whether the relay is admitted with that key (D1 `relays`) is the caller's next step.
 */
export function checkRelayBlessingRequest(
  r: RelayBlessingRequest,
  signature: string,
  servicesApex: string,
  now: number,
): { ok: true } | { ok: false; reason: "malformed" | "wrong-apex" | "stale" | "bad-signature" } {
  let msg: Bytes;
  try {
    msg = canonicalRelayBlessingRequest(r);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (r.servicesApex !== servicesApex) return { ok: false, reason: "wrong-apex" };
  if (Math.abs(r.issuedAt - now) > MESH_CLOCK_SKEW_MS) return { ok: false, reason: "stale" };
  if (!edVerify(signature, msg, r.relayKey)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

// ── relay directory (§3.3) ────────────────────────────────────────────────

export interface RelayDirectoryEntry {
  relayId: string;
  relayKey: string;
  /** Exactly `<relayId>.tunnel.<servicesApex>`. */
  tunnelHost: string;
  relayKind: RelayKind;
  region: string;
  ipv4: string[];
  ipv6: string[];
}

export interface RelayDirectoryBody {
  servicesApex: string;
  /** +1 on every change; a daily re-mint keeps it and moves `issuedAt`. */
  directoryVersion: number;
  issuedAt: number;
  expiresAt: number;
  relays: RelayDirectoryEntry[];
}

export interface RelayDirectory extends RelayDirectoryBody {
  kind: "RelayDirectory";
  version: 1;
  signedBy: string;
  signatures: Array<{ pubkey: string; sig: string }>;
}

function addressList(name: string, v: unknown, re: RegExp, needsColon: boolean): string {
  if (!Array.isArray(v)) bad(name, "must be a list");
  const seen = new Set<string>();
  for (const a of v as unknown[]) {
    if (typeof a !== "string" || !re.test(a) || (needsColon && !a.includes(":"))) bad(name, "holds a malformed address");
    if (seen.has(a)) bad(name, "holds a duplicate");
    seen.add(a);
  }
  return seen.size === 0 ? "-" : [...seen].sort().join(",");
}

/** One entry line (§3.3); the address lists are sorted bytewise, `-` when empty. */
export function relayDirectoryEntryLine(e: RelayDirectoryEntry, servicesApex: string): string {
  relayIdField("relayId", e.relayId);
  hexField("relayKey", e.relayKey);
  apexField("servicesApex", servicesApex);
  if (e.tunnelHost !== relayTunnelHost(e.relayId, servicesApex)) bad("tunnelHost", "must be <relayId>.tunnel.<servicesApex>");
  kindField(e.relayKind);
  if (typeof e.region !== "string" || !REGION.test(e.region)) bad("region", "must be a short lowercase region");
  const v4 = addressList("ipv4", e.ipv4, IPV4, false);
  const v6 = addressList("ipv6", e.ipv6, IPV6, true);
  return [e.relayId, e.relayKey, e.tunnelHost, e.relayKind, e.region, v4, v6].join(" ");
}

/** sha256 hex of the entry lines, sorted bytewise, joined by `\n`. Refuses a repeated relay id or relay key. */
export function relayDirectoryEntriesSha256(relays: readonly RelayDirectoryEntry[], servicesApex: string): string {
  if (!Array.isArray(relays)) bad("relays", "must be a list");
  const ids = new Set<string>();
  const keys = new Set<string>();
  const lines = relays.map((r) => {
    const line = relayDirectoryEntryLine(r, servicesApex);
    if (ids.has(r.relayId)) bad("relays", `lists ${r.relayId} twice`);
    if (keys.has(r.relayKey)) bad("relays", "lists one relay key twice");
    ids.add(r.relayId);
    keys.add(r.relayKey);
    return line;
  });
  return sha256hex(lines.sort().join("\n"));
}

export function canonicalRelayDirectory(d: RelayDirectoryBody): Bytes {
  apexField("servicesApex", d.servicesApex);
  intField("directoryVersion", d.directoryVersion, 1);
  intField("issuedAt", d.issuedAt);
  intField("expiresAt", d.expiresAt);
  if (d.expiresAt <= d.issuedAt) bad("expiresAt", "must be after issuedAt");
  const sum = relayDirectoryEntriesSha256(d.relays, d.servicesApex);
  return enc([TAG_RELAY_DIRECTORY, d.servicesApex, d.directoryVersion, d.issuedAt, d.expiresAt, sum]);
}

export function signRelayDirectory(body: RelayDirectoryBody, ca: Keypair): RelayDirectory {
  const env = caEnvelope("RelayDirectory", canonicalRelayDirectory(body), ca);
  return {
    kind: env.kind,
    version: env.version,
    servicesApex: body.servicesApex,
    directoryVersion: body.directoryVersion,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    relays: body.relays.map((r) => ({ ...r, ipv4: [...r.ipv4], ipv6: [...r.ipv6] })),
    signedBy: env.signedBy,
    signatures: env.signatures,
  };
}

/**
 * Verify a directory: well-formed, for `servicesApex`, not issued in the future (past the skew), CA-signed. An expired
 * directory still verifies (routing fails open); `expired` says so, and `/api/health` turns 503 once it is
 * `DIRECTORY_EXPIRED_UNHEALTHY_MS` past. Keep the newest verified one (`newerRelayDirectory`).
 */
export function verifyRelayDirectory(
  d: RelayDirectory,
  caKeys: readonly string[],
  now: number,
  servicesApex: string,
): { ok: true; expired: boolean } | { ok: false; reason: CaSignedReject | "future" } {
  let msg: Bytes;
  try {
    if (d?.kind !== "RelayDirectory" || d.version !== 1) bad("kind", "must be RelayDirectory v1");
    msg = canonicalRelayDirectory(d);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (d.servicesApex !== servicesApex) return { ok: false, reason: "wrong-apex" };
  if (caKeys.length === 0) return { ok: false, reason: "no-authorized-ca-keys" };
  if (d.issuedAt > now + MESH_CLOCK_SKEW_MS) return { ok: false, reason: "future" };
  if (!caSigned(d, msg, caKeys)) return { ok: false, reason: "signature-unverified" };
  return { ok: true, expired: now >= d.expiresAt };
}

export function verifyRelayDirectoryWithChain(
  d: RelayDirectory,
  chain: CaTrustChain | null,
  now: number,
  servicesApex: string,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): { ok: true; expired: boolean } | { ok: false; reason: CaSignedReject | "future" | CaArtifactReject } {
  const g = authorizedCaKeysOrFailClosed(chain, now, pinnedMandateHash);
  if (!g.ok) return g;
  return verifyRelayDirectory(d, g.keys.map((k) => k.toLowerCase()), now, servicesApex);
}

/** True when `candidate` should replace `current`: a higher version, or the same version re-minted later. Never back. */
export function newerRelayDirectory(current: RelayDirectoryBody | null, candidate: RelayDirectoryBody): boolean {
  if (!current) return true;
  if (candidate.directoryVersion !== current.directoryVersion) return candidate.directoryVersion > current.directoryVersion;
  return candidate.issuedAt > current.issuedAt;
}

/** The directory's entry for `relayId`, or null. */
export function directoryRelay(d: RelayDirectoryBody | null, relayId: string): RelayDirectoryEntry | null {
  return d?.relays.find((r) => r.relayId === relayId) ?? null;
}

// ── the relay log (§4.2) ──────────────────────────────────────────────────

export type RelayLogKind =
  | "box-register"
  | "box-revoke"
  | "account-authority"
  | "policy-head"
  | "renewal-key-revoke"
  | "device-grant-revoke"
  | "cert-revoke"
  | "relay-revoke";

/** One log row as stored and served (`{entry, signature}` on the wire). Numeric fields inside f1–f4 are decimal strings. */
export interface RelayLogEntry {
  sequence: number;
  kind: RelayLogKind;
  at: number;
  f1: string;
  f2: string;
  f3: string;
  f4: string;
}

export interface SignedRelayLogEntry {
  entry: RelayLogEntry;
  signature: string;
}

/** The typed meaning of an entry's fields. */
export type RelayLogBody =
  | { kind: "box-register"; nameHash: string; boxPub: string; regGen: number }
  | { kind: "box-revoke"; boxPub: string; regGen: number }
  | { kind: "account-authority"; accountHash: string; adminRootPub: string | null; irkPub: string; authorityGen: number }
  | { kind: "policy-head"; boxPub: string; regGen: number; policyGen: number; policySha256: string }
  | { kind: "renewal-key-revoke"; renewalPub: string }
  | { kind: "device-grant-revoke"; grantId: string; devicePub: string }
  | { kind: "cert-revoke"; accountHash: string; certId: string }
  | { kind: "relay-revoke"; relayId: string; relayKey: string };

function decimal(name: string, v: string, min: number): number {
  if (!DECIMAL.test(v)) bad(name, "must be a decimal integer");
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) bad(name, `must be a safe integer ≥ ${min}`);
  return n;
}
function empty(name: string, v: string): void {
  if (v !== "") bad(name, "must be empty");
}

/** The fields of a body, as a log row stores them. */
export function makeRelayLogEntry(sequence: number, at: number, b: RelayLogBody): RelayLogEntry {
  const row = (f1: string, f2 = "", f3 = "", f4 = ""): RelayLogEntry => ({ sequence, kind: b.kind, at, f1, f2, f3, f4 });
  let e: RelayLogEntry;
  switch (b.kind) {
    case "box-register":
      e = row(b.nameHash, b.boxPub, String(b.regGen));
      break;
    case "box-revoke":
      e = row(b.boxPub, String(b.regGen));
      break;
    case "account-authority":
      e = row(b.accountHash, b.adminRootPub ?? "", b.irkPub, String(b.authorityGen));
      break;
    case "policy-head":
      e = row(b.boxPub, String(b.regGen), String(b.policyGen), b.policySha256);
      break;
    case "renewal-key-revoke":
      e = row(b.renewalPub);
      break;
    case "device-grant-revoke":
      e = row(b.grantId, b.devicePub);
      break;
    case "cert-revoke":
      e = row(b.accountHash, b.certId);
      break;
    case "relay-revoke":
      e = row(b.relayId, b.relayKey);
      break;
    default:
      bad("kind", "is not a relay log kind");
  }
  parseRelayLogEntry(e);
  return e;
}

/** Validate an entry's shape and read its fields; throws on anything malformed. */
export function parseRelayLogEntry(e: RelayLogEntry): RelayLogBody {
  if (typeof e !== "object" || e === null) bad("entry", "must be an object");
  intField("sequence", e.sequence, 1);
  intField("at", e.at);
  for (const f of ["f1", "f2", "f3", "f4"] as const) if (typeof e[f] !== "string") bad(f, "must be a string");
  switch (e.kind) {
    case "box-register":
      hexField("f1 nameHash", e.f1);
      hexField("f2 boxPub", e.f2);
      empty("f4", e.f4);
      return { kind: e.kind, nameHash: e.f1, boxPub: e.f2, regGen: decimal("f3 regGen", e.f3, 1) };
    case "box-revoke":
      hexField("f1 boxPub", e.f1);
      empty("f3", e.f3);
      empty("f4", e.f4);
      return { kind: e.kind, boxPub: e.f1, regGen: decimal("f2 regGen", e.f2, 1) };
    case "account-authority":
      hexField("f1 accountHash", e.f1);
      if (e.f2 !== "") hexField("f2 adminRootPub", e.f2);
      hexField("f3 irkPub", e.f3);
      return { kind: e.kind, accountHash: e.f1, adminRootPub: e.f2 === "" ? null : e.f2, irkPub: e.f3, authorityGen: decimal("f4 authorityGen", e.f4, 1) };
    case "policy-head":
      hexField("f1 boxPub", e.f1);
      hexField("f4 policySha256", e.f4);
      return { kind: e.kind, boxPub: e.f1, regGen: decimal("f2 regGen", e.f2, 1), policyGen: decimal("f3 policyGen", e.f3, 1), policySha256: e.f4 };
    case "renewal-key-revoke":
      hexField("f1 renewalPub", e.f1, P256_PUB);
      empty("f2", e.f2);
      empty("f3", e.f3);
      empty("f4", e.f4);
      return { kind: e.kind, renewalPub: e.f1 };
    case "device-grant-revoke":
      hexField("f1 grantId", e.f1, RELAY_LOG_GRANT_ID);
      hexField("f2 devicePub", e.f2);
      empty("f3", e.f3);
      empty("f4", e.f4);
      return { kind: e.kind, grantId: e.f1, devicePub: e.f2 };
    case "cert-revoke":
      hexField("f1 accountHash", e.f1);
      hexField("f2 certId", e.f2);
      empty("f3", e.f3);
      empty("f4", e.f4);
      return { kind: e.kind, accountHash: e.f1, certId: e.f2 };
    case "relay-revoke":
      relayIdField("f1 relayId", e.f1);
      hexField("f2 relayKey", e.f2);
      empty("f3", e.f3);
      empty("f4", e.f4);
      return { kind: e.kind, relayId: e.f1, relayKey: e.f2 };
    default:
      return bad("kind", "is not a relay log kind");
  }
}

export function canonicalRelayLogEntry(servicesApex: string, e: RelayLogEntry): Bytes {
  apexField("servicesApex", servicesApex);
  parseRelayLogEntry(e);
  return enc([TAG_RELAY_LOG, servicesApex, e.sequence, e.kind, e.at, e.f1, e.f2, e.f3, e.f4]);
}

/** The entry's hash: what the head's `tipSha256` names. */
export function relayLogEntryHash(servicesApex: string, e: RelayLogEntry): string {
  return hex(sha256(canonicalRelayLogEntry(servicesApex, e)));
}

// ── the head (§4.3) ───────────────────────────────────────────────────────

export interface RelayLogHead {
  servicesApex: string;
  /** The last appended sequence; 0 before any entry. */
  sequence: number;
  /** sha256 hex of entry `sequence`'s canonical bytes; `RELAY_LOG_ZERO_TIP` when 0. */
  tipSha256: string;
  directoryVersion: number;
  issuedAt: number;
}

export interface SignedRelayLogHead {
  head: RelayLogHead;
  signature: string;
}

export function canonicalRelayLogHead(h: RelayLogHead): Bytes {
  apexField("servicesApex", h.servicesApex);
  intField("sequence", h.sequence);
  hexField("tipSha256", h.tipSha256);
  if (h.sequence === 0 && h.tipSha256 !== RELAY_LOG_ZERO_TIP) bad("tipSha256", "must be zeros before any entry");
  intField("directoryVersion", h.directoryVersion);
  intField("issuedAt", h.issuedAt);
  return enc([TAG_RELAY_LOG_HEAD, h.servicesApex, h.sequence, h.tipSha256, h.directoryVersion, h.issuedAt]);
}

/** The newer of two verified heads: later `issuedAt`, then higher sequence. */
export function newerRelayLogHead(a: RelayLogHead | null, b: RelayLogHead): boolean {
  if (!a) return true;
  return b.issuedAt !== a.issuedAt ? b.issuedAt > a.issuedAt : b.sequence > a.sequence;
}

// ── attachments, withdrawal, bridge auth, hints, moves, phone grants ──────

export interface BoxAttachment {
  /** The box's pod name `<server>.<user>.<apex>`. */
  serverFqdn: string;
  boxPub: string;
  regGen: number;
  /** The holder relay. */
  relayId: string;
  /** When this tunnel's HELLO_ACK arrived (box clock); fixed for the tunnel's life. */
  attachedAt: number;
  issuedAt: number;
  notAfter: number;
}

function attachmentFields(a: BoxAttachment): void {
  if (typeof a?.serverFqdn !== "string" || a.serverFqdn.length === 0 || a.serverFqdn.length > 253 || a.serverFqdn !== a.serverFqdn.toLowerCase() || !a.serverFqdn.split(".").every((l) => LABEL.test(l))) {
    bad("serverFqdn", "must be a lowercase host name");
  }
  hexField("boxPub", a.boxPub);
  intField("regGen", a.regGen, 1);
  relayIdField("relayId", a.relayId);
  intField("attachedAt", a.attachedAt);
  intField("issuedAt", a.issuedAt);
  intField("notAfter", a.notAfter);
  if (a.attachedAt > a.issuedAt || a.issuedAt >= a.notAfter) bad("times", "must satisfy attachedAt ≤ issuedAt < notAfter");
}

export function canonicalBoxAttachment(a: BoxAttachment): Bytes {
  attachmentFields(a);
  return enc([TAG_RELAY_ATTACHMENT, a.serverFqdn, a.boxPub, a.regGen, a.relayId, a.attachedAt, a.issuedAt, a.notAfter]);
}

/** Same fields as a box attachment; signed by the holder relay for a box without `mesh-v1` (§5.3). */
export type LegacyAttachment = BoxAttachment;

export function canonicalLegacyAttachment(a: LegacyAttachment): Bytes {
  attachmentFields(a);
  return enc([TAG_RELAY_LEGACY_ATTACHMENT, a.serverFqdn, a.boxPub, a.regGen, a.relayId, a.attachedAt, a.issuedAt, a.notAfter]);
}

export type WithdrawSubjectKind = "box" | "phone";

export interface RelayWithdraw {
  subjectKind: WithdrawSubjectKind;
  /** The box's pod name, or the phone's bare hostname. */
  subject: string;
  /** The relay that announced (and now withdraws) it; the signer. */
  relayId: string;
  /** The `issuedAt` of the attachment (or grant) withdrawn; that one and every older one from this relay go. */
  withdrawnIssuedAt: number;
  at: number;
}

export function canonicalRelayWithdraw(w: RelayWithdraw): Bytes {
  if (w?.subjectKind !== "box" && w?.subjectKind !== "phone") bad("subjectKind", "must be box or phone");
  if (typeof w.subject !== "string" || w.subject.length === 0 || w.subject.length > 253 || !w.subject.split(".").every((l) => LABEL.test(l))) bad("subject", "must be a lowercase host name");
  relayIdField("relayId", w.relayId);
  intField("withdrawnIssuedAt", w.withdrawnIssuedAt);
  intField("at", w.at);
  return enc([TAG_RELAY_WITHDRAW, w.subjectKind, w.subject, w.relayId, w.withdrawnIssuedAt, w.at]);
}

export type BridgeRole = "client" | "server";

export interface BridgeAuth {
  /** The signer's role: the dialer is `client`, the acceptor `server`. */
  role: BridgeRole;
  signerRelayId: string;
  peerRelayId: string;
  /** 32-byte nonces, 64 lowercase hex: the acceptor's (`mesh-hello`) and the dialer's. */
  serverNonce: string;
  clientNonce: string;
  at: number;
  /** The signer's ephemeral X25519 public key for this bridge, 64 lowercase hex (§6.2 channel binding). */
  kx: string;
}

export function canonicalBridgeAuth(b: BridgeAuth): Bytes {
  if (b?.role !== "client" && b?.role !== "server") bad("role", "must be client or server");
  relayIdField("signerRelayId", b.signerRelayId);
  relayIdField("peerRelayId", b.peerRelayId);
  if (b.signerRelayId === b.peerRelayId) bad("peerRelayId", "must differ from the signer");
  hexField("serverNonce", b.serverNonce);
  hexField("clientNonce", b.clientNonce);
  intField("at", b.at);
  hexField("kx", b.kx);
  return enc([TAG_RELAY_BRIDGE_AUTH, b.role, b.signerRelayId, b.peerRelayId, b.serverNonce, b.clientNonce, b.at, b.kx]);
}

export type MoveHintReason = "locality" | "co-locate" | "retire";

export interface MoveHint {
  serverFqdn: string;
  boxPub: string;
  fromRelayId: string;
  toRelayId: string;
  reason: MoveHintReason;
  issuedAt: number;
  notAfter: number;
}

export function canonicalMoveHint(h: MoveHint): Bytes {
  if (typeof h?.serverFqdn !== "string" || h.serverFqdn.length === 0 || h.serverFqdn.length > 253 || !h.serverFqdn.split(".").every((l) => LABEL.test(l))) bad("serverFqdn", "must be a lowercase host name");
  hexField("boxPub", h.boxPub);
  relayIdField("fromRelayId", h.fromRelayId);
  relayIdField("toRelayId", h.toRelayId);
  if (h.fromRelayId === h.toRelayId) bad("toRelayId", "must differ from fromRelayId");
  if (h.reason !== "locality" && h.reason !== "co-locate" && h.reason !== "retire") bad("reason", "must be locality, co-locate or retire");
  intField("issuedAt", h.issuedAt);
  intField("notAfter", h.notAfter);
  if (h.notAfter <= h.issuedAt) bad("notAfter", "must be after issuedAt");
  return enc([TAG_RELAY_MOVE_HINT, h.serverFqdn, h.boxPub, h.fromRelayId, h.toRelayId, h.reason, h.issuedAt, h.notAfter]);
}

export interface AccountMove {
  accountHash: string;
  fromRelayId: string;
  toRelayId: string;
  issuedAt: number;
  notAfter: number;
}

export function canonicalAccountMove(m: AccountMove): Bytes {
  hexField("accountHash", m?.accountHash);
  relayIdField("fromRelayId", m.fromRelayId);
  relayIdField("toRelayId", m.toRelayId);
  if (m.fromRelayId === m.toRelayId) bad("toRelayId", "must differ from fromRelayId");
  intField("issuedAt", m.issuedAt);
  intField("notAfter", m.notAfter);
  if (m.notAfter <= m.issuedAt) bad("notAfter", "must be after issuedAt");
  return enc([TAG_RELAY_ACCOUNT_MOVE, m.accountHash, m.fromRelayId, m.toRelayId, m.issuedAt, m.notAfter]);
}

export interface PhoneRouteGrant {
  /** The phone's bare name `<account>.<apex>`. */
  hostname: string;
  phoneRoutePub: string;
  generation: number;
  /** P: the relay holding the phone's tunnel; the only relay that may announce the grant. */
  holderRelayId: string;
  /** L: the account's phone ledger relay; the signer. */
  ledgerRelayId: string;
  issuedAt: number;
  notAfter: number;
}

export function canonicalPhoneRouteGrant(g: PhoneRouteGrant): Bytes {
  if (typeof g?.hostname !== "string" || g.hostname.length === 0 || g.hostname.length > 253 || !g.hostname.split(".").every((l) => LABEL.test(l)) || g.hostname.split(".").length < 3) {
    bad("hostname", "must be a lowercase bare name");
  }
  hexField("phoneRoutePub", g.phoneRoutePub);
  intField("generation", g.generation, 1);
  relayIdField("holderRelayId", g.holderRelayId);
  relayIdField("ledgerRelayId", g.ledgerRelayId);
  intField("issuedAt", g.issuedAt);
  intField("notAfter", g.notAfter);
  if (g.notAfter <= g.issuedAt) bad("notAfter", "must be after issuedAt");
  return enc([TAG_PHONE_ROUTE_GRANT, g.hostname, g.phoneRoutePub, g.generation, g.holderRelayId, g.ledgerRelayId, g.issuedAt, g.notAfter]);
}

// ── generic sign / verify over the plain (non-CA) records ─────────────────

/** Records signed by one Ed25519 key (relay, box, log key). The log entry needs the apex: `canonicalRelayLogEntry`. */
const PLAIN = {
  "relay-blessing-request": canonicalRelayBlessingRequest,
  "relay-log-head": canonicalRelayLogHead,
  "relay-attachment": canonicalBoxAttachment,
  "relay-legacy-attachment": canonicalLegacyAttachment,
  "relay-withdraw": canonicalRelayWithdraw,
  "relay-bridge-auth": canonicalBridgeAuth,
  "relay-move-hint": canonicalMoveHint,
  "relay-account-move": canonicalAccountMove,
  "phone-route-grant": canonicalPhoneRouteGrant,
} as const;
export type RelayMeshRecordKind = keyof typeof PLAIN;
type MeshRecordOf<K extends RelayMeshRecordKind> = Parameters<(typeof PLAIN)[K]>[0];

/** Sign a record's canonical bytes; returns the signature as 128 lowercase hex. Throws on a malformed record. */
export function signRelayMeshRecord<K extends RelayMeshRecordKind>(kind: K, r: MeshRecordOf<K>, sign: (msg: Bytes) => Bytes): string {
  return hex(sign((PLAIN[kind] as (x: MeshRecordOf<K>) => Bytes)(r)));
}

/** Strict Ed25519 over the record's canonical bytes; false for any malformed record, key or signature. */
export function verifyRelayMeshRecord<K extends RelayMeshRecordKind>(kind: K, r: MeshRecordOf<K>, sigHex: string, pubHex: string): boolean {
  let msg: Bytes;
  try {
    msg = (PLAIN[kind] as (x: MeshRecordOf<K>) => Bytes)(r);
  } catch {
    return false;
  }
  return edVerify(sigHex, msg, pubHex);
}

/** Sign a log entry (`.com`, the log key). */
export function signRelayLogEntry(servicesApex: string, e: RelayLogEntry, sign: (msg: Bytes) => Bytes): string {
  return hex(sign(canonicalRelayLogEntry(servicesApex, e)));
}

export function verifyRelayLogEntry(servicesApex: string, e: RelayLogEntry, sigHex: string, logKeyHex: string): boolean {
  let msg: Bytes;
  try {
    msg = canonicalRelayLogEntry(servicesApex, e);
  } catch {
    return false;
  }
  return edVerify(sigHex, msg, logKeyHex);
}

// ── the derived state (§4.2) ──────────────────────────────────────────────

export interface RelayLogBox {
  boxPub: string;
  regGen: number;
  /** The `box-register` entry's sequence. */
  sequence: number;
}

export interface RelayLogAuthority {
  adminRootPub: string | null;
  irkPub: string;
  authorityGen: number;
  sequence: number;
}

export interface RelayLogPolicyHead {
  policyGen: number;
  policySha256: string;
  sequence: number;
}

/** What a relay knows from the log. Treat as immutable: `applyRelayLog` returns a new one. */
export interface RelayLogState {
  servicesApex: string;
  /** The last applied sequence; 0 before any. */
  sequence: number;
  /** Hash of entry `sequence` (`RELAY_LOG_ZERO_TIP` at 0). */
  tipSha256: string;
  /** The hashes of the last `RELAY_LOG_TIP_HISTORY` entries, by sequence (a head behind the tip is matched here). */
  recentTips: Map<number, string>;
  /** nameHash → the newest `box-register` (a newer key for the name evicts the older one). */
  boxesByName: Map<string, RelayLogBox>;
  /** boxPub → its name's hash, for the boxes `boxesByName` holds. */
  boxNames: Map<string, string>;
  /** boxPub → the highest revoked regGen (every generation at or below it is revoked). */
  revokedBoxes: Map<string, number>;
  /** accountHash → the newest authority (highest authorityGen; on a tie, the later entry). */
  authorities: Map<string, RelayLogAuthority>;
  /** `<boxPub>|<regGen>` → the newest policy head (highest policyGen; on a tie, the later entry). */
  policyHeads: Map<string, RelayLogPolicyHead>;
  revokedRenewalKeys: Set<string>;
  /** grantId → the device key it named. */
  revokedGrants: Map<string, string>;
  /** `<accountHash>|<certId>`. */
  revokedCerts: Set<string>;
  /** relayId → the relay key retired with it. */
  revokedRelays: Map<string, string>;
}

export function emptyRelayLogState(servicesApex: string): RelayLogState {
  apexField("servicesApex", servicesApex);
  return {
    servicesApex,
    sequence: 0,
    tipSha256: RELAY_LOG_ZERO_TIP,
    recentTips: new Map([[0, RELAY_LOG_ZERO_TIP]]),
    boxesByName: new Map(),
    boxNames: new Map(),
    revokedBoxes: new Map(),
    authorities: new Map(),
    policyHeads: new Map(),
    revokedRenewalKeys: new Set(),
    revokedGrants: new Map(),
    revokedCerts: new Set(),
    revokedRelays: new Map(),
  };
}

function cloneState(s: RelayLogState): RelayLogState {
  return {
    servicesApex: s.servicesApex,
    sequence: s.sequence,
    tipSha256: s.tipSha256,
    recentTips: new Map(s.recentTips),
    boxesByName: new Map(s.boxesByName),
    boxNames: new Map(s.boxNames),
    revokedBoxes: new Map(s.revokedBoxes),
    authorities: new Map(s.authorities),
    policyHeads: new Map(s.policyHeads),
    revokedRenewalKeys: new Set(s.revokedRenewalKeys),
    revokedGrants: new Map(s.revokedGrants),
    revokedCerts: new Set(s.revokedCerts),
    revokedRelays: new Map(s.revokedRelays),
  };
}

export type RelayLogApplyFailure = "gap" | "bad-signature" | "malformed";

/**
 * The outcome of `applyRelayLog`. On failure, `at` is the sequence to fetch (or re-fetch) from, and `state`/`applied`
 * hold what was applied before it (a valid prefix is kept: fetch from `at` and apply again).
 */
export type RelayLogApply =
  | { ok: true; state: RelayLogState; applied: number }
  | { ok: false; reason: RelayLogApplyFailure; at: number; state: RelayLogState; applied: number };

function applyBody(next: RelayLogState, b: RelayLogBody, seq: number): void {
  switch (b.kind) {
    case "box-register": {
      const had = next.boxesByName.get(b.nameHash);
      if (had && had.boxPub !== b.boxPub && next.boxNames.get(had.boxPub) === b.nameHash) next.boxNames.delete(had.boxPub);
      const oldName = next.boxNames.get(b.boxPub);
      if (oldName !== undefined && oldName !== b.nameHash) next.boxesByName.delete(oldName);
      next.boxesByName.set(b.nameHash, { boxPub: b.boxPub, regGen: b.regGen, sequence: seq });
      next.boxNames.set(b.boxPub, b.nameHash);
      return;
    }
    case "box-revoke":
      next.revokedBoxes.set(b.boxPub, Math.max(next.revokedBoxes.get(b.boxPub) ?? 0, b.regGen));
      return;
    case "account-authority": {
      const had = next.authorities.get(b.accountHash);
      if (!had || b.authorityGen >= had.authorityGen) {
        next.authorities.set(b.accountHash, { adminRootPub: b.adminRootPub, irkPub: b.irkPub, authorityGen: b.authorityGen, sequence: seq });
      }
      return;
    }
    case "policy-head": {
      const key = `${b.boxPub}|${b.regGen}`;
      const had = next.policyHeads.get(key);
      if (!had || b.policyGen >= had.policyGen) next.policyHeads.set(key, { policyGen: b.policyGen, policySha256: b.policySha256, sequence: seq });
      return;
    }
    case "renewal-key-revoke":
      next.revokedRenewalKeys.add(b.renewalPub);
      return;
    case "device-grant-revoke":
      next.revokedGrants.set(b.grantId, b.devicePub);
      return;
    case "cert-revoke":
      next.revokedCerts.add(`${b.accountHash}|${b.certId}`);
      return;
    case "relay-revoke":
      next.revokedRelays.set(b.relayId, b.relayKey);
      return;
  }
}

/**
 * Apply log entries in sequence order under the log key (modelled on `applyRevocationEntries`). An entry at or below
 * the current sequence is a duplicate and skipped; one that skips a number is a `gap`; a bad signature stops at that
 * entry (`bad-signature`: ignore it until a correct copy arrives); a malformed one stops with `malformed`. The state
 * passed in is never changed.
 */
export function applyRelayLog(state: RelayLogState, entries: ReadonlyArray<SignedRelayLogEntry>, logKey: string): RelayLogApply {
  const sorted = [...entries].sort((a, b) => Number(a?.entry?.sequence) - Number(b?.entry?.sequence));
  let next: RelayLogState | null = null;
  let applied = 0;
  const cur = (): RelayLogState => next ?? state;
  for (const item of sorted) {
    const entry = item?.entry;
    let body: RelayLogBody;
    let msg: Bytes;
    try {
      body = parseRelayLogEntry(entry);
      msg = canonicalRelayLogEntry(state.servicesApex, entry);
    } catch {
      const seq = Number(entry?.sequence);
      return { ok: false, reason: "malformed", at: Number.isSafeInteger(seq) && seq > 0 ? seq : cur().sequence + 1, state: cur(), applied };
    }
    if (entry.sequence <= cur().sequence) continue;
    if (entry.sequence !== cur().sequence + 1) return { ok: false, reason: "gap", at: cur().sequence + 1, state: cur(), applied };
    if (!edVerify(item.signature, msg, logKey)) return { ok: false, reason: "bad-signature", at: entry.sequence, state: cur(), applied };
    if (!next) next = cloneState(state);
    applyBody(next, body, entry.sequence);
    const tip = hex(sha256(msg));
    next.sequence = entry.sequence;
    next.tipSha256 = tip;
    next.recentTips.set(entry.sequence, tip);
    next.recentTips.delete(entry.sequence - RELAY_LOG_TIP_HISTORY);
    applied++;
  }
  return { ok: true, state: cur(), applied };
}

/** A head's signature and apex (log key), before it is compared with the state. */
export function verifyRelayLogHead(h: SignedRelayLogHead, logKey: string, servicesApex: string): { ok: true } | { ok: false; reason: "malformed" | "wrong-apex" | "bad-signature" } {
  let msg: Bytes;
  try {
    msg = canonicalRelayLogHead(h.head);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (h.head.servicesApex !== servicesApex) return { ok: false, reason: "wrong-apex" };
  if (!edVerify(h.signature, msg, logKey)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

/**
 * Where the state stands against a verified head: `applied` (the state holds the head's entry with the same hash),
 * `behind` (fetch entries past `state.sequence`), `fork` (the same sequence with another hash: refetch from the head's
 * sequence), `unknown` (the head is older than the tip history; wait for a newer head).
 */
export function relayLogHeadStatus(state: RelayLogState, head: RelayLogHead): "applied" | "behind" | "fork" | "unknown" {
  if (head.sequence > state.sequence) return "behind";
  const tip = state.recentTips.get(head.sequence);
  if (tip === undefined) return "unknown";
  return tip === head.tipSha256 ? "applied" : "fork";
}

/** §4.6: fresh while the newest verified head is applied and at most `HEAD_FRESH_MS` old. */
export function relayLogFresh(state: RelayLogState, head: RelayLogHead | null, now: number): boolean {
  return !!head && head.issuedAt >= now - HEAD_FRESH_MS && relayLogHeadStatus(state, head) === "applied";
}

/** The newest registration for a pod name, or null (not whether it is revoked: see `revokedBoxes`). */
export function relayLogBox(state: RelayLogState, serverFqdn: string): RelayLogBox | null {
  try {
    return state.boxesByName.get(nameHash(serverFqdn)) ?? null;
  } catch {
    return null;
  }
}

/** §4.4 `adminKeyFromCom`: the account's admin root, else its IRK; null when the log has no authority for it. */
export function relayLogAdminKey(state: RelayLogState, account: string): string | null {
  let h: string;
  try {
    h = accountHash(account);
  } catch {
    return null;
  }
  const a = state.authorities.get(h);
  return a ? (a.adminRootPub ?? a.irkPub) : null;
}

export function relayLogPolicyHead(state: RelayLogState, boxPub: string, regGen: number): RelayLogPolicyHead | null {
  return state.policyHeads.get(`${boxPub}|${regGen}`) ?? null;
}

/** The adapter `servingDecision` takes its revocations through: keyed by box key alone (§4.2). Shares the maps. */
export function relayLogRevocations(state: RelayLogState): ServingRevocations {
  return { boxes: state.revokedBoxes, renewalKeys: state.revokedRenewalKeys };
}

// ── attachment checks (§5) ────────────────────────────────────────────────

/** What a check needs to know: the apex, the verified log state, the verified directory and the clock. */
export interface MeshCheckContext {
  servicesApex: string;
  log: RelayLogState;
  directory: RelayDirectoryBody | null;
  now: number;
}

export type AttachmentRefusal =
  | "malformed"
  | "not-pod-name"
  | "ttl-too-long"
  | "future"
  | "expired"
  | "not-registered"
  | "mismatch"
  | "revoked"
  | "unknown-relay"
  | "relay-revoked"
  | "not-full"
  | "not-this-tunnel"
  | "not-this-relay"
  | "bad-signature";

export type AttachmentCheck = { ok: true } | { ok: false; reason: AttachmentRefusal };

/** The holder's extra checks: this tunnel's box and name, and itself. */
export interface AttachmentHolder {
  relayId: string;
  boxPub: string;
  serverFqdn: string;
}

function checkAttachmentCommon(
  a: BoxAttachment,
  canonical: (x: BoxAttachment) => Bytes,
  ttl: number,
  ctx: MeshCheckContext,
  holder: AttachmentHolder | undefined,
): { ok: true; msg: Bytes; relay: RelayDirectoryEntry } | { ok: false; reason: AttachmentRefusal } {
  let msg: Bytes;
  try {
    msg = canonical(a);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPodName(a.serverFqdn, ctx.servicesApex)) return { ok: false, reason: "not-pod-name" };
  if (a.notAfter - a.issuedAt > ttl) return { ok: false, reason: "ttl-too-long" };
  if (a.issuedAt > ctx.now + MESH_CLOCK_SKEW_MS) return { ok: false, reason: "future" };
  if (a.notAfter <= ctx.now) return { ok: false, reason: "expired" };
  const reg = relayLogBox(ctx.log, a.serverFqdn);
  if (!reg) return { ok: false, reason: "not-registered" };
  if (reg.boxPub !== a.boxPub || reg.regGen !== a.regGen) return { ok: false, reason: "mismatch" };
  if ((ctx.log.revokedBoxes.get(a.boxPub) ?? 0) >= a.regGen) return { ok: false, reason: "revoked" };
  if (ctx.log.revokedRelays.has(a.relayId)) return { ok: false, reason: "relay-revoked" };
  const relay = directoryRelay(ctx.directory, a.relayId);
  if (!relay) return { ok: false, reason: "unknown-relay" };
  if (holder) {
    if (a.boxPub !== holder.boxPub || a.serverFqdn !== holder.serverFqdn) return { ok: false, reason: "not-this-tunnel" };
    if (a.relayId !== holder.relayId) return { ok: false, reason: "not-this-relay" };
  }
  return { ok: true, msg, relay };
}

/**
 * §5.1: a box-signed attachment is valid on any relay when its fields are well-formed, its name is a pod name under the
 * apex, `notAfter − issuedAt ≤ ATTACH_TTL_MS`, `issuedAt ≤ now + MESH_CLOCK_SKEW_MS`, `notAfter > now`, the log's newest
 * `box-register` for the name has exactly this key and regGen, that regGen is not revoked, the relay is not revoked and
 * is in the directory, and the box key signed it. The holder passes `holder` for its own extra checks.
 */
export function checkBoxAttachment(a: BoxAttachment, signature: string, ctx: MeshCheckContext, holder?: AttachmentHolder): AttachmentCheck {
  const c = checkAttachmentCommon(a, canonicalBoxAttachment, ATTACH_TTL_MS, ctx, holder);
  if (!c.ok) return c;
  if (!edVerify(signature, c.msg, a.boxPub)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

/** §5.3: as a box attachment, but `LEGACY_TTL_MS`, from a `full` relay, signed by that relay's directory key. */
export function checkLegacyAttachment(a: LegacyAttachment, signature: string, ctx: MeshCheckContext, holder?: AttachmentHolder): AttachmentCheck {
  const c = checkAttachmentCommon(a, canonicalLegacyAttachment, LEGACY_TTL_MS, ctx, holder);
  if (!c.ok) return c;
  if (c.relay.relayKind !== "full") return { ok: false, reason: "not-full" };
  if (!edVerify(signature, c.msg, c.relay.relayKey)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

export interface BoxItem {
  kind: "box";
  attachment: BoxAttachment;
  signature: string;
}
export interface LegacyItem {
  kind: "legacy";
  attachment: LegacyAttachment;
  signature: string;
}
export interface PhoneItem {
  kind: "phone";
  grant: PhoneRouteGrant;
  /** The ledger relay's signature over the grant. */
  signature: string;
  /** The phone's `route-claim/v1` for this generation (§8.3), and its signature under `grant.phoneRoutePub`. */
  claim: RouteClaim;
  claimSignature: string;
  /**
   * The phone's eligibility proof (§8.3): the admin-root-signed device grants for `grant.phoneRoutePub` it presented in
   * `begin`, exactly as {@link phoneItemGrants} keeps them. Every relay checks one of them under the log's admin root.
   */
  grants: PhoneBeginGrant[];
}
export type AttachmentItem = BoxItem | LegacyItem;
/** An item in an `announce` message (§6.3). Mailbox items (§7.6) are typed by their own module. */
export type MeshItem = BoxItem | LegacyItem | PhoneItem;

export function checkAttachmentItem(item: AttachmentItem, ctx: MeshCheckContext, holder?: AttachmentHolder): AttachmentCheck {
  if (item?.kind === "box") return checkBoxAttachment(item.attachment, item.signature, ctx, holder);
  if (item?.kind === "legacy") return checkLegacyAttachment(item.attachment, item.signature, ctx, holder);
  return { ok: false, reason: "malformed" };
}

/** The ATTACHMENT frame's refusal code for a holder-side refusal (§9.1). */
export function attachmentRefusalCode(r: AttachmentRefusal): "clock" | "mismatch" | "not-registered" | "revoked" {
  if (r === "future" || r === "expired") return "clock";
  if (r === "not-registered") return "not-registered";
  if (r === "revoked") return "revoked";
  return "mismatch";
}

/**
 * §5.2 precedence between two VALID attachments for the same name: positive when `a` wins, negative when `b` wins, 0
 * for the same attachment. Higher regGen; box-signed beats legacy; later `attachedAt` (the newer tunnel, so a retiring
 * tunnel's late renewal never outranks the one that replaced it); later `issuedAt`; the bytewise-smaller relayId.
 */
export function compareAttachments(a: AttachmentItem, b: AttachmentItem): number {
  const x = a.attachment;
  const y = b.attachment;
  if (x.regGen !== y.regGen) return x.regGen > y.regGen ? 1 : -1;
  if (a.kind !== b.kind) return a.kind === "box" ? 1 : -1;
  if (x.attachedAt !== y.attachedAt) return x.attachedAt > y.attachedAt ? 1 : -1;
  if (x.issuedAt !== y.issuedAt) return x.issuedAt > y.issuedAt ? 1 : -1;
  if (x.relayId !== y.relayId) return x.relayId < y.relayId ? 1 : -1;
  return 0;
}

// ── withdrawal (§5.4) ─────────────────────────────────────────────────────

export type WithdrawRefusal = "malformed" | "not-subject" | "future" | "unknown-relay" | "bad-signature";

/** A withdrawal counts when well-formed, about a pod name (box) or bare name (phone), not from the future, and signed by its relay. */
export function checkWithdraw(w: RelayWithdraw, signature: string, ctx: MeshCheckContext): { ok: true } | { ok: false; reason: WithdrawRefusal } {
  let msg: Bytes;
  try {
    msg = canonicalRelayWithdraw(w);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const subjectOk = w.subjectKind === "box" ? isPodName(w.subject, ctx.servicesApex) : isBarePhoneName(w.subject, ctx.servicesApex);
  if (!subjectOk) return { ok: false, reason: "not-subject" };
  if (w.at > ctx.now + MESH_CLOCK_SKEW_MS) return { ok: false, reason: "future" };
  const relay = directoryRelay(ctx.directory, w.relayId);
  if (!relay) return { ok: false, reason: "unknown-relay" };
  if (!edVerify(signature, msg, relay.relayKey)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

/** Does a (checked) withdrawal remove `item`? Same subject, announced by the withdrawing relay, issued no later. */
export function withdrawCovers(w: RelayWithdraw, item: MeshItem): boolean {
  if (item.kind === "phone") {
    return w.subjectKind === "phone" && item.grant.hostname === w.subject && item.grant.holderRelayId === w.relayId && item.grant.issuedAt <= w.withdrawnIssuedAt;
  }
  return w.subjectKind === "box" && item.attachment.serverFqdn === w.subject && item.attachment.relayId === w.relayId && item.attachment.issuedAt <= w.withdrawnIssuedAt;
}

// ── bridge handshake (§6.2) ───────────────────────────────────────────────

/** `{type:"mesh-hello"}`: the acceptor's first message. */
export interface MeshHello {
  type: "mesh-hello";
  v: 1;
  relayId: string;
  nonce: string;
  at: number;
}

/** `{type:"mesh-auth"}`: each side's proof; `blessing` null from a relay that restarted while `.com` was down. */
export interface MeshAuth {
  type: "mesh-auth";
  v: 1;
  relayId: string;
  peer: string;
  nonce: string;
  at: number;
  /** Ephemeral X25519 public key (64 hex), signed in `sig`: the bridge MAC keys come from it (§6.2). */
  kx: string;
  blessing: RelayBlessing | null;
  sig: string;
}

export type BridgeRefusal = "bad-blessing" | "not-in-directory" | "revoked" | "bad-signature" | "stale" | "wrong-peer";

/**
 * Check the peer's `mesh-auth` (§6.2). `role` is the PEER's role (`client` when this side accepted). `selfNonce` is the
 * nonce this side sent (the acceptor's `mesh-hello` nonce, or the dialer's own `mesh-auth` nonce). With `blessing:
 * null` the peer is accepted only on a still-valid blessing this side holds for that relayId (`heldBlessing`, kept
 * from earlier handshakes and `directory.json`). Order: wrong-peer, stale, bad-blessing, revoked, not-in-directory,
 * bad-signature. On success, the blessing used (to return it in `{type:"blessing"}` when the peer sent none).
 */
export function checkBridgeAuth(o: {
  auth: MeshAuth;
  role: BridgeRole;
  selfRelayId: string;
  selfNonce: string;
  heldBlessing?: RelayBlessing | null;
  caKeys: readonly string[];
  ctx: MeshCheckContext;
}): { ok: true; blessing: RelayBlessing } | { ok: false; reason: BridgeRefusal } {
  const a = o.auth;
  if (a?.type !== "mesh-auth" || a.v !== 1 || !isRelayId(a.relayId) || a.peer !== o.selfRelayId || a.relayId === o.selfRelayId) return { ok: false, reason: "wrong-peer" };
  if (typeof a.at !== "number" || !Number.isSafeInteger(a.at) || Math.abs(a.at - o.ctx.now) > MESH_CLOCK_SKEW_MS) return { ok: false, reason: "stale" };
  const blessing = a.blessing ?? o.heldBlessing ?? null;
  if (!blessing || blessing.relayId !== a.relayId || !verifyRelayBlessing(blessing, o.caKeys, o.ctx.now, o.ctx.servicesApex).ok) return { ok: false, reason: "bad-blessing" };
  if (o.ctx.log.revokedRelays.has(a.relayId)) return { ok: false, reason: "revoked" };
  const entry = directoryRelay(o.ctx.directory, a.relayId);
  if (!entry || entry.relayKey !== blessing.relayKey) return { ok: false, reason: "not-in-directory" };
  const [serverNonce, clientNonce] = o.role === "client" ? [o.selfNonce, a.nonce] : [a.nonce, o.selfNonce];
  const ok = verifyRelayMeshRecord("relay-bridge-auth", { role: o.role, signerRelayId: a.relayId, peerRelayId: o.selfRelayId, serverNonce, clientNonce, at: a.at, kx: a.kx }, a.sig, blessing.relayKey);
  return ok ? { ok: true, blessing } : { ok: false, reason: "bad-signature" };
}

// ── bridge channel binding (§6.2) ─────────────────────────────────────────

/** The two MAC keys of one bridge: `c2s` authenticates what the dialer sends, `s2c` what the acceptor sends. */
export interface BridgeMacKeys {
  c2s: Bytes;
  s2c: Bytes;
}

/**
 * Derive a bridge's MAC keys from this side's ephemeral X25519 secret and the peer's signed `kx` (§6.2): shared =
 * X25519; PRK = HKDF-SHA256(salt `<serverNonce>|<clientNonce>`, shared); each key = expand(`flagship/relay-bridge-mac/v1|
 * <c2s|s2c>|<clientRelayId>|<serverRelayId>`, 32). Null for a malformed key or an all-zero shared secret.
 */
export function bridgeMacKeys(o: { secret: Bytes; peerKx: string; serverNonce: string; clientNonce: string; clientRelayId: string; serverRelayId: string }): BridgeMacKeys | null {
  if (typeof o.peerKx !== "string" || !HEX64.test(o.peerKx) || o.secret.length !== 32) return null;
  let shared: Bytes;
  try {
    shared = x25519.getSharedSecret(o.secret, fromHex(o.peerKx));
  } catch {
    return null;
  }
  if (shared.every((b) => b === 0)) return null;
  const salt = new TextEncoder().encode(`${o.serverNonce}|${o.clientNonce}`);
  const info = (dir: string) => new TextEncoder().encode(`${TAG_RELAY_BRIDGE_MAC}|${dir}|${o.clientRelayId}|${o.serverRelayId}`);
  return { c2s: hkdf(sha256, shared, salt, info("c2s"), 32), s2c: hkdf(sha256, shared, salt, info("s2c"), 32) };
}

/** A fresh ephemeral X25519 key pair for one handshake: `kx` is the public half as hex. */
export function bridgeEphemeral(): { secret: Bytes; kx: string } {
  const secret = x25519.utils.randomSecretKey();
  return { secret, kx: hex(x25519.getPublicKey(secret)) };
}

/** The public half of an X25519 secret, as hex (tests and vectors). */
export function bridgeKx(secret: Bytes): string {
  return hex(x25519.getPublicKey(secret));
}

/** HMAC-SHA256(key, u64be(seq) ‖ utf8(json)), 64 lowercase hex. */
export function bridgeMac(key: Bytes, seq: number, json: string): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("seq must be a safe integer ≥ 0");
  const body = new TextEncoder().encode(json);
  const m = new Uint8Array(8 + body.length);
  new DataView(m.buffer).setBigUint64(0, BigInt(seq));
  m.set(body, 8);
  return hex(hmac(sha256, key, m));
}

/** A control message on an authenticated bridge: the MAC (64 hex) then the JSON (§6.3). */
export function sealBridgeText(key: Bytes, seq: number, json: string): string {
  return bridgeMac(key, seq, json) + json;
}

/** The JSON of a sealed control message when its MAC is right for `seq`, else null. */
export function openBridgeText(key: Bytes, seq: number, text: string): string | null {
  if (text.length < 64) return null;
  const mac = text.slice(0, 64);
  const json = text.slice(64);
  const want = bridgeMac(key, seq, json);
  let d = 0;
  for (let i = 0; i < 64; i++) d |= mac.charCodeAt(i) ^ want.charCodeAt(i);
  return d === 0 ? json : null;
}

// ── move hints, box side (§9.3) ───────────────────────────────────────────

/** The box's hint bookkeeping, persisted in `<dataDir>/relay-mesh.json`. */
export interface MoveHintRateState {
  /** When the box last acted on a `locality` hint. */
  lastLocalityAt: number | null;
  /** When it acted on `co-locate` hints in the last 24 h. */
  coLocateAt: number[];
  /** relayId → when a move to it last failed. */
  failedTargets: Record<string, number>;
}

export function emptyMoveHintRateState(): MoveHintRateState {
  return { lastLocalityAt: null, coLocateAt: [], failedTargets: {} };
}

export type MoveHintRefusal =
  | "malformed"
  | "not-this-box"
  | "wrong-from"
  | "bad-signature"
  | "ttl-too-long"
  | "future"
  | "expired"
  | "bad-target"
  | "target-not-full"
  | "target-mismatch"
  | "directory-stale"
  | "not-in-directory"
  | "rate-limited"
  | "target-failed";

/**
 * May the box act on this hint (§9.3)? It names this box and this tunnel's relay as `fromRelayId`, is signed by that
 * relay's blessed key, lasts at most `MOVE_HINT_TTL_MS` and is live; `target` is a valid `full` blessing for
 * `toRelayId` under the box's apex; `toRelayId` is in a directory fetched within `BOX_DIRECTORY_MAX_AGE_MS`
 * (`directory-stale`: fetch it and ask again); the rate limits hold and the target did not fail in the last hour.
 * Call `recordMoveHint` when acting on it and `recordMoveTargetFailed` when the move fails.
 */
export function checkMoveHint(o: {
  hint: MoveHint;
  signature: string;
  target: RelayBlessing;
  box: { serverFqdn: string; boxPub: string; servicesApex: string };
  current: { relayId: string; relayKey: string };
  directory: RelayDirectoryBody | null;
  directoryFetchedAt: number | null;
  caKeys: readonly string[];
  rate: MoveHintRateState;
  now: number;
}): { ok: true } | { ok: false; reason: MoveHintRefusal } {
  const h = o.hint;
  let msg: Bytes;
  try {
    msg = canonicalMoveHint(h);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (h.serverFqdn !== o.box.serverFqdn || h.boxPub !== o.box.boxPub) return { ok: false, reason: "not-this-box" };
  if (h.fromRelayId !== o.current.relayId) return { ok: false, reason: "wrong-from" };
  if (!edVerify(o.signature, msg, o.current.relayKey)) return { ok: false, reason: "bad-signature" };
  if (h.notAfter - h.issuedAt > MOVE_HINT_TTL_MS) return { ok: false, reason: "ttl-too-long" };
  if (h.issuedAt > o.now + MESH_CLOCK_SKEW_MS) return { ok: false, reason: "future" };
  if (h.notAfter <= o.now) return { ok: false, reason: "expired" };
  if (!verifyRelayBlessing(o.target, o.caKeys, o.now, o.box.servicesApex).ok) return { ok: false, reason: "bad-target" };
  if (o.target.relayKind !== "full") return { ok: false, reason: "target-not-full" };
  if (o.target.relayId !== h.toRelayId) return { ok: false, reason: "target-mismatch" };
  if (!o.directory || o.directoryFetchedAt === null || o.now - o.directoryFetchedAt > BOX_DIRECTORY_MAX_AGE_MS) return { ok: false, reason: "directory-stale" };
  const entry = directoryRelay(o.directory, h.toRelayId);
  if (!entry || entry.relayKey !== o.target.relayKey) return { ok: false, reason: "not-in-directory" };
  const r = o.rate;
  const failed = r.failedTargets[h.toRelayId];
  if (failed !== undefined && o.now - failed < MOVE_FAILED_TARGET_MS) return { ok: false, reason: "target-failed" };
  if (h.reason === "locality" && r.lastLocalityAt !== null && o.now - r.lastLocalityAt < MOVE_LOCALITY_MIN_MS) return { ok: false, reason: "rate-limited" };
  if (h.reason === "co-locate") {
    const day = r.coLocateAt.filter((t) => o.now - t < DAY);
    if (day.some((t) => o.now - t < MOVE_COLOCATE_MIN_MS) || day.length >= MOVE_COLOCATE_MAX_PER_DAY) return { ok: false, reason: "rate-limited" };
  }
  return { ok: true };
}

/** The rate state after acting on a hint (pure; co-locate times older than a day are dropped). */
export function recordMoveHint(rate: MoveHintRateState, reason: MoveHintReason, now: number): MoveHintRateState {
  const coLocateAt = rate.coLocateAt.filter((t) => now - t < DAY);
  if (reason === "co-locate") coLocateAt.push(now);
  return {
    lastLocalityAt: reason === "locality" ? now : rate.lastLocalityAt,
    coLocateAt,
    failedTargets: Object.fromEntries(Object.entries(rate.failedTargets).filter(([, t]) => now - t < MOVE_FAILED_TARGET_MS)),
  };
}

/** The rate state after a move to `relayId` failed (it is ignored for `MOVE_FAILED_TARGET_MS`). */
export function recordMoveTargetFailed(rate: MoveHintRateState, relayId: string, now: number): MoveHintRateState {
  const failedTargets = Object.fromEntries(Object.entries(rate.failedTargets).filter(([, t]) => now - t < MOVE_FAILED_TARGET_MS));
  failedTargets[relayId] = now;
  return { lastLocalityAt: rate.lastLocalityAt, coLocateAt: [...rate.coLocateAt], failedTargets };
}

// ── account moves (§10.3) ─────────────────────────────────────────────────

export type AccountMoveRefusal =
  | "malformed"
  | "ttl-too-long"
  | "future"
  | "expired"
  | "not-home"
  | "unknown-relay"
  | "relay-revoked"
  | "target-not-full"
  | "too-soon"
  | "bad-signature";

/**
 * A peer accepts an account move when it is well-formed, lasts at most `ACCOUNT_MOVE_TTL_MS` and is live, comes from
 * the relay this peer computes as the account's home (`expectedHome`), names a `full`, unrevoked target in the
 * directory, the last accepted move for the account is at least `ACCOUNT_MOVE_MIN_INTERVAL_MS` old, and the home's
 * directory key signed it.
 */
export function checkAccountMove(o: {
  move: AccountMove;
  signature: string;
  expectedHome: string | null;
  lastAcceptedAt: number | null;
  ctx: MeshCheckContext;
}): { ok: true } | { ok: false; reason: AccountMoveRefusal } {
  const m = o.move;
  let msg: Bytes;
  try {
    msg = canonicalAccountMove(m);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const now = o.ctx.now;
  if (m.notAfter - m.issuedAt > ACCOUNT_MOVE_TTL_MS) return { ok: false, reason: "ttl-too-long" };
  if (m.issuedAt > now + MESH_CLOCK_SKEW_MS) return { ok: false, reason: "future" };
  if (m.notAfter <= now) return { ok: false, reason: "expired" };
  if (m.fromRelayId !== o.expectedHome) return { ok: false, reason: "not-home" };
  if (o.ctx.log.revokedRelays.has(m.fromRelayId) || o.ctx.log.revokedRelays.has(m.toRelayId)) return { ok: false, reason: "relay-revoked" };
  const from = directoryRelay(o.ctx.directory, m.fromRelayId);
  const to = directoryRelay(o.ctx.directory, m.toRelayId);
  if (!from || !to) return { ok: false, reason: "unknown-relay" };
  if (to.relayKind !== "full") return { ok: false, reason: "target-not-full" };
  if (o.lastAcceptedAt !== null && now - o.lastAcceptedAt < ACCOUNT_MOVE_MIN_INTERVAL_MS) return { ok: false, reason: "too-soon" };
  if (!edVerify(o.signature, msg, from.relayKey)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

// ── phone items (§8.3, §8.4) ──────────────────────────────────────────────

export type PhoneItemRefusal =
  | "malformed"
  | "not-bare-name"
  | "ttl-too-long"
  | "future"
  | "expired"
  | "generation-jump"
  | "wrong-holder"
  | "relay-revoked"
  | "unknown-relay"
  | "not-full"
  | "not-ledger"
  | "claim-mismatch"
  | "bad-signature"
  | "bad-claim"
  | "not-eligible";

const PHONE_GRANT_ID = /^[0-9a-fA-F][0-9a-fA-F-]{0,63}$/;
const PHONE_GRANT_MAX_SCOPES = 16;
const uintOk = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * One grant of a phone item's eligibility proof in exactly its wire shape (§8.3): a grant id the log can carry (so a
 * `device-grant-revoke` reaches it), the device key is `phoneRoutePub`, lowercase hex, signed by the admin root.
 */
function isPhoneItemGrant(p: unknown, phoneRoutePub: string): p is PhoneBeginGrant {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  const g = o.grant as Record<string, unknown> | null | undefined;
  if (typeof g !== "object" || g === null) return false;
  return (
    typeof g.grantId === "string" && PHONE_GRANT_ID.test(g.grantId) &&
    typeof g.username === "string" && typeof g.deviceId === "string" && g.devicePubHex === phoneRoutePub &&
    Array.isArray(g.scopes) && g.scopes.length <= PHONE_GRANT_MAX_SCOPES && g.scopes.every((x) => typeof x === "string") &&
    uintOk(g.issuedAt) && uintOk(g.expiresAt) &&
    typeof o.signatureHex === "string" && HEX128.test(o.signatureHex) && o.signerRoot === "admin-root"
  );
}

/**
 * What P puts in its phone item (§8.3): of the first {@link PHONE_BEGIN_MAX_GRANTS} grants the phone presented in
 * `begin`, those in the wire shape for this key, copied field by field.
 */
export function phoneItemGrants(presented: unknown, phoneRoutePub: string): PhoneBeginGrant[] {
  const pub = phoneRoutePub.toLowerCase();
  const out: PhoneBeginGrant[] = [];
  for (const p of Array.isArray(presented) ? presented.slice(0, PHONE_BEGIN_MAX_GRANTS) : []) {
    if (!isPhoneItemGrant(p, pub)) continue;
    const g = p.grant;
    out.push({
      grant: { grantId: g.grantId, username: g.username, deviceId: g.deviceId, devicePubHex: g.devicePubHex, scopes: [...g.scopes], issuedAt: g.issuedAt, expiresAt: g.expiresAt },
      signatureHex: p.signatureHex,
      signerRoot: "admin-root",
    });
  }
  return out;
}

/**
 * §8.3: may `phoneRoutePub` hold the account's bare name, by its own proof? `malformed` unless 1 to
 * {@link PHONE_BEGIN_MAX_GRANTS} grants in the wire shape for this key; `not-eligible` unless at least one of them,
 * not revoked by the log (`device-grant-revoke`), is an unexpired `admin` grant naming the account that verifies under
 * the log's admin root for the account (`requireMasterAdmin`), and the key is not that root. The ledger relay checks
 * it before it signs a grant and every relay before it accepts a phone item.
 */
export function checkPhoneEligibilityProof(grants: unknown, account: string, phoneRoutePub: string, log: RelayLogState, now: number): "ok" | "malformed" | "not-eligible" {
  if (!Array.isArray(grants) || grants.length < 1 || grants.length > PHONE_BEGIN_MAX_GRANTS) return "malformed";
  if (!HEX64.test(phoneRoutePub) || !grants.every((p) => isPhoneItemGrant(p, phoneRoutePub))) return "malformed";
  let h: string;
  try {
    h = accountHash(account);
  } catch {
    return "not-eligible";
  }
  const root = log.authorities.get(h)?.adminRootPub ?? null;
  if (!root || root === phoneRoutePub) return "not-eligible";
  for (const p of grants as PhoneBeginGrant[]) {
    if (log.revokedGrants.has(relayLogGrantId(p.grant.grantId))) continue;
    const g = p.grant;
    const view = {
      grant: { grantId: g.grantId, username: g.username, deviceId: g.deviceId, devicePubKey: fromHex(g.devicePubHex), scopes: g.scopes as never, issuedAt: g.issuedAt, expiresAt: g.expiresAt },
      signatureHex: p.signatureHex,
      signerRoot: "admin-root" as const,
      revokedAt: null,
    };
    if (requireMasterAdmin(phoneRoutePub, account, root, [view], now).ok) return "ok";
  }
  return "not-eligible";
}

/** Is `relayId` among the first `PHONE_LEDGER_TOP_K` of the account's ledger ranking (§8.1)? */
export function isPhoneLedgerFor(account: string, relayId: string, directory: RelayDirectoryBody | null, log: RelayLogState | null): boolean {
  try {
    return phoneLedgerRanking(account, directory, log).slice(0, PHONE_LEDGER_TOP_K).includes(relayId);
  } catch {
    return false;
  }
}

/**
 * A phone item is valid when the grant is well-formed for a bare name under the apex, lasts at most
 * `PHONE_ROUTE_GRANT_TTL_MS`, is live, its generation is at most `PHONE_GENERATION_MAX` and at most
 * `PHONE_GENERATION_MAX_JUMP` above `highestLive` (the highest generation among the live items the caller holds for the
 * name; 0 when none), was announced by its `holderRelayId`, both relays are unrevoked `full` relays in the directory,
 * `ledgerRelayId` is among the first `PHONE_LEDGER_TOP_K` of the account's ledger ranking, the phone's route claim it
 * carries names the same hostname, key and generation (issued no later than the grant, within the skew), the ledger's
 * directory key signed the grant, the phone's key signed the claim, and the item's grants prove the key is an admin
 * device of the account under the log's admin root ({@link checkPhoneEligibilityProof}; malformed grants are
 * `malformed`).
 */
export function checkPhoneItem(item: PhoneItem, announcerRelayId: string, ctx: MeshCheckContext, highestLive = 0): { ok: true } | { ok: false; reason: PhoneItemRefusal } {
  const g = item?.grant;
  const c = item?.claim;
  let msg: Bytes;
  let claimMsg: Bytes;
  try {
    if (item?.kind !== "phone") bad("kind", "must be phone");
    msg = canonicalPhoneRouteGrant(g);
    claimMsg = canonicalRouteClaim(c);
    hexField("signature", item.signature, HEX128);
    hexField("claimSignature", item.claimSignature, HEX128);
    if (!Array.isArray(item.grants) || item.grants.length < 1 || item.grants.length > PHONE_BEGIN_MAX_GRANTS || !item.grants.every((p) => isPhoneItemGrant(p, g.phoneRoutePub))) {
      bad("grants", "must be 1 to 8 admin-root grants for the phone key");
    }
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isBarePhoneName(g.hostname, ctx.servicesApex)) return { ok: false, reason: "not-bare-name" };
  if (g.notAfter - g.issuedAt > PHONE_ROUTE_GRANT_TTL_MS) return { ok: false, reason: "ttl-too-long" };
  if (g.issuedAt > ctx.now + MESH_CLOCK_SKEW_MS) return { ok: false, reason: "future" };
  if (g.notAfter <= ctx.now) return { ok: false, reason: "expired" };
  if (g.generation > PHONE_GENERATION_MAX || (highestLive > 0 && g.generation > highestLive + PHONE_GENERATION_MAX_JUMP)) return { ok: false, reason: "generation-jump" };
  if (announcerRelayId !== g.holderRelayId) return { ok: false, reason: "wrong-holder" };
  if (ctx.log.revokedRelays.has(g.ledgerRelayId) || ctx.log.revokedRelays.has(g.holderRelayId)) return { ok: false, reason: "relay-revoked" };
  const ledger = directoryRelay(ctx.directory, g.ledgerRelayId);
  const holder = directoryRelay(ctx.directory, g.holderRelayId);
  if (!ledger || !holder) return { ok: false, reason: "unknown-relay" };
  if (ledger.relayKind !== "full" || holder.relayKind !== "full") return { ok: false, reason: "not-full" };
  const account = g.hostname.slice(0, -(ctx.servicesApex.length + 1));
  if (!isPhoneLedgerFor(account, g.ledgerRelayId, ctx.directory, ctx.log)) return { ok: false, reason: "not-ledger" };
  if (c.account !== account || c.hostname !== g.hostname || c.phoneRoutePub !== g.phoneRoutePub || c.generation !== g.generation || c.issuedAt > g.issuedAt + MESH_CLOCK_SKEW_MS) {
    return { ok: false, reason: "claim-mismatch" };
  }
  if (!edVerify(item.signature, msg, ledger.relayKey)) return { ok: false, reason: "bad-signature" };
  if (!edVerify(item.claimSignature, claimMsg, g.phoneRoutePub)) return { ok: false, reason: "bad-claim" };
  if (checkPhoneEligibilityProof(item.grants, account, g.phoneRoutePub, ctx.log, ctx.now) !== "ok") return { ok: false, reason: "not-eligible" };
  return { ok: true };
}

/** §8.4 winner between two valid phone items for one hostname: higher generation, later `issuedAt`, smaller holder id. */
export function comparePhoneItems(a: PhoneItem, b: PhoneItem): number {
  const x = a.grant;
  const y = b.grant;
  if (x.generation !== y.generation) return x.generation > y.generation ? 1 : -1;
  if (x.issuedAt !== y.issuedAt) return x.issuedAt > y.issuedAt ? 1 : -1;
  if (x.holderRelayId !== y.holderRelayId) return x.holderRelayId < y.holderRelayId ? 1 : -1;
  return 0;
}

// ── routing (§7.3, §8.1, §10.2) ───────────────────────────────────────────

/**
 * §7.3: the relay an account's boxes should be on. `attachments` are the account's live, valid, winning attachments
 * (box-signed or legacy; one per box). `move` is a verified, accepted account move, if any. Rule 1: an unexpired move
 * to B while B holds at least one of them. Rule 2: among `full` relays holding them, the most attachments, then the
 * earliest `attachedAt`, then the smaller relayId. Null when none is held by a `full` relay.
 */
export function accountHome(o: {
  attachments: ReadonlyArray<{ relayId: string; attachedAt: number }>;
  directory: RelayDirectoryBody | null;
  move: { toRelayId: string; notAfter: number } | null;
  now: number;
}): string | null {
  if (o.move && o.move.notAfter > o.now && o.attachments.some((a) => a.relayId === o.move!.toRelayId)) return o.move.toRelayId;
  const per = new Map<string, { n: number; first: number }>();
  for (const a of o.attachments) {
    if (directoryRelay(o.directory, a.relayId)?.relayKind !== "full") continue;
    const p = per.get(a.relayId);
    if (p) {
      p.n++;
      p.first = Math.min(p.first, a.attachedAt);
    } else per.set(a.relayId, { n: 1, first: a.attachedAt });
  }
  let best: [string, { n: number; first: number }] | null = null;
  for (const e of per) {
    if (!best) best = e;
    else {
      const [id, p] = e;
      const [bid, bp] = best;
      if (p.n > bp.n || (p.n === bp.n && (p.first < bp.first || (p.first === bp.first && id < bid)))) best = e;
    }
  }
  return best ? best[0] : null;
}

/**
 * §8.1: the directory's `full`, unrevoked relays ranked for `account` by `sha256hex(accountHash(account) + "|" +
 * relayId)`, highest first. The ledger relay is the first one this relay can reach.
 */
export function phoneLedgerRanking(account: string, directory: RelayDirectoryBody | null, log: RelayLogState | null): string[] {
  const ah = accountHash(account);
  return (directory?.relays ?? [])
    .filter((r) => r.relayKind === "full" && !log?.revokedRelays.has(r.relayId))
    .map((r) => ({ id: r.relayId, rank: sha256hex(`${ah}|${r.relayId}`) }))
    .sort((a, b) => (a.rank < b.rank ? 1 : a.rank > b.rank ? -1 : 0))
    .map((r) => r.id);
}

export type RebalanceRefusal =
  | "legacy-box"
  | "recent-move"
  | "below-threshold"
  | "no-candidate"
  | "share"
  | "lead"
  | "unknown-relay"
  | "not-full"
  | "load-stale"
  | "draining"
  | "load-high";

export interface RebalanceRelay {
  relayId: string;
  relayKind: RelayKind;
  /** When its last `load` message arrived; null if none. */
  lastLoadAt: number | null;
  draining: boolean;
  tunnels: number;
  capacity: number;
}

/**
 * §10.2, pure: should the home move the account to `T`, the top entry relay other than the home by bytes (ties: the
 * smaller relayId)? `window` is the last `REBALANCE_WINDOW_MS` of visitor bytes and streams per entry relay (the home
 * itself for local visitors). Integer arithmetic only: share(T) ≥ 6/10, share(T) − share(home) ≥ 3/10, tunnels /
 * capacity < 8/10. Order of refusals: legacy-box, recent-move, below-threshold, no-candidate, share, lead,
 * unknown-relay, not-full, load-stale, draining, load-high.
 */
export function rebalanceDecision(o: {
  home: string;
  window: ReadonlyArray<{ relayId: string; bytes: number; streams: number }>;
  relays: ReadonlyArray<RebalanceRelay>;
  lastMoveAt: number | null;
  hasLegacyBox: boolean;
  now: number;
}): { move: true; to: string } | { move: false; reason: RebalanceRefusal } {
  if (o.hasLegacyBox) return { move: false, reason: "legacy-box" };
  if (o.lastMoveAt !== null && o.now - o.lastMoveAt < ACCOUNT_MOVE_MIN_INTERVAL_MS) return { move: false, reason: "recent-move" };
  const bytes = new Map<string, bigint>();
  let total = 0n;
  let streams = 0n;
  for (const w of o.window) {
    const b = BigInt(Math.max(0, Math.floor(w.bytes)));
    bytes.set(w.relayId, (bytes.get(w.relayId) ?? 0n) + b);
    total += b;
    streams += BigInt(Math.max(0, Math.floor(w.streams)));
  }
  if (total < BigInt(REBALANCE_MIN_BYTES) && streams < BigInt(REBALANCE_MIN_STREAMS)) return { move: false, reason: "below-threshold" };
  let top: [string, bigint] | null = null;
  for (const [id, b] of bytes) {
    if (id === o.home || b === 0n) continue;
    if (!top || b > top[1] || (b === top[1] && id < top[0])) top = [id, b];
  }
  if (!top) return { move: false, reason: "no-candidate" };
  const [to, bt] = top;
  const bh = bytes.get(o.home) ?? 0n;
  if (10n * bt < BigInt(REBALANCE_MIN_SHARE_TENTHS) * total) return { move: false, reason: "share" };
  if (10n * (bt - bh) < BigInt(REBALANCE_MIN_LEAD_TENTHS) * total) return { move: false, reason: "lead" };
  const t = o.relays.find((r) => r.relayId === to);
  if (!t) return { move: false, reason: "unknown-relay" };
  if (t.relayKind !== "full") return { move: false, reason: "not-full" };
  if (t.lastLoadAt === null || o.now - t.lastLoadAt >= MESH_LOAD_FRESH_MS) return { move: false, reason: "load-stale" };
  if (t.draining) return { move: false, reason: "draining" };
  if (!(t.capacity > 0) || 10 * t.tunnels >= REBALANCE_MAX_LOAD_TENTHS * t.capacity) return { move: false, reason: "load-high" };
  return { move: true, to };
}
