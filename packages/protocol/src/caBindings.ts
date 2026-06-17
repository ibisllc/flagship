/**
 * CA-signed bindings — the username→pubkey binding the per-user TLS / CA
 * layer issues, and the demo-account directive that tells a client to route
 * the recovery ceremony through the Mock provider.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, and encoding are unchanged, so canonical bytes and signatures
 * remain byte-identical. (Imported by `maintainerCa.ts`.)
 */
import { ed } from "./edSync.js";
import { hex } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_USER_PUBKEY_BINDING = "flagship-ca-binding/v1";
// CA-signed (same key as the pubkey binding). Tells a client that
// `username` is a demo account and the recovery ceremony must run
// through the Mock provider. Signed server-side so a client can't
// self-elect demo behavior. See task #84.
const TAG_DEMO_DIRECTIVE = "flagship/demo-directive/v1";

export interface UserPubKeyBinding {
  version: 1;
  username: string;
  pubKey: Bytes;
  issuedAt: number;
  expiresAt: number;
  /** CA identifier — versioned so we can rotate the CA later. */
  issuer: string;
}

/**
 * Platform statement that `username` is a demo account (task #84).
 * The only behavioral effect a client honors is `useMockRecovery`:
 * route the WebAuthn-PRF recovery ceremony through the Mock provider
 * (Apple/Play review can't drive a real passkey). Everything else
 * stays live. CA-signed + time-boxed so a client can't self-elect
 * demo mode and a captured directive can't be replayed forever.
 */
export interface DemoDirective {
  version: 1;
  username: string;
  useMockRecovery: boolean;
  issuedAt: number;
  expiresAt: number;
  /** CA identifier — versioned so we can rotate the CA later. */
  issuer: string;
}

function canonicalUserPubKeyBinding(b: UserPubKeyBinding): Bytes {
  return new TextEncoder().encode(
    [
      TAG_USER_PUBKEY_BINDING,
      b.version,
      b.username,
      hex(b.pubKey),
      b.issuedAt,
      b.expiresAt,
      b.issuer,
    ].join("|"),
  );
}

export function signUserPubKeyBinding(b: UserPubKeyBinding, ca: Keypair): Bytes {
  return ed.sign(canonicalUserPubKeyBinding(b), ca.privateKey);
}

export function verifyUserPubKeyBinding(
  b: UserPubKeyBinding,
  sig: Bytes,
  caPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalUserPubKeyBinding(b), caPub);
  } catch {
    return false;
  }
}

function canonicalDemoDirective(d: DemoDirective): Bytes {
  return new TextEncoder().encode(
    [
      TAG_DEMO_DIRECTIVE,
      d.version,
      d.username,
      d.useMockRecovery ? 1 : 0,
      d.issuedAt,
      d.expiresAt,
      d.issuer,
    ].join("|"),
  );
}

export function signDemoDirective(d: DemoDirective, ca: Keypair): Bytes {
  return ed.sign(canonicalDemoDirective(d), ca.privateKey);
}

export function verifyDemoDirective(
  d: DemoDirective,
  sig: Bytes,
  caPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalDemoDirective(d), caPub);
  } catch {
    return false;
  }
}
