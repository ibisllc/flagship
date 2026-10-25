// `flagship/browser-grant/v1`: the owner's answer to an app's request for browser access beyond its
// manifest, signed with the sensitive-order key and posted to POST /api/browser/owner/grant-requests/answer.
// Wire parity with packages/protocol/src/browserGrant.ts; pinned by packages/protocol/test-vectors/browser-grant/vectors.json.

export const BROWSER_GRANT_TAG = "flagship/browser-grant/v1";

const clean = (s) => typeof s === "string" && s.length > 0 && !/[|\x00-\x1f\x7f]/.test(s);
const toHex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function canonicalBrowserGrantAnswer(a) {
  for (const k of ["serverDomain", "requestId", "serviceId"]) if (!clean(a[k])) throw new Error(k);
  if (a.decision !== "allow" && a.decision !== "deny") throw new Error("decision");
  if (!["once", "session", "service"].includes(a.duration)) throw new Error("duration");
  if (!Number.isSafeInteger(a.issuedAt) || a.issuedAt < 0) throw new Error("issuedAt");
  for (const c of a.capabilities) if (!clean(c) || c.includes(",")) throw new Error("capability");
  const digest = toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode([...a.origins].sort().join("\n"))));
  const l = a.localNetwork;
  const lan = !l ? "none" : l.kind === "whole-lan" ? "whole-lan" : `exact:${[...l.hosts].sort().join(",")}`;
  return new TextEncoder().encode(
    [BROWSER_GRANT_TAG, a.serverDomain.toLowerCase(), a.requestId, a.serviceId, a.decision, a.duration, [...a.capabilities].sort().join(","), digest, lan, a.issuedAt].join("|"),
  );
}

// The owner may answer with the same scope or narrower, never wider (packages/protocol/src/browserGrant.ts
// `browserGrantWithin`; the box checks). The webapp offers the durations: once < session < service.
const DURATION_RANK = { once: 0, session: 1, service: 2 };

/** The durations the owner can choose for an ask, shortest first. */
export function browserGrantDurationChoices(asked) {
  if (!(asked in DURATION_RANK)) return [];
  return ["once", "session", "service"].filter((d) => DURATION_RANK[d] <= DURATION_RANK[asked]);
}

/** Is `answer` (duration, capabilities, origins, localNetwork) the same as `ask` or narrower? */
export function browserGrantWithin(ask, answer) {
  if (!(answer.duration in DURATION_RANK) || !(ask.duration in DURATION_RANK)) return false;
  if (DURATION_RANK[answer.duration] > DURATION_RANK[ask.duration]) return false;
  const caps = new Set(ask.capabilities);
  if (answer.capabilities.length === 0 || !answer.capabilities.every((c) => caps.has(c))) return false;
  const origins = new Set(ask.origins);
  if (!answer.origins.every((o) => origins.has(o))) return false;
  const a = answer.localNetwork;
  const q = ask.localNetwork;
  if (a) {
    if (!q) return false;
    if (a.kind === "whole-lan" && q.kind !== "whole-lan") return false;
    if (a.kind === "exact") {
      if (q.kind !== "exact" || a.hosts.length === 0) return false;
      const hosts = new Set(q.hosts);
      if (!a.hosts.every((h) => hosts.has(h))) return false;
    }
  }
  return answer.origins.length > 0 || a !== null;
}

// `flagship/browser-grant-revoke/v1`: the owner withdraws a grant they gave. Pinned by
// packages/protocol/test-vectors/browser-grant-revoke/vectors.json.
export const BROWSER_GRANT_REVOKE_TAG = "flagship/browser-grant-revoke/v1";

export function canonicalBrowserGrantRevoke(r) {
  for (const k of ["serverDomain", "serviceId", "grantId"]) if (!clean(r[k])) throw new Error(k);
  if (!Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0) throw new Error("issuedAt");
  return new TextEncoder().encode([BROWSER_GRANT_REVOKE_TAG, r.serverDomain.toLowerCase(), r.serviceId, r.grantId, r.issuedAt].join("|"));
}
