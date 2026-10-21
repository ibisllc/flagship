// Name dibs — `.com` holders get first claim on the matching account name
// during a one-year window (docs/naming-recovery-and-name-change.md §7 and the
// owner decisions of 2026-10-09 in §16).
//
//   GET  /api/name-dibs/window     PUBLIC  — is the window open, until when
//   POST /api/name-dibs/initiate   IRK     — start a claim, get the challenge
//   POST /api/name-dibs/verify     IRK     — check the published proof
//
// Rules:
//   - `.com` only. During the window a custom name whose `<name>.com` is
//     REGISTERED is reserved for that domain's holder; anyone may buy any
//     other free name. After the window everything is open to everyone.
//   - A lookup failure counts as "registered" (fail closed): a DNS hiccup must
//     never let someone take a brand's name.
//   - The proof is a challenge bound to the claimant's IRK and a server nonce
//     (protocol `nameDibsChallenge`), published as a DNS TXT record or an HTTPS
//     file. A record someone else published can't be replayed by another key.
//   - First verified claim wins (the store allows one verified row per name).
//   - Verifying doesn't rename anything. The name is taken by redeeming a dibs
//     entitlement and running the shared rename path — `allocateDibsName`, whose
//     entitlement and rename steps are injected so the paid name change can
//     supply them.

import {
  NAME_DIBS_RECORD_PREFIX,
  NAME_DIBS_TXT_LABEL,
  NAME_DIBS_WELL_KNOWN_PATH,
  nameDibsChallenge,
  verifyNameDibsInitiate,
  verifyNameDibsVerify,
  type NameDibsInitiate,
  type NameDibsVerify,
} from "@flagship/protocol";
import type { NameDibsClaimStorage, UsernameStorage } from "@flagship/storage";
import { HEX64, HEX128, equalHex, hexToBytes } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

/** The dibs claim price, USD (owner decision 2026-10-09). */
export const DIBS_CLAIM_PRICE_USD = 20;
/** How long a started claim's nonce stays verifiable (DNS can be slow). */
export const DIBS_NONCE_TTL_MS = 7 * 24 * 60 * 60_000;
/** Claim starts allowed per account per hour (enforced in storage). */
export const DIBS_STARTS_PER_HOUR = 10;

const HTTP_PROOF_TIMEOUT_MS = 5_000;
const HTTP_PROOF_MAX_BYTES = 4_096;

/** A minimal fetch shape, injectable for tests. */
export type DibsFetch = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: "manual" | "follow" | "error"; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface DibsWindow {
  /** ms since epoch; both unset ⇒ dibs is off and every name is open. */
  start?: number;
  end?: number;
}

export interface NameDibsDeps {
  usernames: UsernameStorage;
  claims: NameDibsClaimStorage;
  window: DibsWindow;
  fetch: DibsFetch;
  now?: () => number;
  freshnessMs?: number;
  /** Nonce source (tests). Defaults to 32 random bytes, hex. */
  newNonce?: () => string;
}

export interface DibsWindowState {
  configured: boolean;
  open: boolean;
  start: number | null;
  end: number | null;
}

/** Parse `DIBS_WINDOW_START` / `DIBS_WINDOW_END` (ISO dates or ms). Anything
 *  unparseable, or an end not after the start, leaves dibs off. */
export function parseDibsWindow(start?: string, end?: string): DibsWindow {
  const toMs = (v?: string): number | undefined => {
    if (!v) return undefined;
    const n = /^\d+$/.test(v.trim()) ? Number(v.trim()) : Date.parse(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const s = toMs(start);
  const e = toMs(end);
  if (s === undefined || e === undefined || e <= s) return {};
  return { start: s, end: e };
}

export function dibsWindowState(w: DibsWindow, now: number): DibsWindowState {
  const configured = w.start !== undefined && w.end !== undefined;
  return {
    configured,
    open: configured && now >= w.start! && now < w.end!,
    start: w.start ?? null,
    end: w.end ?? null,
  };
}

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? (() => Date.now()))();
}

function defaultNonce(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ── `.com` lookups (DNS-over-HTTPS) ─────────────────────────────────────────

interface DohResponse {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

async function doh(fetchImpl: DibsFetch, name: string, type: "NS" | "TXT"): Promise<DohResponse> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetchImpl(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH ${type} ${name}: HTTP ${res.status}`);
  const body = (await res.json()) as DohResponse;
  if (typeof body?.Status !== "number") throw new Error(`DoH ${type} ${name}: malformed`);
  return body;
}

/** True iff `<name>.com` is a registered domain (it has NS records). Throws on a
 *  lookup failure — callers decide which way to fail. */
export async function dotComRegistered(name: string, fetchImpl: DibsFetch): Promise<boolean> {
  const body = await doh(fetchImpl, `${name.toLowerCase()}.com`, "NS");
  return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0;
}

/**
 * Is `name` reserved for its `.com` holder right now? True only while the dibs
 * window is open AND `<name>.com` is registered — or the lookup failed, which
 * counts as reserved so an outage can't hand out a brand's name.
 */
export async function reservedForDotComHolder(
  deps: Pick<NameDibsDeps, "window" | "fetch" | "now">,
  name: string,
): Promise<boolean> {
  if (!dibsWindowState(deps.window, nowOf(deps)).open) return false;
  try {
    return await dotComRegistered(name, deps.fetch);
  } catch {
    return true;
  }
}

/** Join a DoH TXT answer's quoted segments (`"abc" "def"` → `abcdef`). */
function txtValue(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return data.trim();
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

async function proofInDns(fetchImpl: DibsFetch, name: string, expected: string): Promise<boolean> {
  try {
    const body = await doh(fetchImpl, `${NAME_DIBS_TXT_LABEL}.${name}.com`, "TXT");
    if (body.Status !== 0 || !Array.isArray(body.Answer)) return false;
    return body.Answer.some((a) => typeof a.data === "string" && txtValue(a.data).trim() === expected);
  } catch {
    return false;
  }
}

/**
 * The HTTPS proof. The URL is always `https://<name>.com/.well-known/…` where
 * `name` passed the username grammar — so it can't be an IP literal, a port, a
 * userinfo trick or another scheme. Redirects are refused (a redirect could
 * point at an internal address), the read is capped in size and time, and only
 * a 200 counts.
 */
async function proofOverHttps(fetchImpl: DibsFetch, name: string, expected: string): Promise<boolean> {
  const url = `https://${name}.com${NAME_DIBS_WELL_KNOWN_PATH}`;
  try {
    const signal = AbortSignal.timeout(HTTP_PROOF_TIMEOUT_MS);
    const res = await fetchImpl(url, { redirect: "manual", signal, headers: { accept: "text/plain" } });
    if (res.status !== 200) return false;
    const text = (await res.text()).slice(0, HTTP_PROOF_MAX_BYTES);
    return text.split(/\r?\n/).some((line) => line.trim() === expected);
  } catch {
    return false;
  }
}

// ── handlers ───────────────────────────────────────────────────────────────

/** `GET /api/name-dibs/window` — PUBLIC; drives the site page + in-app notice. */
export function handleNameDibsWindow(
  deps: Pick<NameDibsDeps, "window" | "now">,
): HandlerResponseWithHeaders {
  const st = dibsWindowState(deps.window, nowOf(deps));
  return ok({ ...st, scope: ".com", priceUsd: DIBS_CLAIM_PRICE_USD });
}

interface SignedBody<T> {
  request?: Partial<T>;
  signature?: unknown;
}

async function authClaimant(
  deps: NameDibsDeps,
  username: string,
  verify: (irkPub: Uint8Array) => boolean,
): Promise<{ ok: true; irkPubHex: string } | { ok: false; response: HandlerResponseWithHeaders }> {
  const rec = await deps.usernames.get(username);
  if (!rec) return { ok: false, response: notFound("unknown account") };
  if (!verify(hexToBytes(rec.irkPubHex))) return { ok: false, response: forbidden("invalid signature") };
  return { ok: true, irkPubHex: rec.irkPubHex.toLowerCase() };
}

function claimTarget(name: string) {
  return {
    dns: { name: `${NAME_DIBS_TXT_LABEL}.${name}.com`, type: "TXT" },
    https: { url: `https://${name}.com${NAME_DIBS_WELL_KNOWN_PATH}` },
  };
}

/** `POST /api/name-dibs/initiate` — start (or restart) a claim on `<name>.com`. */
export async function handleNameDibsInitiate(
  deps: NameDibsDeps,
  body: SignedBody<NameDibsInitiate> | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.name !== "string" ||
    typeof r.irkPubHex !== "string" ||
    !HEX64.test(r.irkPubHex) ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed dibs initiate");
  }
  if (Math.abs(now - r.issuedAt) > (deps.freshnessMs ?? 5 * 60_000)) return forbidden("stale request");
  if (!dibsWindowState(deps.window, now).open) {
    return conflict("the dibs window is not open — every free name is open to everyone");
  }
  const label = validateUserLabel(r.name);
  if (!label.ok) return malformed(label.reason);
  const name = label.label;
  const username = r.username.toLowerCase();

  const req: NameDibsInitiate = { username: r.username, name: r.name, irkPubHex: r.irkPubHex, issuedAt: r.issuedAt };
  const sig = hexToBytes(body.signature);
  const auth = await authClaimant(deps, username, (pub) => verifyNameDibsInitiate(req, sig, pub));
  if (!auth.ok) return auth.response;
  if (!equalHex(r.irkPubHex, auth.irkPubHex)) return forbidden("irkPubHex is not the account's registered IRK");

  if (username === name) return conflict("that is already your name");
  if (await deps.usernames.get(name)) return conflict("that name is already taken");
  const winner = await deps.claims.winner(name);
  if (winner && winner.username !== username) return conflict("another account has already proven that .com");

  let registered: boolean;
  try {
    registered = await dotComRegistered(name, deps.fetch);
  } catch {
    return { status: 503, body: { error: "couldn't check the .com registration — try again shortly" } };
  }
  if (!registered) {
    return conflict(`${name}.com isn't registered, so the name isn't reserved — buy it as an ordinary name change`);
  }

  if ((await deps.claims.countStartsSince(username, now - 60 * 60_000)) >= DIBS_STARTS_PER_HOUR) {
    return { status: 429, body: { error: "too many claim attempts — try again in an hour" } };
  }

  const nonce = (deps.newNonce ?? defaultNonce)();
  const row = await deps.claims.start({ name, username, irkPubHex: auth.irkPubHex, nonce, createdAt: now });
  const challenge = nameDibsChallenge(name, auth.irkPubHex, row.nonce);
  return ok({
    name,
    nonce: row.nonce,
    challenge,
    record: `${NAME_DIBS_RECORD_PREFIX}${challenge}`,
    publishAt: claimTarget(name),
    expiresAt: row.createdAt + DIBS_NONCE_TTL_MS,
    verified: row.verifiedAt !== undefined,
    priceUsd: DIBS_CLAIM_PRICE_USD,
  });
}

/** `POST /api/name-dibs/verify` — look for the published proof and, if found,
 *  record this account as the name's verified claimant. */
export async function handleNameDibsVerify(
  deps: NameDibsDeps,
  body: SignedBody<NameDibsVerify> | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.name !== "string" ||
    typeof r.nonce !== "string" ||
    !HEX64.test(r.nonce) ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed dibs verify");
  }
  if (Math.abs(now - r.issuedAt) > (deps.freshnessMs ?? 5 * 60_000)) return forbidden("stale request");
  if (!dibsWindowState(deps.window, now).open) {
    return conflict("the dibs window is not open — every free name is open to everyone");
  }
  const label = validateUserLabel(r.name);
  if (!label.ok) return malformed(label.reason);
  const name = label.label;
  const username = r.username.toLowerCase();

  const req: NameDibsVerify = { username: r.username, name: r.name, nonce: r.nonce, issuedAt: r.issuedAt };
  const sig = hexToBytes(body.signature);
  const auth = await authClaimant(deps, username, (pub) => verifyNameDibsVerify(req, sig, pub));
  if (!auth.ok) return auth.response;

  const row = await deps.claims.get(name, username);
  if (!row || row.nonce !== r.nonce.toLowerCase()) return notFound("no matching claim — start one first");
  if (row.verifiedAt !== undefined) return ok({ name, verified: true, method: row.method ?? null });
  if (now - row.createdAt > DIBS_NONCE_TTL_MS) return conflict("this claim expired — start a new one");
  // The claim was started under the account's key at that time; a key rotation
  // since then would make the published challenge name the wrong key.
  if (!equalHex(row.irkPubHex, auth.irkPubHex)) return conflict("your account key changed — start a new claim");

  const expected = `${NAME_DIBS_RECORD_PREFIX}${nameDibsChallenge(name, row.irkPubHex, row.nonce)}`;
  let method: "dns" | "http" | null = null;
  if (await proofInDns(deps.fetch, name, expected)) method = "dns";
  else if (await proofOverHttps(deps.fetch, name, expected)) method = "http";
  if (!method) {
    return conflict(`no proof found yet — publish it at ${claimTarget(name).dns.name} or ${claimTarget(name).https.url}`);
  }

  const marked = await deps.claims.markVerified(name, username, method, now);
  if (!marked.ok) {
    return marked.reason === "taken"
      ? conflict("another account proved that .com first")
      : notFound("no matching claim — start one first");
  }
  return ok({ name, verified: true, method, priceUsd: DIBS_CLAIM_PRICE_USD });
}

// ── allocation ─────────────────────────────────────────────────────────────

export interface DibsAllocationDeps {
  usernames: UsernameStorage;
  claims: NameDibsClaimStorage;
  now?: () => number;
  /** Consume a $20 dibs entitlement for (username → name). Single-use; returns
   *  false when there is none. Supplied by the paid name change. */
  consumeEntitlement: (args: { username: string; name: string }) => Promise<boolean>;
  /** Put an unconsumed entitlement back if the rename fails afterwards. */
  restoreEntitlement?: (args: { username: string; name: string }) => Promise<void>;
  /** The shared rename path (account + every box). */
  rename: (args: { oldUsername: string; newUsername: string }) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type DibsAllocationResult =
  | { ok: true; newUsername: string }
  | { ok: false; status: number; reason: string };

/**
 * Turn a verified dibs claim into the account's new name. The claim must be the
 * name's verified winner, still unconsumed; the name must still be free and
 * pass the grammar + reserved list; then the entitlement is consumed (exactly
 * once — a racing second request finds it gone) and the shared rename runs.
 * If the rename fails, the entitlement is restored and the claim stays usable.
 */
export async function allocateDibsName(
  deps: DibsAllocationDeps,
  args: { username: string; name: string },
): Promise<DibsAllocationResult> {
  const username = args.username.toLowerCase();
  const label = validateUserLabel(args.name);
  if (!label.ok) return { ok: false, status: 400, reason: label.reason };
  const name = label.label;
  const claim = await deps.claims.get(name, username);
  if (!claim || claim.verifiedAt === undefined) return { ok: false, status: 403, reason: "no verified claim on that name" };
  if (claim.consumedAt !== undefined) return { ok: false, status: 409, reason: "this claim was already used" };
  if (await deps.usernames.get(name)) return { ok: false, status: 409, reason: "that name is already taken" };

  if (!(await deps.consumeEntitlement({ username, name }))) {
    return { ok: false, status: 402, reason: "a dibs claim entitlement is required" };
  }
  const renamed = await deps.rename({ oldUsername: username, newUsername: name });
  if (!renamed.ok) {
    await deps.restoreEntitlement?.({ username, name });
    return { ok: false, status: 409, reason: renamed.reason };
  }
  // The rename moves username-keyed rows, which may or may not include this
  // claim's row depending on the rename implementation — mark it under both
  // keys (one is a no-op).
  await deps.claims.markConsumed(name, name, nowOf(deps));
  await deps.claims.markConsumed(name, username, nowOf(deps));
  return { ok: true, newUsername: name };
}
