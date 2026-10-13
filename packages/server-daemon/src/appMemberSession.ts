/**
 * Who a browser visitor of an app is (docs/app-apis.md §5, "Members").
 *
 * A browser can't sign, so a person signs in to an app with their phone: the
 * app's knock page shows a QR / link, their phone signs the knock with their
 * account id (AID), and the box hands that browser a `Flagship-App-Session`
 * cookie for this app's host (`serviceAccessWeb.ts`). This resolver turns the
 * cookie back into the member the app sees:
 *
 *   - the session must be live and issued for THIS app (a cookie for another
 *     app, an expired or closed one is anonymous);
 *   - its AID must still be let in: the owner's AID always is, anyone else
 *     only while on the app's members list (removing them, or revoking their
 *     invite, signs them out on their next request). This holds in both
 *     modes: on an open app a member who signs in gets their role, anyone
 *     else is an anonymous visitor;
 *   - rank, on Flagship's member < manager < master: `owner` for
 *     the owner's AID; otherwise the highest of the roles the owner gave
 *     their grants (the invites they joined through) or them, with signed
 *     `flagship/app-member-role/v1` orders, else the role the legacy
 *     membership store holds, else the manifest's `default_role` (never
 *     `owner`, which only the box owner carries: a default of `owner` gives
 *     invited people `master`);
 *   - stable id: per app, from the app secret and the AID, so it survives the
 *     person's device and key changes and can't be linked across apps.
 */
import type { Bytes } from "@flagship/protocol";
import { ladderRole, readSessionCookie, type ServiceAccessStore, type ServiceSessionStore } from "./serviceAccess.js";
import type { SessionResolver } from "./serviceProxy.js";

export interface AppSessionResolverOptions {
  sessions: Pick<ServiceSessionStore, "lookup">;
  access: Pick<ServiceAccessStore, "isAllowed" | "isOwner" | "roleOf">;
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
    const memberPub = hexToBytes(sess.aid);
    return { memberPub, stableId: app.membership.stableIdFor(memberPub), role: roleFor(sess.aid, memberPub) };

    function roleFor(aidHex: string, pub: Bytes): string {
      if (opts.access.isOwner(aidHex)) return "owner";
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
