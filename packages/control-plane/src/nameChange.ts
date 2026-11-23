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
// Paid with a single-use code (`voucherCode`, minted by an admin: voucher.ts), or with blind $1 vouchers
// (`vouchers`: `priceUsd / unitUsd` of them, 10 for a name change, 20 for a dibs claim) through the same
// nullifier store as `POST /api/vouchers/redeem` (blindVouchers.ts spendVouchersExactly). The vouchers were bought
// and unblinded without `.com` learning who bought them; spending them here tells `.com` only what the rename itself
// does (this account changed its name and paid). Either payment is taken atomically and put back if the rename fails.
//
// The names registry (migration 0127) moves in the rename's own batch (names.ts renameOwnerStatements): the new
// name is claimed under its look-alike key and the old one is held for 30 days, redirecting to the new name. A
// first rename within the sign-up window (`SIGNUP_RENAME_WINDOW_MS` of the account's claim) releases the old name at
// once instead: it is the random name `.com` suggested at sign-up, which only its owner has seen (the rename is
// refused once the account has a voi.ci page or a server, so nothing public ever pointed at it), and the apps'
// "Choose your own account name" runs this rename straight after creating the account.
//
// Not yet: accounts with servers. A box's FQDN, certificate, unlock lease and
// routing all encode the owner name; moving them is transfer-a-box's
// same-owner re-home, which isn't built or validated, so a rename is refused
// while any server is live rather than risk a box that can't unlock.

import { verifyNameChange, voiciNameProblem, type NameChange, type PaymentsConfig } from "@flagship/protocol";
import type {
  AuditEventStorage,
  BlindVoucherStorage,
  NameRegistryStorage,
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
import { spendVouchersExactly, unspendVouchers, type VoucherSigningKey } from "./blindVouchers.js";
import { checkNameGrant, returnNameGrant, spendNameGrant, takeNameGrant } from "./nameGrant.js";
import { DIBS_CLAIM_PRICE_USD, dibsWindowState, reservedForDotComHolder, type DibsFetch, type DibsWindow } from "./nameDibs.js";
import { OFFER_TTL_MS } from "./usernameClaim.js";
import { consumeNameVoucher, NAME_CHANGE_PRICE_USD, releaseNameVoucher } from "./voucher.js";
import { forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

/** One rename per account per this window. */
export const NAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60_000;

/** A first rename this soon after the account's claim releases the suggested name at once (see the header). The same
 *  hour the suggestion was reserved for this sign-up (OFFER_TTL_MS); a store purchase sheet fits well inside it. */
export const SIGNUP_RENAME_WINDOW_MS = OFFER_TTL_MS;

/** The blind-voucher rail: the keys and payment numbers of `/api/vouchers/*`, and its nullifier store. */
export interface NameChangeBlindVouchers {
  keys: VoucherSigningKey[];
  config: PaymentsConfig;
  store: BlindVoucherStorage;
}

export interface NameChangeDeps {
  usernames: UsernameStorage;
  nameChanges: NameChangeStorage;
  vouchers: VoucherStorage;
  claims: NameDibsClaimStorage;
  servers: ServerStorage;
  offers?: UsernameOfferStorage;
  aliases?: UsernameAliasStorage;
  /** The names registry: the new name must be free of look-alikes, as at sign-up. */
  names?: Pick<NameRegistryStorage, "isTaken">;
  /** Present when blind vouchers may pay (`vouchers` in the body). */
  blind?: NameChangeBlindVouchers;
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
/** `code` is the machine reason the apps turn into a sentence; `reason` stays the English for logs and old builds. */
type Refusal = { ok: false; status: number; reason: string; code: string; extra?: Record<string, unknown> };

function refusalBody(r: { reason: string; code: string; extra?: Record<string, unknown> }) {
  return { error: r.reason, code: r.code, ...(r.extra ?? {}) };
}

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? (() => Date.now()))();
}

/**
 * Everything about the target name that doesn't depend on the signature: is
 * it a valid, free, unreserved name — and if it's held for a .com holder, is
 * this account the verified holder? Shared by the quote and the rename.
 */
async function assessName(
  deps: NameChangeDeps,
  oldUsername: string,
  rawNew: string,
  opts: { liftDibs?: boolean } = {},
): Promise<Assessment | Refusal> {
  // The sign-up format (docs/voici-namespace-spec.md D12) and the account-label grammar + reserved list.
  const problem = voiciNameProblem(String(rawNew));
  if (problem) return { ok: false, status: 400, reason: "not a valid username", code: "invalid", extra: { problem } };
  const label = validateUserLabel(rawNew);
  if (!label.ok) return { ok: false, status: 400, reason: label.reason, code: "invalid" };
  const name = label.label;
  const taken: Refusal = { ok: false, status: 409, reason: "that name is taken", code: "taken" };
  if (name === oldUsername) return { ok: false, status: 409, reason: "that is already your name", code: "same-name" };
  if (await deps.usernames.get(name)) return taken;
  if (deps.aliases && (await deps.aliases.isConsumed(name))) return taken;
  // Taken or too similar to a live name (D8, D9). The account's own current name doesn't count: it is held or
  // released in the rename's batch, which then decides (a held own name still blocks its look-alikes).
  if (deps.names && (await deps.names.isTaken(name)) && voiciKey(name) !== voiciKey(oldUsername)) return taken;
  if (deps.offers && (await deps.offers.isOffered(name, nowOf(deps) - OFFER_TTL_MS))) {
    return { ok: false, status: 409, reason: "that name was just offered to someone signing up — try again later", code: "offered" };
  }
  // A name grant from the owner (nameGrant.ts) lifts only this hold, for only its own name.
  if (!opts.liftDibs && (await reservedForDotComHolder(deps, name))) {
    const winner = await deps.claims.winner(name);
    if (!winner || winner.username !== oldUsername) {
      return {
        ok: false,
        status: 409,
        reason: `${name} is held for whoever controls ${name}.com until the dibs window closes — prove you own it in "Claim your .com name"`,
        code: "dibs-held",
        extra: { heldUntil: dibsWindowState(deps.window, nowOf(deps)).end },
      };
    }
    if (winner.consumedAt !== undefined) return { ok: false, status: 409, reason: "this dibs claim was already used", code: "dibs-used" };
    return { ok: true, kind: "dibs-claim", priceUsd: DIBS_CLAIM_PRICE_USD };
  }
  return { ok: true, kind: "name-change", priceUsd: NAME_CHANGE_PRICE_USD };
}

function voiciKey(n: string): string {
  return n.toLowerCase().replace(/-/g, "").replace(/0/g, "o").replace(/1/g, "l");
}

/** Blind $1 vouchers that pay `priceUsd` (null when the rail is off). */
function unitsFor(deps: NameChangeDeps, priceUsd: number): number | null {
  if (!deps.blind || deps.blind.keys.length === 0) return null;
  return Math.ceil(priceUsd / deps.blind.config.unitUsd);
}

const HAS_SERVERS = "renaming an account that has servers isn't available yet";

async function liveServerCount(deps: NameChangeDeps, username: string): Promise<number> {
  const servers = await deps.servers.listForUser(username);
  return servers.filter((s) => !s.revokedAt).length;
}

/** `POST /api/account/name-change/quote` — `{ username, newUsername }` →
 *  `{ available, kind, priceUsd }` or `{ available:false, reason }`. Public:
 *  it reveals only what the public username lookup and DNS already do. */
export async function handleNameChangeQuote(
  deps: NameChangeDeps,
  body: { username?: unknown; newUsername?: unknown; nameGrant?: unknown } | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (typeof body?.username !== "string" || typeof body?.newUsername !== "string") {
    return malformed("username and newUsername are required");
  }
  const old = body.username.toLowerCase();
  if (!(await deps.usernames.get(old))) return notFound("unknown account");
  // A grant is checked, never taken, here.
  let grantPaid = false;
  if (body.nameGrant !== undefined) {
    const g = await checkNameGrant({ vouchers: deps.vouchers, now: deps.now }, body.newUsername.toLowerCase(), body.nameGrant);
    if (!g.ok) return ok({ available: false, reason: g.reason, code: g.code });
    grantPaid = g.paid;
  }
  const a = await assessName(deps, old, body.newUsername, { liftDibs: body.nameGrant !== undefined });
  if (!a.ok) return ok({ available: false, reason: a.reason, code: a.code, ...(a.extra ?? {}) });
  if ((await liveServerCount(deps, old)) > 0) {
    return ok({ available: false, reason: HAS_SERVERS, code: "has-servers" });
  }
  if (grantPaid) return ok({ available: true, kind: a.kind, priceUsd: 0, paid: true });
  const units = unitsFor(deps, a.priceUsd);
  return ok({ available: true, kind: a.kind, priceUsd: a.priceUsd, ...(units !== null ? { units } : {}) });
}

interface NameChangeBody {
  request?: Partial<NameChange>;
  signature?: unknown;
  /** A single-use name-change (or dibs-claim) code. */
  voucherCode?: unknown;
  /** Or blind $1 vouchers, exactly the price's worth. */
  vouchers?: unknown;
  /** The owner's grant for exactly this name (nameGrant.ts): lifts its dibs hold; a free one also pays. */
  nameGrant?: unknown;
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
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed name change");
  }
  const code = typeof body.voucherCode === "string" && body.voucherCode.trim() !== "" ? body.voucherCode : null;
  const blindVouchers = Array.isArray(body.vouchers) ? body.vouchers : null;
  const hasGrant = body.nameGrant !== undefined && body.nameGrant !== null;
  // At most one way to pay (none only with a grant that pays; checked below).
  if (code !== null && blindVouchers !== null) return malformed("malformed name change");
  if (code === null && blindVouchers === null && !hasGrant) return malformed("malformed name change");
  if (Math.abs(now - r.issuedAt) > (deps.freshnessMs ?? 5 * 60_000)) return forbidden("stale request");

  const oldUsername = r.oldUsername.toLowerCase();
  const userRec = await deps.usernames.get(oldUsername);
  if (!userRec) return notFound("unknown account");
  if (userRec.isDemo || userRec.accountType === "demo") return { status: 403, body: { error: "a demo account can't change its name", code: "demo" } };
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
    return { status: 409, body: { error: HAS_SERVERS, code: "has-servers" } };
  }
  if ((await deps.nameChanges.countSince(claim.aidPubHex, now - NAME_CHANGE_COOLDOWN_MS)) > 0) {
    return { status: 429, body: { error: "you can change your name once every 30 days", code: "cooldown" } };
  }

  const newUsername = r.newUsername.toLowerCase();
  const grantDeps = { vouchers: deps.vouchers, now: () => now };
  let grant: { codeHash: string; paid: boolean } | null = null;
  if (hasGrant) {
    const g = await checkNameGrant(grantDeps, newUsername, body.nameGrant);
    if (!g.ok) return { status: g.status, body: { error: g.reason, code: g.code } };
    grant = g;
    if (!g.paid && code === null && blindVouchers === null) return { status: 402, body: { error: "this name still needs paying for", code: "payment-required" } };
  }
  const a = await assessName(deps, oldUsername, r.newUsername, { liftDibs: grant !== null });
  if (!a.ok) return { status: a.status, body: refusalBody(a) };
  const firstRename = (await deps.nameChanges.countSince(claim.aidPubHex, 0)) === 0;
  const signupRename = firstRename && now - userRec.claimedAt >= 0 && now - userRec.claimedAt <= SIGNUP_RENAME_WINDOW_MS;

  // (1) Pay, then rename; refund if the rename fails. Both spends are atomic,
  // so of two racing requests with one payment only one reaches the rename.
  const refunds: Array<() => Promise<void>> = [];
  const refund = async () => {
    for (const f of refunds) await f();
  };
  if (grant) {
    const g = grant;
    if (!(await takeNameGrant(grantDeps, g.codeHash))) return { status: 402, body: { error: "this link was already used", code: "grant-used" } };
    refunds.push(() => returnNameGrant(grantDeps, g.codeHash));
  }
  if (grant?.paid) {
    // The grant pays for the rename; a code or vouchers sent with it are not taken.
  } else if (code !== null) {
    const paid = await consumeNameVoucher(deps, { code, kind: a.kind, username: oldUsername });
    if (!paid.ok) {
      await refund();
      return { status: 402, body: { error: paid.reason, code: paid.code } };
    }
    // The voucher row's redeemed_by is untouched by the rename only when the
    // rename rolled back — which is exactly when we release it.
    refunds.push(() => releaseNameVoucher(deps, { codeHash: paid.codeHash, username: oldUsername }));
  } else {
    const units = unitsFor(deps, a.priceUsd);
    if (units === null || !deps.blind) {
      await refund();
      return { status: 402, body: { error: "vouchers aren't accepted here", code: "vouchers-off" } };
    }
    const spent = await spendVouchersExactly({ ...deps.blind, now: () => now }, blindVouchers!, units);
    if (!spent.ok) {
      await refund();
      return spent.response;
    }
    const store = deps.blind.store;
    refunds.push(() => unspendVouchers(store, spent.nullifiers));
  }

  let renamed: { ok: true } | { ok: false; reason: string };
  try {
    renamed = await deps.nameChanges.renameAccount({
      aidPubHex: claim.aidPubHex,
      oldUsername,
      newUsername,
      at: now,
      oldNameHoldMs: signupRename ? 0 : undefined,
    });
  } catch (e) {
    await refund();
    throw e;
  }
  if (!renamed.ok) {
    await refund();
    const code = /taken/.test(renamed.reason) ? "taken" : /quantum|voi\.ci|Messages/.test(renamed.reason) ? "rename-unavailable" : "rename-failed";
    return { status: 409, body: { error: renamed.reason, code } };
  }

  if (grant) await spendNameGrant(grantDeps, grant.codeHash);
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
    /** True when the old name was released at once (a sign-up rename), false when it is held for 30 days. */
    oldNameReleased: signupRename,
    /** Every name this account has had, oldest first — private-profile blobs
     *  are bound to the account id at write time. */
    previousUsernames: [...new Set(history.map((h) => h.oldUsername))],
  });
}
