// Webapp wrapper for `/api/users/check` + `/api/dev/sample-user/{u}/
// connect` — the Plan A mobile-mirror surface.
//
// Mirror of:
//   - apps/mobile/ios/Sources/FlagshipAPI/Client/FlagshipServerClient.swift
//     (usernameAvailable, DemoServerBlock, DemoConnectClient)
//   - apps/mobile/android/app/src/main/java/com/flagshipserver/app/api/
//     FlagshipServerClient.kt (UsernameAvailabilityResponse, DemoConnectClient)
//
// When `/api/users/check` returns a `demoServer` block, the webapp
// can branch the same way iOS / Android branch — render ONE real
// device and call /connect on tap. Absent ⇒ legacy testAccount-only
// behaviour. See docs/sample-users.md §10.9.

/** @typedef {Object} DemoServerBlock
 *  @property {string} fqdn
 *  @property {"none"|"provisioning"|"up"} status
 *  @property {number} ttlIdleMinutes
 *  @property {?string} [phase]      latest provisioning PHASE checkpoint —
 *                                   a canonical ProvisionStatusPhase
 *                                   (booting…live, terminal `error`), the
 *                                   SAME vocabulary the real-box install
 *                                   timeline uses; null until the first
 *                                   checkpoint arrives. Lockstep with
 *                                   iOS/Android + the control-plane channel.
 *  @property {?number} [phaseAt]    wall-clock ms the latest phase landed
 *  @property {string} [lastError]   failure detail, only when phase==="failed"
 *  @property {string} [ip]          public IPv4 the provider returned (migration 0036)
 *  @property {string} [region]      provider location, e.g. "fsn1"
 *  @property {string} [serverType]  provider size, e.g. "cx22"
 *  @property {string} [image]       provider OS image, e.g. "debian-12"
 */

/** @typedef {Object} TestAccountMeta
 *  @property {string} display
 *  @property {number} ttlHours
 */

/** @typedef {Object} UsersCheckResponse
 *  @property {string} username
 *  @property {boolean} available
 *  @property {string=} reason
 *  @property {TestAccountMeta=} testAccount
 *  @property {DemoServerBlock=} demoServer
 *  @property {DeviceCapabilityBlock=} deviceCapability
 */

/** v2 device-addressing — mirror of the Worker's `deviceCapability`
 *  block in `packages/control-plane/src/usersCheck.ts`. Embedded into
 *  the `/api/users/check` response when the typed username matched
 *  the `<u>.<device-label>` syntax AND a matching active
 *  DeviceCapabilityGrant exists. See
 *  docs/v2-device-addressing-and-real-ticket.md §5.1.
 *
 *  Scopes are wire-format strings; use `deviceCapabilityScopeSet` for
 *  forward-compat parsing (unknown future scope strings drop out).
 *  @typedef {Object} DeviceCapabilityBlock
 *  @property {string} label
 *  @property {string} devicePubKey
 *  @property {string[]} scopes
 *  @property {string} grantId
 *  @property {number} expiresAt
 *  @property {string} signature
 */

import { controlApex } from "./apex.js";

/** Canonical scope list — mirror of `DEVICE_SCOPES` in
 *  `packages/protocol/src/auth.ts`. Order MUST match the canonical
 *  sort order so a future audit-trail render stays stable.
 *  @type {readonly string[]}
 */
export const DEVICE_SCOPES = Object.freeze([
  "browse",
  "install-service",
  "vibe-code",
  "add-device",
  "manage-services",
  "revoke-others",
  "demo-provision",
]);

/** Forward-compat scope set: unknown future strings are silently
 *  dropped. Used by UI callsites to gate the install / vibe-code
 *  buttons. Returns an empty set when the block is absent.
 *  @param {DeviceCapabilityBlock|null|undefined} block
 *  @returns {Set<string>}
 */
export function deviceCapabilityScopeSet(block) {
  if (!block || !Array.isArray(block.scopes)) return new Set();
  return new Set(block.scopes.filter((s) => DEVICE_SCOPES.includes(s)));
}

/** True iff the device's scopes cover the full DEVICE_SCOPES set —
 *  i.e. the device is a primary device with no restrictions. The chip
 *  + tooltips suppress when this is true; a null block also suppresses
 *  (legacy single-IRK path).
 *  @param {DeviceCapabilityBlock|null|undefined} block
 *  @returns {boolean}
 */
export function isDeviceFullyScoped(block) {
  if (!block) return false;
  const set = deviceCapabilityScopeSet(block);
  return DEVICE_SCOPES.every((s) => set.has(s));
}

/** Build a one-line summary suitable for the chip below the username.
 *  `browse-only` is the canonical reviewer state; anything else
 *  summarises as "N scopes" so the chip stays one line. Returns null
 *  when the block is absent or fully-scoped (no chip should render).
 *  @param {DeviceCapabilityBlock|null|undefined} block
 *  @returns {string|null}
 */
export function deviceCapabilityChipText(block) {
  if (!block) return null;
  if (isDeviceFullyScoped(block)) return null;
  const set = deviceCapabilityScopeSet(block);
  const summary = (set.size === 1 && set.has("browse"))
    ? "browse-only"
    : `${block.scopes.length} scopes`;
  return `Device: ${block.label} · ${summary}`;
}

/** Per-action capability gate. Returns true when the action is
 *  allowed under the current device's scope set, OR when no capability
 *  is installed (legacy single-IRK — every scope implicit).
 *  @param {DeviceCapabilityBlock|null|undefined} block
 *  @param {string} scope
 *  @returns {boolean}
 */
export function deviceCapabilityAllows(block, scope) {
  if (!block) return true;
  return deviceCapabilityScopeSet(block).has(scope);
}

/** UI helper: mutate an `<button>` element in place so an
 *  `install-service`-disabled session can't tap it. Sets disabled,
 *  aria-disabled, title (tooltip), and a `data-device-restricted`
 *  marker so styling hooks can target the state. Idempotent — calling
 *  it with a fully-scoped block re-enables the button.
 *
 *  Pure DOM mutation so view-layer callsites can hand it any button
 *  reference (vibe-code submit, "add device",
 *  etc.) under the same gate.
 *  @param {HTMLButtonElement|HTMLElement|null|undefined} button
 *  @param {DeviceCapabilityBlock|null|undefined} block
 *  @param {string} scope
 *  @param {string} disabledTooltip
 */
export function applyScopeGateToButton(button, block, scope, disabledTooltip) {
  if (!button) return;
  const allowed = deviceCapabilityAllows(block, scope);
  if (allowed) {
    if ("disabled" in button) /** @type {any} */ (button).disabled = false;
    button.removeAttribute("aria-disabled");
    button.removeAttribute("title");
    button.removeAttribute("data-device-restricted");
    return;
  }
  if ("disabled" in button) /** @type {any} */ (button).disabled = true;
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("title", disabledTooltip);
  button.setAttribute("data-device-restricted", scope);
}

/** Map a demoServer block to the typed lifecycle. The SINGLE canonical
 *  phase is the source of truth: `live` → up, `error` → still
 *  provisioning (the daemon retries — a terminal error isn't a torn-down
 *  pod), any other ladder phase → provisioning. When no phase has arrived
 *  yet we fall back to the coarse 3-state `status`. Forward-compat: an
 *  unknown value collapses to `"provisioning"` so a client that hasn't
 *  been updated still polls instead of opening an unhealthy pod.
 *  @param {DemoServerBlock|null|undefined} block
 *  @returns {"none"|"provisioning"|"up"|null}
 */
export function demoLifecycle(block) {
  if (!block) return null;
  // Derive from the canonical phase first (single source).
  if (typeof block.phase === "string" && block.phase.length > 0) {
    if (block.phase === "live") return "up";
    return "provisioning";
  }
  // No phase yet — fall back to the coarse lifecycle.
  if (typeof block.status !== "string") return null;
  if (block.status === "up") return "up";
  if (block.status === "none") return "none";
  return "provisioning";
}

/** Map a demoServer lifecycle to a pod-status label the home view
 *  can render. Both `none` and `provisioning` render as "pending"
 *  (waiting affordance); `up` renders as "online". Returns null when
 *  the block is absent.
 *  @param {DemoServerBlock|null|undefined} block
 *  @returns {"pending"|"online"|null}
 */
export function demoPodStatus(block) {
  const lc = demoLifecycle(block);
  if (lc === null) return null;
  return lc === "up" ? "online" : "pending";
}

/** Build one pod descriptor from the server-supplied block. Used by
 *  the demo-mode renderer (Plan A) — when /users/check returns a
 *  `demoServer`, the webapp renders ONE real device backed by this
 *  FQDN.
 *  @param {DemoServerBlock} block
 *  @param {string} username
 *  @returns {{ podId: string, name: string, fqdn: string, status: "pending"|"online" }}
 */
export function samplePodFromDemoServer(block, username) {
  const label = (block.fqdn.split(".")[0] || "Home").toString();
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  return {
    podId: `demo-server-${username}`,
    name,
    fqdn: block.fqdn,
    status: demoPodStatus(block) || "pending",
  };
}

/** POST `/api/users/check` against the Worker.
 *  @param {string} username
 *  @param {{ fetch?: typeof fetch, baseUrl?: string }} [opts]
 *  @returns {Promise<UsersCheckResponse>}
 */
export async function checkUsername(username, opts = {}) {
  const f = opts.fetch || fetch;
  const baseUrl = opts.baseUrl || controlApex();
  const resp = await f(`${baseUrl}/api/users/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!resp.ok) {
    throw new Error(`users/check failed: HTTP ${resp.status}`);
  }
  return resp.json();
}

/** POST `/api/dev/sample-user/{username}/connect` (no auth, no body).
 *  Tells the Worker to (re)provision the Hetzner VPS backing the
 *  demo. 200 = the Worker observed (or already had) a provisioning /
 *  up row; non-2xx throws so the caller can show a precise error.
 *  @param {string} username
 *  @param {{ fetch?: typeof fetch, baseUrl?: string }} [opts]
 */
export async function connectDemoServer(username, opts = {}) {
  const f = opts.fetch || fetch;
  const baseUrl = opts.baseUrl || controlApex();
  const url = `${baseUrl}/api/dev/sample-user/${encodeURIComponent(username)}/connect`;
  const resp = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`connect failed: HTTP ${resp.status} ${text}`);
  }
}

/** POST `/api/dev/sample-user/{username}/cancel` (no auth, no body) —
 *  "Cancel this device" from the install-progress detail page. Public
 *  (a demo account is a no-auth capability) + edge rate-limited; it
 *  ONLY touches demo_users rows. Tears down the active VPS and resets
 *  the demo to the empty state so the UI returns to the list. 200 =
 *  cancelled (or already torn down); non-2xx throws.
 *  @param {string} username
 *  @param {{ fetch?: typeof fetch, baseUrl?: string }} [opts]
 *  @returns {Promise<{ username: string, cancelled: boolean, state: string }>}
 */
export async function cancelDemoServer(username, opts = {}) {
  const f = opts.fetch || fetch;
  const baseUrl = opts.baseUrl || controlApex();
  const url = `${baseUrl}/api/dev/sample-user/${encodeURIComponent(username)}/cancel`;
  const resp = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`cancel failed: HTTP ${resp.status} ${text}`);
  }
  return resp.json();
}

/** Poll `/api/users/check` every [pollIntervalMs] ms until the
 *  embedded `demoServer.status` flips to `"up"`. Returns the final
 *  block. Throws on timeout or when the demoServer block disappears
 *  mid-poll (operator ran delete-sample-user).
 *  @param {string} username
 *  @param {{ fetch?: typeof fetch, baseUrl?: string, pollIntervalMs?: number, timeoutMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 *  @returns {Promise<DemoServerBlock>}
 */
export async function pollUntilDemoServerUp(username, opts = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "provisioning";
  while (Date.now() < deadline) {
    const resp = await checkUsername(username, opts);
    const block = resp.demoServer;
    if (!block) {
      const err = new Error("demo went away mid-poll");
      err.code = "demoServerWentAway";
      throw err;
    }
    lastStatus = block.status;
    if (demoLifecycle(block) === "up") return block;
    await sleep(pollIntervalMs);
  }
  const err = new Error(`still booting (last status: ${lastStatus})`);
  err.code = "timedOut";
  err.lastStatus = lastStatus;
  throw err;
}
