// apex — the SINGLE source of truth for the backend apexes the webapp talks
// to. Every other module derives its `.com` origin / sub-origins / the data
// plane `.flagship.services` suffix from here, instead of carrying its own
// hardcoded literal (there used to be ~37 scattered copies).
//
// Why a function, not a baked constant: the webapp is served from the SAME
// host it talks to (prod: webapp.flagshipserver.com → flagshipserver.com; the
// gym test env: webapp.gym.flagshipserver.com → gym.flagshipserver.com), so the
// control apex is DERIVED from `window.location.origin` — serving the webapp
// from `gym.flagshipserver.com` auto-retargets the whole app at the gym
// backend with no rebuild (docs/ui-test-gym.md §12-G2). When there is no
// usable browser origin (the unit-test `node` env, or a non-flagship host),
// it FALLS BACK to today's prod literal, so prod is byte-identical and the
// canonical-byte / URL-pinning tests stay green.
//
// One override knob for non-browser callers + tests: `setApexOverride({
// control, data })` forces both apexes (used by the gym harness / tests that
// need a non-prod apex without a real `window`). `null` clears it.

const PROD_CONTROL_APEX = "https://flagshipserver.com";
const PROD_CONTROL_HOST = "flagshipserver.com";
const PROD_DATA_APEX = "flagship.services";

// The label we treat as "the control apex" — `flagshipserver.com` in prod,
// `gym.flagshipserver.com` under the gym test env. We recognise a served
// origin as a flagship control surface when its host IS this apex or a
// known sub-origin of it (`webapp.`, `remote.`, `boot.`, `recovery.`).
//
// `web.` stays in the list purely so the retired origin still resolves an
// apex if a stale service worker serves the shell from cache before the
// 308 to `webapp.` takes effect. It matches only the exact `web.` label —
// `webapp.flagshipserver.com` does NOT start with `web.` — so the old and
// new prefixes cannot shadow each other.
const KNOWN_SUBORIGIN_PREFIXES = ["webapp.", "remote.", "boot.", "recovery.", "web."];

let override = null; // { control, data } | null

/** Force the apexes (gym harness / tests). Pass null to clear. */
export function setApexOverride(next) {
  override = next
    ? {
        control: String(next.control || PROD_CONTROL_APEX).replace(/\/+$/, ""),
        data: String(next.data || PROD_DATA_APEX).replace(/^\.+|\/+$/g, ""),
      }
    : null;
}

function browserOrigin() {
  try {
    const loc = globalThis.location;
    if (!loc || typeof loc.origin !== "string" || !loc.origin) return null;
    if (loc.protocol !== "https:" && loc.protocol !== "http:") return null;
    return loc.origin;
  } catch {
    return null;
  }
}

/** Strip a known sub-origin prefix off a host, yielding the bare control apex
 *  host (webapp.gym.flagshipserver.com → gym.flagshipserver.com). */
function apexHostFrom(host) {
  for (const p of KNOWN_SUBORIGIN_PREFIXES) {
    if (host.startsWith(p)) return host.slice(p.length);
  }
  return host;
}

/** Does this host look like a flagship control surface we should adopt? Prod
 *  `*.flagshipserver.com`, the gym `*.gym.flagshipserver.com`, or localhost
 *  dev are accepted; anything else falls back to the prod literal so a stray
 *  host can never silently retarget the app. */
function isFlagshipControlHost(host) {
  return (
    host === PROD_CONTROL_HOST ||
    host.endsWith(".flagshipserver.com") ||
    host === "localhost" ||
    host.startsWith("localhost:") ||
    host === "127.0.0.1" ||
    host.startsWith("127.0.0.1:")
  );
}

/** The control-plane apex origin (no trailing slash). */
export function controlApex() {
  if (override) return override.control;
  const origin = browserOrigin();
  if (origin) {
    try {
      const u = new URL(origin);
      if (isFlagshipControlHost(u.host)) {
        return `${u.protocol}//${apexHostFrom(u.host)}`;
      }
    } catch {
      /* fall through to the prod default */
    }
  }
  return PROD_CONTROL_APEX;
}

/** The control-plane apex HOST (no scheme) — used by the comFetch host gate. */
export function controlHost() {
  try {
    return new URL(controlApex()).host;
  } catch {
    return PROD_CONTROL_HOST;
  }
}

/** A sub-origin of the control apex: e.g. subOrigin("boot") →
 *  https://boot.flagshipserver.com (prod) / https://boot.gym.flagshipserver.com
 *  (gym). */
export function subOrigin(prefix) {
  try {
    const u = new URL(controlApex());
    return `${u.protocol}//${prefix}.${u.host}`;
  } catch {
    return `https://${prefix}.${PROD_CONTROL_HOST}`;
  }
}

/** The boot-worker origin (boot.<apex>). */
export function bootOrigin() {
  return subOrigin("boot");
}

/** The cloud-recovery sub-origin (recovery.<apex>). */
export function recoveryOrigin() {
  return subOrigin("recovery");
}

/** The webapp host origin (webapp.<apex>) — the owner webapp. */
export function webappOrigin() {
  return subOrigin("webapp");
}

/** The browser-remote origin (remote.<apex>) — where a desktop starts a
 *  phone-approved remote session, and where that session then lives. */
export function remoteOrigin() {
  return subOrigin("remote");
}

/** True when the shell is being served from the remote origin, i.e. this
 *  tab is the browser-remote surface rather than the owner webapp. Used by
 *  the boot path to decide what `/` means. Default-false off-browser so the
 *  unit-test env and any unknown host get the ordinary webapp behaviour. */
export function isRemoteSurface() {
  try {
    const host = globalThis.location?.hostname;
    return typeof host === "string" && host.startsWith("remote.");
  } catch {
    return false;
  }
}

/** The data-plane apex suffix (no leading dot): `flagship.services` in prod,
 *  `gym.flagship.services` under the gym test env. Derived from the control
 *  apex host (its trailing `flagship.services`-equivalent) so prod and gym
 *  stay in lockstep, with the prod literal as the floor. */
export function dataApex() {
  if (override) return override.data;
  // Mirror the control apex's gym prefix onto the data plane: under the gym
  // env the control host is `gym.flagshipserver.com`, so the data apex is
  // `gym.flagship.services`. In prod (or any non-gym host) it's the literal.
  const host = controlHost();
  const m = host.match(/^(.*\.)?flagshipserver\.com$/);
  if (m && m[1]) return `${m[1]}${PROD_DATA_APEX}`;
  return PROD_DATA_APEX;
}

/** The canonical FQDN of a server: `<server>.<user>.flagship.services`. */
export function serverFqdn(serverName, username) {
  return `${serverName}.${username}.${dataApex()}`;
}

/** A user's data-plane zone host: `<user>.flagship.services`. */
export function userZoneHost(username) {
  return `${username}.${dataApex()}`;
}
