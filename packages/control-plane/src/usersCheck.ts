// POST /api/users/check
//
// Wire shape:
//   request:  { username: string }
//   response: {
//     username: string,
//     available: boolean,
//     reason?: string,                        // present when available=false
//     testAccount?: { display: string, ttlHours: number },
//   }
//
// The handler folds three checks:
//   1. Label rules (RFC 1035 + reserved-username allowlist)
//   2. D1: is there already a claim for this username?
//   3. Test-account list (Worker secret) — if the typed username matches,
//      response carries the testAccount metadata so the mobile client
//      enters a sandboxed demo mode without provisioning real keys.
//      The list LIVES OFF-GIT (env.TEST_ACCOUNTS) so a curious user
//      can't discover an active sandbox by reading the repo.

import type { UsernameStorage } from "@flagship/storage";
import { validateUserLabel } from "./labels.js";
import { ok, malformed } from "./types.js";
import type { HandlerResponseWithHeaders } from "./types.js";

export interface TestAccountMeta {
  /** Human-readable name shown in the mobile UI's "Enter <X>" CTA. */
  display: string;
  /** Informational: how often the sandbox resets. Mobile only renders
   *  this in a tooltip; the actual reset cron lives on the Worker. */
  ttlHours: number;
}

export interface UsersCheckDeps {
  storage: UsernameStorage;
  /** JSON-decoded contents of env.TEST_ACCOUNTS, or null when no test
   *  accounts are configured. Keys are usernames (lowercased). */
  testAccounts?: Record<string, TestAccountMeta> | null;
}

export interface UsersCheckBody {
  username?: unknown;
}

export interface UsersCheckResponse {
  username: string;
  available: boolean;
  reason?: string;
  testAccount?: TestAccountMeta;
}

export async function handleUsersCheck(
  deps: UsersCheckDeps,
  body: UsersCheckBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body || typeof body.username !== "string") {
    return malformed("malformed body");
  }
  const norm = body.username.toLowerCase();

  // 1. Label rules first (rejects "" / non-ASCII / reserved labels)
  const labelCheck = validateUserLabel(norm);
  if (!labelCheck.ok) {
    return ok<UsersCheckResponse>({
      username: norm,
      available: false,
      reason: labelCheck.reason,
    });
  }

  // 2. Test-account secret list. Match-by-key (no enumeration leak —
  //    we never expose the full list, only the configured behavior
  //    for the specific username the caller asked about).
  const testHit = deps.testAccounts?.[norm];
  if (testHit) {
    return ok<UsersCheckResponse>({
      username: norm,
      // We deliberately return available=false so any caller that
      // wasn't expecting a test-account hit can't accidentally claim
      // the slot. Mobile clients branch on testAccount being non-null
      // BEFORE looking at available.
      available: false,
      reason: "test account",
      testAccount: { display: testHit.display, ttlHours: testHit.ttlHours },
    });
  }

  // 3. Real claim lookup.
  const existing = await deps.storage.getUsername(norm);
  if (existing) {
    return ok<UsersCheckResponse>({
      username: norm,
      available: false,
      reason: "already claimed",
    });
  }

  return ok<UsersCheckResponse>({
    username: norm,
    available: true,
  });
}

/**
 * Parse the env.TEST_ACCOUNTS secret. Returns null on missing/invalid
 * input so the handler degrades to "no test accounts configured"
 * instead of returning 500s when a deploy ships without the secret.
 */
export function parseTestAccountsEnv(
  raw: unknown,
): Record<string, TestAccountMeta> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const out: Record<string, TestAccountMeta> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    if (typeof m.display !== "string") continue;
    const ttl = typeof m.ttlHours === "number" && m.ttlHours > 0 ? m.ttlHours : 24;
    out[k.toLowerCase()] = { display: m.display, ttlHours: ttl };
  }
  return Object.keys(out).length === 0 ? null : out;
}
