// H6 — `.flagshipkey` import must run the TAKEOVER re-pair.
//
// Bringing a device into an account via its backup file is a TAKEOVER, not a
// silent local-identity swap: the cloud must learn the new device is taking
// over so the account's OTHER devices are alerted during the grace window
// (an alert, not a veto: only the incoming key can cancel). This is the exact
// security flow mobile runs.
//
//   1. The key file was unwrapped (lib/keyfileBackup.unwrapUmkFromKeyfile).
//      Nothing is installed in this browser until the initiate is accepted, so
//      a refusal leaves the browser as it was.
//   2. Find the OLD IRK: the key `.com` holds for the account, among every
//      client's derivation of the seed (lib/irkLineage.js). An account made on
//      Android or iOS does not hold the web v1, which is why an Android key
//      file was refused with "oldIrkPub does not match the current registered
//      IRK" (Windows acceptance 2026-11-05, Failure 4).
//   3. NEW IRK = this app's own scheme at the matched version + 1. The re-pair
//      ROTATES: the handler rejects new == current ("nothing to swap").
//   4. INITIATE the re-pair (POST /api/users/:u/re-pair) with both signatures:
//      the NEW key's, and the OLD key's as the credential `.com` verifies
//      against the key it stores. A `401` carrying `totpProof` means a second
//      factor is enrolled: route the user to the sign-in flow.
//
// The grace countdown + completion reuse loginTakeover.js (graceTimeline /
// finishTakeover).

import { initiateRePair, isCredentialRequiredError } from "./loginTakeover.js";
import { generateDeviceId } from "./accountMetadata.js";
import { controlApex } from "./apex.js";
import {
  OWN_IRK_SCHEME,
  fetchRegisteredIrkPub,
  findRegisteredIrk,
  irkKeyFor,
  nextIrkVersion,
} from "./irkLineage.js";

import { tr } from "./i18n.js";
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
  tr("This account has a second factor enrolled. Choose \"Connect to an existing account\" and sign in with your account name — it will ask for your authenticator or recovery code.");

/** A tagged sentinel error so the caller can render the second-factor
 *  guidance instead of a raw failure. */
export class SecondFactorRequiredError extends Error {
  constructor(message = SECOND_FACTOR_GUIDANCE) {
    super(message);
    this.name = "SecondFactorRequiredError";
    this.code = "second-factor-required";
  }
}

/** Why an import was refused, as a sentence for the person. Nothing was stored
 *  in this browser when one of these is thrown. */
export class KeyfileImportRefusedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KeyfileImportRefusedError";
    this.code = code;
  }
}

export function keyfileImportRefusal(code, username) {
  switch (code) {
    case "account-not-found":
      return new KeyfileImportRefusedError(code, tr("There is no account named {0}. Check that this is the right key file.", username));
    case "key-mismatch":
      return new KeyfileImportRefusedError(code, tr("This key file doesn't open {0} any more. It belongs to another account, or the account's key was replaced after the file was made.", username));
    case "unreachable":
      return new KeyfileImportRefusedError(code, tr("Couldn't reach Flagship to check this key file. Nothing was changed in this browser. Check your connection and try again."));
    default:
      return new KeyfileImportRefusedError("initiate-failed", tr("Flagship didn't accept this key file for {0}. Nothing was changed in this browser. Try again in a few minutes.", username));
  }
}

/** Run the takeover re-pair for a key file, before anything is installed.
 *
 *  Throws {@link SecondFactorRequiredError} on a `401 totpProof`, the
 *  RateLimitedError on a 429 (its message is the sentence), and
 *  {@link KeyfileImportRefusedError} for every other refusal.
 *
 *  Returns `{ username, rePair, deviceId, newIrkVersion, profile }`: the rePair
 *  carries `completesAt` / `graceMs` for the countdown, `newIrkVersion` is the
 *  web-scheme version the completion signs with and finalizes.
 *
 *  @param {object} args
 *  @param {string} args.username                 the key file's account name
 *  @param {Uint8Array} args.seed                 the key file's UMK seed
 *  @param {string} [args.registeredIrkPubHex]    skip the lookup (tests)
 *  @param {(profile: object) => unknown} [args.addProfile]
 *  @param {(b: Uint8Array) => string} [args.bytesToHex]
 *  @param {() => number} [args.now]
 *  @param {typeof fetch} [args.fetch]
 *  @param {string} [args.baseUrl]
 *  @returns {Promise<{username: string, rePair: object, deviceId: string, newIrkVersion: number, profile: object}>}
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
  const baseUrl = args.baseUrl || controlApex();

  let registered = args.registeredIrkPubHex;
  if (!registered) {
    try {
      registered = await fetchRegisteredIrkPub(username, { fetch: args.fetch || fetch, baseUrl });
    } catch (e) {
      throw keyfileImportRefusal(e?.status === 404 ? "account-not-found" : "unreachable", username);
    }
  }

  // OLD = the registered key, whichever client made it. Only keys derived from
  // this file's seed are tried, so `.com`'s answer can only pick among them.
  const oldIrk = await findRegisteredIrk(seed, registered);
  if (!oldIrk) throw keyfileImportRefusal("key-mismatch", username);

  // NEW = this browser's device key, one version past the registered one.
  const newVersion = nextIrkVersion(oldIrk);
  const newIrk = await irkKeyFor(seed, OWN_IRK_SCHEME, newVersion);
  if (newIrk.pubHex === oldIrk.pubHex) throw keyfileImportRefusal("initiate-failed", username);

  const issuedAt = now();
  const message = canonical([
    TAG_RE_PAIR_INITIATE,
    username,
    newIrk.pubHex,
    oldIrk.pubHex,
    issuedAt,
  ]);
  const sig = await newIrk.sign(message);
  const oldIrkSig = await oldIrk.sign(message);

  let rePair;
  try {
    rePair = await initiateRePair({
      username,
      newIrkPubHex: newIrk.pubHex,
      oldIrkPubHex: oldIrk.pubHex,
      signHex: toHex(sig),
      oldIrkSignatureHex: toHex(oldIrkSig),
      issuedAt,
      fetch: args.fetch,
      baseUrl,
    });
  } catch (err) {
    if (isCredentialRequiredError(err)) throw new SecondFactorRequiredError();
    if (err?.rateLimited) throw err;
    throw keyfileImportRefusal("initiate-failed", username);
  }

  const deviceId = generateDeviceId();
  const profile = {
    cloudName: username,
    cloudRootPubHex: oldIrk.pubHex,
    accountId: username,
    deviceId,
    deviceCapability: null,
    demoServer: null,
  };
  if (typeof args.addProfile === "function") args.addProfile(profile);

  return { username, rePair, deviceId, newIrkVersion: newVersion, profile };
}
