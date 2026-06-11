/**
 * Mint-reservation client (cert design, box half).
 *
 * A minter (an admin-scope device, or an "autonomous" box that holds a renewal
 * delegation) that sees the box's cert nearing expiry signs a
 * `MintReservationClaim` with its OWN minting key and acquires a CAS lease at
 * `.com` BEFORE running the ACME order. Other minters back off while a live
 * reservation exists; if the holder dies, the lease TTL lapses (δ ≈ one ACME
 * order ≪ remaining cert life) and the next minter takes over — dead-lead-safe,
 * no static election.
 *
 * BEST-EFFORT BY DESIGN. The reservation is advisory coordination only: if the
 * POST throws or `.com` is unreachable, this client FALLS BACK to a
 * deterministic local decision (`shouldMintNow`) so cert RENEWAL never
 * hard-depends on `.com`. A network partition can therefore never strand the
 * cert — the deterministic lead mints anyway, accepting an occasional duplicate
 * (bounded by LE's 5-duplicate/7-day limit; under model A′ the SAN set is
 * per-box, so duplicates only arise from re-mints of the SAME box's cert).
 *
 * Wire contract (mirrors `@flagship/control-plane` `mintReservations.ts`):
 *   POST <baseUrl>/api/users/<username>/mint-reservation          → acquire
 *   POST <baseUrl>/api/users/<username>/mint-reservation/release  → release
 * Body (both): { claim: { username, holderPubKey: <hex>, expiresAt }, signature: <hex> }
 * Acquire 200: { acquired: boolean, holder: { username, holderPubKey, acquiredAt, expiresAt } }
 *
 * This module does NOT touch the live SAN construction in runtime.ts (that is
 * the separate, ops-gated cutover); it only decides WHO mints this cycle.
 */

import { createHash } from "node:crypto";
import {
  signMintReservation,
  type Bytes,
  type Keypair,
  type MintReservationClaim,
} from "@flagship/protocol";

/** Cross-runtime fetch seam (Node 18+ has a global `fetch`; tests inject). */
export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ReservationHolder {
  username: string;
  /** The minter's signing pubkey (hex) that currently holds the lease. */
  holderPubKey: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface AcquireResult {
  acquired: boolean;
  /** Present when `.com` answered; absent on the best-effort local fallback. */
  holder?: ReservationHolder;
  /** True iff this verdict came from the deterministic local fallback because
   *  `.com` was unreachable (the POST threw / non-2xx). Lets the caller log it
   *  and the tests assert the fallback path. */
  fallback?: boolean;
}

export interface AcquireMintReservationOpts {
  /** `.com` identity-plane origin, e.g. "https://flagshipserver.com" (no trailing slash needed). */
  baseUrl: string;
  username: string;
  /** This minter's OWN signing keypair (admin device key, or the box's
   *  delegated minting key) — it signs the claim AND is the holder. */
  holderKeypair: Keypair;
  /** How long the lease should hold (ms) — δ, ≈ one ACME order, ≪ cert life. */
  ttlMs: number;
  /** The minter set this box knows about (their signing pubkeys, hex). Used
   *  ONLY for the deterministic local fallback when `.com` is unreachable.
   *  `selfPubHex` is added to the set automatically. */
  peers?: string[];
  fetchImpl?: FetchImpl;
  now?: () => number;
}

export interface ReleaseMintReservationOpts {
  baseUrl: string;
  username: string;
  holderKeypair: Keypair;
  /** TTL only matters for canonical-bytes shape on release; a short value is
   *  fine since release ignores it server-side. Defaults to 0. */
  ttlMs?: number;
  fetchImpl?: FetchImpl;
  now?: () => number;
}

function bytesToHex(b: Bytes): string {
  return Buffer.from(b).toString("hex");
}

/** Build the signed wire body shared by acquire + release. */
function signedClaimBody(args: {
  username: string;
  holderKeypair: Keypair;
  expiresAt: number;
}): { body: string; usernameNorm: string; holderPubHex: string; expiresAt: number } {
  const usernameNorm = args.username.toLowerCase();
  const claim: MintReservationClaim = {
    username: usernameNorm,
    holderPubKey: args.holderKeypair.publicKey,
    expiresAt: args.expiresAt,
  };
  const signature = signMintReservation(claim, args.holderKeypair);
  const holderPubHex = bytesToHex(args.holderKeypair.publicKey);
  return {
    body: JSON.stringify({
      claim: {
        username: usernameNorm,
        holderPubKey: holderPubHex,
        expiresAt: args.expiresAt,
      },
      signature: bytesToHex(signature),
    }),
    usernameNorm,
    holderPubHex,
    expiresAt: args.expiresAt,
  };
}

function reservationUrl(baseUrl: string, username: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return `${root}/api/users/${encodeURIComponent(username.toLowerCase())}/mint-reservation`;
}

function resolveFetch(injected: FetchImpl | undefined): FetchImpl {
  if (injected) return injected;
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g !== "function") {
    throw new Error("no fetch implementation available; pass opts.fetchImpl");
  }
  return g as unknown as FetchImpl;
}

/**
 * Deterministic single-lead election used as the BEST-EFFORT fallback when
 * `.com` is unreachable. Pure + total: returns true iff `selfPubHex` has the
 * lexicographically-lowest sha256 digest among {peers ∪ self}. Every minter
 * computes the same digests over the same set, so exactly one (the lowest) gets
 * `true` — a partition cannot strand the cert (the lead mints anyway), and two
 * minters cannot both believe they lead. Hashing the pubkeys (rather than
 * comparing them raw) avoids any structure/adjacency bias in key bytes.
 *
 * `selfPubHex` is included even if it is not already in `peers`; entries are
 * lower-cased + de-duplicated so a caller passing self in `peers` is harmless.
 */
export function shouldMintNow(opts: { peers: string[]; selfPubHex: string }): boolean {
  const self = opts.selfPubHex.toLowerCase();
  const set = new Set<string>([self]);
  for (const p of opts.peers) set.add(p.toLowerCase());
  const sha = (h: string) => createHash("sha256").update(h, "utf8").digest("hex");
  const selfDigest = sha(self);
  let lowest = selfDigest;
  for (const member of set) {
    const d = sha(member);
    if (d < lowest) lowest = d;
  }
  return selfDigest === lowest;
}

/**
 * Acquire the mint-reservation lease for `username` from `.com`. Returns
 * `{ acquired, holder }` from the control plane on success.
 *
 * BEST-EFFORT: if the POST throws (network error) or returns a non-2xx, this
 * does NOT throw — it falls back to the deterministic local decision
 * (`shouldMintNow` over `peers ∪ self`) and returns `{ acquired, fallback:true }`
 * so the caller can mint when it is the deterministic lead even with `.com`
 * down. Renewal therefore never hard-depends on `.com`.
 */
export async function acquireMintReservation(
  opts: AcquireMintReservationOpts,
): Promise<AcquireResult> {
  const now = (opts.now ?? (() => Date.now()))();
  const expiresAt = now + opts.ttlMs;
  const { body, holderPubHex } = signedClaimBody({
    username: opts.username,
    holderKeypair: opts.holderKeypair,
    expiresAt,
  });

  const localFallback = (): AcquireResult => ({
    acquired: shouldMintNow({ peers: opts.peers ?? [], selfPubHex: holderPubHex }),
    fallback: true,
  });

  let res: Awaited<ReturnType<FetchImpl>>;
  try {
    const fetchImpl = resolveFetch(opts.fetchImpl);
    res = await fetchImpl(reservationUrl(opts.baseUrl, opts.username), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch {
    // `.com` unreachable → deterministic local lead so renewal proceeds.
    return localFallback();
  }

  if (!res.ok) {
    // Treat any non-2xx (forbidden, malformed, 5xx) as "coordination
    // unavailable" and fall back rather than block renewal on `.com` health.
    return localFallback();
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return localFallback();
  }

  const p = parsed as {
    acquired?: unknown;
    holder?: {
      username?: unknown;
      holderPubKey?: unknown;
      acquiredAt?: unknown;
      expiresAt?: unknown;
    };
  };
  const holder: ReservationHolder | undefined =
    p.holder &&
    typeof p.holder.username === "string" &&
    typeof p.holder.holderPubKey === "string" &&
    typeof p.holder.acquiredAt === "number" &&
    typeof p.holder.expiresAt === "number"
      ? {
          username: p.holder.username,
          holderPubKey: p.holder.holderPubKey,
          acquiredAt: p.holder.acquiredAt,
          expiresAt: p.holder.expiresAt,
        }
      : undefined;

  return { acquired: p.acquired === true, holder };
}

/**
 * Release this box's mint-reservation lease (best-effort). Server-side this is
 * a no-op unless `holderKeypair` actually holds the lease, so an early release
 * only forfeits leadership. Any failure is swallowed: a stuck release simply
 * lets the lease lapse on its TTL.
 */
export async function releaseMintReservation(
  opts: ReleaseMintReservationOpts,
): Promise<{ released: boolean }> {
  const now = (opts.now ?? (() => Date.now()))();
  const expiresAt = now + (opts.ttlMs ?? 0);
  const { body } = signedClaimBody({
    username: opts.username,
    holderKeypair: opts.holderKeypair,
    expiresAt,
  });
  try {
    const fetchImpl = resolveFetch(opts.fetchImpl);
    const res = await fetchImpl(`${reservationUrl(opts.baseUrl, opts.username)}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return { released: res.ok };
  } catch {
    return { released: false };
  }
}
