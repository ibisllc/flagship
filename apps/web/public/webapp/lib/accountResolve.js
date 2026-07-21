// Login / join preflight — the account-name-first access-control read.
//
// The sign-in space is access-control EVALUATION, not a web fetch: we
// read *what credentials and factors exist for the named account* and
// branch on them. A raw 404 here is a category error — every "absent"
// is a node in the decision tree, never an HTTP error. So the wire
// (`GET /api/account/resolve/<username>`) returns **200 always**:
// a missing account is `kind:"unknown"`, never a 404.
//
// Mirror of:
//   - packages/control-plane/src/accountResolve.ts (AccountResolution,
//     graceModel derivation, kind)
//   - apps/mobile/ios/.../accountResolve (LoginViewModel)
//   - apps/mobile/android/.../accountResolve
// per the lockstep rule + the Mock-matches-Worker-wire invariant.
//
// See docs/login-and-account-redesign.md ("The unified login decision
// tree" + "The keystone: a consolidated preflight endpoint").

/** @typedef {import("./usersCheck.js").DemoServerBlock} DemoServerBlock */

/** @typedef {"demo"|"single"|"multi"|"unknown"} AccountKind */

/** Server-derived recovery-speed hint so every client renders identical
 *  copy without re-deriving the account-type matrix.
 *  @typedef {"instant"|"3d"|"24h-totp"|"none"} GraceModel
 */

/** @typedef {Object} AccountRecoveryFactor
 *  @property {boolean} present
 *  @property {boolean} hasFetchGate
 *  @property {string=} credentialId
 */

/** Shared response type — mirrors `AccountResolution` in
 *  packages/control-plane/src/accountResolve.ts EXACTLY (lockstep).
 *  @typedef {Object} AccountResolution
 *  @property {string} username        normalized handle the lookup ran against
 *  @property {boolean} exists
 *  @property {AccountKind} kind
 *  @property {AccountRecoveryFactor} recovery
 *  @property {boolean} totpEnrolled
 *  @property {DemoServerBlock=} demoServer    present only for demo accounts
 *  @property {GraceModel} graceModel
 */

import { controlApex } from "./apex.js";
import { generateDeviceId } from "./accountMetadata.js";

/** Login field is a bare handle: 3–30 lowercase letters/digits, interior single
 *  dashes OK (no leading/trailing), no dots, no `--`. Mirror of control-plane
 *  labels.ts (docs/service-addressing-double-dash.md). */
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/** A locally-synthesized `unknown` resolution. We never have to call the
 *  network for an obviously-invalid handle, and we still render a STATE
 *  (not an error) — same shape the Worker returns for a miss.
 *  @param {string} username
 *  @returns {AccountResolution}
 */
function localUnknown(username) {
  return {
    username,
    exists: false,
    kind: "unknown",
    recovery: { present: false, hasFetchGate: false },
    totpEnrolled: false,
    graceModel: "none",
  };
}

/** True iff `username` is a syntactically valid bare login handle. Dashed
 *  handles ARE valid logins now (random names are `<adjective>-<noun>`), so this
 *  accepts interior single dashes but still rejects `--` (the slug↔creator
 *  delimiter). Network-skip fast-path for an obviously-invalid handle.
 *  @param {string} username
 *  @returns {boolean}
 */
export function isBareLoginHandle(username) {
  return (
    typeof username === "string" &&
    USERNAME_RE.test(username) &&
    !username.includes("--")
  );
}

/** GET `/api/account/resolve/<username>` — the login/join preflight.
 *
 *  Returns the parsed {@link AccountResolution}. The endpoint returns
 *  **200 always**, so a non-2xx here is a genuine transport/server
 *  failure (rate-limit, 5xx) and is surfaced as a thrown Error for the
 *  caller to toast — it is NOT a "missing account" (that is
 *  `kind:"unknown"` in a 200 body).
 *
 *  @param {string} username
 *  @param {{ fetch?: typeof fetch, baseUrl?: string }} [opts]
 *  @returns {Promise<AccountResolution>}
 */
export async function resolveAccount(username, opts = {}) {
  const f = opts.fetch || fetch;
  const baseUrl = opts.baseUrl || controlApex();
  const url = `${baseUrl}/api/account/resolve/${encodeURIComponent(username)}`;
  const resp = await f(url, { method: "GET" });
  if (resp.status === 429) {
    const retry = resp.headers?.get?.("retry-after");
    throw new Error(
      retry ? `rate limited — retry in ${retry}s` : "rate limited — slow down",
    );
  }
  if (!resp.ok) {
    throw new Error(`account/resolve failed: HTTP ${resp.status}`);
  }
  return resp.json();
}

/** Pure branch selector for the login decision tree. Maps an
 *  {@link AccountResolution} to the action the entry view must take.
 *  Kept pure (no DOM, no network) so the demo-vs-unknown-vs-recover
 *  logic is unit-testable in isolation.
 *
 *    - "demo"    → activate the sandbox directly; NO passkey, NO popup.
 *    - "unknown" → render the "no account by that name" STATE.
 *    - "recover" → fall through to the credentialed recovery flow
 *                  (single/multi). Phase 3 splits these further.
 *
 *  @param {AccountResolution|null|undefined} resolution
 *  @returns {"demo"|"unknown"|"recover"}
 */
export function classifyResolution(resolution) {
  if (!resolution || resolution.kind === "unknown" || !resolution.exists) {
    return "unknown";
  }
  if (resolution.kind === "demo") return "demo";
  return "recover";
}

/** Random URL-safe passphrase. A demo device's local wrap passphrase is
 *  never typed or shown — demo crypto is a no-op and the username is the
 *  capability — so we generate one purely to satisfy the keystore's
 *  local at-rest wrap. It stays in the closure of the activation call
 *  and is discarded; the seed is what `unlockSession` keeps.
 *  @returns {string}
 */
function randomLocalPassphrase() {
  const bytes = (globalThis.crypto || crypto).getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Activate a demo account as a freshly-attached device.
 *
 *  Demo join is a SPECIAL CASE OF RECOVERY whose crypto checks are
 *  no-ops: knowing the username is the entire capability. So we skip the
 *  passkey/popup entirely and just:
 *    1. mint a fresh local device identity (seed → keystore wrap),
 *    2. persist the demo profile (username + demoServer block),
 *    3. unlock the session under the new seed,
 *    4. open the account (dispatch to the initial view → Home).
 *
 *  Each install is a new device (per the redesign): we always generate a
 *  fresh seed rather than reclaiming any past key.
 *
 *  All side-effecting collaborators are injected so this is unit-
 *  testable without IndexedDB / the DOM.
 *
 *  Multi-profile keying: when `setActiveKeystoreProfile` is injected the
 *  keystore is pointed at this demo's cloud BEFORE the fresh device key is
 *  generated, so joining a second demo in the same browser stores its key
 *  under its own record (never clobbers an existing profile).
 *
 *  @param {AccountResolution} resolution   a `kind:"demo"` resolution
 *  @param {{
 *    bootstrapNewIdentity: (passphrase: string) => Promise<Uint8Array>,
 *    setActiveKeystoreProfile?: (cloudName: string) => unknown,
 *    unlockSession: (seed: Uint8Array, username?: string) => Promise<void>|void,
 *    addProfile?: (profile: object, opts?: object) => unknown,
 *    dispatchInitialView?: () => Promise<void>|void,
 *    setUsername?: (username: string) => void,
 *    makePassphrase?: () => string,
 *  }} deps
 *  @returns {Promise<{ username: string, seed: Uint8Array }>}
 */
export async function activateDemoAccount(resolution, deps) {
  if (!resolution || resolution.kind !== "demo") {
    throw new Error("activateDemoAccount: not a demo resolution");
  }
  const username = resolution.username;
  if (!username) throw new Error("activateDemoAccount: missing username");

  if (typeof deps.setActiveKeystoreProfile === "function") {
    deps.setActiveKeystoreProfile(username);
  }
  const makePassphrase = deps.makePassphrase || randomLocalPassphrase;
  const seed = await deps.bootstrapNewIdentity(makePassphrase());

  if (typeof deps.setUsername === "function") deps.setUsername(username);

  if (typeof deps.addProfile === "function") {
    deps.addProfile({
      cloudName: username,
      accountId: username,
      deviceId: generateDeviceId(),
      accountDisplayName: null,
      deviceDisplayName: null,
      deviceCapability: null,
      demoServer: resolution.demoServer ?? null,
    });
  }

  await deps.unlockSession(seed, username);

  if (typeof deps.dispatchInitialView === "function") {
    await deps.dispatchInitialView();
  }

  return { username, seed };
}
