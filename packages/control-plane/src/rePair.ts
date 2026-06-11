import {
  verifyDeviceCapabilityGrant,
  verifyRePairInitiate,
  verifyRePairObject,
  type DeviceCapabilityGrant,
  type DeviceScope,
  type RePairInitiate,
  type RePairObject,
  DEVICE_SCOPES,
} from "@flagship/protocol";
import type {
  AuditEventStorage,
  DeviceCapabilityGrantRecord,
  DeviceCapabilityGrantStorage,
  PendingRePairStorage,
  PushTokenStorage,
  UsernameStorage,
} from "@flagship/storage";
import { recordAuditEvent } from "./auditEvents.js";
import { hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";
import { computeDevicesEtag } from "./usersDevices.js";
import {
  consumeRecoveryCode,
  fireFailedRateAlertIfDue,
  peekVerifyAttempts,
  recordVerifyAttempt,
  validateTotpCode,
  type V12PushFanout,
} from "./totp.js";
import { ALERT_BIT_T0 } from "./rePairAlerts.js";

/**
 * Recovery re-pair endpoints (J.3).
 *
 * Three-step protocol:
 *   1. POST /api/users/:username/re-pair          (NEW IRK signed)
 *      Records a pending row with completes_at = now + grace.
 *   2. POST /api/users/:username/re-pair/object   (OLD IRK signed)
 *      Marks the row objected; no swap will happen.
 *   3. POST /api/users/:username/re-pair/complete (NEW IRK signed)
 *      Atomically swaps the username's IRK pubkey iff:
 *        - completes_at <= now < completes_at + RE_PAIR_COMPLETE_WINDOW_MS
 *        - objected_at IS NULL
 *
 * The 24h grace lets a user whose old device is still online cancel
 * an unauthorized takeover. Membership re-attach (J.4) is a daemon-
 * side concern and lives outside this handler — it walks installed
 * apps after a swap and emits per-app phone alerts for review.
 *
 * **Concurrency guarantees (SQL CAS at every mutation):**
 *
 *   - `pending_re_pairs` has `username` as PRIMARY KEY, so two
 *     concurrent INITIATEs race-safely — one row wins, the other
 *     returns 409 ("re-pair already pending").
 *   - `usernames.swapIrkPub(...)` is a conditional UPDATE that
 *     matches on `(username, current irk_pub_hex)` and returns
 *     `meta.changes > 0`. Two concurrent COMPLETEs both call this;
 *     only one matches the precondition. The loser sees the row
 *     already moved, returns 409, and tidies up the pending row.
 *   - The Replace-device UI flow on the client also passes the
 *     observed devices ETag as `If-Match`, so any client whose
 *     view of the device list is stale gets a 412 from the next
 *     commit (A3) before even reaching the rotation. Belt + braces.
 */

/**
 * v1.1 baseline grace — kept exported so existing callers + tests
 * still reference a single canonical multi-device value. Phase 2 of
 * the v1.2 cascade lets `handleInitiateRePair` widen this to
 * `RE_PAIR_SINGLE_GRACE_MS` (7 days) when the target account is
 * single-device. The multi-device path stays at 24h on purpose:
 * a TOTP proof is required before the grace even starts, so a
 * shorter waiting period is the right trade-off for that mode.
 */
export const RE_PAIR_GRACE_MS = 24 * 60 * 60_000;

/** Recovery Phase B — 3-day grace for single-device accounts. The earlier
 * 7-day window was wide enough to never miss an objection, but it also meant a
 * legitimately-recovering owner waited a week to take their account back. 3
 * days keeps a real objection window while making same-week recovery viable.
 * See docs/session-handoff-2026-06-02.md §4 + docs/v1.2-security-cascade.md
 * §"Re-pair J.3 grace extension". */
export const RE_PAIR_SINGLE_GRACE_MS = 3 * 24 * 60 * 60_000;

/** #52 follow-up — upper bound on HOW LONG a pending row stays
 * completable after its grace elapses. `handleCompleteRePair` used to
 * accept `completesAt <= now` with NO ceiling, so a forgotten row from
 * old testing was completable FOREVER — which is exactly how a takeover
 * could appear to land "same-day": nothing had to wait out the grace,
 * something only had to find a months-old row whose grace had long
 * passed. A pending row is now completable only inside
 * `[completesAt, completesAt + RE_PAIR_COMPLETE_WINDOW_MS)`.
 *
 * 7 days: long enough that a legitimately-recovering owner who
 * initiated and then walked away (vacation, lost charger) can still
 * come back and finish, bounded so an abandoned dispute can't be
 * resurrected months later by whoever stumbles on the row. Outside the
 * window the row is DEAD: /complete 410s + sweeps it (audited), and a
 * fresh initiate sweeps it instead of 409ing. */
export const RE_PAIR_COMPLETE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** v1.2 — 14-day quarantine on a freshly-admitted device's revoke-
 *  others power. The legitimate owner's existing devices remain at
 *  quarantineUntil=0 and can revoke a quarantined device immediately;
 *  the new device cannot lock out other devices until this window
 *  has elapsed. See docs/v1.2-security-cascade.md §"14-day quarantine
 *  on revoke-others power". */
export const RE_PAIR_QUARANTINE_MS = 14 * 24 * 60 * 60_000;

export interface RePairDeps {
  usernames: UsernameStorage;
  pendingRePairs: PendingRePairStorage;
  /**
   * Optional dep. When wired AND the caller supplies an `ifMatch`
   * value to handleInitiateRePair, the handler validates that the
   * supplied ETag still matches the current devices list — closes
   * the "another device registered between fetch-list and submit-
   * rotate" race. Older callers without the dep degrade to the
   * existing un-fenced behavior.
   *
   * v1.2 Phase 2 — also used by the quarantine check when the body
   * carries a `callerTokenId`: the handler reads the row and rejects
   * with 403 if `quarantineUntil > now`. New devices admitted to a
   * multi-device account can't kick out other devices for 14 days.
   */
  pushTokens?: PushTokenStorage;
  /**
   * v1.2 Plan B Phase 5 — optional dep. When wired, audit emissions
   * fire on:
   *   - re-pair initiate (records the initiation as a snapshot of
   *     the account-type at the moment the recovery began),
   *   - recovery-code consumption (recovery-code-consumed),
   *   - re-pair completion (device-replaced + device-added, both
   *     carrying the quarantine-until snapshot).
   */
  auditEvents?: AuditEventStorage;
  /**
   * v1.2 Plan B Phase 5 — push fan-out callback. The Worker injects
   * a real APNs/FCM/Web Push fan-out via the existing pushBridge
   * forwarder; tests pass a recording stub. When wired:
   *   - the T+0 alert fires on a successful initiate,
   *   - the failed-TOTP-rate alert fires when the per-username
   *     verify counter crosses VERIFY_LIMIT in a 15-min window.
   * When unwired, the handler skips the fan-out (deploy-safe degrade
   * matching the rest of the v1.2 cascade).
   */
  pushFanout?: V12PushFanout;
  graceMs?: number;
  /**
   * v1.2 — explicit override for the single-device grace. Tests
   * inject a smaller value so the swap-after-grace assertion doesn't
   * have to wait 7 days. Production callers leave this unset and the
   * handler uses RE_PAIR_SINGLE_GRACE_MS.
   */
  singleDeviceGraceMs?: number;
  quarantineMs?: number;
  /**
   * #52 follow-up — test override for RE_PAIR_COMPLETE_WINDOW_MS so
   * the stale-row assertions don't have to fabricate week-spanning
   * clocks. Production callers leave this unset.
   */
  completeWindowMs?: number;
  maxAgeMs?: number;
  now?: () => number;
  /**
   * v1.2 Phase 3 — 32-byte hex Worker secret used to decrypt the
   * stored TOTP secret for real `RePairInitiate.totpProof`
   * verification on multi-device accounts. When ABSENT, the handler
   * falls back to the Phase 2 structural-only check (matches the
   * /totp/* endpoints which 503 without the KEK). Once a deployment
   * sets `FLAGSHIP_TOTP_KEK`, this path activates and the structural
   * fallback never fires.
   */
  totpKekHex?: string;
  /**
   * v2.1 (W6) — when wired, `handleCompleteRePair` honors the cloud's
   * `recovery_wipe_policy`:
   *   - `'strict'`   → every active DeviceCapabilityGrant for the
   *                    username gets `revoked_at = now` so family
   *                    devices must be re-onboarded by the new admin.
   *   - `'graceful'` → the /complete body MAY carry `refreshedGrants`
   *                    signed by the NEW IRK; each refreshed grant is
   *                    validated under the new IRK pub, must match an
   *                    existing active grant's `devicePubKey`, must
   *                    NOT inflate scopes, and is persisted as a fresh
   *                    row; the old grants get `revoked_at = now`
   *                    atomically after the new ones are in.
   *
   * When the dep is absent the handler falls through to the v1.2
   * behaviour (no grant accounting) — deploy-safe degrade matching
   * the rest of the cascade.
   */
  deviceCapabilityGrants?: DeviceCapabilityGrantStorage;
}

const DEFAULT_MAX_AGE = 5 * 60_000;

export async function handleInitiateRePair(
  deps: RePairDeps,
  username: string,
  body: unknown,
  /**
   * If-Match header value the client sent over the devices ETag it
   * had cached when it initiated. Optional for backwards-compat:
   *   - absent  → behaviour unchanged (old clients still work)
   *   - present → must match the current /api/users/:u/devices ETag,
   *               else 412 Precondition Failed.
   * Both the deps.pushTokens AND this param must be set for the
   * check to fire.
   */
  ifMatch?: string,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const multiGraceMs = deps.graceMs ?? RE_PAIR_GRACE_MS;
  const singleGraceMs = deps.singleDeviceGraceMs ?? RE_PAIR_SINGLE_GRACE_MS;
  const quarantineMs = deps.quarantineMs ?? RE_PAIR_QUARANTINE_MS;

  const b = body as {
    request?: Record<string, unknown>;
    signature?: unknown;
    /**
     * v1.2 Phase 2 — out-of-canonical-bytes proof for multi-device
     * recovery. Not part of the signed envelope (codes are
     * ephemeral). Phase 2 only checks structural presence;
     * Phase 3 replaces this with real `verifyTotp` + atomic
     * recovery-code redemption.
     */
    totpProof?: unknown;
    /**
     * v1.2 Phase 2 — when an existing device initiates the re-pair
     * (impersonation-attempt path) it sends its own push tokenId so
     * the Worker can reject if that device is itself quarantined.
     * Absent on the genuine "lost device → new device claims back"
     * J.3 path (the recovering device has no push_tokens row yet).
     */
    callerTokenId?: unknown;
  };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.newIrkPub !== "string" ||
    typeof r.oldIrkPub !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return { status: 403, body: { error: "username / url mismatch" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  // Optional ETag fence: only fires when the client opted in AND
  // the deps include pushTokens. We compute the devices snapshot
  // inline (same code path as the listing handler) so a renamed
  // device or a new push token between fetch + initiate forces the
  // client to refresh.
  if (ifMatch !== undefined && deps.pushTokens) {
    const rows = await deps.pushTokens.listByUser(r.username);
    const currentEtag = await computeDevicesEtag(
      rows
        .map((p) => ({
          tokenId: p.tokenId,
          tokenPrefix: p.tokenId.slice(0, 8),
          label: p.label || `Untitled ${p.platform}`,
          platform: p.platform,
          addedAt: p.registeredAt,
          lastSeenAt: p.lastSeenAt,
        }))
        .sort((a, b) => a.addedAt - b.addedAt || a.tokenId.localeCompare(b.tokenId)),
    );
    if (currentEtag !== ifMatch) {
      return {
        status: 412,
        body: {
          error: "device list has shifted since you fetched it; refresh and retry",
          currentEtag,
        },
      };
    }
  }

  // v1.2 Phase 2 — quarantine gate on the CALLER's push_token row.
  // Only fires when the body identifies a caller (existing-device
  // initiation) AND the deps include pushTokens. The new-IRK / lost-
  // device J.3 path leaves callerTokenId unset, so the gate is a
  // no-op for genuine recovery — the gate exists only to stop a
  // freshly-admitted (quarantined) device from kicking out a
  // legitimate sibling via the re-pair endpoint.
  if (
    typeof b?.callerTokenId === "string" &&
    b.callerTokenId.length > 0 &&
    deps.pushTokens
  ) {
    const callerRow = await deps.pushTokens.get(b.callerTokenId);
    if (callerRow && (callerRow.quarantineUntil ?? 0) > now()) {
      return {
        status: 403,
        body: {
          reason: "quarantine",
          until: new Date(callerRow.quarantineUntil ?? 0).toISOString(),
          hint: "use a device you've had for longer",
        },
      };
    }
  }

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return { status: 404, body: { error: "unknown username" } };

  // The body's oldIrkPub MUST match the current row — otherwise an
  // attacker could initiate against a stale snapshot of the IRK.
  if (userRec.irkPubHex.toLowerCase() !== r.oldIrkPub.toLowerCase()) {
    return { status: 403, body: { error: "oldIrkPub does not match the current registered IRK" } };
  }
  // No-op when the new IRK already equals the registered one — nothing to swap.
  if (userRec.irkPubHex.toLowerCase() === r.newIrkPub.toLowerCase()) {
    return { status: 400, body: { error: "newIrkPub equals current IRK" } };
  }

  // v1.2 Phase 2 — account-type discriminator drives the grace +
  // TOTP-required flags. Absent / 'demo' falls through as 'single'
  // (the demo path lives in demo_users + never gets accountType
  // stamped on usernames, but treating an accidentally-set 'demo'
  // value as 'single' is the safe default — single is the more
  // restrictive recovery mode, not less).
  const accountType = userRec.accountType ?? "single";
  const isMultiDevice = accountType === "multi";
  const graceMs = isMultiDevice ? multiGraceMs : singleGraceMs;
  const totpRequired = isMultiDevice;

  // #52 follow-up — a single-device account whose row carries an
  // enrolled credential (a TOTP secret and/or unspent recovery codes)
  // must ALSO prove it at initiate. Before this, single-device
  // recovery started its grace on a bare signature from a brand-new
  // self-signed IRK — no credential at all — so the grace window was
  // the ONLY brake. Accounts with NEITHER enrolled keep the grace-only
  // path (no lockout regression for pre-launch accounts), but that
  // credential-less initiate is audit-logged so it stays visible.
  const hasTotpSecret = !!userRec.totpSecretEncrypted;
  // Mirrors totp.ts parseRecoveryCodesJson (which stays module-
  // internal): an unparsable / empty column means "nothing enrolled".
  let hasRecoveryCodes = false;
  if (userRec.recoveryCodesHashesJson) {
    try {
      const rows = JSON.parse(userRec.recoveryCodesHashesJson) as unknown;
      hasRecoveryCodes = Array.isArray(rows) && rows.length > 0;
    } catch {
      hasRecoveryCodes = false;
    }
  }
  const enrolledMethods: Array<"totp" | "recovery-code"> = [
    ...(hasTotpSecret ? (["totp"] as const) : []),
    ...(hasRecoveryCodes ? (["recovery-code"] as const) : []),
  ];
  const proofRequired = isMultiDevice || enrolledMethods.length > 0;
  // What the 401 advertises back to the client so it can prompt for
  // the right thing. Multi always advertises both (the multi flow has
  // historically accepted either); single advertises exactly what's
  // enrolled.
  const credentialRequired: Array<"totp" | "recovery-code"> = isMultiDevice
    ? ["totp", "recovery-code"]
    : enrolledMethods;

  // v1.2 — when a proof is required (multi-device, or single-device
  // with an enrolled credential), the body MUST carry a totpProof
  // beside the signed envelope. Phase 3 swapped the Phase 2
  // structural-only check for real verification: TOTP codes are
  // validated against the decrypted stored secret with a ±1 period
  // window; recovery codes are argon2id-verified against the stored
  // hash array AND atomically CAS-consumed so a single code can never
  // be replayed.
  //
  // The KEK is the production switch: when `totpKekHex` is wired we
  // run the real path; when absent (early-deploy / dev) we fall back
  // to the Phase 2 structural-only check so the call-sites that
  // haven't been updated to pass `totpKekHex` still work. Once
  // `FLAGSHIP_TOTP_KEK` is set in production, the structural fallback
  // never fires.
  let totpProofConsumed = false;
  if (proofRequired) {
    const proof = b?.totpProof as { code?: unknown; method?: unknown } | undefined;
    if (
      !proof ||
      typeof proof.code !== "string" ||
      proof.code.length === 0 ||
      (proof.method !== "totp" && proof.method !== "recovery")
    ) {
      // Same wire shape for both account types (the multi-device
      // clients already key their prompt-and-retry off this 401; the
      // "totpProof" substring + `credentialRequired` let single reuse
      // that handling verbatim).
      return {
        status: 401,
        body: {
          error: isMultiDevice
            ? "totpProof required for multi-device recovery"
            : "totpProof required for single-device recovery (a second factor is enrolled)",
          accountType,
          credentialRequired,
        },
      };
    }
    if (deps.totpKekHex) {
      // Real verification path (Phase 3).
      // Rate-limit the per-username verify counter so a brute-force
      // attempt against the TOTP code is bounded.
      const peek = peekVerifyAttempts(r.username, now());
      if (peek.tripped) {
        const retryAfterMs = Math.max(0, 15 * 60_000 - (now() - peek.windowStart));
        return {
          status: 429,
          body: {
            error: "too many TOTP verify attempts",
            retryAfterMs,
            retryAfterSec: Math.ceil(retryAfterMs / 1000),
          },
        };
      }
      const verdict = await validateTotpCode({
        code: proof.code,
        totpSecretEncrypted: userRec.totpSecretEncrypted,
        recoveryCodesHashesJson: userRec.recoveryCodesHashesJson,
        kekHex: deps.totpKekHex,
        now: now(),
      });
      if (!verdict.valid) {
        const post = recordVerifyAttempt(r.username, now());
        // Dedup'd by claimFailedRateAlertSlot — /totp/verify and the
        // re-pair gate share the same verifyAttemptStore.
        await fireFailedRateAlertIfDue(deps, r.username, now(), deps.pushFanout);
        return {
          status: 401,
          body: {
            error: "invalid TOTP proof",
            remainingAttempts: post.remaining,
          },
        };
      }
      // If the proof was a recovery code, consume it ATOMICALLY now.
      // Two parallel re-pairs racing the same code: only one of the
      // CAS calls in `consumeRecoveryCode` wins; the loser sees the
      // code already gone and 401s.
      if (verdict.method === "recovery") {
        const consume = await consumeRecoveryCode(
          { usernames: deps.usernames },
          r.username,
          proof.code,
        );
        if (!consume.consumed) {
          return {
            status: 401,
            body: {
              error: "recovery code already consumed",
              reason: consume.reason,
            },
          };
        }
        // v1.2 Phase 5 — record the single-use consumption.
        if (deps.auditEvents) {
          await recordAuditEvent(
            { auditEvents: deps.auditEvents },
            {
              username: r.username.toLowerCase(),
              eventKind: "recovery-code-consumed",
              detail: "Recovery code used during re-pair",
              devicePrefix: "",
              postedAt: now(),
              accountTypeAtEvent: accountType,
              recoveryMethod: "recovery-code",
            },
          );
        }
      }
      totpProofConsumed = true;
    } else {
      // Pre-Phase-3 fallback — structural-only validation, exactly
      // as the Phase 2 handler did. Deployments without
      // FLAGSHIP_TOTP_KEK set never reach the real-verify path; this
      // keeps the existing tests + dev paths green.
      totpProofConsumed = true;
    }
  }

  let newIrkPub: Uint8Array;
  let oldIrkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    newIrkPub = hexToBytes(r.newIrkPub);
    oldIrkPub = hexToBytes(r.oldIrkPub);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: RePairInitiate = {
    username: r.username,
    newIrkPub,
    oldIrkPub,
    issuedAt: r.issuedAt,
  };
  // The NEW IRK signs — that's the entity proving they hold the
  // recovered private key. .com verifies against the body's
  // newIrkPub (not the stored old one). totpProof is NOT in the
  // canonical bytes (see RePairInitiate jsdoc) so its presence /
  // absence doesn't affect signature verification.
  if (!verifyRePairInitiate(claim, sig, newIrkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  // Recovery-lock release: pending_re_pairs.username is the PK, so the
  // INSERT below fails with "re-pair already pending" if ANY row exists
  // for this cloud — that's the lock that prevents two simultaneous
  // recoveries from racing. But the row sticks around after veto (the
  // veto handler only stamps objected_at) and after expiry (the cron
  // alert scheduler doesn't delete), which would leave the cloud
  // permanently locked from any future legitimate recovery. Sweep dead
  // rows here, on the next initiate, so the lock releases naturally
  // when a dispute resolves but stays armed during a live one.
  //
  // A row is "dead" if either: (a) it was vetoed (objectedAt != null),
  // OR (b) its COMPLETION window passed without a successful complete
  // (completesAt + RE_PAIR_COMPLETE_WINDOW_MS <= now). Note the
  // predicate is the completion deadline, NOT completesAt: the
  // legitimate flow is initiate → wait out the grace → complete, so a
  // row between completesAt and the completion deadline is exactly a
  // LIVE recovery awaiting its /complete call — sweeping it here would
  // let a second initiate evict a recovery that's about to land. This
  // matches handleCompleteRePair's acceptance window exactly: a row is
  // either completable (lock held, 409 on initiate) or dead (swept).
  const completeWindowMs = deps.completeWindowMs ?? RE_PAIR_COMPLETE_WINDOW_MS;
  const existing = await deps.pendingRePairs.get(r.username);
  if (existing) {
    // objectedAt is `number | undefined` (PendingRePairRecord), NOT
    // `number | null`. A vetoed row has a numeric objectedAt; a live
    // row has it unset. Treat unset as "no veto."
    const vetoed = typeof existing.objectedAt === "number";
    const pastCompletionWindow =
      existing.completesAt + completeWindowMs <= now() && !vetoed;
    if (vetoed || pastCompletionWindow) {
      await deps.pendingRePairs.delete(r.username);
    }
    // else: live dispute / live completable recovery → fall through;
    // the storage layer's PK collision below returns the proper 409
    // "re-pair already pending".
  }

  const insert = await deps.pendingRePairs.initiate({
    username: r.username,
    newIrkPubHex: r.newIrkPub,
    oldIrkPubHex: r.oldIrkPub,
    initiatedAt: now(),
    completesAt: now() + graceMs,
    graceSeconds: Math.floor(graceMs / 1000),
    totpRequired,
    totpProofConsumed,
    // v1.2 Phase 5 — we fire T+0 synchronously below; stamp the bit
    // so the cron's next sweep doesn't double-fire it. (The cron's
    // own catch-up still fires T+0 if push fan-out wasn't wired
    // here, because the bit isn't stamped if push fan-out failed.)
    alertsFiredBitmap: ALERT_BIT_T0,
  });
  if (!insert.ok) return { status: 409, body: { error: insert.reason } };

  // #52 follow-up — a single-device account with NO enrolled credential
  // just started a grace-only recovery on a bare new-IRK signature.
  // That's deliberately still allowed (no lockout regression for
  // accounts that pre-date credential enrollment), but it must be
  // VISIBLE: audit it so the Activity feed shows that this takeover
  // had nothing but the grace window as its brake.
  if (deps.auditEvents && !proofRequired) {
    await recordAuditEvent(
      { auditEvents: deps.auditEvents },
      {
        username: r.username.toLowerCase(),
        eventKind: "re-pair-initiated-no-credential",
        detail: "Recovery started with no second factor enrolled (grace window is the only brake)",
        devicePrefix: r.newIrkPub.slice(0, 8),
        postedAt: now(),
        accountTypeAtEvent: accountType,
        recoveryMethod: "none",
      },
    );
  }

  // v1.2 Phase 5 — fire the T+0 alert push immediately. If the
  // pushFanout dep isn't wired, the cron scheduler picks up rows
  // with bit 0 set (we stamped it above) and skips T+0 — that's
  // the v1.1 baseline behaviour. With pushFanout wired we hand the
  // user's full set of trusted devices a "new device is trying to
  // take over" notification right away.
  if (deps.pushFanout && deps.pushTokens) {
    try {
      const targets = await deps.pushTokens.listByUser(r.username);
      if (targets.length > 0) {
        await deps.pushFanout({
          username: r.username.toLowerCase(),
          targets: targets.map((p) => ({
            tokenId: p.tokenId,
            platform: p.platform,
            providerToken: p.providerToken,
          })),
          payload: {
            category: "re-pair-initiated",
            title: "Account recovery attempt",
            body:
              "A new device is trying to take over your account. Tap to review or object.",
            deepLink: `flagship://account/re-pair?u=${encodeURIComponent(
              r.username.toLowerCase(),
            )}`,
            meta: {
              eventKind: "re-pair-initiated",
              completesAt: now() + graceMs,
              graceSeconds: Math.floor(graceMs / 1000),
              accountType,
            },
          },
        });
      }
    } catch {
      // Swallow — push fan-out failure must not break the initiate;
      // the cron scheduler will retry on its next sweep IF the bit
      // wasn't stamped. We stamped it (above) so the cron skips T+0;
      // this trade is fine because the initiator already saw 200 and
      // the user's other devices learn through the audit feed.
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      completesAt: now() + graceMs,
      graceMs,
      // Phase 2 surfaces the account-type back to the client so the
      // mobile UI (Phase 4) can render the correct copy ("7-day
      // grace" vs "24h grace + TOTP"). Quarantine-on-admit length
      // is also returned so the new device can show the "you're
      // approved but can't kick others for N days" hint.
      accountType,
      totpRequired,
      quarantineMs,
    },
  };
}

export async function handleObjectRePair(
  deps: RePairDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.newIrkPub !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return { status: 403, body: { error: "username / url mismatch" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  const pending = await deps.pendingRePairs.get(r.username);
  if (!pending) return { status: 404, body: { error: "no pending re-pair" } };
  // newIrkPub in the body must match the pending row's newIrkPub —
  // defends against replaying an old objection against a fresh re-pair.
  if (pending.newIrkPubHex.toLowerCase() !== r.newIrkPub.toLowerCase()) {
    return { status: 409, body: { error: "newIrkPub does not match the pending re-pair" } };
  }

  let newIrkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    newIrkPub = hexToBytes(r.newIrkPub);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: RePairObject = { username: r.username, newIrkPub, issuedAt: r.issuedAt };
  // SELF-CANCEL ONLY: the NEW IRK (the recoverer's own key) signs.
  //
  // Earlier model accepted OLD-IRK signatures here, treating /object
  // as "existing-device veto." That gives a device-thief the power
  // to block the legitimate owner's recovery from a fresh device.
  // Since device-possession is often correlated with credential-
  // possession (laptop thief usually also gets the iCloud keychain),
  // the OLD-IRK veto power is a NET-NEGATIVE for security.
  //
  // New model: credentials (iCloud + 2FA) are the sole gate for
  // recovery. Once initiated, recovery is INEVITABLE at T+grace.
  // /object only exists as an UNDO for the recoverer themselves
  // ("oops, I started recovery on the wrong device, let me cancel").
  // Verifying against newIrkPub closes the device-thief vector
  // while preserving the accidental-self-cancel UX.
  //
  // See docs/v1.2-security-cascade.md "Recovery threat model" for
  // the full reasoning.
  if (!verifyRePairObject(claim, sig, newIrkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.pendingRePairs.object(r.username, now());
  return { status: 200, body: { ok: true, objected: true } };
}

/**
 * v2.1 (W6) — body shape for /api/users/:u/re-pair/complete. All
 * fields optional so legacy callers (curl with no body, or pre-W6
 * clients) still work.
 *
 * `refreshedGrants` is only meaningful when the cloud's
 * `recovery_wipe_policy === 'graceful'`. Each entry is a fresh
 * DeviceCapabilityGrant signed by the NEW IRK (whose private key
 * lives on the recovering device, so server-side re-signing is
 * impossible); the handler verifies under the new IRK pub that just
 * landed via `swapIrkPub`, confirms each `devicePubKey` maps to an
 * existing active grant for the user, refuses any scope inflation
 * (refreshed scopes MUST be a SUBSET of the old grant's scopes), and
 * persists the new rows before revoking the old ones. See
 * docs/v1.2-security-cascade.md §"Recovery wipe policy".
 */
export interface CompleteRePairBody {
  refreshedGrants?: Array<{
    grantId: string;
    deviceLabel: string;
    devicePubKey: string;
    scopes: string[];
    issuedAt: number;
    expiresAt: number;
    signature: string;
  }>;
}

/**
 * Validate `refreshedGrants` against the user's existing active
 * DeviceCapabilityGrants. Returns `{ ok: true, pairs }` where each
 * pair is `{ next, old }` so the caller can atomically persist next +
 * revoke old. Returns `{ ok: false, status, error }` on any mismatch.
 *
 * - Each refreshed grant's signature MUST verify under the NEW IRK pub.
 * - Each refreshed `devicePubKey` MUST match an existing active grant
 *   for the user (no new-device admission via the re-sign path).
 * - Refreshed `scopes` MUST be a SUBSET of the old grant's scopes (no
 *   privilege escalation).
 * - Refreshed `deviceLabel` MUST equal the old grant's label (renaming
 *   a device under the new IRK is its own /device-grants/mint flow).
 */
async function validateRefreshedGrants(
  storage: DeviceCapabilityGrantStorage,
  username: string,
  newIrkPubBytes: Uint8Array,
  refreshed: NonNullable<CompleteRePairBody["refreshedGrants"]>,
): Promise<
  | { ok: true; pairs: Array<{ next: DeviceCapabilityGrantRecord; old: DeviceCapabilityGrantRecord }> }
  | { ok: false; status: number; error: string }
> {
  const validScopes = new Set<string>(DEVICE_SCOPES);
  const existing = (await storage.listForUser(username)).filter(
    (g) => g.revokedAt === null,
  );
  const byDevicePub = new Map<string, DeviceCapabilityGrantRecord>();
  for (const g of existing) byDevicePub.set(g.devicePubHex.toLowerCase(), g);

  const seenDevicePubs = new Set<string>();
  const pairs: Array<{ next: DeviceCapabilityGrantRecord; old: DeviceCapabilityGrantRecord }> = [];

  for (const rg of refreshed) {
    if (
      typeof rg.grantId !== "string" ||
      rg.grantId.length === 0 ||
      typeof rg.deviceLabel !== "string" ||
      typeof rg.devicePubKey !== "string" ||
      typeof rg.issuedAt !== "number" ||
      typeof rg.expiresAt !== "number" ||
      typeof rg.signature !== "string" ||
      !Array.isArray(rg.scopes)
    ) {
      return { ok: false, status: 400, error: "malformed refreshedGrant entry" };
    }
    const scopes: DeviceScope[] = [];
    for (const s of rg.scopes) {
      if (typeof s !== "string" || !validScopes.has(s)) {
        return {
          ok: false,
          status: 400,
          error: `refreshedGrant carries unknown scope: ${String(s)}`,
        };
      }
      scopes.push(s as DeviceScope);
    }
    const devPubLower = rg.devicePubKey.toLowerCase();
    if (seenDevicePubs.has(devPubLower)) {
      return {
        ok: false,
        status: 400,
        error: "refreshedGrants contain duplicate devicePubKey",
      };
    }
    seenDevicePubs.add(devPubLower);

    const old = byDevicePub.get(devPubLower);
    if (!old) {
      return {
        ok: false,
        status: 403,
        error: "refreshedGrant devicePubKey does not match an existing active grant",
      };
    }
    if (old.deviceLabel !== rg.deviceLabel) {
      return {
        ok: false,
        status: 403,
        error: "refreshedGrant deviceLabel must match the existing grant's label",
      };
    }
    // No scope inflation. Refreshed scopes MUST be a subset of the
    // old grant's scopes — the recovering admin can re-sign an
    // existing grant, NOT escalate a family member to a power they
    // never had.
    let oldScopes: DeviceScope[];
    try {
      oldScopes = JSON.parse(old.scopesJson) as DeviceScope[];
    } catch {
      return {
        ok: false,
        status: 500,
        error: "existing grant row corrupted",
      };
    }
    const oldScopeSet = new Set(oldScopes);
    for (const s of scopes) {
      if (!oldScopeSet.has(s)) {
        return {
          ok: false,
          status: 403,
          error: `refreshedGrant inflates scope "${s}" not on the existing grant`,
        };
      }
    }

    let devicePubBytes: Uint8Array;
    let sigBytes: Uint8Array;
    try {
      devicePubBytes = hexToBytes(rg.devicePubKey);
      sigBytes = hexToBytes(rg.signature);
    } catch {
      return { ok: false, status: 400, error: "refreshedGrant has invalid hex" };
    }
    const grant: DeviceCapabilityGrant = {
      grantId: rg.grantId,
      username,
      deviceLabel: rg.deviceLabel,
      devicePubKey: devicePubBytes,
      scopes,
      issuedAt: rg.issuedAt,
      expiresAt: rg.expiresAt,
    };
    if (!verifyDeviceCapabilityGrant(grant, sigBytes, newIrkPubBytes)) {
      return {
        ok: false,
        status: 403,
        error: "refreshedGrant signature does not verify under the new IRK",
      };
    }
    const next: DeviceCapabilityGrantRecord = {
      grantId: rg.grantId,
      username: username.toLowerCase(),
      deviceLabel: rg.deviceLabel,
      devicePubHex: devPubLower,
      scopesJson: JSON.stringify(scopes),
      issuedAt: rg.issuedAt,
      expiresAt: rg.expiresAt,
      signatureHex: rg.signature.toLowerCase(),
      revokedAt: null,
    };
    pairs.push({ next, old });
  }
  return { ok: true, pairs };
}

export async function handleCompleteRePair(
  deps: RePairDeps,
  username: string,
  body?: CompleteRePairBody,
): Promise<HandlerResponse> {
  // Public read — no signature gate. A successful complete is
  // idempotent: if we've already swapped, the pending row is gone
  // and we return 404; if we haven't, we check completion conditions
  // and either swap or return why we can't.
  const now = deps.now ?? (() => Date.now());
  const quarantineMs = deps.quarantineMs ?? RE_PAIR_QUARANTINE_MS;
  const pending = await deps.pendingRePairs.get(username);
  if (!pending) return { status: 404, body: { error: "no pending re-pair" } };
  if (pending.objectedAt) {
    return {
      status: 409,
      body: {
        error: "re-pair was objected by the old IRK",
        objectedAt: pending.objectedAt,
      },
    };
  }
  if (pending.completesAt > now()) {
    return {
      status: 425, // Too Early
      body: {
        error: "grace window has not elapsed",
        completesAt: pending.completesAt,
        secondsRemaining: Math.ceil((pending.completesAt - now()) / 1000),
      },
    };
  }
  // #52 follow-up — upper bound on completability. Without this, a row
  // whose grace elapsed was completable FOREVER (the stale-row hole:
  // an abandoned pending row from old testing could be "completed"
  // months later, making a takeover look like it skipped the grace).
  // A pending row is completable only inside
  // [completesAt, completesAt + RE_PAIR_COMPLETE_WINDOW_MS); past the
  // deadline it's dead — 410 Gone, sweep, audit.
  const completeWindowMs = deps.completeWindowMs ?? RE_PAIR_COMPLETE_WINDOW_MS;
  const completionDeadline = pending.completesAt + completeWindowMs;
  if (now() >= completionDeadline) {
    await deps.pendingRePairs.delete(username);
    if (deps.auditEvents) {
      await recordAuditEvent(
        { auditEvents: deps.auditEvents },
        {
          username: username.toLowerCase(),
          eventKind: "re-pair-expired",
          detail: "Stale recovery expired uncompleted — completion window passed; row swept",
          devicePrefix: pending.newIrkPubHex.slice(0, 8),
          postedAt: now(),
        },
      );
    }
    return {
      status: 410, // Gone
      body: {
        error: "re-pair completion window has expired; start a new recovery",
        completesAt: pending.completesAt,
        completionDeadline,
      },
    };
  }

  // v2.1 (W6) — read the cloud's wipe policy BEFORE the swap so we
  // can pre-validate refreshedGrants under the incoming new IRK pub.
  // The handler defaults absent/legacy rows to 'graceful'.
  const userRecBefore = await deps.usernames.get(username);
  const wipePolicy = userRecBefore?.recoveryWipePolicy ?? "graceful";

  // Pre-validate refreshedGrants up-front (under the pending row's
  // newIrkPubHex — which is what the swap is about to install). A
  // validation failure here returns BEFORE the IRK swap so the cloud
  // stays in a clean state. The strict path ignores `refreshedGrants`
  // entirely — silently dropping them on the floor is fine (the
  // recovering device will just see the wipe happen and re-onboard).
  let validatedPairs: Array<{ next: DeviceCapabilityGrantRecord; old: DeviceCapabilityGrantRecord }> = [];
  if (
    wipePolicy === "graceful" &&
    body?.refreshedGrants &&
    body.refreshedGrants.length > 0 &&
    deps.deviceCapabilityGrants
  ) {
    let newIrkPubBytes: Uint8Array;
    try {
      newIrkPubBytes = hexToBytes(pending.newIrkPubHex);
    } catch {
      return { status: 500, body: { error: "pending row has invalid newIrkPubHex" } };
    }
    const verdict = await validateRefreshedGrants(
      deps.deviceCapabilityGrants,
      username.toLowerCase(),
      newIrkPubBytes,
      body.refreshedGrants,
    );
    if (!verdict.ok) {
      return { status: verdict.status, body: { error: verdict.error } };
    }
    validatedPairs = verdict.pairs;
  }

  const swapped = await deps.usernames.swapIrkPub(
    username,
    pending.oldIrkPubHex,
    pending.newIrkPubHex,
    now(),
  );
  if (!swapped) {
    // The current IRK already moved (concurrent rotation, or someone
    // else completed). Drop the row to keep state tidy.
    await deps.pendingRePairs.delete(username);
    return {
      status: 409,
      body: { error: "username's current IRK no longer matches the pending old IRK" },
    };
  }

  // v2.1 (W6) — per-cloud wipe-policy enforcement on the freshly-
  // swapped cloud. Strict: revoke every active grant so the new admin
  // must re-mint. Graceful: persist any pre-validated refreshedGrants
  // first, THEN revoke the old grants the refreshed ones replaced.
  // Active grants whose devicePubKey wasn't covered by a refreshed
  // entry stay live under the OLD IRK's signature — they'll fail
  // verification at requireDeviceScope (defense-in-depth re-verify
  // under the new cloud root) and the family device's UI will prompt
  // a re-onboard. That's the "the user chose graceful but only
  // re-signed for some devices" case; it's a soft-fail by design.
  let wipedGrantIds: string[] = [];
  let refreshedGrantIds: string[] = [];
  if (deps.deviceCapabilityGrants) {
    if (wipePolicy === "strict") {
      const active = (
        await deps.deviceCapabilityGrants.listForUser(username.toLowerCase())
      ).filter((g) => g.revokedAt === null);
      for (const g of active) {
        await deps.deviceCapabilityGrants.revoke(g.grantId, now());
        wipedGrantIds.push(g.grantId);
      }
    } else if (wipePolicy === "graceful" && validatedPairs.length > 0) {
      // Two-step per pair: revoke the OLD first (so the storage
      // layer's duplicate-active guard for (username, deviceLabel)
      // doesn't reject the matching new row), then put the NEW.
      // Doing it the other way would make every put fail because the
      // refreshed grant has the SAME (username, deviceLabel) as the
      // old. The window where neither row is active is the same wall-
      // clock tick on the InMemory adapter; on D1 it's bounded by the
      // adjacent UPDATE + INSERT and the read endpoint is eventually-
      // consistent on top of that anyway.
      for (const { old, next } of validatedPairs) {
        await deps.deviceCapabilityGrants.revoke(old.grantId, now());
        const r = await deps.deviceCapabilityGrants.put(next);
        if (!r.ok) {
          // Should not happen — we revoked the only blocker above.
          // Surface a 500 so an operator notices but keep going (the
          // swap already landed; reverting the IRK is worse than a
          // missing grant).
          return {
            status: 500,
            body: {
              error: "graceful re-sign: failed to persist refreshed grant",
              grantId: next.grantId,
              reason: r.reason,
            },
          };
        }
        refreshedGrantIds.push(next.grantId);
      }
    }
  }
  // v1.2 Phase 2 — stamp the 14-day quarantine on every push_token
  // row currently registered for this user. The re-paired account
  // is, by construction, in a state where the new IRK has just taken
  // over — any push_tokens that were re-registered AFTER the new IRK
  // signed the J.3 initiate envelope might be the new device's own
  // push tokens (in which case quarantining them is exactly right)
  // OR a leftover from the old device (in which case the quarantine
  // is moot — the old device's tokens will be revoked by the next
  // re-registration on the new IRK). Either way, this fail-safe
  // sets a 14-day floor.
  //
  // Pre-quarantine devices on a single-device migration path
  // (quarantineUntil=0 from the column default) stay at 0 here
  // because the docs spell out that pre-existing rows are
  // already-trusted; on a re-pair, we treat the swap event as the
  // moment the new device joins, so every active push_token gets a
  // fresh 14-day clock. Future Phase 4 UI ("Replace device") gives
  // the legitimate owner a clean affordance to lift it manually.
  if (deps.pushTokens) {
    const rows = await deps.pushTokens.listByUser(username);
    const until = now() + quarantineMs;
    for (const row of rows) {
      await deps.pushTokens.setQuarantineUntil(row.tokenId, until);
    }
  }
  await deps.pendingRePairs.delete(username);

  // v1.2 Phase 5 — audit on completion. We capture both the
  // `device-replaced` (IRK rotation) and the `device-added` (the
  // new device's quarantine clock starts) rows. recoveryMethod
  // mirrors what the row stipulated: a verified proof at initiate
  // stamps `totpProofConsumed` (the #52 single-device credential gate
  // sets it too, so it's no longer conditioned on `totpRequired` —
  // that flag only marks multi accounts); recovery-code consumption
  // already emitted its own row at initiate time. accountTypeAtEvent
  // reads through to the post-swap usernames record so the snapshot
  // reflects the account's mode AT THE COMPLETE moment.
  if (deps.auditEvents) {
    const userRec = await deps.usernames.get(username);
    const accountType = userRec?.accountType ?? "single";
    const recoveryMethod: "totp" | "recovery-code" | "none" =
      pending.totpProofConsumed ? "totp" : "none";
    await recordAuditEvent(
      { auditEvents: deps.auditEvents },
      {
        username: username.toLowerCase(),
        eventKind: "device-replaced",
        detail: "Account IRK rotated (re-pair complete)",
        devicePrefix: pending.newIrkPubHex.slice(0, 8),
        postedAt: now(),
        accountTypeAtEvent: accountType,
        recoveryMethod,
      },
    );
    await recordAuditEvent(
      { auditEvents: deps.auditEvents },
      {
        username: username.toLowerCase(),
        eventKind: "device-added",
        detail: `New device admitted under ${quarantineMs / 86_400_000}-day quarantine`,
        devicePrefix: pending.newIrkPubHex.slice(0, 8),
        postedAt: now(),
        accountTypeAtEvent: accountType,
        quarantineUntil: now() + quarantineMs,
        recoveryMethod,
      },
    );
  }

  return {
    status: 200,
    body: {
      ok: true,
      newIrkPub: pending.newIrkPubHex,
      swappedAt: now(),
      quarantineUntil: now() + quarantineMs,
      // v2.1 (W6) — surface the policy applied + the IDs affected so
      // the recovering device's UI can render "All other devices need
      // to re-onboard" (strict) or "Kept N family devices working"
      // (graceful) without a separate /audit fetch.
      recoveryWipePolicy: wipePolicy,
      ...(wipedGrantIds.length > 0 ? { wipedGrantIds } : {}),
      ...(refreshedGrantIds.length > 0 ? { refreshedGrantIds } : {}),
    },
  };
}

export async function handleGetRePair(
  deps: RePairDeps,
  username: string,
): Promise<HandlerResponse> {
  const pending = await deps.pendingRePairs.get(username);
  if (!pending) return { status: 200, body: { pending: null } };
  return {
    status: 200,
    body: {
      pending: {
        newIrkPub: pending.newIrkPubHex,
        oldIrkPub: pending.oldIrkPubHex,
        initiatedAt: pending.initiatedAt,
        completesAt: pending.completesAt,
        objectedAt: pending.objectedAt ?? null,
      },
    },
  };
}
