// H6 — `.flagshipkey` import must run the TAKEOVER re-pair.
//
// Bringing a device into an account via its backup file is a TAKEOVER, not a
// silent local-identity swap: the cloud must learn the new device is taking
// over so the account's OTHER devices are alerted and can object during the
// grace window. This is the exact security flow mobile runs — the webapp used
// to install a fresh local identity with NO server-side takeover and NO
// grace/objection window, a security-model divergence.
//
// Mirror of Android `KeyfileImportViewModel` (the correct reference — iOS had
// the same bug this file used to have; see below):
//   1. The keyfile was already unwrapped + the recovered UMK installed +
//      the session unlocked (lib/keyfileBackup.restoreFromBackupFile).
//   2. Derive BOTH the OLD IRK (the currently-registered key — v1 under the
//      recovered UMK) and a fresh ROTATED device key (the next version) from
//      the installed seed. The re-pair ROTATES: old != new, and new != the
//      registered key. The NEW (rotated) key signs the envelope.
//   3. INITIATE the re-pair (POST /api/users/:u/re-pair). The grace clock
//      starts server-side; the swap + countdown follow.
//   4. A `401` carrying `totpProof` means the account has a second factor
//      enrolled (which the Worker requires at initiate even for single-device
//      accounts, #52). The import sheet has no second-factor field, so — like
//      mobile — we route the user to the sign-in flow which prompts for it.
//
// ⚠️ BUG FIXED (gym recovery e2e, 2026-06-18): this file used to set
// `oldIrkPub = newIrkPub` (both = the registered v1 IRK), claiming parity with
// iOS. But the re-pair handler (control-plane/rePair.ts) REJECTS that with
// 400 "newIrkPub equals current IRK" ("nothing to swap"). So keyfile-import
// recovery was DEAD on the webapp (and iOS, which made the identical mistake) —
// the re-pair never started. Android does it correctly (rotates old→old,
// new→old+1), which the handler accepts. This now matches Android + the
// loginTakeover credentialed-takeover path (both rotate to TAKEOVER_IRK_VERSION).
//
// The grace countdown + completion reuse loginTakeover.js (graceTimeline /
// completeRePair / finishTakeover) so this stays the testable core: every
// side-effecting collaborator is injected, like loginTakeover.runTakeover.

import {
  initiateRePair,
  isCredentialRequiredError,
  TAKEOVER_IRK_VERSION,
} from "./loginTakeover.js";
import { generateDeviceId } from "./accountMetadata.js";

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
 *  Steps (mirrors the CORRECT Android KeyfileImportViewModel + loginTakeover):
 *    1. OLD IRK = the currently-registered key (v1 under the recovered seed).
 *    2. NEW IRK = a fresh ROTATED device key (TAKEOVER_IRK_VERSION). The NEW
 *       key signs the re-pair-initiate canonical bytes. old != new, and new
 *       != the registered key — so the handler accepts it ("something to swap").
 *    3. INITIATE the re-pair → the grace clock starts server-side.
 *
 *  On a `401 totpProof` (second factor enrolled) throws
 *  {@link SecondFactorRequiredError} so the host routes to sign-in.
 *
 *  Returns `{ username, rePair, deviceId, newIrkVersion }` (the rePair
 *  carries `completesAt` / `graceMs` / `accountType` for the grace countdown;
 *  `newIrkVersion` is the rotated version the completion step should finalize).
 *
 *  @param {object} args
 *  @param {string} args.username                 the imported account name
 *  @param {Uint8Array} args.seed                 the installed UMK seed
 *  @param {(seed: Uint8Array) => Promise<{publicKey: Uint8Array}>} args.deriveIrkFromSeed
 *      derive the OLD (registered) IRK
 *  @param {(seed: Uint8Array, version: number) => Promise<{publicKey: Uint8Array}>} [args.deriveIrkVersioned]
 *      derive the NEW (rotated) device IRK. Falls back to deriveIrkFromSeed only
 *      if absent (legacy callers) — which reproduces the old, server-rejected
 *      old==new shape, so real callers MUST inject this.
 *  @param {(seed: Uint8Array, version: number, bytes: Uint8Array) => Promise<Uint8Array>} [args.signWithIrkVersioned]
 *      sign with the NEW (rotated) IRK
 *  @param {(seed: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} [args.signWithIrk]
 *      legacy fallback signer (used only when signWithIrkVersioned is absent)
 *  @param {(profile: object) => unknown} [args.addProfile]   record the admin device
 *  @param {(b: Uint8Array) => string} [args.bytesToHex]
 *  @param {() => number} [args.now]
 *  @param {typeof fetch} [args.fetch]
 *  @param {string} [args.baseUrl]
 *  @returns {Promise<{username: string, rePair: object, deviceId: string, newIrkVersion: number}>}
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
  const newVersion = TAKEOVER_IRK_VERSION;

  // 1 — OLD IRK = the currently-registered (v1) key under the recovered seed.
  const oldIrk = await args.deriveIrkFromSeed(seed);
  const oldIrkPubHex = toHex(oldIrk.publicKey);

  // 2 — NEW IRK = a fresh ROTATED device key. A fresh device DOES hold the
  //     recovered seed, so it can derive a rotated key — the re-pair must
  //     rotate (the handler rejects new==current). Mirrors Android +
  //     loginTakeover. Fall back to the (old, server-rejected) non-rotating
  //     shape only if no versioned deriver was injected.
  const newIrk = args.deriveIrkVersioned
    ? await args.deriveIrkVersioned(seed, newVersion)
    : await args.deriveIrkFromSeed(seed);
  const newIrkPubHex = toHex(newIrk.publicKey);
  const issuedAt = now();
  const message = canonical([
    TAG_RE_PAIR_INITIATE,
    username,
    newIrkPubHex,
    oldIrkPubHex,
    issuedAt,
  ]);
  // The NEW (rotated) IRK signs — it proves it holds the recovered+rotated key.
  const sig = args.signWithIrkVersioned
    ? await args.signWithIrkVersioned(seed, newVersion, message)
    : await args.signWithIrk(seed, message);

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

  const deviceId = generateDeviceId();
  if (typeof args.addProfile === "function") {
    args.addProfile({
      cloudName: username,
      cloudRootPubHex: oldIrkPubHex,
      accountId: username,
      deviceId,
      deviceCapability: null,
      demoServer: null,
    });
  }

  return { username, rePair, deviceId, newIrkVersion: newVersion };
}
