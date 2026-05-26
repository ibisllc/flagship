/**
 * P6 daemon BFF — collaborator-invite endpoints.
 *
 * Thin projection layer over `AppInviteStore` (defined in
 * `../inviteHandler.ts`). The handlers in `screensHttp.ts` translate the
 * webapp-facing wire shapes (`AppInviteIssueRequest`, ...) into store
 * operations + project the store's row shapes back into the response
 * shapes the webapp reads in `invite-issue.js` + `invite-manage.js`.
 *
 * What the daemon NEVER sees here:
 *  - The local label book (displayName, channel, sent-to memo, notes).
 *    That data is held client-side and resolved via `opaqueTag` →
 *    label only on the device that issued the invite.
 *  - The bearer secret AFTER it's been minted — we return it once on
 *    issue() and the issuer relays it out-of-band. The store keeps
 *    only its SHA-256.
 *
 * What the daemon DOES see:
 *  - `opaqueTag` (16 random bytes, client-issued; the only routing
 *    key) and `irkPubHex` (the redeemer's Ed25519 pubkey, after they
 *    redeem). Plus the issuer's role + optional contextNote.
 *
 * Production wiring: the daemon entry should pass its existing
 * `InMemoryAppInviteStore` (the same store that backs
 * `buildInviteHandler`) so the issue/redeem path written through one
 * surface is visible to reads on the other. When a SQLite-backed
 * sibling store is added later (see ShardRegistry pattern), the BFF
 * picks it up automatically — the contract is the `AppInviteStore`
 * interface.
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  AppInviteRow,
  AppInviteStore,
  AppAccessRow,
} from "../inviteHandler.js";
import type {
  AppInviteAccessSummary,
  AppInvitePendingSummary,
} from "./types.js";

export interface AppInviteBffDeps {
  /**
   * The daemon's existing `AppInviteStore` instance. Required; the BFF
   * 503s when null. The production daemon shares the same store with
   * `buildInviteHandler` so issuance via the signed surface (PSK
   * envelope on `/.flagship/app/<id>/invite`) and issuance via this
   * BFF land in the same place.
   */
  store: AppInviteStore | null;
  /** Pod's canonical FQDN — embedded in the row for symmetry with the signed surface. */
  serverFqdn: string;
  /** Default TTL when the BFF issues without a caller-supplied ttlMs. Default 24h. */
  defaultInviteTtlMs?: number;
  /** Hard cap on TTL. Default 72h (matches buildInviteHandler.maxInviteTtlMs). */
  maxInviteTtlMs?: number;
  /** Test seam. */
  now?: () => number;
  /** Test seam. */
  randomBytes?: (n: number) => Uint8Array;
}

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_TTL_MS = 72 * 60 * 60_000;

/**
 * Parse + validate an `AppInviteIssueRequest` body and emit a new
 * pending invite. Returns the secret + expiresAt the webapp surfaces in
 * `invite-issue.js`'s "Shareable link" panel.
 *
 * Why we don't reuse `issueInvite` from `inviteHandler.ts`: that handler
 * insists on a PSK-signed envelope (the phone-driven surface). The BFF
 * authenticates the caller via the paired-session gate in
 * `screensHttp.ts` — in the webapp world the session token IS the PSK
 * equivalent (mirrors the lineage-resolve + peer-backup-toggle design).
 * We still write through the same `AppInviteStore`, so reads from both
 * surfaces stay consistent.
 */
export interface IssueArgs {
  serviceId: string;
  role: string;
  opaqueTag: Uint8Array;
  contextNote: string | null;
  ttlMs?: number;
}

export interface IssueResult {
  inviteId: string;
  secret: string;
  expiresAt: number;
}

export async function issueAppInvite(
  deps: AppInviteBffDeps & { store: AppInviteStore },
  args: IssueArgs,
): Promise<IssueResult> {
  const now = deps.now ?? (() => Date.now());
  const rand = deps.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const defaultTtl = deps.defaultInviteTtlMs ?? DEFAULT_TTL_MS;
  const maxTtl = deps.maxInviteTtlMs ?? DEFAULT_MAX_TTL_MS;
  const ttlMs = clampTtl(args.ttlMs ?? defaultTtl, maxTtl);

  const secret = rand(32);
  const secretHash = sha256Hex(secret);
  const inviteId = bytesToHex(rand(16));
  const issuedAt = now();
  const expiresAt = issuedAt + ttlMs;

  const row: AppInviteRow = {
    inviteId,
    serviceId: args.serviceId,
    secretHash,
    role: args.role,
    opaqueTag: args.opaqueTag,
    // BFF issuance is bearer-only — the phone hasn't yet collected the
    // recipient's IRK at this point. The signed `/.flagship/app/<id>/invite`
    // surface remains the path for IRK-prebound invites.
    expectedIrkPubKey: null,
    contextNote: args.contextNote,
    issuedAt,
    expiresAt,
    status: "pending",
  };
  await deps.store.insertInvite(row);

  return { inviteId, secret: bytesToHex(secret), expiresAt };
}

/**
 * Project pending invite rows into the webapp's wire shape, dropping
 * expired rows. Sorted issuedAt-DESC so newest-first.
 */
export function projectPendingInvites(
  rows: AppInviteRow[],
  nowMs: number,
): AppInvitePendingSummary[] {
  const out: AppInvitePendingSummary[] = [];
  for (const r of rows) {
    if (r.status !== "pending") continue;
    if (r.expiresAt <= nowMs) continue;
    out.push({
      opaqueTag: bytesToHex(r.opaqueTag),
      inviteId: r.inviteId,
      role: r.role,
      expiresAt: r.expiresAt,
    });
  }
  out.sort((a, b) => b.expiresAt - a.expiresAt);
  return out;
}

/**
 * Project active access rows. The store's `listActiveAccess` already
 * filters revoked rows; this is purely a wire-shape adapter.
 */
export function projectAccessRows(
  rows: AppAccessRow[],
): AppInviteAccessSummary[] {
  const out: AppInviteAccessSummary[] = rows.map((r) => ({
    opaqueTag: bytesToHex(r.opaqueTag),
    irkPubHex: r.irkPubHex,
    role: r.role,
    grantedAt: r.grantedAt,
  }));
  out.sort((a, b) => b.grantedAt - a.grantedAt);
  return out;
}

function clampTtl(ttlMs: number, maxTtlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs < 60_000) return 60_000;
  if (ttlMs > maxTtlMs) return maxTtlMs;
  return ttlMs;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}
