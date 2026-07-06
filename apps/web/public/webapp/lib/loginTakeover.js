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
// Phase 3 INITIATES the re-pair (the anti-abuse brake starts server-
// side; the swap happens later). Phase 4 adds the grace COUNTDOWN
// ({@link graceTimeline}) + COMPLETION ({@link completeRePair} /
// {@link finishTakeover}) — once `now >= completesAt` the user can
// "Take over now", which POSTs /re-pair/complete (idempotent, no
// signature gate) to swap the IRK and open the account fully.
// Web Push integration, cross-device add-device QR, and live PRF crypto
// stay out of scope — `recoverFromCloud` is injected and remains the
// existing Mock/popup sub-origin flow.
//
// All side-effecting collaborators are injected so the branch logic is
// unit-testable without IndexedDB / the DOM / the network / a real
// passkey.

import { controlApex } from "./apex.js";

const APEX = controlApex();

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
 *  is multi-device — or (#52) single-device with a second factor
 *  enrolled (the 401 carries `credentialRequired: ["totp"|"recovery-code"]`).
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
    // #52 — surface the status + parsed body on the error so callers
    // (runTakeover) can detect the credential-required 401 and prompt
    // for the second factor instead of dead-ending. Message format is
    // unchanged for existing callers/tests.
    const err = new Error(`re-pair initiate failed (${resp.status}): ${txt}`.trim());
    err.status = resp.status;
    try {
      err.body = JSON.parse(txt);
    } catch {
      err.body = undefined;
    }
    throw err;
  }
  return resp.json();
}

/** #52 — true when an initiate failure is the Worker saying "this
 *  account has a second factor enrolled; prove it". Mirrors the
 *  replaceDeviceCeremony detector: 401 + (`credentialRequired` in the
 *  body OR the load-bearing "totpProof" substring in the error). */
export function isCredentialRequiredError(err) {
  if (!err || err.status !== 401) return false;
  const body = err.body;
  if (Array.isArray(body?.credentialRequired)) return true;
  return typeof body?.error === "string" && body.error.includes("totpProof");
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
 *  Multi-profile keying: when `setActiveKeystoreProfile` is injected the
 *  keystore's active profile is pointed at `username` BEFORE the recovered
 *  seed is wrapped, so a takeover into a SECOND account in the same browser
 *  lands the recovered device key under that account's OWN keystore record
 *  — never clobbering an existing profile's wrapped UMK.
 *
 *  @param {object} resolution         a single|multi AccountResolution
 *  @param {{
 *    recoverFromCloud: (username: string) => Promise<Uint8Array>,
 *    setActiveKeystoreProfile?: (cloudName: string) => unknown,
 *    bootstrapFromExistingSeed: (passphrase: string, seed: Uint8Array) => Promise<void>,
 *    unlockSession: (seed: Uint8Array, username?: string) => Promise<void>|void,
 *    deriveIrkFromSeed: (seed: Uint8Array) => Promise<{publicKey: Uint8Array}>,
 *    deriveIrkVersioned: (seed: Uint8Array, version: number) => Promise<{publicKey: Uint8Array}>,
 *    signWithIrkVersioned: (seed: Uint8Array, version: number, bytes: Uint8Array) => Promise<Uint8Array>,
 *    totpProof?: {code: string, method: "totp"|"recovery"},
 *    requestSecondFactor?: (methods: string[]) => Promise<{code: string, method: "totp"|"recovery"}|null>,
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

  // 2 — persist + unlock under the resolved username. Point the keystore
  // at this profile FIRST so the recovered seed is wrapped under the new
  // profile's own record (multi-profile keying — never clobber profile A).
  if (typeof deps.setActiveKeystoreProfile === "function") {
    deps.setActiveKeystoreProfile(username);
  }
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

  // 4 — INITIATE the re-pair (grace clock starts server-side). The
  // proof rides whenever the caller collected one — #52 made the
  // Worker require it on SINGLE accounts too when a second factor is
  // enrolled, so the proof is no longer multi-only.
  const initiateArgs = {
    username,
    newIrkPubHex,
    oldIrkPubHex,
    signHex: toHex(sig),
    totpProof: deps.totpProof,
    issuedAt,
    fetch: deps.fetch,
    baseUrl: deps.baseUrl,
  };
  let rePair;
  try {
    rePair = await initiateRePair(initiateArgs);
  } catch (err) {
    // #52 — the Worker says a second factor is enrolled on this
    // (single-device) account. If the host injected a collector,
    // prompt + retry ONCE with the proof riding the body, exactly
    // like the multi path / replaceDeviceCeremony. No collector (old
    // host) → rethrow unchanged.
    if (
      !isCredentialRequiredError(err) ||
      deps.totpProof ||
      typeof deps.requestSecondFactor !== "function"
    ) {
      throw err;
    }
    const methods = Array.isArray(err.body?.credentialRequired)
      ? err.body.credentialRequired
      : ["totp", "recovery-code"];
    const proof = await deps.requestSecondFactor(methods);
    if (!proof) {
      const cancelled = new Error("runTakeover: second factor entry was cancelled");
      cancelled.code = "second-factor-cancelled";
      throw cancelled;
    }
    rePair = await initiateRePair({ ...initiateArgs, totpProof: proof });
  }

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

/** L4 — "Keep my other devices working": bring THIS recovered device into
 *  the account WITHOUT rotating the identity. Parity with iOS
 *  PostRecoveryChoiceScreen's default (.keepBothDevices): the device
 *  derives the SAME account IRK (v1) from the recovered seed, so every
 *  already-paired device keeps working untouched — no rotation, no grace,
 *  no /re-pair POST, no network. Strictly does LESS than {@link runTakeover}.
 *
 *  @param {object} resolution  a single|multi AccountResolution
 *  @param {object} deps        the same takeover-deps bundle runTakeover
 *                              takes (the rotation/re-pair fields go unused)
 *  @returns {Promise<{username: string, seed: Uint8Array, deviceLabel: string}>}
 */
export async function runKeepBoth(resolution, deps) {
  const username = resolution?.username;
  if (!username) throw new Error("runKeepBoth: missing username");
  if (!resolution?.recovery?.present) {
    throw new Error("runKeepBoth: account has no cloud backup");
  }
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const makePassphrase = deps.makePassphrase || randomLocalPassphrase;

  // 1 — credentialed unwrap of the cloud-stored UMK seed.
  const seed = await deps.recoverFromCloud(username);
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("runKeepBoth: recovered seed is malformed");
  }

  // 2 — persist + unlock under the resolved username. Point the keystore
  // at this profile FIRST so the recovered seed is wrapped under its own
  // record (multi-profile keying — never clobber another profile).
  if (typeof deps.setActiveKeystoreProfile === "function") {
    deps.setActiveKeystoreProfile(username);
  }
  await deps.bootstrapFromExistingSeed(makePassphrase(), seed);
  if (typeof deps.setUsername === "function") deps.setUsername(username);
  await deps.unlockSession(seed, username);

  // 3 — NO rotation: this device's reach IS the account IRK (v1). Record
  // it on the local profile under that registered key. We never derive a
  // rotated key, never sign a re-pair, never touch the network — that is
  // the whole point of keep-both vs. a takeover.
  const accountIrk = await deps.deriveIrkFromSeed(seed);
  if (typeof deps.addProfile === "function") {
    deps.addProfile({
      cloudName: username,
      cloudRootPubHex: toHex(accountIrk.publicKey),
      deviceLabel: ADMIN_LABEL,
      deviceCapability: null,
      demoServer: null,
    });
  }

  // 4 — open the account.
  if (typeof deps.dispatchInitialView === "function") {
    await deps.dispatchInitialView();
  }

  return { username, seed, deviceLabel: ADMIN_LABEL };
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

  // L4 — post-recovery device disposition (parity with iOS
  // PostRecoveryChoiceScreen). When the host injects a chooser, let the
  // user pick how this recovered device relates to their other devices:
  //   - "keep-both"    → no rotation; {@link runKeepBoth}. Other devices
  //                      stay connected.
  //   - "replace-lost" → the takeover below (rotate + re-pair) — unchanged.
  // Backward-compatible: with no chooser injected, recovery is the
  // takeover it has always been.
  if (typeof deps.chooseDisposition === "function") {
    const choice = await deps.chooseDisposition({ resolution, branch });
    if (!choice) return { outcome: "cancelled" };
    if (choice === "keep-both") {
      const keepBoth = await runKeepBoth(resolution, deps.takeoverDeps);
      return { outcome: "keep-both", keepBoth };
    }
    // Any other choice ("replace-lost") falls through to the takeover.
  }

  // Grace explainer — single is 3-day, multi is 24h + a second factor.
  const single = branch === "single";
  const confirmed = await deps.confirm({
    title: single ? "Take over this account" : "Take over this account (2FA)",
    message: single
      ? "This becomes the admin device for the account after a 3-day grace period. Your other devices are alerted and can object during that window."
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

  // #52 — SINGLE accounts with an enrolled second factor are told so
  // by the Worker's 401 at initiate; wire the same collector in as the
  // on-demand prompt so runTakeover can retry with the proof. (Multi
  // pre-collects above; the on-demand path never fires for it.)
  let takeover;
  try {
    takeover = await runTakeover(resolution, {
      ...deps.takeoverDeps,
      totpProof,
      requestSecondFactor: async () => collectRecoveryFactor(deps.prompt),
    });
  } catch (err) {
    if (err?.code === "second-factor-cancelled") return { outcome: "cancelled" };
    throw err;
  }
  return { outcome: "takeover", takeover };
}

// ───────────────────────────────────────────────────────────────────
// Phase 4 — grace-period takeover COMPLETION + countdown.
//
// runTakeover (Phase 3) INITIATES the re-pair: the grace clock starts
// server-side and returns { completesAt, graceMs, ... }. Phase 4 takes
// that result and (a) renders a live countdown ("This device takes over
// in N — your other devices are being alerted") with a "Take over now"
// action that arms once `now >= completesAt`, and (b) POSTs
// /api/users/:u/re-pair/complete to finalize the IRK swap.
//
// The complete endpoint (packages/control-plane/src/rePair.ts
// handleCompleteRePair) is a PUBLIC read — idempotent, no signature
// gate. Its body is optional (W6 `refreshedGrants` only) so the webapp
// posts an empty body; the server CAS-swaps iff `completesAt <= now`
// AND the row wasn't objected. Status map:
//   200 → swapped (carries newIrkPub, swappedAt, quarantineUntil, …)
//   404 → no pending row (already completed earlier == done, or expired
//         + swept). We treat 404 as a benign "already-finalized."
//   409 → objected by the OLD IRK, OR the current IRK already moved
//         (a concurrent complete won). Surfaced as "objected/expired."
//   425 → Too Early (grace window hasn't elapsed). The countdown
//         shouldn't let the user reach this, but we surface it cleanly.
//   403 → kept in the objected/expired bucket for forward-compat (the
//         spec calls out 403/409 as the clean-surface cases).
// ───────────────────────────────────────────────────────────────────

/** Phase 4 — derive the countdown view-model from an initiate result.
 *  Pure: no DOM, no timers. The host re-calls this on each tick with a
 *  fresh `now` to repaint the label + flip the "Take over now" button.
 *
 *  `graceModel` ("3d" single / "24h-totp" multi) only colours the copy;
 *  the authoritative deadline is always `completesAt` from the server.
 *
 *  @param {{completesAt?: number, graceMs?: number, accountType?: string}} rePair
 *  @param {number} [now]
 *  @returns {{
 *    ready: boolean,             now >= completesAt — "Take over now" armed
 *    remainingMs: number,        clamped at 0
 *    completesAt: number,
 *    graceModel: "3d"|"24h-totp",
 *    label: string,              human countdown line
 *    actionEnabled: boolean,     alias of `ready` (button disabled state)
 *  }}
 */
export function graceTimeline(rePair, now = Date.now()) {
  const completesAt = Number(rePair?.completesAt ?? 0);
  const accountType = rePair?.accountType === "multi" ? "multi" : "single";
  const graceModel = accountType === "multi" ? "24h-totp" : "3d";
  const remainingMs = Math.max(0, completesAt - now);
  const ready = now >= completesAt;
  const label = ready
    ? "The grace period has elapsed — you can take over now."
    : `This device takes over in ${formatRemaining(remainingMs)} — your other devices are being alerted.`;
  return {
    ready,
    remainingMs,
    completesAt,
    graceModel,
    label,
    actionEnabled: ready,
  };
}

/** Human "Nd Nh" / "Nh Nm" / "Nm Ns" remaining string. Pure; no
 *  locale dependency so tests pin the exact wording across surfaces. */
export function formatRemaining(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** POST /api/users/:u/re-pair/complete to finalize the IRK swap.
 *
 *  The endpoint is a public read (idempotent, no signature gate); the
 *  webapp posts an empty JSON body. On a graceful-wipe cloud the caller
 *  MAY pass `refreshedGrants` (W6) — out of scope for the webapp's own
 *  takeover, but threaded through so a future caller can.
 *
 *  Returns a tagged outcome instead of throwing on the expected
 *  not-2xx branches so the UI renders a state, never a raw error:
 *    { outcome: "completed", body }           200
 *    { outcome: "already-completed" }          404 (swapped earlier / swept)
 *    { outcome: "objected", status, message }  403 / 409
 *    { outcome: "too-early", completesAt, secondsRemaining } 425
 *    { outcome: "expired", message }           410 (#52 completion
 *        window passed — the row was swept; re-initiate, don't finalize)
 *  Any OTHER status throws (genuine transport / server fault).
 *
 *  @param {{
 *    username: string,
 *    refreshedGrants?: object[],
 *    fetch?: typeof fetch,
 *    baseUrl?: string,
 *  }} args
 *  @returns {Promise<{outcome: string, [k: string]: unknown}>}
 */
export async function completeRePair(args) {
  const f = args.fetch || fetch;
  const baseUrl = args.baseUrl || APEX;
  const username = args?.username;
  if (!username) throw new Error("completeRePair: missing username");
  const hasGrants = Array.isArray(args.refreshedGrants) && args.refreshedGrants.length > 0;
  const resp = await f(
    `${baseUrl}/api/users/${encodeURIComponent(username)}/re-pair/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hasGrants ? { refreshedGrants: args.refreshedGrants } : {}),
    },
  );
  if (resp.ok) {
    return { outcome: "completed", body: await resp.json().catch(() => ({})) };
  }
  if (resp.status === 404) {
    // No pending row: either we already swapped on a prior call, or the
    // window expired + the row was swept. Either way the takeover is
    // (or can be re-)driven — treat as benign-done for the UI.
    return { outcome: "already-completed" };
  }
  if (resp.status === 403 || resp.status === 409) {
    const body = await resp.json().catch(() => ({}));
    return {
      outcome: "objected",
      status: resp.status,
      message:
        typeof body?.error === "string"
          ? body.error
          : "This recovery was stopped or has already been claimed by another device.",
    };
  }
  if (resp.status === 425) {
    const body = await resp.json().catch(() => ({}));
    return {
      outcome: "too-early",
      completesAt: typeof body?.completesAt === "number" ? body.completesAt : undefined,
      secondsRemaining:
        typeof body?.secondsRemaining === "number" ? body.secondsRemaining : undefined,
    };
  }
  if (resp.status === 410) {
    // #52 — the completion window (7d past completesAt) elapsed; the
    // Worker swept the stale row. The recovery must be RE-initiated —
    // unlike 404 this is NOT "already done", so don't finalize.
    const body = await resp.json().catch(() => ({}));
    return {
      outcome: "expired",
      message:
        typeof body?.error === "string"
          ? body.error
          : "This recovery expired before it was completed. Start again.",
    };
  }
  const txt = await safeText(resp);
  throw new Error(`re-pair complete failed (${resp.status}): ${txt}`.trim());
}

/** Drive a takeover to FINAL: poll/complete once the grace has elapsed,
 *  then finalize the v2 IRK locally and open the account fully.
 *
 *  The countdown UI calls this from the "Take over now" button (enabled
 *  by {@link graceTimeline}.ready). On `completed` / `already-completed`
 *  we run the injected `finalizeV2Irk` (activate the rotated device key
 *  as the live signing key) and `openAccount` (dispatch Home). The
 *  objected / too-early branches return the tagged outcome WITHOUT
 *  finalizing so the host can show the right state.
 *
 *  @param {object} takeover           the runTakeover return ({username, rePair, …})
 *  @param {{
 *    finalizeV2Irk?: () => Promise<void>|void,
 *    openAccount?: () => Promise<void>|void,
 *    refreshedGrants?: object[],
 *    fetch?: typeof fetch,
 *    baseUrl?: string,
 *    now?: () => number,
 *  }} deps
 *  @returns {Promise<{outcome: string, [k: string]: unknown}>}
 */
export async function finishTakeover(takeover, deps = {}) {
  const username = takeover?.username;
  if (!username) throw new Error("finishTakeover: missing username");
  const now = deps.now ?? (() => Date.now());
  const completesAt = Number(takeover?.rePair?.completesAt ?? 0);
  if (now() < completesAt) {
    // Defense-in-depth: the button shouldn't be reachable before the
    // deadline, but never POST a complete the server will 425 on.
    return {
      outcome: "too-early",
      completesAt,
      secondsRemaining: Math.ceil((completesAt - now()) / 1000),
    };
  }
  const result = await completeRePair({
    username,
    refreshedGrants: deps.refreshedGrants,
    fetch: deps.fetch,
    baseUrl: deps.baseUrl,
  });
  if (result.outcome === "completed" || result.outcome === "already-completed") {
    if (typeof deps.finalizeV2Irk === "function") await deps.finalizeV2Irk();
    if (typeof deps.openAccount === "function") await deps.openAccount();
  }
  return result;
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
