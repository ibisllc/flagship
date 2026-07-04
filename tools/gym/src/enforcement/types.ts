/**
 * LIVE-ENFORCEMENT gym gates — types (docs/ui-test-gym.md; the "does the control
 * actually fire on the wire" standing check).
 *
 * The standing lesson these gates encode: a security control that passes its unit
 * tests can still be BYPASSABLE off-box (the restricted-mode no-op — unit-green
 * while the gate keyed off the wrong request field). So each control here is
 * proven by DRIVING it over the real wire (or, where the wire proof needs a
 * provisioning capability the gym lacks today, by a deterministic authority-boundary
 * proof against the same @flagship/protocol primitives the box uses) and rolling
 * the verdict up with a STRICT rule: a check that could not run reads as SKIPPED,
 * never as green.
 *
 * The transport is INJECTED (`HttpFn` / `RawFn`) so the exact assertion logic is
 * unit-testable with a stubbed box — the driver's verdict logic is validated
 * deterministically without ever provisioning a box.
 */

/** A normalized HTTP response (mirrors the live drivers' `http()` shape). */
export interface WireResponse {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
  /** Every `set-cookie` header value (getSetCookie), for holder-cookie checks. */
  readonly setCookies: readonly string[];
}

export interface HttpInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** The injected HTTP transport (real fetch live; a stub in unit tests). */
export type HttpFn = (url: string, init?: HttpInit) => Promise<WireResponse>;

/**
 * A RAW TLS request that chooses the SNI and the Host header INDEPENDENTLY — the
 * `curl --resolve` / spoofed-or-absent-Host class the GAP-1 bypass rode in on
 * (fetch() can't do this: it derives Host from the URL). Live this is an
 * `openssl s_client` raw write; in unit tests it's a stub.
 */
export interface RawProbe {
  /** The TLS SNI server-name (selects the app container / cert). */
  readonly sni: string;
  /** The HTTP Host header — `null` means OMIT it entirely (absent-Host case). */
  readonly host: string | null;
  readonly path: string;
}
export type RawFn = (p: RawProbe) => Promise<WireResponse>;

/** One wire assertion inside a control check. `ok:true` ⇒ the control fired. */
export interface Assertion {
  readonly label: string;
  /** true = the control behaved correctly (gated/rejected/verified). */
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * A control check's verdict.
 *  - `enforced`  — it ran and every enforcement assertion held.
 *  - `bypassed`  — it ran and at least one assertion proved the control DID NOT
 *                  fire (a real bypass — RED, blocks the run).
 *  - `skipped`   — it could not run (no box / no secret / transport error /
 *                  precondition unmet). NEVER counts as a pass.
 */
export type CheckStatus = "enforced" | "bypassed" | "skipped";

/**
 * A note that part (or all) of a control's live wire proof needs a capability the
 * gym can't provision today (e.g. a box with a pinned admin master root, or LAN
 * SSH to the box), so it is proven DETERMINISTICALLY now against the shared
 * protocol primitives, with the live wire step recorded as a TODO.
 */
export interface DeferredNote {
  /** Why the full live wire proof is deferred. */
  readonly reason: string;
  /** The exact live step to run once the capability exists. */
  readonly todo: string;
  /**
   * true ⇒ the authority boundary is nonetheless proven deterministically here
   * (so the check can still be `enforced`, not merely skipped).
   */
  readonly deterministic: boolean;
}

export interface CheckOutcome {
  readonly id: string;
  /** The control this proves (matches the task's control list 1..5). */
  readonly control: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly assertions: readonly Assertion[];
  readonly skipReason?: string;
  readonly deferred?: DeferredNote;
}

/** Sentinel: throw this inside a check body to mark it SKIPPED (not failed). */
export class EnforcementSkip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EnforcementSkip";
  }
}

/**
 * Run a control check body, converting outcomes into a `CheckOutcome`:
 *  - a returned assertion list with any `ok:false` ⇒ `bypassed`;
 *  - all `ok:true` ⇒ `enforced`;
 *  - an `EnforcementSkip` (or ANY thrown error — an inconclusive run must never
 *    read green) ⇒ `skipped`.
 */
export async function runCheck(
  meta: { id: string; control: string; title: string; deferred?: DeferredNote },
  body: () => Promise<readonly Assertion[]>,
): Promise<CheckOutcome> {
  try {
    const assertions = await body();
    const bypassed = assertions.some((a) => !a.ok);
    return {
      ...meta,
      status: bypassed ? "bypassed" : "enforced",
      assertions,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ...meta, status: "skipped", assertions: [], skipReason: reason };
  }
}
