// POST /api/users/check
//
// Wire shape:
//   request:  { username: string }
//   response: {
//     username: string,
//     available: boolean,
//     reason?: string,                        // present when available=false
//   }
//
// The handler folds two checks:
//   1. Label rules (RFC 1035 + reserved-username allowlist)
//   2. D1: is there already a claim for this username?
// Public username checks never return private account or device metadata.

import type { UsernameStorage, DemoUsersStorage } from "@flagship/storage";
import {
  signDemoDirective,
  verifyCaSignedDemoDirective,
  type DemoDirective,
} from "@flagship/protocol";
import { validateUserLabel } from "./labels.js";
import { ok, malformed } from "./types.js";
import type { HandlerResponseWithHeaders } from "./types.js";
import { type CaIssuer, type CaGate, evaluateCaGate } from "./pubkeyCert.js";
import { bytesToHex } from "./hex.js";
import { demoServerBlockFromRow, type DemoServerBlock } from "./demoUsers.js";

export interface UsersCheckDeps {
  storage: UsernameStorage;
  /** Platform CA keypair. When present, an `is_demo` claim's check
   *  response carries a CA-signed demo directive (#84). Absent in the
   *  legacy Fastify path → demo accounts simply behave as normal
   *  claims there (no directive minted). */
  ca?: CaIssuer;
  /** #30 maintainer→CA gate over the minted demo directive. Same
   *  deploy-safe semantics as PubkeyCertDeps.caGate: absent ⇒ legacy
   *  (no gate); present + enforce=false ⇒ OBSERVE (log, sign as
   *  today); enforce=true ⇒ refuse when unauthorized. */
  caGate?: CaGate;
  /** Override for tests. */
  now?: () => number;
  /** Directive validity window. Default 7 days (matches the pubkey
   *  binding); the client re-fetches on every check anyway. */
  demoDirectiveTtlMs?: number;
  /** Demo provisioning status for a durably issued demo identity. */
  demoUsers?: DemoUsersStorage;
}

export interface UsersCheckBody {
  username?: unknown;
}

export interface UsersCheckResponse {
  username: string;
  available: boolean;
  reason?: string;
  /** Present only for an `is_demo` claim when a CA keypair is wired.
   *  The client verifies `signature` over the canonical
   *  flagship/demo-directive/v1 bytes with the published CA pubkey
   *  before honoring `directive.useMockRecovery`. */
  demoDirective?: { directive: DemoDirective; signature: string };
  /** Plan A — present when the typed username matches a `demo_users`
   *  row. Carries the FQDN + current server-lifecycle state so
   *  mobile clients render one real device. See
   *  docs/sample-users.md §10.9. */
  demoServer?: DemoServerBlock;
}

export async function handleUsersCheck(
  deps: UsersCheckDeps,
  body: UsersCheckBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body || typeof body.username !== "string") {
    return malformed("malformed body");
  }
  const norm = body.username.toLowerCase();

  // Demo rows are checked before the normal label guard because their
  // public usernames follow the separate demo username validator.

  let demoServer: DemoServerBlock | undefined;
  if (deps.demoUsers) {
    const row = await deps.demoUsers.get(norm);
    if (row && (row.state === "initializing" || row.state === "cleanup-only")) {
      return ok<UsersCheckResponse>({ username: norm, available: false, reason: "unavailable" });
    }
    if (row) {
      demoServer = demoServerBlockFromRow(row);
    }
  }

  if (demoServer) {
    return ok<UsersCheckResponse>({
      username: norm,
      available: false,
      reason: "demo account",
      demoServer,
    });
  }

  // Standard label check. Demo accounts already returned above.
  const labelCheck = validateUserLabel(norm);
  if (!labelCheck.ok) {
    return ok<UsersCheckResponse>({
      username: norm,
      available: false,
      reason: labelCheck.reason,
    });
  }

  // Real claim lookup. A demo account is a real claim — it still
  //    reports "already claimed" — but when the CA key is wired it
  //    additionally carries a signed directive telling the client to
  //    run recovery through the Mock (#84). Signed server-side so a
  //    client can't self-elect; time-boxed against replay.
  const existing = await deps.storage.get(norm);
  if (existing) {
    const resp: UsersCheckResponse = {
      username: norm,
      available: false,
      reason: "already claimed",
      demoServer,
    };
    if (existing.isDemo && deps.ca) {
      const now = (deps.now ?? (() => Date.now()))();
      const ttlMs = deps.demoDirectiveTtlMs ?? 7 * 24 * 60 * 60_000;
      const directive: DemoDirective = {
        version: 1,
        username: norm,
        useMockRecovery: true,
        issuedAt: now,
        expiresAt: now + ttlMs,
        issuer: deps.ca.issuer,
      };
      const sig = signDemoDirective(directive, deps.ca.keypair);
      // #30 chokepoint over the signed directive. OBSERVE (default)
      // logs + attaches the directive exactly as today; ENFORCE +
      // unauthorized refuses to attach a CA-signed directive (the
      // claim-lookup response itself is unchanged — no directive).
      const gateResp = evaluateCaGate(
        deps.caGate,
        "DemoDirective",
        norm,
        now,
        () =>
          verifyCaSignedDemoDirective(
            directive,
            sig,
            deps.caGate!.caTrustChain,
            now,
          ),
      );
      if (!gateResp) {
        resp.demoDirective = { directive, signature: bytesToHex(sig) };
      }
    }
    return ok<UsersCheckResponse>(resp);
  }

  return ok<UsersCheckResponse>({
    username: norm,
    available: true,
    demoServer,
  });
}
