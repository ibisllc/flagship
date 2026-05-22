// Open-account — standalone account creation, decoupled from server
// provisioning.
//
// An account is an IDENTITY, not a server (docs/login-and-account-
// redesign.md, principle 1 + Phase 2). Opening an account =
//   1. reserve a username (the standalone, idempotent
//      `flagship/claim-username/v1` claim — no server needed), bound to
//   2. this device's IRK (the device key generated at bootstrap), then
//   3. land in the normal app shell with ZERO servers.
//
// A *server* (pod) is a separate, later, possibly-plural resource added
// from Home. So this module does the claim that used to live buried
// inside `views/create-server.js`'s `mintInstallBlobBundle` — pulled out
// so the username claim happens at "open account" time, not at
// "create server" time.
//
// The claim is idempotent: re-running it (or running it after the
// create-server path already claimed) is a 409 the Worker treats as
// success — so retries and the legacy create-path are both safe.
//
// All side-effecting collaborators are injected so this is unit-testable
// without IndexedDB / the DOM / the network.

/** Login/identity handle is a bare label: lowercase letters/digits, no
 *  dots, no hyphens. Mirror of state.js / bootstrap.js / control-plane
 *  labels. */
const USERNAME_RE = /^[a-z0-9]{1,63}$/;

/** Canonical-bytes tag for the standalone username claim. MUST match
 *  `views/create-server.js` (TAG_CLAIM) and the Worker. */
export const TAG_CLAIM = "flagship/claim-username/v1";

/** Encode canonical-bytes parts the same way every signed message does:
 *  `|`-joined, UTF-8. Mirror of create-server.js `canonical()`. */
function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

/** True iff `username` is a syntactically valid bare account handle. */
export function isValidUsername(username) {
  return typeof username === "string" && USERNAME_RE.test(username);
}

/** POST the standalone, idempotent username claim. A 409 means the name
 *  is already bound to this same IRK (re-run / legacy create-path
 *  already claimed it) — that's success, not failure. Any other non-2xx
 *  throws.
 *
 *  @param {string} username        bare handle
 *  @param {Uint8Array} irkPub      this device's IRK public key
 *  @param {(canonicalBytes: Uint8Array) => Promise<Uint8Array>} sign
 *         signs canonical-bytes with the session UMK→IRK
 *  @param {{ fetch?: typeof fetch, bytesToHex?: (b: Uint8Array) => string }} [deps]
 *  @returns {Promise<{ status: number, alreadyClaimed: boolean }>}
 */
export async function claimUsername(username, irkPub, sign, deps = {}) {
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const irkPubHex = toHex(irkPub);
  const issuedAt = Date.now();
  const sig = await sign(canonical([TAG_CLAIM, username, irkPubHex, issuedAt]));
  const resp = await f("/api/username/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { username, irkPub: irkPubHex, issuedAt },
      signature: toHex(sig),
    }),
  });
  if (!resp.ok && resp.status !== 409) {
    const body = await safeText(resp);
    throw new Error(`claim failed (${resp.status}): ${body}`);
  }
  return { status: resp.status, alreadyClaimed: resp.status === 409 };
}

/** Open an account: claim the (already-picked) username against this
 *  device's IRK, persist the username + a server-less profile, and open
 *  the app shell. No server is created — the user lands on Home with an
 *  empty server list + an "add your first server" CTA.
 *
 *  Preconditions: the session is unlocked (device key generated at
 *  bootstrap) — `session.umk` + `session.irk` are present. The caller
 *  validates the username via {@link isValidUsername} first.
 *
 *  Multi-profile keying: when `persistSeedForProfile` is injected the
 *  session UMK is re-persisted under the NEW profile's keystore record
 *  (keyed by `username`) BEFORE the local profile is added — so a second
 *  account opened in the same browser gets its OWN device-key record and
 *  never clobbers the first profile's wrapped UMK. The first account
 *  opened simply re-keys the bootstrap (DEFAULT) record onto its handle.
 *
 *  @param {string} username
 *  @param {{
 *    session: { umk: Uint8Array, irk: { publicKey: Uint8Array } },
 *    signWithIrk: (umk: Uint8Array, canonicalBytes: Uint8Array) => Promise<Uint8Array>,
 *    bytesToHex?: (b: Uint8Array) => string,
 *    fetch?: typeof fetch,
 *    setUsername?: (username: string) => void,
 *    addProfile?: (profile: object, opts?: object) => unknown,
 *    persistSeedForProfile?: (seed: Uint8Array, cloudName: string, passphrase: string) => Promise<unknown>,
 *    makePassphrase?: () => string,
 *    dispatchInitialView?: () => Promise<void>|void,
 *  }} deps
 *  @returns {Promise<{ username: string, alreadyClaimed: boolean }>}
 */
export async function openAccount(username, deps) {
  if (!isValidUsername(username)) {
    throw new Error("username must be lowercase letters and digits only");
  }
  const session = deps?.session;
  if (!session || !session.umk || !session.irk) {
    throw new Error("generate a device key first");
  }

  const sign = (bytes) => deps.signWithIrk(session.umk, bytes);
  const { alreadyClaimed } = await claimUsername(
    username,
    session.irk.publicKey,
    sign,
    { fetch: deps.fetch, bytesToHex: deps.bytesToHex },
  );

  // Bind the identity locally: username persisted + a server-less
  // profile (the device key IS the binding — the claim above tied the
  // username to session.irk).
  if (typeof deps.setUsername === "function") deps.setUsername(username);

  // Multi-profile keying: re-persist the session UMK under THIS profile's
  // keystore record (set active to the new cloudName first) so adding a
  // second account never clobbers the first profile's device key. Done
  // BEFORE addProfile so the keystore record exists before the profile is
  // listed/made active.
  if (typeof deps.persistSeedForProfile === "function") {
    const makePassphrase = deps.makePassphrase || randomLocalPassphrase;
    await deps.persistSeedForProfile(session.umk, username, makePassphrase());
  }

  if (typeof deps.addProfile === "function") {
    const toHex = deps.bytesToHex || defaultBytesToHex;
    deps.addProfile({
      cloudName: username,
      cloudRootPubHex: toHex(session.irk.publicKey),
      deviceLabel: null,
      deviceCapability: null,
      demoServer: null,
    });
  }

  // Open the account into the normal app shell (Home → empty server
  // list → "add your first server").
  if (typeof deps.dispatchInitialView === "function") {
    await deps.dispatchInitialView();
  }

  return { username, alreadyClaimed };
}

function defaultBytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Random URL-safe local at-rest wrap passphrase for the per-profile
 *  keystore record. The username claim (Ed25519-signed by the device key)
 *  is the real identity gate; a typed local passphrase here would just be
 *  friction on the open-account path. Mirrors loginTakeover.js. */
function randomLocalPassphrase() {
  const bytes = (globalThis.crypto || crypto).getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
