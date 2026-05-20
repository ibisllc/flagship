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
 */

/** Map the raw status to the typed lifecycle. Forward-compat: an
 *  unknown future value collapses to `"provisioning"` so a client
 *  that hasn't been updated still polls instead of opening an
 *  unhealthy pod.
 *  @param {DemoServerBlock|null|undefined} block
 *  @returns {"none"|"provisioning"|"up"|null}
 */
export function demoLifecycle(block) {
  if (!block || typeof block.status !== "string") return null;
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
  const baseUrl = opts.baseUrl || "https://flagshipserver.com";
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
  const baseUrl = opts.baseUrl || "https://flagshipserver.com";
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
