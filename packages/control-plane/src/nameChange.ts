// Paid name change — move an account to a new name
// (docs/naming-recovery-and-name-change.md §5–6, decisions of 2026-10-09).
//
//   POST /api/account/name-change/quote   PUBLIC — can this account move to that
//                                          name, and what does it cost?
//   POST /api/account/name-change         the rename itself
//
// The free #93 rename was exploited to squat a reserved name (removed
// 2026-10-08). This endpoint is where squatting will be attempted next, so it
// enforces every item of the §5 ship-blocker checklist:
//   1. a single-use entitlement (voucher), consumed atomically before the
//      rename and put back if the rename fails — two requests with one code
//      yield exactly one rename;
//   2. `validateUserLabel` on the new name (grammar + reserved list);
//   3. a name currently offered to someone at sign-up is refused;
//   4. during the dibs window a name whose `<name>.com` is registered needs a
//      verified dibs claim by THIS account and a $20 dibs voucher;
//   5. a per-account rate limit, keyed by the stable AID and enforced in
//      storage (the edge RATE_LIMITER is only advisory);
//   6. every account field is carried to the new row (storage copies the whole
//      usernames row and moves every account table in one transaction);
//   7. the dead #93 route stays dead — this is a separate route.
//
// The envelope (`flagship/name-change/v1|aid|old|new|issuedAt`) is signed under
// the account's admin authority (admin root when pinned, else the IRK) and is
// bound to the stable AID, so it can't be replayed against another account.
//
// Not yet: accounts with servers. A box's FQDN, certificate, unlock lease and
// routing all encode the owner name; moving them is transfer-a-box's
// same-owner re-home, which isn't built or validated, so a rename is refused
// while any server is live rather than risk a box that can't unlock.

import { verifyNameChange, type NameChange } from "@flagship/protocol";
import type {
  AuditEventStorage,
  DeviceCapabilityGrantStorage,
  NameChangeStorage,
  NameDibsClaimStorage,
  ServerStorage,
  UsernameAliasStorage,
  UsernameOfferStorage,
  UsernameStorage,
  VoucherStorage,
} from "@flagship/storage";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { HEX64, HEX128, equalHex, hexToBytes } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import { DIBS_CLAIM_PRICE_USD, reservedForDotComHolder, type DibsFetch, type DibsWindow } from "./nameDibs.js";
import { OFFER_TTL_MS } from "./usernameClaim.js";
import { consumeNameVoucher, NAME_CHANGE_PRICE_USD, releaseNameVoucher } from "./voucher.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

/** One rename per account per this window. */
export const NAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60_000;

export interface NameChangeDeps {
  usernames: UsernameStorage;
  nameChanges: NameChangeStorage;
  vouchers: VoucherStorage;
  claims: NameDibsClaimStorage;
  servers: ServerStorage;
  offers?: UsernameOfferStorage;
  aliases?: UsernameAliasStorage;
  grants?: DeviceCapabilityGrantStorage;
  auditEvents?: AuditEventStorage;
  window: DibsWindow;
  fetch: DibsFetch;
  now?: () => number;
  freshnessMs?: number;
}

type Kind = "name-change" | "dibs-claim";

interface Assessment {
  ok: true;
  kind: Kind;
  priceUsd: number;
}
type Refusal = { ok: false; status: number; reason: string };

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? (() => Date.now()))();
}

/**
 * Everything about the target name that doesn't depend on the signature: is
 * it a valid, free, unreserved name — and if it's held for a .com holder, is
 * this account the verified holder? Shared by the quote and the rename.
 */
async function assessName(deps: NameChangeDeps, oldUsername: string, rawNew: string): Promise<Assessment | Refusal> {
  const label = validateUserLabel(rawNew);
  if (!label.ok) return { ok: false, status: 400, reason: label.reason };
  const name = label.label;
  if (name === oldUsername) return { ok: false, status: 409, reason: "that is already your name" };
  if (await deps.usernames.get(name)) return { ok: false, status: 409, reason: "that name is taken" };
  if (deps.aliases && (await deps.aliases.isConsumed(name))) {
    return { ok: false, status: 409, reason: "that name is taken" };
  }
  if (deps.offers && (await deps.offers.isOffered(name, nowOf(deps) - OFFER_TTL_MS))) {
    return { ok: false, status: 409, reason: "that name was just offered to someone signing up — try again later" };
  }
  if (await reservedForDotComHolder(deps, name)) {
    const winner = await deps.claims.winner(name);
    if (!winner || winner.username !== oldUsername) {
      return {
        ok: false,
        status: 409,
        reason: `${name} is held for whoever controls ${name}.com until the dibs window closes — prove you own it in "Claim your .com name"`,
      };
    }
    if (winner.consumedAt !== undefined) return { ok: false, status: 409, reason: "this dibs claim was already used" };
    return { ok: true, kind: "dibs-claim", priceUsd: DIBS_CLAIM_PRICE_USD };
  }
  return { ok: true, kind: "name-change", priceUsd: NAME_CHANGE_PRICE_USD };
}

async function liveServerCount(deps: NameChangeDeps, username: string): Promise<number> {
  const servers = await deps.servers.listForUser(username);
  return servers.filter((s) => !s.revokedAt).length;
}

/** `POST /api/account/name-change/quote` — `{ username, newUsername }` →
 *  `{ available, kind, priceUsd }` or `{ available:false, reason }`. Public:
 *  it reveals only what the public username lookup and DNS already do. */
export async function handleNameChangeQuote(
  deps: NameChangeDeps,
  body: { username?: unknown; newUsername?: unknown } | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (typeof body?.username !== "string" || typeof body?.newUsername !== "string") {
    return malformed("username and newUsername are required");
  }
  const old = body.username.toLowerCase();
  if (!(await deps.usernames.get(old))) return notFound("unknown account");
  const a = await assessName(deps, old, body.newUsername);
  if (!a.ok) return ok({ available: false, reason: a.reason });
  if ((await liveServerCount(deps, old)) > 0) {
    return ok({ available: false, reason: "renaming an account that has servers isn't available yet" });
  }
  return ok({ available: true, kind: a.kind, priceUsd: a.priceUsd });
}

interface NameChangeBody {
  request?: Partial<NameChange>;
  signature?: unknown;
  voucherCode?: unknown;
}

/** `POST /api/account/name-change` — the rename. */
export async function handleNameChange(
  deps: NameChangeDeps,
  body: NameChangeBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const r = body?.request;
  if (
    !r ||
    typeof r.aidPubHex !== "string" ||
    !HEX64.test(r.aidPubHex) ||
    typeof r.oldUsername !== "string" ||
    typeof r.newUsername !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature) ||
    typeof body.voucherCode !== "string" ||
    body.voucherCode.trim() === ""
  ) {
    return malformed("malformed name change");
  }
  if (Math.abs(now - r.issuedAt) > (deps.freshnessMs ?? 5 * 60_000)) return forbidden("stale request");

  const oldUsername = r.oldUsername.toLowerCase();
  const userRec = await deps.usernames.get(oldUsername);
  if (!userRec) return notFound("unknown account");
  if (userRec.isDemo || userRec.accountType === "demo") return forbidden("a demo account can't change its name");
  if (!userRec.aidPubHex || !equalHex(userRec.aidPubHex, r.aidPubHex)) {
    return forbidden("the request isn't bound to this account");
  }

  const claim: NameChange = {
    aidPubHex: r.aidPubHex.toLowerCase(),
    oldUsername: r.oldUsername,
    newUsername: r.newUsername,
    issuedAt: r.issuedAt,
  };
  const sig = hexToBytes(body.signature);
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    { username: oldUsername, userRec, verifyWith: (pub) => verifyNameChange(claim, sig, hexToBytes(pub)) },
  );
  if (!authz.ok) return forbidden("invalid signature");

  if ((await liveServerCount(deps, oldUsername)) > 0) {
    return conflict("renaming an account that has servers isn't available yet");
  }
  if ((await deps.nameChanges.countSince(claim.aidPubHex, now - NAME_CHANGE_COOLDOWN_MS)) > 0) {
    return { status: 429, body: { error: "you can change your name once every 30 days" } };
  }

  const a = await assessName(deps, oldUsername, r.newUsername);
  if (!a.ok) return { status: a.status, body: { error: a.reason } };
  const newUsername = r.newUsername.toLowerCase();

  // (1) Pay, then rename; refund if the rename fails. The consume is atomic,
  // so of two racing requests with one code only one reaches the rename.
  const paid = await consumeNameVoucher(deps, { code: body.voucherCode, kind: a.kind, username: oldUsername });
  if (!paid.ok) return { status: 402, body: { error: paid.reason } };

  const renamed = await deps.nameChanges.renameAccount({
    aidPubHex: claim.aidPubHex,
    oldUsername,
    newUsername,
    at: now,
  });
  if (!renamed.ok) {
    // The voucher row's redeemed_by is untouched by the rename only when the
    // rename rolled back — which is exactly when we release it.
    await releaseNameVoucher(deps, { codeHash: paid.codeHash, username: oldUsername });
    return conflict(renamed.reason);
  }

  if (a.kind === "dibs-claim") {
    // The claim row moved with the account (name_dibs_claims.username).
    await deps.claims.markConsumed(newUsername, newUsername, now);
  }
  await deps.offers?.consume(newUsername);
  try {
    await deps.auditEvents?.append({
      username: newUsername,
      eventKind: "account-renamed",
      detail: `${oldUsername} → ${newUsername}`,
      devicePrefix: "",
      postedAt: now,
    });
  } catch {
    /* the rename is committed; a lost audit row must not undo it */
  }
  const history = await deps.nameChanges.history(claim.aidPubHex);
  return ok({
    ok: true,
    oldUsername,
    newUsername,
    kind: a.kind,
    /** Every name this account has had, oldest first — private-profile blobs
     *  are bound to the account id at write time. */
    previousUsernames: [...new Set(history.map((h) => h.oldUsername))],
  });
}
