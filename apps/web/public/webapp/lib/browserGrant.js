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
