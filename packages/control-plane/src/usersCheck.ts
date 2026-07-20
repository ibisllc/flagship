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

import type {
  UsernameStorage,
  DemoUsersStorage,
  DeviceCapabilityGrantStorage,
} from "@flagship/storage";
import {
  signDemoDirective,
  verifyCaSignedDemoDirective,
  type DemoDirective,
  type DeviceScope,
} from "@flagship/protocol";
import { validateUserLabel } from "./labels.js";
import { ok, malformed, notFound } from "./types.js";
import type { HandlerResponseWithHeaders } from "./types.js";
import { type CaIssuer, type CaGate, evaluateCaGate } from "./pubkeyCert.js";
import { bytesToHex } from "./hex.js";
import { demoServerBlockFromRow, type DemoServerBlock } from "./demoUsers.js";

// Hyphen-free, same charset AND length as real usernames (validateUserLabel =
// [a-z0-9]{3,30}), so a demo name can never break the `<creator>-<slug>` app-id
// split or be rejected by the endpoints that enforce that rule.
const DEMO_USERNAME_RE = /^[a-z0-9]{3,30}$/;
const DEVICE_LABEL_RE = /^[a-z0-9-]{1,24}$/;

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
  /** Plan A — sample-user / on-connect Hetzner provisioning. When
   *  wired AND the typed username has a matching demo_users row,
   *  the response embeds a `demoServer` block (the fqdn + lifecycle
   *  state) so mobile clients can render one real device and decide
   *  whether to call /api/dev/sample-user/{u}/connect. Absent ⇒
   *  legacy behavior unchanged. See docs/sample-users.md §10.9. */
  demoUsers?: DemoUsersStorage;
  /** v2 device-addressing — the `<u>.<device-label>` syntax embeds
   *  the per-device DeviceCapabilityGrant in the response. OPTIONAL so
   *  existing callers (without the v2 grant storage wired) keep
   *  compiling + degrade to legacy behavior. See
   *  docs/v2-device-addressing-and-real-ticket.md §5.1. */
  deviceCapabilityGrants?: DeviceCapabilityGrantStorage;
}

export interface UsersCheckBody {
  username?: unknown;
}

export interface UsersCheckResponse {
  username: string;
  available: boolean;
  reason?: string;
  testAccount?: TestAccountMeta;
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
  /** v2 device-addressing — present when the typed username matched
   *  the `<u>.<device-label>` syntax AND a matching active grant
   *  exists. The mobile client treats this as a strong declaration
   *  of "you are a restricted device under this user"; the UI greys
   *  out actions absent from `scopes`. */
  deviceCapability?: {
    label: string;
    devicePubKey: string;
    scopes: DeviceScope[];
    grantId: string;
    expiresAt: number;
    signature: string;
  };
}

export async function handleUsersCheck(
  deps: UsersCheckDeps,
  body: UsersCheckBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body || typeof body.username !== "string") {
    return malformed("malformed body");
  }
  const norm = body.username.toLowerCase();

  // 0. v2 device-addressing: `<u>.<device-label>` syntax. The dot is
  //    a client-side separator the Worker resolves into the
  //    `device_capability_grants` table — it never appears in a real
  //    TLS hostname. Resolves only when (a) we have grants storage
  //    wired, (b) the username part is a demo username with a row,
  //    and (c) an active grant exists for the (user, label) pair.
  //    Any of those failing → 404 with a structured reason so the
  //    mobile UI can surface the typo with the device-label suffix
  //    visible. See docs/v2-device-addressing-and-real-ticket.md §5.1.
  if (norm.includes(".") && deps.deviceCapabilityGrants && deps.demoUsers) {
    const dot = norm.indexOf(".");
    const userPart = norm.slice(0, dot);
    const labelPart = norm.slice(dot + 1);
    const userPartOk = DEMO_USERNAME_RE.test(userPart);
    const labelPartOk =
      DEVICE_LABEL_RE.test(labelPart) &&
      !labelPart.startsWith("-") &&
      !labelPart.endsWith("-");
    if (!userPartOk || !labelPartOk) {
      return notFound("unknown demo device label");
    }
    const demoRow = await deps.demoUsers.get(userPart);
    if (!demoRow) {
      return notFound("unknown demo device label");
    }
    const grant = await deps.deviceCapabilityGrants.getActiveForUserLabel(
      userPart,
      labelPart,
    );
    if (!grant) {
      return notFound("unknown demo device label");
    }
    let scopes: DeviceScope[] = [];
    try {
      const parsed = JSON.parse(grant.scopesJson);
      if (Array.isArray(parsed)) scopes = parsed as DeviceScope[];
    } catch {
      // A corrupted scopes_json blob is operationally equivalent to a
      // missing grant from the client's perspective — same 404 path.
      return notFound("unknown demo device label");
    }
    return ok<UsersCheckResponse>({
      username: norm,
      available: false,
      reason: "device capability",
      demoServer: demoServerBlockFromRow(demoRow),
      deviceCapability: {
        label: grant.deviceLabel,
        devicePubKey: grant.devicePubHex,
        scopes,
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
        signature: grant.signatureHex,
      },
    });
  }

  // 1a. Demo-user / test-account lookups run BEFORE the validateUserLabel
  //     guard so a registered demo/test account is recognized as such
  //     regardless of the real-account label rules (e.g. a legacy reserved
  //     name). New demo usernames use the canonical real-account grammar.
  //
  //     Strict matching here: the demoUsers/testAccounts hit MUST
  //     be a literal-string lookup against the supplied username
  //     (already lowercased into `norm`). No reformatting; if the
  //     lookup hits we trust it and short-circuit. If it misses we
  //     fall through to the canonical validateUserLabel path, which
  //     handles every real account uniformly.

  let demoServer: DemoServerBlock | undefined;
  if (deps.demoUsers) {
    const row = await deps.demoUsers.get(norm);
    if (row) {
      demoServer = demoServerBlockFromRow(row);
    }
  }

  const testHit = deps.testAccounts?.[norm];
  if (demoServer || testHit) {
    // Demo / test account path. We return BEFORE validateUserLabel so
    // hyphenated demo usernames work end-to-end.
    return ok<UsersCheckResponse>({
      username: norm,
      available: false,
      reason: testHit ? "test account" : "demo account",
      ...(testHit ? { testAccount: { display: testHit.display, ttlHours: testHit.ttlHours } } : {}),
      demoServer,
    });
  }

  // 1b. Now the standard label check (rejects malformed / reserved labels).
  //     Demo accounts already escaped above.
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
