// A live app's access list: which hosts it may reach (docs/ai-privacy-and-staging.md
// §3a). One `allow`/`deny` rule per line, checked top to bottom; the first rule
// that matches decides and a host no rule matches is denied. The box enforces
// only a list the owner signed with the sensitive-order key:
//
//   flagship/app-access/v1|<serverDomain>|<serviceId>|<sha256 hex of the normalized list>|<issuedAt ms>
//
// The normalizer, parser (exact error texts), matcher and withRule must pass
// packages/protocol/test-vectors/app-access/vectors.json, like every platform's.

import { requireOwnerProfile } from "./companionGuard.js";

import { tr } from "./i18n.js";
export const TAG_APP_ACCESS = "flagship/app-access/v1";
export const MAX_ACCESS_RULES = 200;
/** A new app's list: denies everything and shows how to open it up. The box
 *  returns it for an app it holds no signed list for. */
export const DEFAULT_ACCESS_LIST = "# Uncomment the following line to allow all hosts\n#allow all\n";

export const ACCESS_TITLE = tr("Internet access");
export const ACCESS_VIEW_LIST = tr("View access list");
export const ACCESS_ALLOW = "Allow";
export const ACCESS_DENY = "Deny";
export const ACCESS_IGNORE = "Ignore";
export const ACCESS_NOT_NOW = tr("Not now");
export const ACCESS_CLOSE = "Close";
export const ACCESS_SAVE = "Save";
export const ACCESS_PENDING_BADGE = tr("Wants internet");
export const ACCESS_COMPANION_NOTE = tr("Change this from your owner app.");
export const ACCESS_LIST_HELP =
  tr("One rule per line: allow or deny, then a host, *.example.com for its subdomains, or all. The first rule that matches decides; a host no rule matches is blocked. # starts a comment.");
export const ACCESS_PUSH_TEXT = tr("One of your apps wants to reach the internet");
export const ACCESS_DRAFT_TITLE = tr("This app suggests letting it reach these hosts");
export const ACCESS_DRAFT_REVIEW = "Review";
export const ACCESS_DRAFT_DISMISS = "Dismiss";
export const ACCESS_DRAFT_BADGE = tr("Access suggested");
export const ACCESS_DRAFT_WAITING = tr("A suggested access list is waiting…");
export const ACCESS_DRAFT_EDITOR_NOTE =
  tr("This is the list the app suggests. Nothing changes until you save it; edit it first if you like.");

const MSG = {
  verb: 'start the line with "allow" or "deny"',
  noTarget: 'say what to allow or deny, e.g. "allow example.com"',
  oneHost: "one host per line",
  scheme: "write the host only, without http:// or https://",
  path: "write the host only, without a path",
  port: "write the host only, without a port",
  ip: tr("IP addresses can't be allowed or denied; use a host name"),
  star: 'write "all" instead of "*"',
  starPlace: "a * may only start a host, as in *.example.com",
  tooMany: `an access list can have at most ${MAX_ACCESS_RULES} rules`,
};

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d+(?:\.\d+){3}$/;

/** `\r\n` and `\r` become `\n`, trailing spaces and trailing blank lines go,
 *  and a non-empty list ends in one `\n`. The bytes that get hashed. */
export function normalizeAccessList(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function checkTarget(raw) {
  const v = raw.toLowerCase();
  if (v === "all") return { target: "all" };
  if (v.includes("://")) return { error: MSG.scheme };
  if (v.includes("/")) return { error: MSG.path };
  if (v.startsWith("[") || (v.match(/:/g) ?? []).length >= 2) return { error: MSG.ip };
  if (v.includes(":")) return { error: MSG.port };
  if (v === "*") return { error: MSG.star };
  let host = v;
  let wildcard = false;
  if (host.startsWith("*.")) {
    wildcard = true;
    host = host.slice(2);
  }
  if (host.includes("*")) return { error: MSG.starPlace };
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (IPV4_RE.test(host)) return { error: MSG.ip };
  if (host === "localhost" || host.endsWith(".localhost")) return { error: tr("\"localhost\" is not a public host name") };
  if (host.length === 0 || host.length > 253 || !host.split(".").every((l) => LABEL_RE.test(l))) {
    return { error: tr("\"{0}\" is not a valid host name", v) };
  }
  return { target: wildcard ? `*.${host}` : host };
}

/** One line: null (blank or comment), `{action, target}`, or `{error}`. */
export function parseAccessLine(raw) {
  const hash = raw.indexOf("#");
  const body = (hash === -1 ? raw : raw.slice(0, hash)).trim();
  if (!body) return null;
  const tokens = body.split(/\s+/);
  const action = tokens[0].toLowerCase();
  if (action !== "allow" && action !== "deny") return { error: MSG.verb };
  if (tokens.length < 2) return { error: MSG.noTarget };
  if (tokens.length > 2) return { error: MSG.oneHost };
  const t = checkTarget(tokens[1]);
  return t.error ? { error: t.error } : { action, target: t.target };
}

/**
 * Parse a list. `rules` are `{line, action, target}` (1-based lines); `errors`
 * are `{line, message}`, one per bad line, and a list with any error is not
 * enforced.
 */
export function parseAccessList(text) {
  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  const rules = [];
  const errors = [];
  lines.forEach((raw, i) => {
    const r = parseAccessLine(raw);
    if (!r) return;
    const line = i + 1;
    if (r.error) {
      errors.push({ line, message: r.error });
      return;
    }
    if (rules.length >= MAX_ACCESS_RULES) {
      errors.push({ line, message: MSG.tooMany });
      return;
    }
    rules.push({ line, action: r.action, target: r.target });
  });
  return { rules, errors };
}

/** The editor's state for `text` against the saved list: the parse errors,
 *  the rule count, and whether Save is on (no errors, something changed, and
 *  not a companion). */
export function accessEditorState(text, savedList, { companion = false } = {}) {
  const { rules, errors } = parseAccessList(text);
  const changed = normalizeAccessList(text) !== normalizeAccessList(savedList);
  return { rules: rules.length, errors, changed, canSave: !companion && errors.length === 0 && changed };
}

function ruleMatches(target, host) {
  if (target === "all") return true;
  if (target.startsWith("*.")) {
    const suffix = target.slice(1);
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return host === target;
}

/**
 * What the list decides for `host`: `{result: "allow"|"deny", rule}` where
 * `rule` is the 1-based position of the deciding rule among the parsed rules
 * (comments and blank lines don't count), or null when none matched (denied
 * by default). A list with errors denies everything.
 */
export function decideAccess(list, host) {
  const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  const { rules, errors } = parseAccessList(list);
  if (errors.length > 0) return { result: "deny", rule: null };
  for (let i = 0; i < rules.length; i++) {
    if (ruleMatches(rules[i].target, h)) return { result: rules[i].action, rule: i + 1 };
  }
  return { result: "deny", rule: null };
}

/**
 * The list with `action host` on top, after dropping any rule for exactly that
 * host, so the new rule decides. Comments and other rules stay as written.
 */
export function withRule(list, action, host) {
  const a = String(action ?? "").toLowerCase();
  if (a !== "allow" && a !== "deny") throw new Error('action must be "allow" or "deny"');
  const parsed = parseAccessLine(`${a} ${String(host ?? "").trim()}`);
  if (!parsed || parsed.error) throw new Error(parsed?.error ?? MSG.noTarget);
  const kept = normalizeAccessList(list)
    .split("\n")
    .filter((line) => {
      const r = parseAccessLine(line);
      return !(r && !r.error && r.target === parsed.target);
    });
  return normalizeAccessList([`${a} ${parsed.target}`, ...kept].join("\n"));
}

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** sha256 hex of the normalized list's UTF-8 bytes. */
export async function accessListSha256(list) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeAccessList(list)));
  return toHex(new Uint8Array(digest));
}

export function canonicalAppAccessBytes({ serverDomain, serviceId, listSha256, issuedAt }) {
  if (!serverDomain) throw new Error("app-access: empty serverDomain");
  if (!serviceId) throw new Error("app-access: empty serviceId");
  if (!/^[0-9a-f]{64}$/.test(String(listSha256 ?? ""))) throw new Error("app-access: bad listSha256");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("app-access: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_APP_ACCESS, serverDomain, serviceId, listSha256, String(issuedAt)].join("|"),
  );
}

/** Thrown before signing when the list doesn't parse; carries the errors. */
export class AccessListError extends Error {
  constructor(errors) {
    super(errors.map((e) => tr("Line {0}: {1}", e.line, e.message)).join("\n"));
    this.name = "AccessListError";
    this.errors = errors;
  }
}

/**
 * Normalize, check, hash and sign a list. Resolves to the POST body
 * `{list, grant: {serverDomain, serviceId, listSha256, issuedAt}, signature}`.
 */
export async function signAccessList({ serverDomain, serviceId, list, issuedAt, umk, signWithIrk, bytesToHex = toHex }) {
  const text = normalizeAccessList(list);
  const { errors } = parseAccessList(text);
  if (errors.length > 0) throw new AccessListError(errors);
  const grant = { serverDomain, serviceId, listSha256: await accessListSha256(text), issuedAt };
  const sig = await signWithIrk(umk, canonicalAppAccessBytes(grant));
  return { list: text, grant, signature: bytesToHex(sig) };
}

/** `{list, listSha256, pending, draft}` from a GET or POST answer, or null. */
export function readAccessState(body) {
  const a = body && typeof body === "object" && body.access && typeof body.access === "object" ? body.access : body;
  if (!a || typeof a !== "object" || typeof a.list !== "string") return null;
  return {
    list: a.list,
    listSha256: typeof a.listSha256 === "string" ? a.listSha256 : "",
    pending: readRequests(a.pending),
    draft: readAccessDraft(a.draft),
  };
}

function readDraftHosts(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((h) => (typeof h === "string" ? { host: h } : h))
    .filter((h) => h && typeof h === "object" && typeof h.host === "string" && h.host)
    .map((h) => (typeof h.why === "string" && h.why.trim() ? { host: h.host, why: h.why.trim() } : { host: h.host }));
}

/** A suggested list `{list, listSha256, hosts:[{host, why?}], createdAt}`, or null. */
export function readAccessDraft(d) {
  if (!d || typeof d !== "object" || typeof d.list !== "string") return null;
  return {
    list: d.list,
    listSha256: typeof d.listSha256 === "string" ? d.listSha256 : "",
    hosts: readDraftHosts(d.hosts),
    createdAt: Number.isFinite(d.createdAt) ? d.createdAt : null,
  };
}

export function isAccessDraft(r) {
  return r?.kind === "draft";
}

function readRequests(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r) => r && typeof r === "object" && typeof r.host === "string" && r.host)
    .map((r) => ({
      host: r.host,
      source: r.source === "app" ? "app" : "attempt",
      attempts: Number.isFinite(r.attempts) ? r.attempts : 0,
      firstSeen: Number.isFinite(r.firstSeen) ? r.firstSeen : null,
      lastSeen: Number.isFinite(r.lastSeen) ? r.lastSeen : null,
      ...(typeof r.serviceId === "string" ? { serviceId: r.serviceId } : {}),
      ...(typeof r.appName === "string" ? { appName: r.appName } : {}),
    }));
}

/** The requests of GET /api/screens/access-requests (each with serviceId):
 *  drafts (`kind: "draft"`) first, then single-host requests. */
export function readAccessRequests(body) {
  const all = Array.isArray(body?.requests) ? body.requests : [];
  const drafts = all
    .filter((r) => isAccessDraft(r) && typeof r.serviceId === "string" && r.serviceId)
    .map((r) => ({
      kind: "draft",
      serviceId: r.serviceId,
      appName: typeof r.appName === "string" ? r.appName : "",
      hosts: readDraftHosts(r.hosts),
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt : null,
    }));
  const requests = readRequests(all.filter((r) => !isAccessDraft(r))).filter(
    (r) => typeof r.serviceId === "string" && r.serviceId,
  );
  return [...drafts, ...requests];
}

const count = (v) => (Array.isArray(v) ? v.length : Number.isFinite(v) && v >= 0 ? v : 0);

/** An app summary's `access: {rules, pending, draft}`, or null from an older box. */
export function readAccessSummary(app) {
  const a = app?.access;
  if (!a || typeof a !== "object") return null;
  return { rules: count(a.rules), pending: count(a.pending), draft: a.draft === true };
}

/** Whether the app list shows the "Access suggested" badge. */
export function hasAccessDraft(app) {
  return readAccessSummary(app)?.draft === true;
}

/** Whether the app list shows the "wants internet" badge. Falls back to the
 *  v1 egress fields for a box that doesn't send `access`. */
export function hasPendingInternetRequest(app, hasPendingEgress = () => false) {
  const s = readAccessSummary(app);
  return s ? s.pending > 0 : hasPendingEgress(app);
}

export function ruleCountText(n) {
  if (!n) return tr("No rules: this app can't reach the internet.");
  return n === 1 ? "1 rule" : `${n} rules`;
}

export function accessRequestTitle(appName, host) {
  return `${appName || tr("An app")} wants to reach ${host}`;
}

/** Whether it tried to connect or asked at install. */
export function accessRequestNote(req) {
  if (req?.source === "app") return tr("It asked for this when it was installed.");
  const n = req?.attempts ?? 0;
  if (n > 1) return tr("It tried to connect {0} times.", n);
  return tr("It tried to connect.");
}

export function accessDraftAlertTitle(appName) {
  return `${appName || tr("An app")} suggests an access list`;
}

export function accessAnsweredText(appName, host, action) {
  const name = appName || tr("This app");
  return action === "allow" ? `${name} can now reach ${host}` : `${name} won't reach ${host}`;
}

/** The box's refusal, said plainly. */
export function accessErrorMessage(e) {
  if (e instanceof AccessListError) return e.message;
  const status = e?.status;
  const raw = typeof e?.body?.error === "string" && e.body.error ? e.body.error : String(e?.message ?? "");
  if (status === 400 && Array.isArray(e?.body?.errors) && e.body.errors.length > 0) {
    return e.body.errors.map((x) => tr("Line {0}: {1}", x.line, x.message)).join("\n");
  }
  if (status === 404) return tr("This app isn't installed on this server anymore.");
  if (status === 409) return tr("The access list changed on your server. Refresh and try again.");
  if (status === 403) {
    if (/stale|clock|issuedAt/i.test(raw)) return tr("This device's clock is more than 10 minutes off. Fix the clock and try again.");
    if (/different server|serverDomain/i.test(raw)) return tr("This list was signed for a different server.");
    if (/signature/i.test(raw)) return tr("Your server didn't accept this list's signature.");
    if (/companion|read-only/i.test(raw)) return ACCESS_COMPANION_NOTE;
    return raw || tr("Your server refused this access list.");
  }
  return raw || tr("Couldn't update this app's internet access.");
}

const accessPath = (serviceId) => `/api/screens/services/${encodeURIComponent(serviceId)}/access`;

export async function fetchServiceAccess(serviceId, fetchJson) {
  return readAccessState(await fetchJson(accessPath(serviceId)));
}

export async function fetchAccessRequests(fetchJson) {
  return readAccessRequests(await fetchJson("/api/screens/access-requests"));
}

/** Ignore: the box forgets the request; nothing the app can reach changes. */
export async function dismissAccessRequest({ serviceId, host, fetchJson }, deps = {}) {
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  await fetchJson(`${accessPath(serviceId)}/dismiss`, { method: "POST", body: JSON.stringify({ host }) });
}

/** Dismiss a suggested list: the box discards it; nothing the app can reach
 *  changes, so there's no signature. Resolves to the box's new access state. */
export async function dismissAccessDraft({ serviceId, fetchJson }, deps = {}) {
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  return readAccessState(await fetchJson(`${accessPath(serviceId)}/draft/dismiss`, { method: "POST" }));
}

/**
 * Sign `list` and send it. Resolves to the box's new access state.
 *
 * @param {object} args
 * @param {string} args.serverDomain
 * @param {string} args.serviceId
 * @param {string} args.list
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk  the sensitive-order signer
 * @param {(path: string, init?: object) => Promise<any>} args.fetchJson  screensFetch
 * @param {(b: Uint8Array) => string} [args.bytesToHex]
 * @param {{ now?: () => number, requireOwnerProfile?: () => void }} [deps]
 */
export async function sendAccessList(args, deps = {}) {
  const { serverDomain, serviceId, list, umk, signWithIrk, fetchJson, bytesToHex } = args;
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  if (!umk || typeof signWithIrk !== "function") throw new Error(tr("Unlock the webapp first"));
  const body = await signAccessList({
    serverDomain,
    serviceId,
    list,
    issuedAt: (deps.now || Date.now)(),
    umk,
    signWithIrk,
    ...(bytesToHex ? { bytesToHex } : {}),
  });
  const r = await fetchJson(accessPath(serviceId), { method: "POST", body: JSON.stringify(body) });
  return readAccessState(r) ?? { list: body.list, listSha256: body.grant.listSha256, pending: [], draft: null };
}

/**
 * Allow or Deny one host: read the current list, put the rule on top with
 * `withRule`, sign and send. A 409 (the list moved meanwhile) is retried once
 * on the newer list.
 */
export async function answerAccessRequest(args, deps = {}) {
  const { serviceId, host, action, fetchJson } = args;
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  for (let attempt = 0; ; attempt++) {
    const current = (attempt === 0 && args.current) || (await fetchServiceAccess(serviceId, fetchJson));
    const list = withRule(current ? current.list : DEFAULT_ACCESS_LIST, action, host);
    try {
      return await sendAccessList({ ...args, list }, deps);
    } catch (e) {
      if (attempt === 0 && e?.status === 409) continue;
      throw e;
    }
  }
}
