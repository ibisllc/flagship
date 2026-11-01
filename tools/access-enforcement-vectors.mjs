// Writes packages/protocol/test-vectors/access-enforcement/decisions.json (run from the repo root: node tools/access-enforcement-vectors.mjs).
// The expectations here are the contract, written from docs/app-apis.md §2-§5 and
// docs/service-access-gating.md, not read back from either implementation.
import { writeFileSync, mkdirSync } from "node:fs";

const h = (b) => b.repeat(32);
const OWNER_AID = h("0a");
const ADMIN_DEV = h("a1");
const MEMBER_DEV = h("a2");
const LEGACY_AID = OWNER_AID;
const COMGR = h("c1");
const COMGR_VIEW = h("c2");
const SHARE_M = "51".repeat(16);
const SHARE_V = "52".repeat(16);
const FRIEND = h("f1"); // joined through an admin's invite
const PAL = h("f2"); // joined through a non-admin device's invite
const BOTH = h("f3"); // joined through both
const BOSS = h("f4"); // an admin order on them directly (aid:)
const OLDIE = h("f5"); // joined through an invite bound before tiers were recorded
const RAISED = h("f6"); // a member invite's join an admin raised (grant:)
const CHIEF = h("f7"); // joined through an invite an admin set to master
const STRANGER = h("e1");

const roles = (r) => ({ aids: {}, invites: {}, grants: {}, seq: {}, tiers: {}, creators: {}, ranks: {}, evidence: {}, withdrawn: {}, coManagers: {}, ...r });

const state = {
  "alice--club": {
    mode: "restricted",
    allow: [FRIEND, PAL, BOTH, BOSS, OLDIE, RAISED, CHIEF],
    groups: {
      "inv-admin": [FRIEND, BOTH],
      "inv-mem": [PAL, BOTH, RAISED],
      "inv-old": [OLDIE],
      "inv-boss": [BOSS],
      "inv-chief": [CHIEF],
    },
    roles: roles({
      aids: { [BOSS]: "master" },
      invites: { "inv-chief": "master" },
      grants: { [`inv-mem/${RAISED}`]: "manager" },
      tiers: { "inv-admin": "admin", "inv-mem": "member", "inv-boss": "member", "inv-chief": "admin" },
    }),
  },
  "alice--blog": { mode: "open", allow: [], groups: {}, roles: roles({}) },
  "alice--quiet": {
    mode: "restricted",
    allow: [],
    groups: {},
    roles: roles({ ranks: { [`device:${ADMIN_DEV}`]: "refused", [`share:${SHARE_M}`]: "member", [`device:${MEMBER_DEV}`]: "master" } }),
  },
  "alice--odd": { mode: "sideways", allow: [FRIEND], groups: {}, roles: roles({}) },
};

const principals = [
  { kind: "device", pub: ADMIN_DEV, tier: "admin" },
  { kind: "device", pub: MEMBER_DEV, tier: "member" },
  { kind: "device", pub: LEGACY_AID, tier: "member" },
  { kind: "co-manager", pub: COMGR, shareId: SHARE_M, level: "manage" },
  { kind: "co-manager", pub: COMGR_VIEW, shareId: SHARE_V, level: "view" },
];

const fixtures = {
  box: { ownerAid: OWNER_AID, principals, stateText: JSON.stringify(state) },
  "no-state-file": { ownerAid: OWNER_AID, principals, stateText: null },
  "after-a-lost-file": { ownerAid: OWNER_AID, principals, stateText: JSON.stringify({ "*": { mode: "restricted", allow: [], groups: {} }, "alice--blog": state["alice--blog"] }) },
  "corrupt-state-file": { ownerAid: OWNER_AID, principals, stateText: "{ not json" },
  "state-file-not-an-object": { ownerAid: OWNER_AID, principals, stateText: "[]" },
};

const CLUB = { serviceRef: "alice--club", host: "club.home.alice.flagship.services", publicRoutes: ["/hooks/stripe", "/api/public/*", "/"], defaultRole: "manager" };
const BLOG = { serviceRef: "alice--blog", host: "blog.home.alice.flagship.services", publicRoutes: [], defaultRole: "member" };
const QUIET = { serviceRef: "alice--quiet", host: "quiet.home.alice.flagship.services", publicRoutes: [], defaultRole: "member" };
const ODD = { serviceRef: "alice--odd", host: "odd.home.alice.flagship.services", publicRoutes: [], defaultRole: "member" };
const NEW = { serviceRef: "alice--new", host: "new.home.alice.flagship.services", publicRoutes: [], defaultRole: "member" };
const WIDE = { serviceRef: "alice--club", host: CLUB.host, publicRoutes: ["/*"], defaultRole: "member" };

const req = (r = {}) => ({ method: "GET", path: "/", upgrade: false, headers: {}, session: null, apiKey: "none", externalFresh: true, ...r });
const as = (aid, r = {}, service = "alice--club") => req({ path: "/members", session: { serviceRef: service, aid, live: true }, ...r });

const fwd = (visitor, role = null, identity = null, external = false) => ({ outcome: "forward", visitor, role, identity, external });
const ANON = fwd("anonymous");
const DENY = { outcome: "deny" };

const cases = [];
const c = (name, fixture, app, request, expect, extra = {}) => cases.push({ name, fixture, app, request, expect, ...extra });

// Mode and anonymous visitors (app-apis.md §2).
c("anonymous on a members-only app is denied", "box", CLUB, req({ path: "/members" }), DENY);
c("anonymous on an open app is forwarded anonymous", "box", BLOG, req({ path: "/anything", method: "POST" }), ANON);
c("anonymous WebSocket on an open app is forwarded", "box", BLOG, req({ path: "/ws", upgrade: true }), ANON);
c("anonymous WebSocket on a members-only app is denied", "box", CLUB, req({ path: "/ws", upgrade: true }), DENY);
c("an app with no row is open when the state file is absent", "no-state-file", NEW, req({ path: "/x" }), ANON);
c("an app with no row is open on a readable file without a default row", "box", NEW, req({ path: "/x" }), ANON);
c("an app with no row is members-only after a lost file", "after-a-lost-file", NEW, req({ path: "/x" }), DENY);
c("an app with its own open row stays open after a lost file", "after-a-lost-file", BLOG, req({ path: "/x" }), ANON);
c("every app is members-only when the state file is corrupt", "corrupt-state-file", BLOG, req({ path: "/x" }), DENY);
c("every app is members-only when the state file is not an object", "state-file-not-an-object", BLOG, req({ path: "/x" }), DENY);
c("a row with an unknown mode falls back to the default (open)", "box", ODD, req({ path: "/x" }), ANON);
c("a row with an unknown mode keeps no members", "box", ODD, as(FRIEND, {}, "alice--odd"), ANON);

// Public routes (app-apis.md §2).
c("a public route on a members-only app is forwarded anonymous", "box", CLUB, req({ path: "/hooks/stripe", method: "POST" }), ANON);
c("a public route matches with a trailing slash", "box", CLUB, req({ path: "/hooks/stripe/" }), ANON);
c("a public route ignores the query", "box", CLUB, req({ path: "/hooks/stripe?x=1" }), ANON);
c("the root public route covers only the root", "box", CLUB, req({ path: "/?q=1" }), ANON);
c("the root public route does not cover a page", "box", CLUB, req({ path: "/members" }), DENY);
c("a prefix covers its bare path", "box", CLUB, req({ path: "/api/public" }), ANON);
c("a prefix covers paths under it", "box", CLUB, req({ path: "/api/public/feed/1" }), ANON);
c("a prefix is segment-aware", "box", CLUB, req({ path: "/api/publicity" }), DENY);
c("public routes are case-sensitive", "box", CLUB, req({ path: "/Hooks/stripe" }), DENY);
c("a dot-dot segment out of a prefix is never public", "box", CLUB, req({ path: "/api/public/../secret" }), DENY);
c("an encoded dot-dot is never public", "box", CLUB, req({ path: "/api/public/%2e%2e/secret" }), DENY);
c("a dot-dot with a matrix parameter is never public", "box", CLUB, req({ path: "/api/public/..;x/secret" }), DENY);
c("an encoded slash is never public", "box", CLUB, req({ path: "/api/public%2fx" }), DENY);
c("a double-encoded percent is never public", "box", CLUB, req({ path: "/hooks/stripe%25" }), DENY);
c("a backslash is never public", "box", CLUB, req({ path: "/api/public\\x" }), DENY);
c("a control character is never public", "box", CLUB, req({ path: "/hooks/stripe%0a" }), DENY);
c("a malformed escape is never public", "box", CLUB, req({ path: "/hooks/stripe%zz" }), DENY);
c("collapsed slashes still match", "box", CLUB, req({ path: "//hooks//stripe" }), ANON);
c("a whole-app public route opens every path", "box", WIDE, req({ path: "/deep/page" }), ANON);
c("a whole-app public route still refuses a dot segment", "box", WIDE, req({ path: "/a/./b" }), DENY);
c("a path that does not start with a slash is never public", "box", WIDE, req({ path: "*" }), DENY);
c("a public route is decided the same for a WebSocket", "box", CLUB, req({ path: "/api/public/live", upgrade: true }), ANON);

// Account people (service-access-gating.md "Account members").
c("an admin device is master and shows as the owner", "box", CLUB, as(ADMIN_DEV, { path: "/members" }), fwd("member", "master", OWNER_AID));
c("a non-admin device is manager and shows as the owner", "box", CLUB, as(MEMBER_DEV), fwd("member", "manager", OWNER_AID));
c("the legacy account id on an admin-pinned box is a non-admin device", "box", CLUB, as(LEGACY_AID), fwd("member", "manager", OWNER_AID));
c("a co-manager is manager and external", "box", CLUB, as(COMGR), fwd("member", "manager", COMGR, true));
c("a view-level co-manager is still manager in an app", "box", CLUB, as(COMGR_VIEW), fwd("member", "manager", COMGR_VIEW, true));
c("an admin's refusal shuts out an admin device", "box", QUIET, as(ADMIN_DEV, {}, "alice--quiet"), DENY);
c("an admin's order demotes a co-manager to member", "box", QUIET, as(COMGR, {}, "alice--quiet"), fwd("member", "member", COMGR, true));
c("an admin's order raises a non-admin device to master", "box", QUIET, as(MEMBER_DEV, {}, "alice--quiet"), fwd("member", "master", OWNER_AID));
c("an account device needs no allow-list entry", "box", QUIET, as(MEMBER_DEV, {}, "alice--quiet"), fwd("member", "master", OWNER_AID));
c("an admin device on an open app is master", "box", BLOG, as(ADMIN_DEV, {}, "alice--blog"), fwd("member", "master", OWNER_AID));
c("a refused admin device reaches only public routes", "box", { ...QUIET, publicRoutes: ["/hook"] }, as(ADMIN_DEV, { path: "/hook" }, "alice--quiet"), ANON);

// Invited people (rank = highest live grant; admin orders; default_role never raises).
c("a join through an admin's invite takes the app's default rank", "box", CLUB, as(FRIEND), fwd("member", "manager", FRIEND, true));
c("a join through a non-admin's invite is member whatever the default", "box", CLUB, as(PAL), fwd("member", "member", PAL, true));
c("two joins give the higher rank", "box", CLUB, as(BOTH), fwd("member", "manager", BOTH, true));
c("an admin order on the person replaces their grants", "box", CLUB, as(BOSS), fwd("member", "master", BOSS, true));
c("an invite bound before tiers were recorded gives member", "box", CLUB, as(OLDIE), fwd("member", "member", OLDIE, true));
c("an admin order on one join raises a member invite's join", "box", CLUB, as(RAISED), fwd("member", "manager", RAISED, true));
c("an admin's order on an invite sets its rank", "box", CLUB, as(CHIEF), fwd("member", "master", CHIEF, true));
c("the manifest's default never raises a non-admin's invite", "box", { ...CLUB, defaultRole: "master" }, as(PAL), fwd("member", "member", PAL, true));
c("an admin's invite takes a master default", "box", { ...CLUB, defaultRole: "master" }, as(FRIEND), fwd("member", "master", FRIEND, true));
c("an unknown default role reads as member", "box", { ...CLUB, defaultRole: "superuser" }, as(FRIEND), fwd("member", "member", FRIEND, true));
c("a legacy default role name maps onto the ladder", "box", { ...CLUB, defaultRole: "editor" }, as(FRIEND), fwd("member", "manager", FRIEND, true));
c("a stranger's session is anonymous and denied", "box", CLUB, as(STRANGER), DENY);
c("a stranger's session on an open app is anonymous", "box", BLOG, as(STRANGER, {}, "alice--blog"), ANON);
c("a member of one app is anonymous on another open app", "box", BLOG, as(FRIEND, {}, "alice--blog"), ANON);

// Sessions.
c("a session issued for another app is anonymous", "box", BLOG, as(ADMIN_DEV, {}, "alice--club"), ANON);
c("a closed or expired session is anonymous", "box", CLUB, req({ path: "/members", session: { serviceRef: "alice--club", aid: FRIEND, live: false } }), DENY);
c("a session whose key is not lower-case hex is anonymous", "box", CLUB, req({ path: "/members", session: { serviceRef: "alice--club", aid: FRIEND.toUpperCase(), live: true } }), DENY);
c("an invited person needs a fresh checkpoint", "box", CLUB, as(FRIEND, { externalFresh: false }), DENY);
c("a co-manager needs a fresh checkpoint", "box", CLUB, as(COMGR, { externalFresh: false }), DENY);
c("an account device never needs a checkpoint", "box", CLUB, as(MEMBER_DEV, { externalFresh: false }), fwd("member", "manager", OWNER_AID));

// Catch-up hold (one list per app).
c("while catching up an invited person is held", "box", CLUB, as(FRIEND), DENY, { catchingUp: ["alice--club"] });
c("while catching up a co-manager is held", "box", CLUB, as(COMGR), DENY, { catchingUp: ["alice--club"] });
c("while catching up an account device still gets in", "box", CLUB, as(ADMIN_DEV), fwd("member", "master", OWNER_AID), { catchingUp: ["alice--club"] });
c("catching up on another app holds nobody here", "box", CLUB, as(FRIEND), fwd("member", "manager", FRIEND, true), { catchingUp: ["alice--blog"] });
c("a held person is anonymous on a public route", "box", CLUB, as(FRIEND, { path: "/hooks/stripe" }), ANON, { catchingUp: ["alice--club"] });

// Sibling apps (app-apis.md §4).
const other = { origin: "https://evil.home.alice.flagship.services" };
c("a cross-origin POST drops the member", "box", CLUB, as(FRIEND, { method: "POST", headers: other }), DENY);
c("a cross-origin POST on an open app is anonymous", "box", BLOG, as(ADMIN_DEV, { method: "POST", headers: other }, "alice--blog"), ANON);
c("a cross-origin GET keeps the member", "box", CLUB, as(FRIEND, { headers: other }), fwd("member", "manager", FRIEND, true));
c("a cross-origin WebSocket drops the member", "box", CLUB, as(FRIEND, { upgrade: true, headers: other }), DENY);
c("a same-origin POST keeps the member", "box", CLUB, as(FRIEND, { method: "POST", headers: { origin: `https://${CLUB.host}` } }), fwd("member", "manager", FRIEND, true));
c("a same-origin POST matches the host case-insensitively", "box", CLUB, as(FRIEND, { method: "POST", headers: { origin: `https://${CLUB.host.toUpperCase()}` } }), fwd("member", "manager", FRIEND, true));
c("an origin on another port is another origin", "box", CLUB, as(FRIEND, { method: "POST", headers: { origin: `https://${CLUB.host}:8443` } }), DENY);
c("an http origin is another origin", "box", CLUB, as(FRIEND, { method: "POST", headers: { origin: `http://${CLUB.host}` } }), DENY);
c("a null origin is another origin", "box", CLUB, as(FRIEND, { method: "POST", headers: { origin: "null" } }), DENY);
c("cross-site fetch metadata drops the member", "box", CLUB, as(FRIEND, { method: "DELETE", headers: { "sec-fetch-site": "same-site" } }), DENY);
c("same-origin fetch metadata keeps the member", "box", CLUB, as(FRIEND, { method: "PUT", headers: { "sec-fetch-site": "same-origin" } }), fwd("member", "manager", FRIEND, true));
c("a user-initiated navigation keeps the member", "box", CLUB, as(FRIEND, { method: "POST", headers: { "sec-fetch-site": "none" } }), fwd("member", "manager", FRIEND, true));
c("the origin header wins over fetch metadata", "box", CLUB, as(FRIEND, { method: "POST", headers: { ...other, "sec-fetch-site": "same-origin" } }), DENY);
c("a cross-origin referer drops the member", "box", CLUB, as(FRIEND, { method: "POST", headers: { referer: "https://evil.example/x" } }), DENY);
c("a same-origin referer keeps the member", "box", CLUB, as(FRIEND, { method: "POST", headers: { referer: `https://${CLUB.host}/page` } }), fwd("member", "manager", FRIEND, true));
c("no origin signal at all counts as same-origin", "box", CLUB, as(FRIEND, { method: "POST" }), fwd("member", "manager", FRIEND, true));
c("a forged host does not make a sibling's origin the app's own", "box", CLUB, as(FRIEND, { method: "POST", headers: other, host: "evil.home.alice.flagship.services" }), DENY);

// API keys (app-apis.md §3).
c("a valid API key reaches a members-only page", "box", CLUB, req({ path: "/members", apiKey: { keyId: "k1", scope: "write" }, method: "POST" }), fwd("api", "api", "apikey:k1"));
c("an API key wins over a member session", "box", CLUB, as(FRIEND, { apiKey: { keyId: "k2", scope: "read" } }), fwd("api", "api", "apikey:k2"));
c("a wrong or revoked API key is refused", "box", CLUB, req({ apiKey: "invalid" }), { outcome: "api-invalid" });
c("a wrong API key is refused even on an open app", "box", BLOG, req({ apiKey: "invalid" }), { outcome: "api-invalid" });
c("a read key on a write method is refused", "box", CLUB, req({ apiKey: "scope", method: "POST" }), { outcome: "api-scope" });
c("an API key over its rate is refused", "box", CLUB, req({ apiKey: "rate-limited" }), { outcome: "api-rate-limited" });

// The router's choice of app is the only one (H5): a Host naming another app changes nothing.
c("a Host naming another app does not pick that app's mode", "box", CLUB, req({ path: "/members", host: BLOG.host }), DENY);
c("a session for the Host's app is not one for the routed app", "box", CLUB, as(ADMIN_DEV, { host: BLOG.host }, "alice--blog"), DENY);

const doc = {
  about:
    "Access decisions at the effect boundary (the app proxy): which request reaches an app's container, as whom and with which rank. " +
    "Each case names a fixture (the box's access state file text, null when absent, the account people it knows and the owner's account id), " +
    "the app the ROUTER selected (never the Host header), and the request: method, raw path, upgrade, the origin headers, the session cookie's " +
    "record (live = present, unexpired, not closed), the API key check's result and whether external access is fresh (N07). " +
    "outcome: forward | deny | api-invalid (401) | api-scope (403) | api-rate-limited (429). For forward: visitor member|api|anonymous, " +
    "role (null when anonymous), identity (the key the app id is derived from: the owner's account id for every account device; null when anonymous), " +
    "external (the visitor is outside the owner's own devices). TypeScript: packages/server-daemon/tests/accessEnforcementVectors.test.ts; " +
    "Rust: rust/crates/flagship-access/tests/decision_vectors.rs.",
  fixtures,
  cases,
};
const OUT = process.argv[2] ?? "packages/protocol/test-vectors/access-enforcement";
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/decisions.json`, JSON.stringify(doc, null, 1) + "\n");
console.log(cases.length, "cases");
