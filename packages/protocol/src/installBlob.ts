/**
 * Install-blob / auth-code domain — the phone-signed recipe (`InstallBlob`)
 * and its inner IRK-signed credential (`AuthCode`), the box's own
 * server-register proof (`ServerRegisterRequest`), plus the auth-code
 * revoke + release-server-name envelopes.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; field order,
 * tags, guards, and the backward-compatible `bootUnlockMode` / `de=`
 * extensions are unchanged, so all canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_AUTH_CODE = "flagship/auth-code/v1";
const TAG_INSTALL_BLOB = "flagship/install-blob/v1";
const TAG_SERVER_REGISTER = "flagship/server-register/v1";
const TAG_AUTH_CODE_REVOKE = "flagship/auth-code-revoke/v1";
const TAG_RELEASE_SERVER_NAME = "flagship/release-server-name/v1";

export interface AuthCode {
  version: 1;
  serial: string;
  username: string;
  serverName: string;
  serverDomain: string;
  delegatedPubKey: Bytes;
  userPubKey: Bytes;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthCodeRevocation {
  serial: string;
  username: string;
  issuedAt: number;
}

/**
 * IRK-signed "cancel the server / free the name" request. Releases a
 * reserved-but-unactivated (or active, with owner auth) server name so
 * the leftmost `<server>` label under the user can be claimed again.
 *
 * Unlike {@link AuthCodeRevocation} (keyed by a single auth-code serial),
 * this is keyed by the full `serverDomain` so .com can release every
 * piece of the reservation that pins the name — the RCK routing record
 * (the thing that actually makes a failed name un-reusable), any active
 * auth-codes for that domain, and the registered server record if the
 * box ever phoned home. The signature is verified against the username's
 * registered IRK, so only the account owner can release their own name.
 */
export interface ReleaseServerName {
  username: string;
  serverDomain: string;
  issuedAt: number;
}

/**
 * InstallBlob v2.
 *
 * v1→v2: dropped `issuedAt` and `expiresAt`. The only meaningful TTL
 * on a recipe is `authCode.expiresAt` (gated by .com at
 * /api/server/register). The blob's own time fields were never
 * enforced post-issue and existed only as defense-in-depth that no
 * code path actually defended. See ADR / commit body for context.
 */
export interface InstallBlob {
  version: 2;
  serverDomain: string;
  username: string;
  serverName: string;
  phoneDelegatedPubKey: Bytes;
  registrationUrl: string;
  authCode: AuthCode;
  authCodeUserSignature: Bytes;
  /**
   * Git ref the bootstrap will pull installer/ from at first boot. Tag
   * preferred (`v0.1.0`); branch (`main`) acceptable for early
   * releases. Empty string treated as "main". The phone signs over
   * this so a compromised network/control-plane cannot swap the
   * installer revision.
   */
  installerGitRef: string;
  /**
   * Routing-Control-Key public key for this server's subdomain. Daemon
   * uses it to verify SetRoutingTarget mutations it sees in the
   * routing record (defense-in-depth against a compromised .com).
   */
  rckPubKey: Bytes;
  /**
   * Boot-unlock policy chosen at server creation (see
   * docs/security-phone-as-unlock-endpoint.md §7a). The phone signs over
   * it so a compromised network/.com cannot DOWNGRADE an "approve" server
   * to "auto".
   *
   *   - "auto"    — the box self-unlocks via a box-sealed lease (.com holds
   *                 ciphertext only; revocable from the phone). Default.
   *   - "approve" — the box cannot self-unlock; every boot waits for a
   *                 phone-gated, biometric approval (the relay). For
   *                 critical servers.
   *
   * OPTIONAL for backward compatibility: a blob WITHOUT this field
   * canonicalizes exactly as before (so existing signatures still verify);
   * absence is treated as "auto" by consumers.
   */
  bootUnlockMode?: "auto" | "approve";
  /**
   * Disk-encryption policy chosen at server creation. The phone signs over it
   * so a compromised network/.com can't DOWNGRADE an encrypted box to plaintext
   * by tampering with the recipe in transit (the burner verifies the blob
   * signature, so a flipped value would fail to verify).
   *
   *   - "luks" (DEFAULT): the root is LUKS-encrypted; the unlock key is sealed
   *     to the phone (auto-unlock over the network at early boot). The core
   *     security property — data-at-rest is unreadable without phone authority.
   *   - "none": the root is NOT encrypted. The box boots with no network-gated
   *     unlock, so it survives a Wi-Fi-only environment where the initramfs
   *     can't reach the network to fetch the sealed key — at the cost of
   *     at-rest encryption. An explicit, user-chosen weakening; never a default.
   *
   * OPTIONAL + backward-compatible: a blob WITHOUT this field canonicalizes
   * exactly as before; absence is treated as "luks" (encrypted).
   */
  diskEncryption?: "luks" | "none";
}

export interface ServerRegisterRequest {
  authCode: AuthCode;
  authCodeUserSignature: Bytes;
  serverIdentityPubKey: Bytes;
  issuedAt: number;
  nonce: Bytes;
}

function canonicalAuthCode(c: AuthCode): Bytes {
  legacyFieldGuard("serial", c.serial);
  legacyFieldGuard("username", c.username);
  legacyFieldGuard("serverName", c.serverName);
  legacyFieldGuard("serverDomain", c.serverDomain);
  return new TextEncoder().encode(
    [
      TAG_AUTH_CODE,
      c.version,
      c.serial,
      c.username,
      c.serverName,
      c.serverDomain,
      hex(c.delegatedPubKey),
      hex(c.userPubKey),
      c.issuedAt,
      c.expiresAt,
    ].join("|"),
  );
}

function canonicalInstallBlob(b: InstallBlob): Bytes {
  legacyFieldGuard("serverDomain", b.serverDomain);
  legacyFieldGuard("username", b.username);
  legacyFieldGuard("serverName", b.serverName);
  legacyFieldGuard("registrationUrl", b.registrationUrl);
  legacyFieldGuard("authCode.serial", b.authCode.serial);
  legacyFieldGuard("installerGitRef", b.installerGitRef);
  const parts: (string | number)[] = [
    TAG_INSTALL_BLOB,
    b.version,
    b.serverDomain,
    b.username,
    b.serverName,
    hex(b.phoneDelegatedPubKey),
    b.registrationUrl,
    b.authCode.serial,
    hex(b.authCode.userPubKey),
    hex(b.authCodeUserSignature),
    b.installerGitRef,
    hex(b.rckPubKey),
  ];
  // Backward-compatible extension: a blob WITHOUT bootUnlockMode produces
  // the exact pre-existing canonical bytes (old signatures keep verifying).
  // When present it is appended, so the signer commits to it — a relay
  // cannot strip the field (signature would fail) nor downgrade the value.
  if (b.bootUnlockMode !== undefined) parts.push(b.bootUnlockMode);
  // Same backward-compatible append. The `de=` prefix can't collide with a
  // bootUnlockMode ("auto"/"approve") token. The signer commits to it, so a
  // relay can neither strip it (sig fails) nor flip "luks"→"none" to downgrade
  // an encrypted box to plaintext.
  if (b.diskEncryption !== undefined) {
    parts.push(`de=${b.diskEncryption}`);
  }
  return new TextEncoder().encode(parts.join("|"));
}

function canonicalServerRegister(r: ServerRegisterRequest): Bytes {
  legacyFieldGuard("authCode.serial", r.authCode.serial);
  legacyFieldGuard("authCode.serverDomain", r.authCode.serverDomain);
  return new TextEncoder().encode(
    [
      TAG_SERVER_REGISTER,
      r.authCode.serial,
      r.authCode.serverDomain,
      hex(r.serverIdentityPubKey),
      r.issuedAt,
      hex(r.nonce),
    ].join("|"),
  );
}

function canonicalAuthCodeRevoke(r: AuthCodeRevocation): Bytes {
  legacyFieldGuard("serial", r.serial);
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [TAG_AUTH_CODE_REVOKE, r.serial, r.username, r.issuedAt].join("|"),
  );
}

function canonicalReleaseServerName(r: ReleaseServerName): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("serverDomain", r.serverDomain);
  return new TextEncoder().encode(
    [TAG_RELEASE_SERVER_NAME, r.username, r.serverDomain, r.issuedAt].join("|"),
  );
}

export function signAuthCode(c: AuthCode, irk: Keypair): Bytes {
  return ed.sign(canonicalAuthCode(c), irk.privateKey);
}

export function verifyAuthCode(c: AuthCode, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalAuthCode(c), irkPub);
  } catch {
    return false;
  }
}

export function signInstallBlob(b: InstallBlob, irk: Keypair): Bytes {
  return ed.sign(canonicalInstallBlob(b), irk.privateKey);
}

export function verifyInstallBlob(b: InstallBlob, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalInstallBlob(b), irkPub);
  } catch {
    return false;
  }
}

export function signServerRegister(r: ServerRegisterRequest, identity: Keypair): Bytes {
  return ed.sign(canonicalServerRegister(r), identity.privateKey);
}

export function verifyServerRegister(
  r: ServerRegisterRequest,
  sig: Bytes,
  identityPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServerRegister(r), identityPub);
  } catch {
    return false;
  }
}

export function signAuthCodeRevocation(r: AuthCodeRevocation, irk: Keypair): Bytes {
  return ed.sign(canonicalAuthCodeRevoke(r), irk.privateKey);
}

export function verifyAuthCodeRevocation(
  r: AuthCodeRevocation,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalAuthCodeRevoke(r), irkPub);
  } catch {
    return false;
  }
}

export function signReleaseServerName(r: ReleaseServerName, irk: Keypair): Bytes {
  return ed.sign(canonicalReleaseServerName(r), irk.privateKey);
}

export function verifyReleaseServerName(
  r: ReleaseServerName,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalReleaseServerName(r), irkPub);
  } catch {
    return false;
  }
}
