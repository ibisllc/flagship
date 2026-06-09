/**
 * Plan A real-ticket integration + Plan-B-via-S3.3 admin endpoints.
 *
 * `handleAdminClaimAndIssue` is the missing half of the
 * `create-sample-user` pipeline: it derives a deterministic User IRK
 * from `DEMO_IRK_KEK` (a Worker-only secret), claims the username with
 * that derived IRK, mints AuthCode + InstallBlob via the existing
 * envelopes, and ships back a build-code the CLI pipes into
 * `personalize-iso --blob-json`. Before this, the CLI used
 * `synthesizeBlob`, which produces a self-signed blob the daemon's
 * first-boot register call rejects.
 *
 * `handleAdminMintDeviceGrant` is the parallel demo-mode primitive for
 * minting a child device's grant (e.g. `demoalice.reviewer`). It
 * derives a deterministic Device IRK from the same KEK, signs a
 * DeviceCapabilityGrant with the User IRK, and persists. Old grants
 * for the same (username, deviceLabel) are revoked-then-replaced (the
 * re-issuance flow per §2.1).
 *
 * BOTH endpoints are admin-only. Deriving deterministic keys inside
 * the Worker is safe because `DEMO_IRK_KEK` has no public exposure
 * path; observers cannot reconstruct the keys without it.
 */

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import {
  DEVICE_SCOPES,
  ed,
  signAuthCode,
  signDeviceCapabilityGrant,
  signInstallBlob,
  type AuthCode,
  type DeviceCapabilityGrant,
  type DeviceScope,
  type InstallBlob,
  type Keypair,
} from "@flagship/protocol";
import type {
  AuthCodeStorage,
  DeviceCapabilityGrantStorage,
  UsernameStorage,
} from "@flagship/storage";
import { bytesToHex } from "./hex.js";
import type { DemoUsersDeps } from "./demoUsers.js";
import {
  conflict,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

const USERNAME_RE = /^[a-z0-9-]{3,32}$/;
const SERVER_NAME_RE = /^[a-z0-9-]{3,32}$/;
const DEVICE_LABEL_RE = /^[a-z0-9-]{1,24}$/;
const RESERVED_DEVICE_LABELS: ReadonlySet<string> = new Set([
  "admin",
  "user",
  "root",
  "home",
  "service",
  "services",
]);
const VALID_SCOPES = new Set<string>(DEVICE_SCOPES);

/** §2.2 — demo user's PRIMARY device (created at create-sample-user).
 *  Full power within the demo sandbox, including the demo-provision
 *  bit that lets the daemon respond to `/connect` / `/heartbeat`. */
const DEFAULT_DEMO_PRIMARY_SCOPES: readonly DeviceScope[] = [
  "browse",
  "install-service",
  "vibe-code",
  "add-device",
  "manage-services",
  "revoke-others",
  "demo-provision",
];

export const _internalDefaultDemoPrimaryScopes = DEFAULT_DEMO_PRIMARY_SCOPES;

const HKDF_USER_IRK_SALT = "flagship-demo-irk-v1";
const HKDF_USER_IRK_INFO = "user-irk";
const HKDF_DEVICE_IRK_SALT = "flagship-demo-device-irk-v1";
const HKDF_DEVICE_IRK_INFO = "device-irk";
const HKDF_DELEGATED_INFO = "delegated";
const HKDF_RCK_INFO = "rck";

/**
 * HKDF-SHA256 wrapper. Returns the requested L bytes.
 *
 * The spec calls this out by name; we match the field order exactly so
 * any future operator who re-derives a demo IRK off-cluster (e.g. to
 * audit a key rotation) produces the same byte string. Do NOT change
 * `salt`, `info`, or input ordering without bumping the salt version
 * label.
 */
function hkdfSha256(
  salt: string,
  ikm: Uint8Array,
  info: string,
  L: number,
): Uint8Array {
  return hkdf(
    sha256,
    ikm,
    new TextEncoder().encode(salt),
    new TextEncoder().encode(info),
    L,
  );
}

/** Per-spec: sha256(KEK || ':' || username). */
function deriveUserIkm(kek: Uint8Array, username: string): Uint8Array {
  const sep = new TextEncoder().encode(`:${username}`);
  const concat = new Uint8Array(kek.length + sep.length);
  concat.set(kek, 0);
  concat.set(sep, kek.length);
  return sha256(concat);
}

/** Per-spec: sha256(KEK || ':' || username || '.' || deviceLabel). */
function deriveDeviceIkm(
  kek: Uint8Array,
  username: string,
  deviceLabel: string,
): Uint8Array {
  const sep = new TextEncoder().encode(`:${username}.${deviceLabel}`);
  const concat = new Uint8Array(kek.length + sep.length);
  concat.set(kek, 0);
  concat.set(sep, kek.length);
  return sha256(concat);
}

function seedToKeypair(seed: Uint8Array): Keypair {
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

/**
 * Derive the deterministic User IRK keypair for a demo username.
 * Exported only so the test suite can pin the derivation against a
 * fixed KEK; production callers go through the handlers above.
 */
export function deriveDemoUserIrk(
  kek: Uint8Array,
  username: string,
): Keypair {
  const ikm = deriveUserIkm(kek, username);
  const seed = hkdfSha256(HKDF_USER_IRK_SALT, ikm, HKDF_USER_IRK_INFO, 32);
  return seedToKeypair(seed);
}

/** Derive the deterministic Device IRK for (username, deviceLabel). */
export function deriveDemoDeviceIrk(
  kek: Uint8Array,
  username: string,
  deviceLabel: string,
): Keypair {
  const ikm = deriveDeviceIkm(kek, username, deviceLabel);
  const seed = hkdfSha256(HKDF_DEVICE_IRK_SALT, ikm, HKDF_DEVICE_IRK_INFO, 32);
  return seedToKeypair(seed);
}

/** Derive the phone-delegated pubkey embedded in the InstallBlob /
 *  AuthCode. The daemon never sees the private half (it lives only
 *  inside the Worker); the pubkey is what the daemon registers under
 *  for the first ServerRegister. Exported so the W11 provisioning
 *  handler can re-mint a fresh blob without reaching into private
 *  helpers. */
export function deriveDemoDelegatedKey(
  kek: Uint8Array,
  username: string,
): Keypair {
  const ikm = deriveUserIkm(kek, username);
  const seed = hkdfSha256(HKDF_USER_IRK_SALT, ikm, HKDF_DELEGATED_INFO, 32);
  return seedToKeypair(seed);
}

/** Derive the Routing-Control-Key pubkey embedded in the InstallBlob.
 *  Exported for the same W11 reason as `deriveDemoDelegatedKey`. */
export function deriveDemoRckKey(
  kek: Uint8Array,
  username: string,
): Keypair {
  const ikm = deriveUserIkm(kek, username);
  const seed = hkdfSha256(HKDF_USER_IRK_SALT, ikm, HKDF_RCK_INFO, 32);
  return seedToKeypair(seed);
}

// ──────────────────────────────────────────────────────────────────────
// Deps + shared helpers
// ──────────────────────────────────────────────────────────────────────

export interface DemoAdminDeps extends DemoUsersDeps {
  /** Real `usernames` table — admin-claim-and-issue inserts the demo
   *  row here so subsequent auth-code / server-register flows resolve
   *  the IRK pub the way they would for a real claim. */
  usernames: UsernameStorage;
  /** AuthCodes table — admin-claim-and-issue mints + persists. */
  authCodes: AuthCodeStorage;
  /** Build-ticket table — admin-claim-and-issue stores the personalized
   *  InstallBlob keyed by a fresh build-code. */
  /** Device-capability-grants table — both admin endpoints persist into
   *  it (admin-claim-and-issue: the primary; mint-device-grant: the
   *  child). */
  deviceCapabilityGrants: DeviceCapabilityGrantStorage;
  /** Worker secret. The single byte-string that gates demo IRK
   *  derivation. Generated once via `openssl rand -hex 32`; the hex is
   *  decoded into 32 bytes BEFORE arriving here. */
  demoIrkKek: Uint8Array;
  /** Test override for the random byte source (used for the auth-code
   *  serial + UUID minting). Defaults to crypto.getRandomValues. */
  random?: (n: number) => Uint8Array;
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function nowOf(deps: DemoAdminDeps): number {
  return (deps.now ?? Date.now)();
}

/** Format 16 random bytes as a v4 UUID. The grant_id column accepts
 *  any TEXT, so this matches the spec's stated "fresh v4 UUID" without
 *  pulling in a uuid dependency. */
function v4Uuid(rand: (n: number) => Uint8Array): string {
  const b = rand(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/dev/sample-user/admin-claim-and-issue
// ──────────────────────────────────────────────────────────────────────

export interface AdminClaimAndIssueBody {
  username?: unknown;
  serverName?: unknown;
  scopes?: unknown;
  /** Disk-encryption choice for the minted recipe (auth.ts `de=` field).
   *  "luks" (default / absent) ⇒ encrypted; "none" ⇒ unencrypted boot for a
   *  box that can't keep network at early-boot (Wi-Fi-only). */
  diskEncryption?: unknown;
}

/** Parse + validate the optional disk-encryption choice from an admin body.
 *  Returns `"none"` only when explicitly requested; absent / "luks" ⇒
 *  undefined (omit the field so the blob canonicalizes legacy-identically).
 *  Throws on any other value so a typo can't silently ship an encrypted box. */
export function parseDiskEncryption(
  raw: unknown,
): "none" | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "luks") return undefined;
  if (raw === "none") return "none";
  return { error: 'diskEncryption must be "luks" or "none"' };
}

export async function handleAdminClaimAndIssue(
  deps: DemoAdminDeps,
  body: AdminClaimAndIssueBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body) return malformed("malformed body");
  if (typeof body.username !== "string" || !USERNAME_RE.test(body.username)) {
    return malformed("username must match [a-z0-9-]{3,32}");
  }
  if (typeof body.serverName !== "string" || !SERVER_NAME_RE.test(body.serverName)) {
    return malformed("serverName must match [a-z0-9-]{3,32}");
  }
  let scopes: DeviceScope[];
  if (body.scopes === undefined) {
    scopes = [...DEFAULT_DEMO_PRIMARY_SCOPES];
  } else if (Array.isArray(body.scopes)) {
    const out: DeviceScope[] = [];
    for (const s of body.scopes) {
      if (typeof s !== "string" || !VALID_SCOPES.has(s)) {
        return malformed("scopes must be a non-empty array of known DeviceScope strings");
      }
      out.push(s as DeviceScope);
    }
    if (out.length === 0) {
      return malformed("scopes must be a non-empty array of known DeviceScope strings");
    }
    scopes = out;
  } else {
    return malformed("scopes must be a non-empty array of known DeviceScope strings");
  }

  const diskEncryption = parseDiskEncryption(body.diskEncryption);
  if (diskEncryption !== undefined && typeof diskEncryption === "object") {
    return malformed(diskEncryption.error);
  }

  const username = body.username.toLowerCase();
  const serverName = body.serverName.toLowerCase();

  const row = await deps.storage.get(username);
  if (!row) {
    return notFound("demo user does not exist; call /create first");
  }

  const userIrk = deriveDemoUserIrk(deps.demoIrkKek, username);
  const delegated = deriveDemoDelegatedKey(deps.demoIrkKek, username);
  const rck = deriveDemoRckKey(deps.demoIrkKek, username);
  const userIrkHex = bytesToHex(userIrk.publicKey);

  // Claim the username under the derived IRK. The username storage's
  // put rejects on conflicting IRK (different hex for the same name);
  // that's an explicit 409 to keep a bad-key-rotation from silently
  // overwriting a real account's claim.
  const claimResult = await deps.usernames.put({
    username,
    irkPubHex: userIrkHex,
    claimedAt: nowOf(deps),
    isDemo: true,
  });
  if (!claimResult.ok) {
    return conflict("username claimed under different IRK; cannot re-issue");
  }

  const rand = deps.random ?? defaultRandom;
  const now = nowOf(deps);
  const issuedAt = now;
  const expiresAt = now + 24 * 3_600_000;

  const serial = bytesToHex(rand(16));
  const serverDomain = `${serverName}.${username}.flagship.services`;

  const authCode: AuthCode = {
    version: 1,
    serial,
    username,
    serverName,
    serverDomain,
    delegatedPubKey: delegated.publicKey,
    userPubKey: userIrk.publicKey,
    issuedAt,
    expiresAt,
  };
  const authCodeSig = signAuthCode(authCode, userIrk);

  // Persist AuthCode FIRST (before the build-ticket) so a partial
  // failure leaves a usable serial — the build-ticket can be regenerated
  // cheaply, but the AuthCode serial is what the daemon registers
  // under and re-minting it would change the install identity.
  const acResult = await deps.authCodes.put({
    serial,
    username,
    serverName,
    serverDomain,
    delegatedPubKeyHex: bytesToHex(delegated.publicKey),
    userPubKeyHex: userIrkHex,
    userSignatureHex: bytesToHex(authCodeSig),
    issuedAt,
    expiresAt,
    status: "active",
    recordedAt: now,
  });
  if (!acResult.ok) {
    return conflict(`auth-code persist failed: ${acResult.reason}`);
  }

  const blob: InstallBlob = {
    version: 2,
    serverDomain,
    username,
    serverName,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature: authCodeSig,
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
    // Carry diskEncryption ONLY for "none". "luks"/absent ⇒ omitted, so the
    // signed bytes stay byte-identical to a legacy pre-diskEncryption recipe.
    ...(diskEncryption === "none" ? { diskEncryption: "none" as const } : {}),
  };
  const blobSig = signInstallBlob(blob, userIrk);

  // No build-ticket emission anymore — QR-pipe is the only flow, .com
  // never stores the signed blob at rest. The caller (CLI / demo
  // operator) gets the blob inline in the response and personalizes
  // the ISO from it directly.
  const blobObj = installBlobToJson(blob);

  // Primary DeviceCapabilityGrant. devicePubKey == user IRK pub for
  // demo accounts — the user IRK literally IS the primary device for
  // demos (one box, one user, one device); the grant exists so the
  // scope set is explicit + queryable in the same shape as a
  // reviewer's sub-grant.
  const grantId = v4Uuid(rand);
  const grant: DeviceCapabilityGrant = {
    grantId,
    username,
    deviceLabel: "primary",
    devicePubKey: userIrk.publicKey,
    scopes,
    issuedAt: now,
    expiresAt: now + 90 * 24 * 3_600_000,
  };
  const grantSig = signDeviceCapabilityGrant(grant, userIrk);
  await deps.deviceCapabilityGrants.put({
    grantId,
    username,
    deviceLabel: "primary",
    devicePubHex: userIrkHex,
    scopesJson: JSON.stringify(scopes),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: bytesToHex(grantSig),
    revokedAt: null,
  });

  return ok({
    blob: blobObj,
    blobSignature: bytesToHex(blobSig),
    primaryGrant: {
      grantId,
      username,
      deviceLabel: "primary",
      devicePubKey: userIrkHex,
      scopes,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      signature: bytesToHex(grantSig),
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/dev/sample-user/<u>/admin-mint-device-grant
// ──────────────────────────────────────────────────────────────────────

export interface AdminMintDeviceGrantBody {
  deviceLabel?: unknown;
  scopes?: unknown;
}

export async function handleAdminMintDeviceGrant(
  deps: DemoAdminDeps,
  username: string,
  body: AdminMintDeviceGrantBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body) return malformed("malformed body");
  if (typeof body.deviceLabel !== "string" || !DEVICE_LABEL_RE.test(body.deviceLabel)) {
    return malformed("deviceLabel must match [a-z0-9-]{1,24}");
  }
  const deviceLabel = body.deviceLabel.toLowerCase();
  if (deviceLabel.startsWith("-") || deviceLabel.endsWith("-")) {
    return malformed("deviceLabel must not start or end with '-'");
  }
  if (RESERVED_DEVICE_LABELS.has(deviceLabel)) {
    return malformed(`deviceLabel "${deviceLabel}" is reserved`);
  }
  if (!Array.isArray(body.scopes)) {
    return malformed("scopes must be a non-empty array of known DeviceScope strings");
  }
  const scopes: DeviceScope[] = [];
  for (const s of body.scopes) {
    if (typeof s !== "string" || !VALID_SCOPES.has(s)) {
      return malformed("scopes must be a non-empty array of known DeviceScope strings");
    }
    scopes.push(s as DeviceScope);
  }
  if (scopes.length === 0) {
    return malformed("scopes must be a non-empty array of known DeviceScope strings");
  }

  const u = username.toLowerCase();
  const row = await deps.storage.get(u);
  if (!row) return notFound("demo user does not exist");

  const userIrk = deriveDemoUserIrk(deps.demoIrkKek, u);
  const deviceIrk = deriveDemoDeviceIrk(deps.demoIrkKek, u, deviceLabel);
  const rand = deps.random ?? defaultRandom;
  const now = nowOf(deps);

  const grantId = v4Uuid(rand);
  const grant: DeviceCapabilityGrant = {
    grantId,
    username: u,
    deviceLabel,
    devicePubKey: deviceIrk.publicKey,
    scopes,
    issuedAt: now,
    expiresAt: now + 90 * 24 * 3_600_000,
  };
  const grantSig = signDeviceCapabilityGrant(grant, userIrk);

  // Re-issuance flow: if a previous grant for (u, deviceLabel) is
  // still ACTIVE, revoke it first then write the new one. The storage
  // layer's unique partial index is the line-of-defense; we walk it
  // explicitly here so the failure mode surfaces as the spec's
  // "re-issuance" behavior rather than a 409.
  const existing = await deps.deviceCapabilityGrants.getActiveForUserLabel(u, deviceLabel);
  if (existing) {
    await deps.deviceCapabilityGrants.revoke(existing.grantId, now);
  }

  const putResult = await deps.deviceCapabilityGrants.put({
    grantId,
    username: u,
    deviceLabel,
    devicePubHex: bytesToHex(deviceIrk.publicKey),
    scopesJson: JSON.stringify(scopes),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: bytesToHex(grantSig),
    revokedAt: null,
  });
  if (!putResult.ok) {
    return conflict(`grant persist failed: ${putResult.reason}`);
  }

  return ok({
    grant: {
      grantId,
      username: u,
      deviceLabel,
      devicePubKey: bytesToHex(deviceIrk.publicKey),
      scopes,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    },
    signature: bytesToHex(grantSig),
    devicePubHex: bytesToHex(deviceIrk.publicKey),
  });
}

// ──────────────────────────────────────────────────────────────────────
// InstallBlob ↔ JSON
// ──────────────────────────────────────────────────────────────────────

interface InstallBlobJson {
  version: 2;
  serverDomain: string;
  username: string;
  serverName: string;
  phoneDelegatedPubKey: string;
  registrationUrl: string;
  authCode: {
    version: number;
    serial: string;
    username: string;
    serverName: string;
    serverDomain: string;
    delegatedPubKey: string;
    userPubKey: string;
    issuedAt: number;
    expiresAt: number;
  };
  authCodeUserSignature: string;
  installerGitRef: string;
  rckPubKey: string;
  /** Present iff the blob carries diskEncryption (i.e. "none"). Mirrors the
   *  signed blob so the recipe JSON the operator hands out round-trips it. */
  diskEncryption?: "luks" | "none";
}

function installBlobToJson(b: InstallBlob): InstallBlobJson {
  return {
    version: 2,
    serverDomain: b.serverDomain,
    username: b.username,
    serverName: b.serverName,
    phoneDelegatedPubKey: bytesToHex(b.phoneDelegatedPubKey),
    registrationUrl: b.registrationUrl,
    authCode: {
      version: 1,
      serial: b.authCode.serial,
      username: b.authCode.username,
      serverName: b.authCode.serverName,
      serverDomain: b.authCode.serverDomain,
      delegatedPubKey: bytesToHex(b.authCode.delegatedPubKey),
      userPubKey: bytesToHex(b.authCode.userPubKey),
      issuedAt: b.authCode.issuedAt,
      expiresAt: b.authCode.expiresAt,
    },
    authCodeUserSignature: bytesToHex(b.authCodeUserSignature),
    installerGitRef: b.installerGitRef,
    rckPubKey: bytesToHex(b.rckPubKey),
    // Echo diskEncryption exactly as signed (present iff "none").
    ...(b.diskEncryption !== undefined ? { diskEncryption: b.diskEncryption } : {}),
  };
}
