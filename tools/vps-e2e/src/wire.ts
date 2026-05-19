/**
 * Wire helpers — the EXACT request shapes + canonical-bytes the phone
 * simulator (`apps/web/public/dev/create-server.js`) and the `.com`
 * control plane agree on. Mirroring it byte-for-byte is load-bearing:
 * the same canonical-bytes the Worker re-derives to verify the IRK
 * signature. If this drifts from the live wire format the live run
 * fails loudly at the `.com` boundary (never silently).
 *
 * We re-use `@flagship/protocol` only for the Ed25519 primitive (via
 * the injected IdentityHelper); the canonical join is `parts.join("|")`
 * UTF-8 encoded, identical to the simulator.
 */

export const TAG_CLAIM = "flagship/claim-username/v1";
export const TAG_AUTH_CODE = "flagship/auth-code/v1";
export const TAG_INSTALL_BLOB = "flagship/install-blob/v1";
export const TAG_RCK_REGISTER = "flagship/rck-register/v1";

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Canonical bytes = the `|`-joined parts, UTF-8 encoded. */
export function canonical(parts: (string | number)[]): Uint8Array {
  return new TextEncoder().encode(parts.join("|"));
}

/** RFC-1035 single label, lowercased — same regex as the simulator. */
export const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Mirror the simulator's 26-char hex serial generator. */
export function genSerial(rand: (n: number) => Uint8Array): string {
  const r = rand(10);
  let s = "01";
  for (const x of r) s += x.toString(16).padStart(2, "0").toUpperCase();
  return s.slice(0, 26);
}

export interface AuthCode {
  version: number;
  serial: string;
  username: string;
  serverName: string;
  serverDomain: string;
  delegatedPubKeyHex: string;
  userPubKeyHex: string;
  issuedAt: number;
  expiresAt: number;
}

/** Exact /api/username/claim body. */
export function claimBody(
  username: string,
  irkPubHex: string,
  issuedAt: number,
  signatureHex: string,
): unknown {
  return {
    request: { username, irkPub: irkPubHex, issuedAt },
    signature: signatureHex,
  };
}

export function claimCanonical(
  username: string,
  irkPubHex: string,
  issuedAt: number,
): Uint8Array {
  return canonical([TAG_CLAIM, username, irkPubHex, issuedAt]);
}

export function authCodeCanonical(c: AuthCode): Uint8Array {
  return canonical([
    TAG_AUTH_CODE,
    c.version,
    c.serial,
    c.username,
    c.serverName,
    c.serverDomain,
    c.delegatedPubKeyHex,
    c.userPubKeyHex,
    c.issuedAt,
    c.expiresAt,
  ]);
}

/** Exact /api/auth-code/issue body. */
export function authCodeIssueBody(c: AuthCode, signatureHex: string): unknown {
  return {
    code: {
      version: c.version,
      serial: c.serial,
      username: c.username,
      serverName: c.serverName,
      serverDomain: c.serverDomain,
      delegatedPubKey: c.delegatedPubKeyHex,
      userPubKey: c.userPubKeyHex,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    },
    signature: signatureHex,
  };
}

export function rckRegisterCanonical(
  username: string,
  serverDomain: string,
  rckPubHex: string,
  issuedAt: number,
): Uint8Array {
  return canonical([
    TAG_RCK_REGISTER,
    username,
    serverDomain,
    rckPubHex,
    issuedAt,
  ]);
}

/** Exact /api/routing/register-rck body. */
export function rckRegisterBody(
  username: string,
  serverDomain: string,
  rckPubHex: string,
  issuedAt: number,
  signatureHex: string,
): unknown {
  return {
    request: {
      username,
      subdomain: serverDomain,
      rckPubKey: rckPubHex,
      issuedAt,
    },
    signature: signatureHex,
  };
}

export interface InstallBlobParts {
  serverDomain: string;
  username: string;
  serverName: string;
  phoneDelegatedPubKeyHex: string;
  registrationUrl: string;
  authCode: AuthCode;
  authCodeUserSignatureHex: string;
  issuedAt: number;
  expiresAt: number;
  installerGitRef: string;
  rckPubKeyHex: string;
}

export function installBlobCanonical(b: InstallBlobParts): Uint8Array {
  return canonical([
    TAG_INSTALL_BLOB,
    1,
    b.serverDomain,
    b.username,
    b.serverName,
    b.phoneDelegatedPubKeyHex,
    b.registrationUrl,
    b.authCode.serial,
    b.authCode.userPubKeyHex,
    b.authCodeUserSignatureHex,
    b.issuedAt,
    b.expiresAt,
    b.installerGitRef,
    b.rckPubKeyHex,
  ]);
}

/** Exact /api/build-tickets/issue body. */
export function buildTicketIssueBody(
  b: InstallBlobParts,
  blobSignatureHex: string,
  ttlMs: number,
): unknown {
  return {
    blob: {
      version: 1,
      serverDomain: b.serverDomain,
      username: b.username,
      serverName: b.serverName,
      phoneDelegatedPubKey: b.phoneDelegatedPubKeyHex,
      registrationUrl: b.registrationUrl,
      authCode: {
        version: b.authCode.version,
        serial: b.authCode.serial,
        username: b.authCode.username,
        serverName: b.authCode.serverName,
        serverDomain: b.authCode.serverDomain,
        delegatedPubKey: b.authCode.delegatedPubKeyHex,
        userPubKey: b.authCode.userPubKeyHex,
        issuedAt: b.authCode.issuedAt,
        expiresAt: b.authCode.expiresAt,
      },
      authCodeUserSignature: b.authCodeUserSignatureHex,
      issuedAt: b.issuedAt,
      expiresAt: b.expiresAt,
      installerGitRef: b.installerGitRef,
      rckPubKey: b.rckPubKeyHex,
    },
    signature: blobSignatureHex,
    ttlMs,
  };
}
