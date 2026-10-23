/**
 * Who a browser visitor of an app is (docs/app-apis.md §5, "Members").
 *
 * A browser can't sign, so a person signs in to an app with their phone: the
 * app's knock page shows a QR / link, their phone signs the knock, and the box
 * hands that browser a `Flagship-App-Session` cookie for this app's host
 * (`serviceAccessWeb.ts`). This resolver turns the cookie back into the member
 * the app sees:
 *
 *   - the session must be live and issued for THIS app (a cookie for another
 *     app, an expired or closed one is anonymous);
 *   - its key must still be let in: a device of the account that owns the box
 *     or a co-manager unless an admin refused them in this app, anyone else
 *     only while on the app's members list (removing them, or revoking their
 *     invite, signs them out on their next request). This holds in both
 *     modes: on an open app a member who signs in gets their rank, anyone
 *     else is an anonymous visitor;
 *   - rank, on Flagship's member < manager < master (there is no owner rank;
 *     docs/service-access-gating.md "Account members"): an admin device is
 *     master and the account's other devices and co-managers manager unless
 *     an admin order says otherwise; an invited person has the rank their
 *     grants give, else the legacy membership store's, else the manifest's
 *     `default_role` (an `owner` there reads as master);
 *   - stable id: per app, from the app secret and a key: the owner AID for
 *     every device of the owning account (one person, many devices), the
 *     share key for a co-manager, the per-app id for an invited person. It
 *     can't be linked across apps.
 */
import type { Bytes } from "@flagship/protocol";
import { ladderRole, readSessionCookie, type ServiceAccessStore, type ServiceSessionStore } from "./serviceAccess.js";
import type { SessionResolver } from "./serviceProxy.js";

export interface AppSessionResolverOptions {
  sessions: Pick<ServiceSessionStore, "lookup">;
  access: Pick<ServiceAccessStore, "isAllowed" | "principal" | "accountRank" | "roleOf" | "appIdentityKey">;
  now?: () => number;
}

export function buildAppSessionResolver(opts: AppSessionResolverOptions): SessionResolver {
  const now = opts.now ?? (() => Date.now());
  return (req, app) => {
    const token = readSessionCookie(req.headers.cookie);
    if (!token) return null;
    const sess = opts.sessions.lookup(token, now());
    if (!sess || sess.serviceRef !== app.serviceId) return null;
    if (!/^[0-9a-f]{64}$/.test(sess.aid)) return null;
    if (!opts.access.isAllowed(app.serviceId, sess.aid)) return null;
    const p = opts.access.principal(sess.aid);
    const identity = hexToBytes(opts.access.appIdentityKey(sess.aid));
    const role = p ? opts.access.accountRank(app.serviceId, p) : invitedRole(sess.aid, hexToBytes(sess.aid));
    if (!role) return null;
    // Someone outside the owner's own devices (an invited person, a co-manager) also needs a current
    // freshness checkpoint; a device of the owner's account never does.
    const external = !p || p.kind === "co-manager";
    return { memberPub: identity, stableId: app.membership.stableIdFor(identity), role, ...(external ? { external: true } : {}) };

    function invitedRole(aidHex: string, pub: Bytes): string {
      const d = app.manifest.access.default_role;
      const set = opts.access.roleOf(app.serviceId, aidHex, d);
      if (set !== null) return set;
      const assigned = ladderRole(app.membership.members.getRole(pub));
      if (assigned !== null) return assigned;
      return ladderRole(d) ?? "member";
    }
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
