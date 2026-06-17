import {
  verifyRegisterRck,
  verifySetRoutingTarget,
  type RegisterRck,
  type SetRoutingTarget,
} from "@flagship/protocol";
import type { RoutingStorage, UsernameStorage } from "@flagship/storage";
import { HEX64, HEX128, equalHex, hexToBytes, bytesToHex } from "./hex.js";
import { validateServerLabel } from "./labels.js";
import {
  conflict, forbidden, malformed, notFound, ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

// M6 (Thread G): ring-buffer of recently-seen (subdomain, nonce) pairs
// for SetRoutingTarget replay defense. The freshness window already
// rejects requests older than 5min, but within that window an attacker
// who captured a valid signed envelope could replay it. The ring
// catches in-window duplicates with O(1) lookups.
//
// 256 slots × ~50 bytes per entry = 13 KB max — negligible memory
// across a Worker instance. Module-level state intentionally;
// per-process is the right scope (replay defense is best-effort across
// CF Workers' isolate ephemerality, but combined with the storage-level
// monotonic nonce check it's belt + suspenders).
const REPLAY_RING_SIZE = 256;
const seenRoutingNonces: Array<string> = [];
const seenRoutingNonceSet = new Set<string>();

function rememberRoutingNonce(subdomain: string, nonce: string): boolean {
  const key = `${subdomain}|${nonce}`;
  if (seenRoutingNonceSet.has(key)) return false; // duplicate, reject
  seenRoutingNonces.push(key);
  seenRoutingNonceSet.add(key);
  while (seenRoutingNonces.length > REPLAY_RING_SIZE) {
    const evicted = seenRoutingNonces.shift();
    if (evicted !== undefined) seenRoutingNonceSet.delete(evicted);
  }
  return true;
}

/** Test-only: reset the in-process ring (used by vitest to isolate cases). */
export function __resetRoutingReplayRing(): void {
  seenRoutingNonces.length = 0;
  seenRoutingNonceSet.clear();
}

export interface RoutingDeps {
  routing: RoutingStorage;
  usernames: UsernameStorage;
  /**
   * The data-plane apex subdomains live under — `flagship.services` in
   * prod, `gym.flagship.services` in the test env (docs/ui-test-gym.md
   * §6.5). Used only in the RCK subdomain namespace guard (not in
   * canonical bytes). Defaults to the prod literal so prod is byte-identical.
   */
  apex?: string;
  freshnessMs?: number;
  now?: () => number;
}

interface RegisterBody {
  request?: {
    username?: string;
    subdomain?: string;
    rckPubKey?: string;
    issuedAt?: number;
  };
  signature?: string;
}

interface SetTargetBody {
  request?: {
    subdomain?: string;
    newTargetIdentityPubKey?: string;
    issuedAt?: number;
    nonce?: string;
  };
  signature?: string;
}

const NONCE_HEX = /^[0-9a-f]{16,128}$/;

export async function handleRegisterRck(
  deps: RoutingDeps,
  body: RegisterBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.subdomain !== "string" ||
    typeof r.rckPubKey !== "string" ||
    !HEX64.test(r.rckPubKey) ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }
  if (Math.abs(now - r.issuedAt) > freshnessMs) return malformed("stale request");

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("username not registered");

  const claim: RegisterRck = {
    username: r.username,
    subdomain: r.subdomain,
    rckPubKey: hexToBytes(r.rckPubKey),
    issuedAt: r.issuedAt,
  };
  const sig = hexToBytes(body.signature);
  if (!verifyRegisterRck(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
  }

  // Subdomain must be `<server>.<user>.<apex>` and the user segment must
  // match the username — defends against claiming someone else's subdomain
  // even with a valid IRK.
  const expectedSuffix = `.${r.username}.${deps.apex ?? "flagship.services"}`;
  if (
    !r.subdomain.endsWith(expectedSuffix) ||
    r.subdomain.length === expectedSuffix.length
  ) {
    return malformed(`subdomain must end with ${expectedSuffix}`);
  }

  // M5 (Thread G): validate the leftmost <server> label's shape. Same
  // rule as auth-code serverName (validateServerLabel — an RFC-1123 DNS
  // label: interior hyphens allowed, no leading/trailing hyphen).
  // Catches trailing-dot, empty-leftmost, leading/trailing-hyphen, or
  // unicode-in-label attempts before they reach storage.
  const serverLabel = r.subdomain.slice(0, r.subdomain.length - expectedSuffix.length);
  const labelV = validateServerLabel(serverLabel);
  if (!labelV.ok) {
    return malformed(`invalid server label: ${labelV.reason}`);
  }

  const out = await deps.routing.register({
    subdomain: r.subdomain,
    username: r.username,
    rckPubKeyHex: r.rckPubKey,
    currentTargetHex: "",
    registeredAt: now,
    lastTargetUpdate: 0,
    lastTargetNonce: "",
  });
  if (!out.ok) return conflict(out.reason);
  return ok({ ok: true, subdomain: r.subdomain });
}

export async function handleSetRoutingTarget(
  deps: RoutingDeps,
  body: SetTargetBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;
  const r = body?.request;
  if (
    !r ||
    typeof r.subdomain !== "string" ||
    typeof r.newTargetIdentityPubKey !== "string" ||
    !HEX64.test(r.newTargetIdentityPubKey) ||
    typeof r.issuedAt !== "number" ||
    typeof r.nonce !== "string" ||
    !NONCE_HEX.test(r.nonce) ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }
  if (Math.abs(now - r.issuedAt) > freshnessMs) return malformed("stale request");

  const route = await deps.routing.get(r.subdomain);
  if (!route) return notFound("subdomain not registered");

  const claim: SetRoutingTarget = {
    subdomain: r.subdomain,
    newTargetIdentityPubKey: hexToBytes(r.newTargetIdentityPubKey),
    issuedAt: r.issuedAt,
    nonce: hexToBytes(r.nonce),
  };
  const sig = hexToBytes(body.signature);
  if (!verifySetRoutingTarget(claim, sig, hexToBytes(route.rckPubKeyHex))) {
    return forbidden("invalid signature");
  }

  // M6: reject in-window replays. The storage layer's monotonic
  // lastTargetNonce already rejects regressions, but a single signed
  // envelope used twice in quick succession could otherwise toggle state.
  if (!rememberRoutingNonce(r.subdomain, r.nonce)) {
    return conflict("nonce already seen in window");
  }

  const out = await deps.routing.setTarget(
    r.subdomain,
    r.newTargetIdentityPubKey,
    r.nonce,
    now,
  );
  if (!out.ok) {
    return out.reason === "unknown subdomain" ? notFound(out.reason) : conflict(out.reason);
  }
  return ok({ ok: true, subdomain: r.subdomain, currentTarget: r.newTargetIdentityPubKey });
}

export async function handleRoutingLookup(
  deps: RoutingDeps,
  subdomain: string,
): Promise<HandlerResponseWithHeaders> {
  const r = await deps.routing.get(subdomain);
  if (!r) return notFound("subdomain not registered");
  return ok({
    subdomain: r.subdomain,
    username: r.username,
    rckPubKey: r.rckPubKeyHex,
    currentTarget: r.currentTargetHex,
    lastTargetUpdate: r.lastTargetUpdate,
  });
}

/** Helper: when a server registers, set it as the current target if no
 *  prior target was set (first-server-wins for an empty subdomain). The
 *  phone can later override with a signed SetRoutingTarget. */
export async function setRoutingTargetFromRegistration(
  routing: RoutingStorage,
  subdomain: string,
  serverIdentityPubKeyHex: string,
  now: number,
): Promise<void> {
  const r = await routing.get(subdomain);
  if (!r) return; // no RCK registered yet; routing is "free"
  if (r.currentTargetHex && r.currentTargetHex !== serverIdentityPubKeyHex) return;
  await routing.setTarget(subdomain, serverIdentityPubKeyHex, "00".repeat(8), now);
}

export { equalHex };
