// Phase 3 — real-account login state machine (single / multi branches).
//
// Drives the credentialed JOIN once the preflight (resolveAccount) has
// told us the account is real (kind === "single" | "multi"). This is the
// account-name-first decision tree's right-hand side
// (docs/login-and-account-redesign.md, "The unified login decision tree"
// + "The admin label & the no-lockout guarantee" + "Recovery TOTP").
//
// Branches:
//   1. recovery.present == false  → a STATE, not an error:
//        single → "No cloud backup on this account. Use a device that
//                  still has access."
//        multi  → "Use another device, or one of your recovery codes."
//   2. single (recovery.present)  → cloud-recovery unwrap → TAKEOVER:
//        7-day-grace explainer → on confirm: persist the recovered
//        seed/profile, INITIATE re-pair (POST /api/users/:u/re-pair),
//        label this device "admin", open the account.
//   3. multi (recovery.present)   → cloud-recovery unwrap + collect a
//        recovery TOTP (6-digit) OR a recovery code → pass it as the
//        re-pair `totpProof` (the Worker REQUIRES it for
//        account_type === "multi") → 24h-grace TAKEOVER → "admin" label.
//
// The recovered seed IS the user key (UMK). The currently-registered
// IRK is the v1 derivation of that seed (`flagship.irk.v1` — what every
// surface registers); the takeover ROTATES to a fresh DEVICE key (the
// next version) so the NEW IRK signs the J.3 envelope while the OLD
// (registered) IRK is the one the swap will displace. "Each install is a
// new device" — the rotated key is this browser's device key.
//
// Grace COUNTDOWN / completion / push / quarantine are Phase 4; this
// module only INITIATES the re-pair (the anti-abuse brake starts
// server-side; the swap happens later). Live PRF crypto stays out of
// scope — `recoverFromCloud` is injected and remains the existing
// Mock/popup sub-origin flow.
//
// All side-effecting collaborators are injected so the branch logic is
// unit-testable without IndexedDB / the DOM / the network / a real
// passkey.

const APEX = "https://flagshipserver.com";

/** The rotation version the takeover's NEW device key derives at. v1 is
 *  the registered (old) IRK; the takeover device owns v2. */
export const TAKEOVER_IRK_VERSION = 2;

/** Label stamped on the device a takeover produces. Its REACH is the
 *  whole user namespace (the no-lockout guarantee); the stable id stays
 *  a normal `ukey.dkey`. Reach enforcement is Phase 4+ / server-side —
 *  here we record the label on the local profile. */
export const ADMIN_LABEL = "admin";

/** Canonical-bytes tag for the re-pair initiate envelope. MUST match
 *  packages/protocol/src/auth.ts TAG_RE_PAIR_INITIATE and the Worker. */
export const TAG_RE_PAIR_INITIATE = "flagship/re-pair-initiate/v1";

/** `|`-joined, UTF-8 — same as every signed message. */
function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

function defaultBytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Branch selector for a REAL (single/multi) resolution. Pure: no DOM,
 *  no network. Maps an {@link AccountResolution} to the takeover action.
 *
 *    - "no-recovery" → render the inline STATE (no cloud backup).
 *    - "single"      → 7-day-grace takeover (no second factor).
 *    - "multi"       → 24h-grace takeover, recovery TOTP/code REQUIRED.
 *
 *  @param {{kind?: string, recovery?: {present?: boolean}}|null|undefined} resolution
 *  @returns {"no-recovery"|"single"|"multi"}
 */
export function classifyRealAccount(resolution) {
  const present = !!resolution?.recovery?.present;
  if (!present) return "no-recovery";
  return resolution?.kind === "multi" ? "multi" : "single";
}

/** The inline-state copy for the no-cloud-backup branch. Pure so tests
 *  pin the exact wording per the doc. NOT an error/404 — a node in the
 *  decision tree. */
export function noRecoveryState(resolution) {
  const single = resolution?.kind !== "multi";
  return {
    title: "No cloud backup on this account",
    message: single
      ? "No cloud backup on this account. Use a device that still has access."
      : "Use another device, or one of your recovery codes.",
  };
}

/** Validate a recovery second-factor input. A 6-digit string is a TOTP;
 *  anything else non-empty is treated as a recovery code (the Worker
 *  decides which by trying TOTP first, then the code list). Returns the
 *  `{ code, method }` proof shape the re-pair body carries, or null.
 *  @param {string} raw
 *  @returns {{ code: string, method: "totp"|"recovery" }|null}
 */
export function parseRecoveryFactor(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if (/^[0-9]{6}$/.test(v)) return { code: v, method: "totp" };
  return { code: v, method: "recovery" };
}

/** Prompt for a multi-device recovery TOTP (or recovery code) via an
 *  injected modal. Returns the proof, or null if the user cancelled /
 *  entered nothing. Kept thin so the orchestrator can require it before
 *  touching the re-pair endpoint.
 *  @param {(opts: object) => Promise<string|null>} inlinePrompt
 *  @returns {Promise<{code: string, method: "totp"|"recovery"}|null>}
 */
export async function collectRecoveryFactor(inlinePrompt) {
  const raw = await inlinePrompt({
    title: "Recovery code",
    message:
      "This account requires a second factor. Enter your 6-digit recovery TOTP, or one of your recovery codes.",
    placeholder: "123456",
    validate: (v) => (parseRecoveryFactor(v) ? null : "enter a 6-digit code or a recovery code"),
  });
  return parseRecoveryFactor(raw ?? "");
}

/** POST the J.3 re-pair-initiate envelope. The NEW IRK signs canonical
 *  bytes over (username, newIrkPub, oldIrkPub, issuedAt). `totpProof`
 *  rides BESIDE the signed envelope (it is NOT in the canonical bytes —
 *  codes are ephemeral) and is REQUIRED by the Worker when the account
 *  is multi-device.
 *
 *  Returns the parsed body (`{ ok, completesAt, graceMs, accountType,
 *  totpRequired, quarantineMs }`). Throws on any non-2xx so the caller
 *  can surface it.
 *
 *  @param {{
 *    username: string,
 *    newIrkPubHex: string,
 *    oldIrkPubHex: string,
 *    signHex: string,          hex Ed25519 sig by the NEW IRK
 *    totpProof?: {code: string, method: "totp"|"recovery"},
 *    issuedAt?: number,
 *    fetch?: typeof fetch,
 *    baseUrl?: string,
 *  }} args
 *  @returns {Promise<object>}
 */
export async function initiateRePair(args) {
  const f = args.fetch || fetch;
  const baseUrl = args.baseUrl || APEX;
  const issuedAt = args.issuedAt ?? Date.now();
  const body = {
    request: {
      username: args.username,
      newIrkPub: args.newIrkPubHex,
      oldIrkPub: args.oldIrkPubHex,
      issuedAt,
    },
    signature: args.signHex,
    ...(args.totpProof ? { totpProof: args.totpProof } : {}),
  };
  const resp = await f(
    `${baseUrl}/api/users/${encodeURIComponent(args.username)}/re-pair`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const txt = await safeText(resp);
    throw new Error(`re-pair initiate failed (${resp.status}): ${txt}`.trim());
  }
  return resp.json();
}

/** Run a credentialed TAKEOVER for a real account.
 *
 *  Steps (single == multi minus the second factor):
 *    1. Cloud-recovery unwrap → the original UMK seed (injected
 *       `recoverFromCloud`; stays the Mock/popup sub-origin flow).
 *    2. Persist the recovered seed under a fresh local wrap +
 *       unlock the session under the resolved username.
 *    3. Derive the OLD IRK (v1 == registered) and a fresh NEW device
 *       IRK (rotated version) from the SAME seed; the NEW IRK signs the
 *       re-pair-initiate canonical bytes.
 *    4. INITIATE the re-pair (the grace clock starts server-side; the
 *       swap + countdown are Phase 4). Multi passes the collected
 *       `totpProof` — the Worker rejects a multi initiate without it.
 *    5. Record the device as `admin` on the local profile (reach is
 *       enforced server-side later; this is the local label).
 *    6. Open the account (dispatch to Home).
 *
 *  @param {object} resolution         a single|multi AccountResolution
 *  @param {{
 *    recoverFromCloud: (username: string) => Promise<Uint8Array>,
 *    bootstrapFromExistingSeed: (passphrase: string, seed: Uint8Array) => Promise<void>,
 *    unlockSession: (seed: Uint8Array, username?: string) => Promise<void>|void,
 *    deriveIrkFromSeed: (seed: Uint8Array) => Promise<{publicKey: Uint8Array}>,
 *    deriveIrkVersioned: (seed: Uint8Array, version: number) => Promise<{publicKey: Uint8Array}>,
 *    signWithIrkVersioned: (seed: Uint8Array, version: number, bytes: Uint8Array) => Promise<Uint8Array>,
 *    totpProof?: {code: string, method: "totp"|"recovery"},
 *    bytesToHex?: (b: Uint8Array) => string,
 *    makePassphrase?: () => string,
 *    setUsername?: (username: string) => void,
 *    addProfile?: (profile: object, opts?: object) => unknown,
 *    dispatchInitialView?: () => Promise<void>|void,
 *    fetch?: typeof fetch,
 *    baseUrl?: string,
 *    now?: () => number,
 *  }} deps
 *  @returns {Promise<{username: string, seed: Uint8Array, rePair: object, deviceLabel: string}>}
 */
export async function runTakeover(resolution, deps) {
  const username = resolution?.username;
  if (!username) throw new Error("runTakeover: missing username");
  if (!resolution?.recovery?.present) {
    throw new Error("runTakeover: account has no cloud backup");
  }
  const isMulti = resolution.kind === "multi";
  if (isMulti && !deps.totpProof) {
    // Defense-in-depth: multi REQUIRES a second factor before we even
    // touch the re-pair endpoint. The caller (loginRealAccount) collects
    // it; this guard makes runTakeover safe to call directly too.
    throw new Error("runTakeover: multi-device takeover requires a recovery TOTP or recovery code");
  }

  const toHex = deps.bytesToHex || defaultBytesToHex;
  const makePassphrase = deps.makePassphrase || randomLocalPassphrase;
  const now = deps.now ?? (() => Date.now());

  // 1 — credentialed unwrap of the cloud-stored UMK seed.
  const seed = await deps.recoverFromCloud(username);
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("runTakeover: recovered seed is malformed");
  }

  // 2 — persist + unlock under the resolved username.
  await deps.bootstrapFromExistingSeed(makePassphrase(), seed);
  if (typeof deps.setUsername === "function") deps.setUsername(username);
  await deps.unlockSession(seed, username);

  // 3 — OLD IRK = registered (v1); NEW IRK = fresh device key (rotated).
  const oldIrk = await deps.deriveIrkFromSeed(seed);
  const newIrk = await deps.deriveIrkVersioned(seed, TAKEOVER_IRK_VERSION);
  const oldIrkPubHex = toHex(oldIrk.publicKey);
  const newIrkPubHex = toHex(newIrk.publicKey);
  const issuedAt = now();
  // The NEW IRK signs (it proves it holds the recovered+rotated key).
  const sig = await deps.signWithIrkVersioned(
    seed,
    TAKEOVER_IRK_VERSION,
    canonical([TAG_RE_PAIR_INITIATE, username, newIrkPubHex, oldIrkPubHex, issuedAt]),
  );

  // 4 — INITIATE the re-pair (grace clock starts server-side).
  const rePair = await initiateRePair({
    username,
    newIrkPubHex,
    oldIrkPubHex,
    signHex: toHex(sig),
    totpProof: isMulti ? deps.totpProof : undefined,
    issuedAt,
    fetch: deps.fetch,
    baseUrl: deps.baseUrl,
  });

  // 5 — record the device as `admin` on the local profile.
  if (typeof deps.addProfile === "function") {
    deps.addProfile({
      cloudName: username,
      cloudRootPubHex: oldIrkPubHex,
      deviceLabel: ADMIN_LABEL,
      deviceCapability: null,
      demoServer: null,
    });
  }

  // 6 — open the account.
  if (typeof deps.dispatchInitialView === "function") {
    await deps.dispatchInitialView();
  }

  return { username, seed, rePair, deviceLabel: ADMIN_LABEL };
}

/** Orchestrate the full single/multi login branch off a resolution.
 *
 *    - no-recovery → render the inline STATE (injected `showState`).
 *    - single      → 7-day-grace explainer (injected `confirm`) →
 *                    {@link runTakeover}.
 *    - multi       → 24h-grace explainer → collect the recovery
 *                    TOTP/code (injected `prompt`) → {@link runTakeover}
 *                    with the `totpProof`.
 *
 *  Returns a tagged outcome so callers + tests assert which branch ran:
 *    { outcome: "no-recovery" }
 *    { outcome: "cancelled" }            (user backed out of the explainer/factor)
 *    { outcome: "takeover", takeover }   (re-pair initiated; admin labelled)
 *
 *  @param {object} resolution
 *  @param {{
 *    showState: (state: {title: string, message: string}) => Promise<void>|void,
 *    confirm: (opts: object) => Promise<boolean>,
 *    prompt: (opts: object) => Promise<string|null>,
 *    takeoverDeps: object,            forwarded to runTakeover (minus totpProof)
 *  }} deps
 *  @returns {Promise<{outcome: string, takeover?: object}>}
 */
export async function loginRealAccount(resolution, deps) {
  const branch = classifyRealAccount(resolution);

  if (branch === "no-recovery") {
    await deps.showState(noRecoveryState(resolution));
    return { outcome: "no-recovery" };
  }

  // Grace explainer — single is 7-day, multi is 24h + a second factor.
  const single = branch === "single";
  const confirmed = await deps.confirm({
    title: single ? "Take over this account" : "Take over this account (2FA)",
    message: single
      ? "This becomes the admin device for the account after a 7-day grace period. Your other devices are alerted and can object during that window."
      : "This becomes the admin device after a 24-hour grace period. You'll need a recovery code; your other devices are alerted and can object during that window.",
    okLabel: "Take over",
    cancelLabel: "Cancel",
  });
  if (!confirmed) return { outcome: "cancelled" };

  // Multi REQUIRES a recovery TOTP / recovery code BEFORE the re-pair.
  let totpProof;
  if (!single) {
    totpProof = await collectRecoveryFactor(deps.prompt);
    if (!totpProof) return { outcome: "cancelled" };
  }

  const takeover = await runTakeover(resolution, {
    ...deps.takeoverDeps,
    totpProof,
  });
  return { outcome: "takeover", takeover };
}

/** Random URL-safe local-wrap passphrase. Like the demo path, the
 *  recovered-seed's local at-rest passphrase is generated rather than
 *  typed — the cloud-recovery credential is the real gate, and a typed
 *  passphrase here would just be friction. */
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
