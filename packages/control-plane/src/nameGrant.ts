// Name grants: the owner sets one name aside for a friend (owner decision 2026-11-23; runbook in
// docs/naming-recovery-and-name-change.md "Giving a friend a name").
//
//   POST /api/admin/name-grant   ADMIN (x-admin-secret)   {name, free?, hours?} → {name, code, expiresAt, free}
//
// `scripts/name-grant.mjs` calls it and prints an app link carrying `n=<name>&g=<code>&e=<expiresAt>` in its
// fragment. The rename (nameChange.ts) takes the grant as `nameGrant: {code, expiresAt}`: it lifts ONLY the dibs
// hold on that one name (every other rule stays: taken, reserved, look-alikes, the registry) and, for a `free`
// grant, also pays for the rename.
//
// Stored as a row of the existing vouchers table (no migration): kind `name-grant` or `name-grant-paid`, and the
// name and the end time are bound inside the hashed code (`flagship/name-grant/v1|name|expiresAt|CODE`), so the
// grant is useless for any other name and can't be stretched. A rename takes it atomically (marked redeemed with no
// account name), puts it back if the rename fails, and deletes the row when it succeeds: nothing left in `.com`
// marks the account afterwards, and the audit line is the same as any rename's.

import { voiciNameProblem } from "@flagship/protocol";
import type { VoucherStorage } from "@flagship/storage";
import { validateUserLabel } from "./labels.js";
import { mintVoucherCode, normalizeVoucherCode } from "./voucher.js";

export const NAME_GRANT_TAG = "flagship/name-grant/v1";
export const NAME_GRANT_DEFAULT_HOURS = 72;
export const NAME_GRANT_MAX_HOURS = 30 * 24;

export interface NameGrantDeps {
  vouchers: VoucherStorage;
  now?: () => number;
}

export interface NameGrantPresented {
  code: string;
  expiresAt: number;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The row key: the name and the end time are inside it, so a grant opens nothing else. */
export function nameGrantHash(name: string, expiresAt: number, code: string): Promise<string> {
  return sha256Hex(`${NAME_GRANT_TAG}|${name.toLowerCase()}|${expiresAt}|${normalizeVoucherCode(code)}`);
}

/** `POST /api/admin/name-grant` (admin): mint one grant. The code is returned once; only its hash is kept. */
export async function handleIssueNameGrant(deps: NameGrantDeps, body: unknown): Promise<{ status: number; body: unknown }> {
  const b = (body ?? {}) as { name?: unknown; free?: unknown; hours?: unknown };
  if (typeof b.name !== "string") return { status: 400, body: { error: "name is required" } };
  const name = b.name.trim().toLowerCase();
  const problem = voiciNameProblem(name);
  if (problem) return { status: 400, body: { error: `not a valid account name (${problem})` } };
  const label = validateUserLabel(name);
  if (!label.ok) return { status: 400, body: { error: label.reason } };
  const hours = b.hours === undefined ? NAME_GRANT_DEFAULT_HOURS : Number(b.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > NAME_GRANT_MAX_HOURS) {
    return { status: 400, body: { error: `hours must be a whole number 1..${NAME_GRANT_MAX_HOURS}` } };
  }
  const free = b.free === true;
  const now = (deps.now ?? Date.now)();
  const expiresAt = now + hours * 3_600_000;
  const code = mintVoucherCode();
  const r = await deps.vouchers.create({
    codeHash: await nameGrantHash(name, expiresAt, code),
    kind: free ? "name-grant-paid" : "name-grant",
    tier: "free",
    durationDays: 0,
    createdAt: now,
  });
  if (!r.ok) return { status: 409, body: { error: r.reason } };
  return { status: 200, body: { ok: true, name, code, expiresAt, free } };
}

export type NameGrantCheck =
  | { ok: true; codeHash: string; paid: boolean }
  | { ok: false; status: number; reason: string; code: string };

/** Is `g` an unused, unexpired grant for exactly `name`? Takes nothing. */
export async function checkNameGrant(deps: NameGrantDeps, name: string, g: unknown): Promise<NameGrantCheck> {
  const p = g as Partial<NameGrantPresented> | null;
  const invalid = { ok: false as const, status: 402, reason: "this link isn't for this name", code: "grant-invalid" };
  if (!p || typeof p.code !== "string" || !p.code.trim() || typeof p.expiresAt !== "number" || !Number.isSafeInteger(p.expiresAt)) {
    return invalid;
  }
  if ((deps.now ?? Date.now)() >= p.expiresAt) return { ok: false, status: 402, reason: "this link has expired", code: "grant-expired" };
  const codeHash = await nameGrantHash(name, p.expiresAt, p.code);
  const row = await deps.vouchers.get(codeHash);
  if (!row || (row.kind !== "name-grant" && row.kind !== "name-grant-paid")) return invalid;
  if (row.redeemedAt !== undefined) return { ok: false, status: 402, reason: "this link was already used", code: "grant-used" };
  return { ok: true, codeHash, paid: row.kind === "name-grant-paid" };
}

/** Take the grant for one rename (atomic: of two racing renames one wins). Marked with no account name. */
export async function takeNameGrant(deps: NameGrantDeps, codeHash: string): Promise<boolean> {
  return deps.vouchers.redeem(codeHash, "", (deps.now ?? Date.now)());
}

/** The rename failed: the grant works again. */
export async function returnNameGrant(deps: NameGrantDeps, codeHash: string): Promise<void> {
  await deps.vouchers.release(codeHash, "");
}

/** The rename happened: the row goes, so nothing marks the account. */
export async function spendNameGrant(deps: NameGrantDeps, codeHash: string): Promise<void> {
  await deps.vouchers.delete(codeHash);
}
