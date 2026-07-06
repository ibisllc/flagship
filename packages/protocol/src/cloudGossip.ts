/**
 * Cloud gossip / per-service leadership — the Phase-3 protocol foundation for
 * the multipod liveness/leadership system (docs index: multipod-liveness).
 *
 * PURE cryptographic / canonical-bytes plumbing — no live wiring, no daemon,
 * no clients. Four primitives + their byte-identical Swift/Kotlin mirrors and
 * pinned cross-platform vectors:
 *
 *   1. CGK (Cloud Gossip Key) — one symmetric key PER CLOUD (per account), the
 *      shared secret every pod of the account uses to authenticate + transport
 *      gossip. Derived the SAME way as `deriveSWK` (keys.ts) — HKDF-SHA256 over
 *      `umk.seed` with an empty salt — only the info differs and there is NO
 *      serverId (it is per-cloud, not per-server).
 *
 *   2. `flagship/set-leader/v1` — an owner-IRK-signed preferred-server vote.
 *      Mirrors the server-decommission envelope's conventions exactly (tag,
 *      `|` separator, lowercased hex, `legacyFieldGuard` on free-text fields,
 *      never-throwing verify).
 *
 *   3. Gossip announcement — canonical bytes + an HMAC-SHA256 tag keyed by the
 *      CGK (every pod can mint AND check it; no Ed25519 key exchange needed for
 *      the chatty per-tick liveness frame), plus an AES-256-GCM seal/open
 *      transport helper (nonce-prefixed) keyed by the CGK.
 *
 *   4. Clout ranking — the pure comparator + elector at the heart of
 *      leadership. Among the LIVE pods that run a service, the highest-clout
 *      member leads it; ties break to the oldest birth certificate, then the
 *      lowest domain.
 *
 *   5. `birthDateFromAuthCode` — the seniority source. The create-time,
 *      owner-IRK-signed `AuthCode` is immutable, so its `issuedAt` is a stable
 *      per-pod birth date in ms.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { gcm } from "@noble/ciphers/aes";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { AuthCode } from "./installBlob.js";
import type { Bytes, Keypair, UserId } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// 1. CGK — Cloud Gossip Key (per-cloud / per-account)
// ──────────────────────────────────────────────────────────────────────

/**
 * HKDF info for the Cloud Gossip Key. Dot-separated + `.v1`, matching the
 * `flagship.swk.v1` family of PROTOCOL info strings in keys.ts (NOT the
 * slash-form app-backup keys). There is NO `|serverId` suffix — the CGK is
 * one key for the WHOLE cloud (every pod of the account derives the same one),
 * so it can authenticate gossip between siblings with no per-pod exchange.
 */
const INFO_CGK = "flagship.cloud-gossip.v1";

/**
 * `CGK = HKDF-SHA256(ikm = umkSeed, salt = empty, info = "flagship.cloud-gossip.v1", 32)`.
 *
 * Mirrors `deriveSWK`'s exact HKDF construction (empty `Uint8Array(0)` salt,
 * UTF-8 info, 32-byte output) — only the info differs and there is no serverId.
 * Takes the raw `umk.seed` (32 bytes) like `deriveSWK` takes `umk` (it reads
 * `umk.seed` internally); pass `umk.seed`.
 */
export function deriveCGK(umkSeed: Bytes): Bytes {
  return hkdf(sha256, umkSeed, new Uint8Array(0), new TextEncoder().encode(INFO_CGK), 32);
}

// ──────────────────────────────────────────────────────────────────────
// 2. flagship/set-leader/v1 — owner-IRK-signed preferred-server vote
// ──────────────────────────────────────────────────────────────────────

const TAG_SET_LEADER = "flagship/set-leader/v1";

/** Sentinel `preferredStkPubHex` that CLEARS the vote (no preferred server). */
export const SET_LEADER_NONE = "none";

/**
 * Owner-IRK-signed "this is my preferred server" vote. The owner picks which
 * pod SHOULD lead (when it's live) regardless of clout; the vote's `issuedAt`
 * is what gives a voted pod the highest clout in the ranking (newest vote
 * wins). `preferredStkPubHex = "none"` clears the vote.
 *
 * Commits to (user, preferredStkPubHex, issuedAt, nonce). The nonce makes two
 * votes at the same `issuedAt` distinct; `user` binds the vote to one account.
 */
export interface SetLeaderVote {
  user: UserId;
  /** Lowercased STK pubkey hex of the preferred pod, or "none" to clear. */
  preferredStkPubHex: string;
  issuedAt: number;
  /** Per-vote nonce (replay distinctness within the same account). */
  nonce: string;
}

function canonicalSetLeader(v: SetLeaderVote): Bytes {
  legacyFieldGuard("user", v.user);
  legacyFieldGuard("preferredStkPubHex", v.preferredStkPubHex);
  legacyFieldGuard("nonce", v.nonce);
  return new TextEncoder().encode(
    [
      TAG_SET_LEADER,
      v.user.toLowerCase(),
      v.preferredStkPubHex.toLowerCase(),
      v.issuedAt,
      v.nonce.toLowerCase(),
    ].join("|"),
  );
}

export function signSetLeader(v: SetLeaderVote, irk: Keypair): Bytes {
  return ed.sign(canonicalSetLeader(v), irk.privateKey);
}

export function verifySetLeader(v: SetLeaderVote, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalSetLeader(v), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// 3. Gossip announcement — canonical bytes + HMAC + AES-256-GCM transport
// ──────────────────────────────────────────────────────────────────────

const TAG_GOSSIP = "flagship/gossip/v1";

/**
 * One pod's per-tick gossip frame: who it is, when it was born, the owner's
 * latest vote it has seen, which services it runs, and its own liveness.
 *
 * The whole frame is authenticated by an HMAC-SHA256 tag keyed by the CGK
 * (every sibling pod can both mint and check it), so a peer can't forge a
 * frame attributing services/votes to another pod without the cloud's CGK.
 */
export interface GossipAnnouncement {
  user: UserId;
  /** Pod identity — STK pubkey hex (or domain), lowercased into the bytes. */
  name: string;
  /** The pod's birth-certificate authority hex (its STK pub at create), lowercased. */
  birthAuthHex: string;
  /** Birth-certificate date (ms) — from `birthDateFromAuthCode`. */
  birthDate: number;
  /** STK pubkey hex the owner's latest set-leader vote points at, or "none". */
  voteStkHex: string;
  /** The vote's issuedAt (ms), or 0 when there is no vote. */
  voteDate: number;
  /** Service slugs this pod runs. Sorted + `,`-joined for determinism. */
  services: string[];
  /** This pod's liveness self-report. */
  liveness: "live" | "unreachable" | "never";
  /** When this frame was minted (ms). */
  issuedAt: number;
}

/** Sentinels for the absent vote, matching the comparator's null handling. */
export const GOSSIP_VOTE_NONE = "none";
export const GOSSIP_VOTE_DATE_NONE = "0";

/**
 * Canonical gossip bytes:
 *
 *   flagship/gossip/v1|<user>|<name>|<birthAuthHex>|<birthDate>|<voteStkHex>|<voteDate>|<services>|<liveness>|<issuedAt>
 *
 * `services` = the pod's slugs SORTED and `,`-joined (deterministic regardless
 * of input order, like the tunnel-HELLO controlledDomains list). `voteStkHex`/
 * `voteDate` collapse to "none"/"0" when absent. `name`/`birthAuthHex`/
 * `voteStkHex` are lowercased; `birthDate`/`voteDate`/`issuedAt` are integer-ms
 * strings (template-literal `${number}` stringification).
 */
export function canonicalGossip(a: GossipAnnouncement): Bytes {
  legacyFieldGuard("user", a.user);
  legacyFieldGuard("name", a.name);
  legacyFieldGuard("birthAuthHex", a.birthAuthHex);
  legacyFieldGuard("voteStkHex", a.voteStkHex);
  legacyFieldGuard("liveness", a.liveness);
  for (const s of a.services) legacyFieldGuard("service", s);
  const services = [...a.services].sort().join(",");
  return new TextEncoder().encode(
    [
      TAG_GOSSIP,
      a.user.toLowerCase(),
      a.name.toLowerCase(),
      a.birthAuthHex.toLowerCase(),
      a.birthDate,
      a.voteStkHex.toLowerCase(),
      a.voteDate,
      services,
      a.liveness,
      a.issuedAt,
    ].join("|"),
  );
}

/** HMAC-SHA256 of the canonical gossip bytes under the CGK, lowercased hex. */
export function macGossip(a: GossipAnnouncement, cgk: Bytes): string {
  return hex(hmac(sha256, cgk, canonicalGossip(a)));
}

/**
 * Constant-time check that `mac` (lowercased hex) is the CGK-HMAC of `a`.
 * Never throws — a malformed mac / wrong length returns false.
 */
export function verifyGossipMac(a: GossipAnnouncement, mac: string, cgk: Bytes): boolean {
  try {
    const expected = macGossip(a, cgk);
    if (typeof mac !== "string" || mac.length !== expected.length) return false;
    // Constant-time compare over the hex strings.
    let diff = 0;
    const got = mac.toLowerCase();
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

/**
 * AES-256-GCM transport seal keyed by the CGK. Wire layout (nonce-prefixed,
 * mirrors `encryption.ts` SealedBlob with the nonce inlined):
 *
 *   [nonce: 12 B][ciphertext + GCM tag: var]
 *
 * Simple symmetric transport for the gossip frame between siblings — both
 * sides hold the CGK. NOT a replacement for the HMAC tag (the HMAC
 * authenticates the FRAME's claims; the seal hides them on the wire).
 */
export function sealGossip(plaintext: Bytes, cgk: Bytes): Bytes {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ct = gcm(cgk, nonce).encrypt(plaintext);
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 12);
  return out;
}

/** Open a `sealGossip` blob with the CGK. Throws on a bad tag/length (GCM). */
export function openGossip(blob: Bytes, cgk: Bytes): Bytes {
  if (blob.length < 12 + 16) {
    throw new Error("sealed gossip blob too short (need nonce + GCM tag)");
  }
  const nonce = blob.slice(0, 12);
  const ct = blob.slice(12);
  return gcm(cgk, nonce).decrypt(ct);
}

// ──────────────────────────────────────────────────────────────────────
// 4. Clout ranking — the pure comparator + elector
// ──────────────────────────────────────────────────────────────────────

export interface CloutMember {
  /** STK pubkey hex (or domain) — the pod's identity. */
  id: string;
  /** The pod's FQDN — the final lexicographic tie-break. */
  domain: string;
  /** Birth-certificate date (ms) — the seniority source. */
  birthDate: number;
  /** The owner's set-leader vote issuedAt (ms), or null when not voted. */
  voteIssuedAt: number | null;
  liveness: "live" | "unreachable" | "never";
  /** Service slugs this pod runs. */
  services: string[];
}

/**
 * The raw clout comparator (exported so it is unit-testable). Returns a
 * negative number when `a` outranks `b` (sorts FIRST = the leader), positive
 * when `b` outranks `a`, 0 only when fully tied. Total order — deterministic
 * for any two members:
 *
 *   1. highest `voteIssuedAt` wins (null treated as -Infinity);
 *   2. tie → lowest `birthDate` (the OLDEST birth certificate) wins;
 *   3. tie → lowest `domain` lexicographically.
 */
export function compareClout(a: CloutMember, b: CloutMember): number {
  const av = a.voteIssuedAt ?? -Infinity;
  const bv = b.voteIssuedAt ?? -Infinity;
  // Higher vote first → descending, so b - a.
  if (av !== bv) return bv - av;
  // Lower birthDate first → ascending.
  if (a.birthDate !== b.birthDate) return a.birthDate - b.birthDate;
  // Lower domain first → ascending lexicographic.
  if (a.domain < b.domain) return -1;
  if (a.domain > b.domain) return 1;
  return 0;
}

/**
 * Elect the leader for a single service: among the members that are `live`
 * AND run `serviceSlug`, the highest-clout one (per {@link compareClout}).
 * Returns `null` when no live runner exists.
 */
export function electLeadForService(
  members: CloutMember[],
  serviceSlug: string,
): CloutMember | null {
  const eligible = members.filter(
    (m) => m.liveness === "live" && m.services.includes(serviceSlug),
  );
  if (eligible.length === 0) return null;
  // The comparator is a total order, so the minimum is the unique leader.
  let lead = eligible[0]!;
  for (let i = 1; i < eligible.length; i++) {
    if (compareClout(eligible[i]!, lead) < 0) lead = eligible[i]!;
  }
  return lead;
}

// ──────────────────────────────────────────────────────────────────────
// 5. Birth-certificate date extraction
// ──────────────────────────────────────────────────────────────────────

/**
 * The seniority source for clout: the create-time, owner-IRK-signed AuthCode
 * is immutable (signed ONCE at server creation; `signAuthCode` commits to
 * `issuedAt`), so its `issuedAt` is a stable, unforgeable per-pod birth date.
 * Returned verbatim as ms.
 *
 * NOTE on the field choice: AuthCode carries both `issuedAt` and `expiresAt`.
 * `issuedAt` is the birth instant (creation time); `expiresAt` is only the
 * recipe's redemption TTL. We use `issuedAt` — it is the moment the owner
 * minted this pod's identity, which is exactly "how old is this box".
 */
export function birthDateFromAuthCode(authCode: AuthCode): number {
  return authCode.issuedAt;
}
