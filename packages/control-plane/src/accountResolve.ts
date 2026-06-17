// GET /api/account/resolve/<username>
//
// The login/join preflight. The sign-in space is access-control
// evaluation, not a fetch: this endpoint reads what credentials and
// factors exist for a named account and returns them as FIELDS so the
// client login state machine can branch. It returns **200 always** —
// a missing account is `kind:"unknown"`, never a 404 — because a raw
// HTTP error in the login path is a category mistake.
//
// See docs/login-and-account-redesign.md.

import type {
  UsernameStorage,
  WebauthnRecoveryStorage,
  DemoUsersStorage,
  PushTokenStorage,
} from "@flagship/storage";
import { validateUserLabel } from "./labels.js";
import { ok, type HandlerResponseWithHeaders } from "./types.js";
import { demoServerBlockFromRow, type DemoServerBlock } from "./demoUsers.js";

export type AccountKind = "demo" | "single" | "multi" | "unknown";

/** Server-derived recovery-speed hint so every client renders identical
 *  copy without re-deriving the account-type matrix. `"3d"` is the
 *  single-device grace (shrank from 7d → 3d; see RE_PAIR_SINGLE_GRACE_MS).
 *  The authoritative deadline is always the server's `completesAt` — this
 *  is a copy hint only. */
export type GraceModel = "instant" | "3d" | "24h-totp" | "none";

export interface AccountResolution {
  /** Normalized handle the lookup ran against. */
  username: string;
  exists: boolean;
  kind: AccountKind;
  recovery: { present: boolean; hasFetchGate: boolean; credentialId?: string };
  totpEnrolled: boolean;
  trustedDeviceCount: number;
  /** Present only for demo accounts. */
  demoServer?: DemoServerBlock;
  graceModel: GraceModel;
}

export interface AccountResolveDeps {
  usernames: UsernameStorage;
  webauthnRecovery: WebauthnRecoveryStorage;
  demoUsers: DemoUsersStorage;
  pushTokens: PushTokenStorage;
}

const unknown = (username: string): AccountResolution => ({
  username,
  exists: false,
  kind: "unknown",
  recovery: { present: false, hasFetchGate: false },
  totpEnrolled: false,
  trustedDeviceCount: 0,
  graceModel: "none",
});

export async function handleAccountResolve(
  deps: AccountResolveDeps,
  rawUsername: string,
): Promise<HandlerResponseWithHeaders> {
  const norm = rawUsername.toLowerCase();

  // Demo accounts live in their own table and legitimately carry
  // hyphens, so they're matched by literal lookup BEFORE the hyphen-free
  // real-username label check (mirrors usersCheck.ts). Demo crypto is a
  // no-op — knowing the name is the capability — so the client skips
  // every credential gate and just attaches a device.
  const demoRow = await deps.demoUsers.get(norm);
  if (demoRow) {
    return ok<AccountResolution>({
      username: norm,
      exists: true,
      kind: "demo",
      recovery: { present: false, hasFetchGate: false },
      totpEnrolled: false,
      trustedDeviceCount: 0,
      demoServer: demoServerBlockFromRow(demoRow),
      graceModel: "instant",
    });
  }

  // The login field is a bare username (no dots / hyphens / specials).
  // Anything that fails the label rules is reported as a clean
  // `unknown` STATE so the client renders guidance, not an HTTP error.
  if (!validateUserLabel(norm).ok) {
    return ok<AccountResolution>(unknown(norm));
  }

  const user = await deps.usernames.get(norm);
  if (!user) {
    return ok<AccountResolution>(unknown(norm));
  }

  // `multi ⇒ 2FA` is enforced at enrollment; here we just project the
  // stored account_type. A row with anything other than 'multi'
  // (including the legacy/absent default) resolves to single.
  const kind: AccountKind = user.accountType === "multi" ? "multi" : "single";
  const rec = await deps.webauthnRecovery.get(norm);
  const tokens = await deps.pushTokens.listByUser(norm);

  return ok<AccountResolution>({
    username: norm,
    exists: true,
    kind,
    recovery: rec
      ? {
          present: true,
          hasFetchGate: !!rec.fetchTokenHashHex,
          credentialId: rec.credentialIdHex,
        }
      : { present: false, hasFetchGate: false },
    totpEnrolled: !!user.totpEnrolledAt,
    trustedDeviceCount: tokens.length,
    graceModel: kind === "multi" ? "24h-totp" : "3d",
  });
}
