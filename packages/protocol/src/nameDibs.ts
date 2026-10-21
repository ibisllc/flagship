// Custom account names — the dibs claim and the paid name change
// (docs/naming-recovery-and-name-change.md §5–7, decisions of 2026-10-09).
//
// Three signed envelopes, all over plain `|`-joined canonical bytes:
//
//   NameDibsInitiate  — "I, the account <username> with IRK <irkPub>, want to
//                        prove I own <name>.com." `.com` answers with a nonce
//                        and the challenge to publish.
//   NameDibsVerify    — "Check my published proof for (<name>, <nonce>) now."
//   NameChange        — "Move my account from <oldUsername> to <newUsername>",
//                        bound to the account's stable AID so a captured
//                        envelope can't be replayed against another account.
//
// The CHALLENGE a claimant publishes (DNS TXT or /.well-known file) binds the
// name to the claiming IRK and the server's nonce, so a record somebody else
// published can't be replayed by a different key, and an old record can't
// satisfy a new claim:
//
//   challenge = b64url(sha256("flagship/name-dibs/v1|" + name + "|" + irkPubHex + "|" + nonce))

import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { validateNoSepCtrl } from "./canonicalBase.js";
import { base64UrlEncode } from "./builderPairing.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_INITIATE = "flagship/name-dibs-initiate/v1";
const TAG_VERIFY = "flagship/name-dibs-verify/v1";
const TAG_CHALLENGE = "flagship/name-dibs/v1";
const TAG_NAME_CHANGE = "flagship/name-change/v1";

/** The DNS label a claimant publishes the challenge under (`<label>.<name>.com`). */
export const NAME_DIBS_TXT_LABEL = "_flagship-claim";
/** The HTTPS path a claimant may publish the challenge at instead. */
export const NAME_DIBS_WELL_KNOWN_PATH = "/.well-known/flagship-claim";
/** The TXT record / file body prefix (`flagship-claim:<challenge>`). */
export const NAME_DIBS_RECORD_PREFIX = "flagship-claim:";

const enc = (s: string): Bytes => new TextEncoder().encode(s);

export interface NameDibsInitiate {
  /** The claiming account's current username. */
  username: string;
  /** The name being claimed (the label of `<name>.com`). */
  name: string;
  /** The claiming account's IRK pub, lower-case hex. */
  irkPubHex: string;
  issuedAt: number;
}

export interface NameDibsVerify {
  username: string;
  name: string;
  /** The nonce `.com` returned from initiate, lower-case hex. */
  nonce: string;
  issuedAt: number;
}

export interface NameChange {
  /** The account's stable AID pub, lower-case hex. */
  aidPubHex: string;
  oldUsername: string;
  newUsername: string;
  issuedAt: number;
}

function guard(fields: Record<string, string>): void {
  for (const [k, v] of Object.entries(fields)) validateNoSepCtrl(k, v);
}

export function canonicalNameDibsInitiate(r: NameDibsInitiate): Bytes {
  guard({ username: r.username, name: r.name, irkPubHex: r.irkPubHex });
  return enc([TAG_INITIATE, r.username, r.name, r.irkPubHex, r.issuedAt].join("|"));
}

export function canonicalNameDibsVerify(r: NameDibsVerify): Bytes {
  guard({ username: r.username, name: r.name, nonce: r.nonce });
  return enc([TAG_VERIFY, r.username, r.name, r.nonce, r.issuedAt].join("|"));
}

export function canonicalNameChange(r: NameChange): Bytes {
  guard({ aidPubHex: r.aidPubHex, oldUsername: r.oldUsername, newUsername: r.newUsername });
  return enc([TAG_NAME_CHANGE, r.aidPubHex, r.oldUsername, r.newUsername, r.issuedAt].join("|"));
}

/** The exact bytes hashed into the dibs challenge (exported for vectors). */
export function nameDibsChallengePreimage(name: string, irkPubHex: string, nonce: string): Bytes {
  guard({ name, irkPubHex, nonce });
  return enc([TAG_CHALLENGE, name, irkPubHex, nonce].join("|"));
}

/** The value a claimant publishes after `flagship-claim:`. */
export function nameDibsChallenge(name: string, irkPubHex: string, nonce: string): string {
  return base64UrlEncode(sha256(nameDibsChallengePreimage(name, irkPubHex, nonce)));
}

export function signNameDibsInitiate(r: NameDibsInitiate, irk: Keypair): Bytes {
  return ed.sign(canonicalNameDibsInitiate(r), irk.privateKey);
}
export function verifyNameDibsInitiate(r: NameDibsInitiate, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalNameDibsInitiate(r), irkPub);
  } catch {
    return false;
  }
}

export function signNameDibsVerify(r: NameDibsVerify, irk: Keypair): Bytes {
  return ed.sign(canonicalNameDibsVerify(r), irk.privateKey);
}
export function verifyNameDibsVerify(r: NameDibsVerify, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalNameDibsVerify(r), irkPub);
  } catch {
    return false;
  }
}

export function signNameChange(r: NameChange, signer: Keypair): Bytes {
  return ed.sign(canonicalNameChange(r), signer.privateKey);
}
export function verifyNameChange(r: NameChange, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalNameChange(r), pub);
  } catch {
    return false;
  }
}
