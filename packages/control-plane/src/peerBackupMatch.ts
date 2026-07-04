import { sha256 } from "@noble/hashes/sha256";
import {
  verifyPbManifestDeposit,
  verifyPbRequestPeers,
  type PbManifestDeposit,
  type PbRequestPeers,
} from "@flagship/protocol";
import type {
  DaemonStatusStorage,
  PeerBackupManifestStorage,
  ServerStorage,
} from "@flagship/storage";
import { HEX128, bytesToHex, hexToBytes } from "./hex.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Peer-backup matchmaker + manifest lane (server-migration Layer 0).
//
// Box↔.com PEER protocol, authenticated by the box STK against the
// directory (get → revokedAt guard → verify signature vs the registered
// identityPubKeyHex) — the same posture as the daemon-status heartbeat
// and the secret-mailbox request lane. These are NOT owner/phone orders,
// so they do not ride the Slice-D admin gate (nothing here retires,
// wipes, re-homes, or re-keys anything; the worst a stolen STK can do is
// learn its OWN account's pod list, which /pods already serves).
//
// Topology non-leak: request-peers only ever answers a VERIFIED STK of a
// registered, non-revoked box, and only ever returns pods of THAT box's
// own account. Strangers get a 404/403 and learn nothing.
//
// Peer-selection policy v0: SAME-ACCOUNT pods only. Cross-user
// matchmaking (the lifecycle-spec share-ratio pool) needs a reciprocity
// + abuse policy that is not decided yet.
// TODO(cross-user matchmaking): revisit when the pledge/share-ratio
// policy lands; the response shape already carries everything a
// cross-user peer would need (serverId, stkPubHex, baseUrl).
// ──────────────────────────────────────────────────────────────────────

const REQUEST_FRESHNESS_MS = 10 * 60_000;
const MAX_PEERS_PER_REQUEST = 32;
/** 2 MiB of sealed manifest ciphertext (4 MiB hex) — far above any real manifest. */
const MAX_MANIFEST_CIPHERTEXT_HEX = 4 * 1024 * 1024;
const HEX_RE = /^[0-9a-f]*$/;

export interface PeerBackupMatchDeps {
  servers: ServerStorage;
  /** Optional — when present, live-reporting peers are preferred. */
  daemonStatus?: DaemonStatusStorage;
  now?: () => number;
}

export interface RequestPeersBody {
  request?: {
    requesterServerId?: unknown;
    n?: unknown;
    shardSizeBytes?: unknown;
    durabilityHint?: unknown;
    issuedAt?: unknown;
  };
  /** STK signature over the canonical pb/request-peers/v1 bytes, hex. */
  signature?: unknown;
  /**
   * Peers the requester already uses for this chunk (rides UNSIGNED —
   * it only narrows the result set, never widens authority).
   */
  excludeServerIds?: unknown;
}

export interface MatchedPeer {
  serverId: string;
  stkPubHex: string;
  /** Where the peer's daemon API lives — its public FQDN. */
  baseUrl: string;
}

export async function handlePbRequestPeers(
  deps: PeerBackupMatchDeps,
  body: RequestPeersBody,
): Promise<HandlerResponseWithHeaders> {
  const r = body?.request;
  if (
    !r ||
    typeof r.requesterServerId !== "string" ||
    r.requesterServerId.length === 0 ||
    typeof r.n !== "number" ||
    !Number.isInteger(r.n) ||
    r.n < 1 ||
    typeof r.shardSizeBytes !== "number" ||
    !Number.isFinite(r.shardSizeBytes) ||
    r.shardSizeBytes < 0 ||
    (r.durabilityHint !== "high" && r.durabilityHint !== "best-effort") ||
    typeof r.issuedAt !== "number"
  ) {
    return malformed("malformed request-peers envelope");
  }
  if (typeof body.signature !== "string" || !HEX128.test(body.signature)) {
    return malformed("malformed signature");
  }
  const exclude = new Set<string>();
  if (body.excludeServerIds !== undefined) {
    if (
      !Array.isArray(body.excludeServerIds) ||
      body.excludeServerIds.some((x) => typeof x !== "string")
    ) {
      return malformed("malformed excludeServerIds");
    }
    for (const x of body.excludeServerIds as string[]) exclude.add(x.toLowerCase());
  }

  const reg = await deps.servers.get(r.requesterServerId);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");

  const claim: PbRequestPeers = {
    requesterServerId: r.requesterServerId,
    n: r.n,
    shardSizeBytes: r.shardSizeBytes,
    durabilityHint: r.durabilityHint,
    issuedAt: r.issuedAt,
  };
  let sig: Uint8Array;
  let stkPub: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
    stkPub = hexToBytes(reg.identityPubKeyHex);
  } catch {
    return malformed("bad hex");
  }
  if (!verifyPbRequestPeers(claim, sig, stkPub)) {
    return forbidden("invalid signature");
  }
  const now = (deps.now ?? Date.now)();
  if (Math.abs(now - r.issuedAt) > REQUEST_FRESHNESS_MS) {
    return forbidden("stale request");
  }

  const all = await deps.servers.listForUser(reg.username);
  const requesterKey = reg.serverDomain.toLowerCase();
  const candidates = all.filter(
    (s) =>
      !s.revokedAt &&
      s.serverDomain.toLowerCase() !== requesterKey &&
      !exclude.has(s.serverDomain.toLowerCase()),
  );

  // Prefer peers that have reported a heartbeat recently — a shard
  // placed on a box that's been dark for a month is a shard lost to the
  // next repair pass. Fall back to registration order.
  let lastSeen = new Map<string, number>();
  if (deps.daemonStatus) {
    const statuses = await deps.daemonStatus.listForUser(reg.username);
    lastSeen = new Map(statuses.map((s) => [s.serverDomain.toLowerCase(), s.lastReported]));
  }
  candidates.sort((a, b) => {
    const la = lastSeen.get(a.serverDomain.toLowerCase()) ?? 0;
    const lb = lastSeen.get(b.serverDomain.toLowerCase()) ?? 0;
    if (la !== lb) return lb - la;
    return a.registeredAt - b.registeredAt;
  });

  const n = Math.min(r.n, MAX_PEERS_PER_REQUEST);
  const peers: MatchedPeer[] = candidates.slice(0, n).map((s) => ({
    serverId: s.serverDomain,
    stkPubHex: s.identityPubKeyHex,
    baseUrl: `https://${s.serverDomain}`,
  }));
  return ok({ peers });
}

/**
 * Exact-match STK directory lookup — the RECEIVING peer of a box↔box
 * shard request resolves the caller's directory-bound STK here before
 * trusting anything in the request. Public: the FQDN is already public
 * DNS, the STK pub is what the routing lookup serves for the routed box,
 * and there is no enumeration surface (you must present the exact FQDN).
 */
export async function handlePeerStkLookup(
  deps: Pick<PeerBackupMatchDeps, "servers">,
  serverDomain: string,
): Promise<HandlerResponseWithHeaders> {
  if (!serverDomain) return malformed("missing serverDomain");
  const reg = await deps.servers.get(serverDomain);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  return ok({ serverId: reg.serverDomain, stkPubHex: reg.identityPubKeyHex });
}

export interface PeerBackupManifestDeps {
  servers: ServerStorage;
  peerBackupManifests: PeerBackupManifestStorage;
  now?: () => number;
}

export interface PutBackupManifestBody {
  generation?: unknown;
  updatedAt?: unknown;
  ciphertextHex?: unknown;
  nonceHex?: unknown;
  signatureHex?: unknown;
}

export async function handlePutBackupManifest(
  deps: PeerBackupManifestDeps,
  serverDomain: string,
  body: PutBackupManifestBody,
): Promise<HandlerResponseWithHeaders> {
  if (
    typeof body?.generation !== "number" ||
    !Number.isInteger(body.generation) ||
    body.generation < 1 ||
    typeof body.updatedAt !== "number" ||
    typeof body.ciphertextHex !== "string" ||
    body.ciphertextHex.length === 0 ||
    body.ciphertextHex.length % 2 !== 0 ||
    typeof body.nonceHex !== "string" ||
    body.nonceHex.length !== 24 ||
    typeof body.signatureHex !== "string" ||
    !HEX128.test(body.signatureHex)
  ) {
    return malformed("malformed manifest deposit");
  }
  const ciphertextHex = body.ciphertextHex.toLowerCase();
  const nonceHex = body.nonceHex.toLowerCase();
  if (!HEX_RE.test(ciphertextHex) || !HEX_RE.test(nonceHex)) {
    return malformed("bad hex");
  }
  if (ciphertextHex.length > MAX_MANIFEST_CIPHERTEXT_HEX) {
    return malformed("manifest too large");
  }

  const reg = await deps.servers.get(serverDomain);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");

  const deposit: PbManifestDeposit = {
    serverId: serverDomain,
    generation: body.generation,
    updatedAt: body.updatedAt,
    ciphertextSha256Hex: bytesToHex(sha256(hexToBytes(ciphertextHex))),
    nonceHex,
  };
  let sig: Uint8Array;
  let stkPub: Uint8Array;
  try {
    sig = hexToBytes(body.signatureHex);
    stkPub = hexToBytes(reg.identityPubKeyHex);
  } catch {
    return malformed("bad hex");
  }
  if (!verifyPbManifestDeposit(deposit, sig, stkPub)) {
    return forbidden("invalid signature");
  }
  const now = (deps.now ?? Date.now)();
  if (Math.abs(now - body.updatedAt) > REQUEST_FRESHNESS_MS) {
    return forbidden("stale deposit");
  }

  const put = await deps.peerBackupManifests.put({
    serverDomain: reg.serverDomain,
    username: reg.username,
    generation: body.generation,
    updatedAt: body.updatedAt,
    ciphertextHex,
    nonceHex,
  });
  if (!put.ok) return { status: 409, body: { error: put.reason } };
  return ok({ stored: true, generation: body.generation });
}

/**
 * Public, NON-consuming read — the blob is sealed under the SWK-derived
 * manifest key, so disclosure is ciphertext-only (mirrors the sealed-
 * deposit release posture), and a crashed restore can fetch it again.
 * Deliberately no revoked-guard: the migration flow retires/revokes the
 * OLD box while the fresh box still needs the manifest (the same
 * revoke-tolerance argument as the self-delete consume lane).
 */
export async function handleGetBackupManifest(
  deps: Pick<PeerBackupManifestDeps, "peerBackupManifests">,
  serverDomain: string,
): Promise<HandlerResponseWithHeaders> {
  const rec = await deps.peerBackupManifests.get(serverDomain);
  if (!rec) return notFound("no manifest");
  return ok({
    serverDomain: rec.serverDomain,
    generation: rec.generation,
    updatedAt: rec.updatedAt,
    ciphertextHex: rec.ciphertextHex,
    nonceHex: rec.nonceHex,
  });
}
