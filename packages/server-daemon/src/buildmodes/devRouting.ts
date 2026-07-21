/**
 * `dev--` request routing (feat/dev-prod-dataspace, spec §4).
 *
 * The app-proxy routes an inbound request by the leftmost SNI label. A request
 * addressed to `dev--<slug>.<host>.<user>.flagship.services` must reach the SAME
 * deployed container but with the DEV data principal injected — never prod.
 * This module is the pure parser + selection helper the proxy calls; it holds
 * no state and touches no sockets, so it is exhaustively testable.
 *
 * Why `dev--`: the double dash is already the reserved composite delimiter
 * (`docs/service-addressing-double-dash.md`), so `dev--notes` is parse-safe and
 * the address is covered by the per-box wildcard cert `*.<host>.<user>` — no new
 * certificate is needed. A prod service label never begins with `dev--` because
 * the `--` is reserved; a self-authored service is a bare slug, and a
 * cross-author service is `<slug>--<author>` (author is a username, and the
 * leftmost token there is the slug, never the literal `dev`).
 */

const DEV_PREFIX = "dev--";

export type DataSpace = "dev" | "prod";

export interface ParsedSpaceLabel {
  /** Which dataspace this label selects. */
  space: DataSpace;
  /**
   * The service label with the dev marker stripped — i.e. the label to resolve
   * against the installed apps (`byLabel`). For a prod label this is the input
   * unchanged.
   */
  serviceLabel: string;
}

/**
 * Split a leftmost SNI label into `{space, serviceLabel}`.
 *
 *   "notes"          → { space:"prod", serviceLabel:"notes" }
 *   "dev--notes"     → { space:"dev",  serviceLabel:"notes" }
 *   "dev--notes--bob"→ { space:"dev",  serviceLabel:"notes--bob" }  (cross-author, dev)
 *
 * The prod path is byte-identical to today: any label WITHOUT the `dev--`
 * prefix resolves exactly as before. Only the `dev--` prefix diverts to dev.
 */
export function parseSpaceLabel(leftmost: string): ParsedSpaceLabel {
  const lower = leftmost.toLowerCase();
  if (lower.startsWith(DEV_PREFIX) && lower.length > DEV_PREFIX.length) {
    return { space: "dev", serviceLabel: leftmost.slice(DEV_PREFIX.length) };
  }
  return { space: "prod", serviceLabel: leftmost };
}

/** True iff the leftmost label addresses the dev dataspace. */
export function isDevLabel(leftmost: string): boolean {
  return parseSpaceLabel(leftmost).space === "dev";
}

export interface SelectPrincipalArgs<Cred> {
  space: DataSpace;
  /** The prod data-credential env bundle for the resolved service (always present). */
  prod: Cred;
  /**
   * The dev data-credential env bundle. Present only when a dev dataspace has
   * been provisioned for this service (a dev session is live). Absent otherwise.
   */
  dev?: Cred;
}

export type SelectPrincipalResult<Cred> =
  | { ok: true; principal: Cred }
  | { ok: false; status: 409; reason: string };

/**
 * Pick the data principal to inject for a request, by dataspace. A `dev--`
 * request with NO live dev dataspace returns a 409 (start a dev session first)
 * rather than silently hitting prod — the dev/prod boundary must be explicit,
 * never a silent fall-through to production data.
 *
 * A prod request can NEVER receive the dev principal and vice-versa; the choice
 * is made here in the proxy/credential layer, not in app code.
 */
export function selectDataPrincipal<Cred>(args: SelectPrincipalArgs<Cred>): SelectPrincipalResult<Cred> {
  if (args.space === "dev") {
    if (!args.dev) {
      return { ok: false, status: 409, reason: "no dev dataspace for this service — start a dev session first" };
    }
    return { ok: true, principal: args.dev };
  }
  return { ok: true, principal: args.prod };
}
