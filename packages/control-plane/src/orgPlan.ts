// The Business plan for orgs on `.com` (docs/plans-and-backup-offer.md "As built"): the org's plan state, the CA-signed
// org plan attestation the org's boxes enforce, the sealed org voucher wallet, and spending vouchers on seats.
//
//   GET  /api/orgs/<orgId>/plan                 the plan (public: the orgId is the read capability, as for the org's
//                                               other GET routes, and nothing here is secret)
//   GET  /api/orgs/<orgId>/plan-attestation     flagship/org-plan-attestation/v1, CA-signed
//   GET  /api/orgs/<orgId>/voucher-wallet       the sealed wallet (ciphertext only) or 404
//   PUT  /api/orgs/<orgId>/voucher-wallet       {blob, write, approvals}: one org admin approves every write
//
// Spending (`POST /api/vouchers/redeem` with `org`) goes through blindVouchers.ts and lands in `redeemForOrg` here.
// The gating rule every org route applies: `orgPlanGate`. A lapsed org is never wiped and keeps every existing seat;
// it can't add seats, raise roles, add servers, add admins or start a directory connector.
import {
  DEFAULT_PAYMENTS_CONFIG,
  TAG_ORG_PLAN_ATTESTATION,
  canonicalOrgWalletWrite,
  isOrgSeatCount,
  orgApprovalFromWire,
  orgEgressGb,
  orgPaidUntilAfterSpend,
  orgPlanState,
  orgWalletBlobSha256,
  parseSealedOrgVoucherWallet,
  signOrgPlanAttestation,
  authorizeOrgOrder,
  OrgAuthorityError,
  PqTrustError,
  PLAN_ATTESTATION_TTL_MS,
  type OrgPlanState,
  type OrgPlanTerms,
  type OrgWalletWrite,
  type PaymentsConfig,
} from "@flagship/protocol";
import type { BlindVoucherStorage, OrgRecord, OrgStorage } from "@flagship/storage";
import { loadOrg, type OrgDeps } from "./orgs.js";
import type { CaIssuer } from "./pubkeyCert.js";
import { malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

const DAY_MS = 86_400_000;
const ORG_ID = /^[0-9a-f]{32}$/;
export const ORG_WALLET_MAX_BODY = 6 * 1024 * 1024;
/** The wallet row's key in `voucher_wallets` (a username can't contain ':'). */
export const orgWalletRow = (orgId: string) => `org:${orgId}`;

export const configOf = (deps: Pick<OrgDeps, "payments">): PaymentsConfig => deps.payments ?? DEFAULT_PAYMENTS_CONFIG;

/** The org row's terms; rows from before migration 0156 are on the trial that began at `createdAt`. */
export function orgTermsOf(cfg: PaymentsConfig, org: OrgRecord): OrgPlanTerms {
  return {
    trialEndsAt: org.trialEndsAt ?? org.createdAt + cfg.business.trialDays * DAY_MS,
    trialSeats: org.seatLimit ?? Number.MAX_SAFE_INTEGER,
    paidSeats: org.paidSeats ?? 0,
    paidUntil: org.paidUntil ?? 0,
  };
}

export function orgPlanOf(cfg: PaymentsConfig, org: OrgRecord, now: number): OrgPlanState {
  return orgPlanState(cfg, orgTermsOf(cfg, org), now);
}

/** Live seats: granted and not revoked (what the seat limit counts). */
export function orgLiveSeats(book: { seats: ReadonlyMap<string, unknown>; revoked: ReadonlySet<string> }): number {
  return [...book.seats.keys()].filter((s) => !book.revoked.has(s)).length;
}

export type OrgGatedAction = "new-seat" | "raise-role" | "add-server" | "add-admin" | "start-connector";

/**
 * The one gating rule: `org-plan-lapsed` for what a lapsed org may not do, `org-seat-limit` for a new seat past the
 * limit. Everything else (removing a seat, freezes, offboarding and its rotations, export, the log, the directory,
 * pausing or retiring a connector, every app) stays allowed on every plan state.
 */
export function orgPlanGate(cfg: PaymentsConfig, org: OrgRecord, now: number, action: OrgGatedAction, liveSeats = 0): "org-plan-lapsed" | "org-seat-limit" | null {
  const st = orgPlanOf(cfg, org, now);
  if (st.status === "lapsed") return "org-plan-lapsed";
  if (action === "new-seat" && liveSeats >= st.seatLimit) return "org-seat-limit";
  return null;
}

const NO_STORE = { "cache-control": "no-store" } as const;

function planBody(cfg: PaymentsConfig, orgId: string, st: OrgPlanState, liveSeats: number) {
  return {
    orgId,
    plan: "business",
    status: st.status,
    seatLimit: Math.min(st.seatLimit, Number.MAX_SAFE_INTEGER),
    paidSeats: st.paidSeats,
    paidUntil: st.paidUntil,
    trialEndsAt: st.trialEndsAt,
    coveredUntil: st.coveredUntil,
    liveSeats,
    price: {
      unitUsd: cfg.unitUsd,
      unitsPerSeatMonth: cfg.business.unitsPerSeatMonth,
      minSeats: cfg.business.minSeats,
      maxSeats: cfg.business.maxSeats,
      egressGbPerSeat: cfg.business.egressGbPerSeat,
    },
  };
}

export async function handleOrgPlanGet(deps: OrgDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  const now = (deps.now ?? Date.now)();
  const v = await loadOrg(deps, orgId, now).catch(() => null);
  if (!v) return notFound("org not found");
  const cfg = configOf(deps);
  return ok(planBody(cfg, orgId, orgPlanOf(cfg, v.org, now), orgLiveSeats(v.book)), { ...NO_STORE });
}

export async function handleOrgPlanAttestation(deps: OrgDeps & { ca: CaIssuer; ttlMs?: number }, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  const now = (deps.now ?? Date.now)();
  const org = await deps.orgs.getOrg(orgId);
  if (!org) return notFound("org not found");
  const st = orgPlanOf(configOf(deps), org, now);
  const a = signOrgPlanAttestation(
    {
      orgId,
      status: st.status,
      seatLimit: Math.min(st.seatLimit, Number.MAX_SAFE_INTEGER),
      paidSeats: st.paidSeats,
      trialEndsAt: st.trialEndsAt,
      paidUntil: st.paidUntil,
      issuedAt: now,
      expiresAt: now + (deps.ttlMs ?? PLAN_ATTESTATION_TTL_MS),
    },
    deps.ca.keypair,
  );
  return ok(a, { "cache-control": "private, no-store", "x-flagship-tag": TAG_ORG_PLAN_ATTESTATION });
}

// ── the org wallet ─────────────────────────────────────────────────────

type WalletStore = Pick<BlindVoucherStorage, "getWallet" | "putWallet">;

export async function handleOrgWalletGet(deps: OrgDeps & { wallets: WalletStore }, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  if (!(await deps.orgs.getOrg(orgId))) return notFound("org not found");
  const s = await deps.wallets.getWallet(orgWalletRow(orgId));
  if (!s) return { status: 404, body: { error: "not-found", code: "not-found" }, headers: { ...NO_STORE } };
  return { status: 200, body: JSON.parse(s.blob) as unknown, headers: { ...NO_STORE } };
}

/**
 * `PUT …/voucher-wallet` `{blob, write, approvals}`: `write` must describe exactly this blob, be fresh, and carry one
 * org admin's approval (the `seat-invite` threshold: one org admin, never a scoped seat). Compare-and-set on version;
 * a conflict answers 409 with the stored blob to merge.
 */
export async function handleOrgWalletPut(deps: OrgDeps & { wallets: WalletStore }, orgId: string, bodyText: string): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  if (bodyText.length > ORG_WALLET_MAX_BODY) return { status: 413, body: { error: "too-large", code: "too-large" } };
  let b: { blob?: unknown; write?: OrgWalletWrite; approvals?: unknown[] };
  try {
    b = JSON.parse(bodyText);
  } catch {
    return malformed("json");
  }
  const blob = parseSealedOrgVoucherWallet(b?.blob);
  if (!blob || !b.write || !Array.isArray(b.approvals)) return malformed("blob, write and approvals required");
  const w = b.write;
  let order: Uint8Array;
  try {
    order = canonicalOrgWalletWrite(w);
  } catch {
    return malformed("write");
  }
  if (w.orgId !== orgId || w.version !== blob.version || w.keyVersion !== blob.keyVersion || w.blobSha256 !== orgWalletBlobSha256(blob)) {
    return malformed("write does not describe this blob");
  }
  if (Math.abs(now - w.issuedAt) > 10 * 60_000) return malformed("stale write");
  try {
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    authorizeOrgOrder({ state: v.state, book: v.book, action: { kind: "seat-invite" }, order, approvals: b.approvals.map(orgApprovalFromWire), now });
  } catch (e) {
    if (e instanceof OrgAuthorityError) return { status: 403, body: { error: e.message, code: `org-${e.code}` } };
    if (e instanceof PqTrustError) return { status: 403, body: { error: e.message, code: "org-binding" } };
    return malformed(e instanceof Error ? e.message : "malformed");
  }
  const text = JSON.stringify({ ct: blob.ct, keyVersion: blob.keyVersion, nonce: blob.nonce, version: blob.version });
  if (!(await deps.wallets.putWallet(orgWalletRow(orgId), blob.version, text, now))) {
    const cur = await deps.wallets.getWallet(orgWalletRow(orgId));
    return { status: 409, body: { error: "version-conflict", code: "version-conflict", wallet: cur ? JSON.parse(cur.blob) : null }, headers: { ...NO_STORE } };
  }
  await deps.orgs.appendLog(orgId, "wallet", w.blobSha256, now);
  return ok({ ok: true, version: blob.version }, { ...NO_STORE });
}

// ── spending ───────────────────────────────────────────────────────────

export type OrgSpendCheck =
  | { ok: true; org: OrgRecord; terms: OrgPlanTerms; liveSeats: number }
  | { ok: false; status: number; code: string; extra?: Record<string, unknown> };

/** Before any voucher is spent: the org exists, the seat count is allowed, and the spend would not run too far ahead. */
export async function checkOrgSpend(deps: OrgDeps, orgId: string, what: "business" | "overage", seats: unknown, now: number): Promise<OrgSpendCheck> {
  const cfg = configOf(deps);
  if (!ORG_ID.test(orgId)) return { ok: false, status: 400, code: "malformed" };
  const v = await loadOrg(deps, orgId, now).catch(() => null);
  if (!v) return { ok: false, status: 404, code: "org-not-found" };
  const terms = orgTermsOf(cfg, v.org);
  const liveSeats = orgLiveSeats(v.book);
  if (what === "overage") {
    if (orgPlanState(cfg, terms, now).status === "lapsed") return { ok: false, status: 409, code: "overage-needs-plan" };
    return { ok: true, org: v.org, terms, liveSeats };
  }
  if (!isOrgSeatCount(cfg, seats)) return { ok: false, status: 400, code: "org-seats", extra: { min: cfg.business.minSeats, max: cfg.business.maxSeats } };
  if (seats < liveSeats) return { ok: false, status: 409, code: "org-seats-below-live", extra: { liveSeats } };
  if (orgPaidUntilAfterSpend(cfg, terms, seats, 0, now) - now > cfg.maxAheadDays * DAY_MS) {
    return { ok: false, status: 409, code: "plan-paid-ahead", extra: { paidUntil: terms.paidUntil } };
  }
  return { ok: true, org: v.org, terms, liveSeats };
}

/** Credit `n` fresh vouchers to the org's seats (compare-and-set on the paid end; retried when two spends race). */
export async function creditOrgSeats(deps: OrgDeps, orgId: string, seats: number, n: number, now: number): Promise<OrgPlanState | null> {
  const cfg = configOf(deps);
  for (let attempt = 0; attempt < 5; attempt++) {
    const org = await deps.orgs.getOrg(orgId);
    if (!org) return null;
    const terms = orgTermsOf(cfg, org);
    const paidUntil = orgPaidUntilAfterSpend(cfg, terms, seats, n, now);
    const plan = { planTier: "business", seatLimit: org.seatLimit, paidUntil, paidSeats: seats, ...(org.trialEndsAt == null ? { trialEndsAt: terms.trialEndsAt } : {}) };
    if (await deps.orgs.setPlanIf(orgId, plan, org.paidUntil ?? null)) {
      await deps.orgs.appendLog(orgId, "plan-spend", "0".repeat(64), now);
      return orgPlanState(cfg, { ...terms, paidSeats: seats, paidUntil }, now);
    }
  }
  return null;
}

/** MeterDeps.orgEgressBytes for `.com`: an org name's pooled Business egress while it is on trial or paid. */
export function orgEgressBytesFor(orgs: Pick<OrgStorage, "getOrgByName">, cfg: PaymentsConfig): (account: string, nowMs: number) => Promise<number | null> {
  return async (account, nowMs) => {
    const org = await orgs.getOrgByName(account.toLowerCase());
    if (!org) return null;
    const gb = orgEgressGb(cfg, orgPlanOf(cfg, org, nowMs));
    return gb === null ? null : gb * 1024 ** 3;
  };
}
