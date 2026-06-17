// H6 — `.flagshipkey` import must run the TAKEOVER re-pair.
//
// Bringing a device into an account via its backup file is a TAKEOVER, not a
// silent local-identity swap: the cloud must learn the new device is taking
// over so the account's OTHER devices are alerted and can object during the
// grace window. This is the exact security flow mobile runs — the webapp used
// to install a fresh local identity with NO server-side takeover and NO
// grace/objection window, a security-model divergence.
//
// Mirror of iOS `KeyfileImportViewModel` / Android `KeyfileImportViewModel`:
//   1. The keyfile was already unwrapped + the recovered UMK installed +
//      the session unlocked (lib/keyfileBackup.restoreFromBackupFile).
//   2. Derive the IRK from the just-installed seed. A fresh device does NOT
//      hold the displaced (old) key, so the old-pubkey slot carries the NEW
//      pubkey too — the Worker keys the takeover on the username row (this is
//      byte-identical to iOS, where `oldPubHex = newPubHex`).
//   3. INITIATE the re-pair (POST /api/users/:u/re-pair). The grace clock
//      starts server-side; the swap + countdown follow.
//   4. A `401` carrying `totpProof` means the account has a second factor
//      enrolled (which the Worker requires at initiate even for single-device
//      accounts, #52). The import sheet has no second-factor field, so — like
//      mobile — we route the user to the sign-in flow which prompts for it.
//
// The grace countdown + completion reuse loginTakeover.js (graceTimeline /
// completeRePair / finishTakeover) so this stays the testable core: every
// side-effecting collaborator is injected, like loginTakeover.runTakeover.

import { initiateRePair, isCredentialRequiredError } from "./loginTakeover.js";

/** Label stamped on the device a keyfile-import takeover produces — the same
 *  "admin" reach as the login takeover + the mobile import. */
export const ADMIN_LABEL = "admin";

/** Canonical-bytes tag for the re-pair initiate envelope. MUST match
 *  packages/protocol/src/recovery.ts TAG_RE_PAIR_INITIATE + loginTakeover.js. */
export const TAG_RE_PAIR_INITIATE = "flagship/re-pair-initiate/v1";

/** `|`-joined, UTF-8 — same as every signed message. */
function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

function defaultBytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The user-facing guidance shown when the cloud says a second factor is
 *  enrolled (401 + totpProof) — byte-identical to the iOS/Android copy so the
 *  three surfaces tell the user the same thing. The import sheet can't collect
 *  the factor, so it points at the sign-in flow which can. */
export const SECOND_FACTOR_GUIDANCE =
  'This account has a second factor enrolled. Use "I already have an account" to sign in — it will ask for your authenticator or recovery code.';

/** A tagged sentinel error so the caller can render the second-factor
 *  guidance instead of a raw failure. */
export class SecondFactorRequiredError extends Error {
  constructor(message = SECOND_FACTOR_GUIDANCE) {
    super(message);
    this.name = "SecondFactorRequiredError";
    this.code = "second-factor-required";
  }
}

/** Run the takeover re-pair for a freshly-imported keyfile account.
 *
 *  Steps (mirrors KeyfileImportViewModel on both mobile surfaces):
 *    1. Derive the IRK from the installed seed (NEW key).
 *    2. Sign the re-pair-initiate canonical bytes; old slot == new pubkey.
 *    3. INITIATE the re-pair → the grace clock starts server-side.
 *
 *  On a `401 totpProof` (second factor enrolled) throws
 *  {@link SecondFactorRequiredError} so the host routes to sign-in.
 *
 *  Returns `{ username, rePair, deviceLabel }` (the rePair carries
 *  `completesAt` / `graceMs` / `accountType` for the grace countdown).
 *
 *  @param {object} args
 *  @param {string} args.username                 the imported account name
 *  @param {Uint8Array} args.seed                 the installed UMK seed
 *  @param {(seed: Uint8Array) => Promise<{publicKey: Uint8Array}>} args.deriveIrkFromSeed
 *  @param {(seed: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 *  @param {(profile: object) => unknown} [args.addProfile]   record the admin device
 *  @param {(b: Uint8Array) => string} [args.bytesToHex]
 *  @param {() => number} [args.now]
 *  @param {typeof fetch} [args.fetch]
 *  @param {string} [args.baseUrl]
 *  @returns {Promise<{username: string, rePair: object, deviceLabel: string}>}
 */
export async function runKeyfileImportTakeover(args) {
  const username = args?.username;
  if (!username) throw new Error("runKeyfileImportTakeover: missing username");
  const seed = args?.seed;
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("runKeyfileImportTakeover: installed seed is malformed");
  }
  const toHex = args.bytesToHex || defaultBytesToHex;
  const now = args.now ?? (() => Date.now());

  // 1 — NEW IRK from the just-installed seed.
  const newIrk = await args.deriveIrkFromSeed(seed);
  const newIrkPubHex = toHex(newIrk.publicKey);
  // 2 — a fresh device doesn't hold the displaced key, so the OLD slot
  //     carries the NEW pubkey too (mirrors iOS `oldPubHex = newPubHex`).
  const oldIrkPubHex = newIrkPubHex;
  const issuedAt = now();
  const sig = await args.signWithIrk(
    seed,
    canonical([TAG_RE_PAIR_INITIATE, username, newIrkPubHex, oldIrkPubHex, issuedAt]),
  );

  // 3 — INITIATE. No totpProof: a keyfile decrypt is single-device proof,
  //     exactly like mobile. A 401 means a second factor IS enrolled.
  let rePair;
  try {
    rePair = await initiateRePair({
      username,
      newIrkPubHex,
      oldIrkPubHex,
      signHex: toHex(sig),
      issuedAt,
      fetch: args.fetch,
      baseUrl: args.baseUrl,
    });
  } catch (err) {
    if (isCredentialRequiredError(err)) throw new SecondFactorRequiredError();
    throw err;
  }

  // Record the device as `admin` on the local profile (reach is enforced
  // server-side later; this is the local label, like loginTakeover).
  if (typeof args.addProfile === "function") {
    args.addProfile({
      cloudName: username,
      cloudRootPubHex: oldIrkPubHex,
      deviceLabel: ADMIN_LABEL,
      deviceCapability: null,
      demoServer: null,
    });
  }

  return { username, rePair, deviceLabel: ADMIN_LABEL };
}
