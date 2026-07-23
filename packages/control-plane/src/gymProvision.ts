/**
 * Phase 1 of the gym recipe→Hetzner pipeline (docs/gym-recipe-to-hetzner.md).
 *
 * `POST /api/gym/provision` takes an APP-SIGNED InstallBlob — the recipe the
 * real app (browser/simulator) composed and signed with its OWN device IRK —
 * plus the app's TEST IRK private key, and provisions a Hetzner box FROM that
 * recipe. The box ends up owned by the app's IRK (= `authCode.userPubKey`) by
 * construction; there is no demo-IRK or client-side trust backdoor in the
 * identity path.
 *
 * ⚠️  GYM-ONLY. This endpoint accepts an IRK PRIVATE KEY so the box can
 * self-mint its required entitlement bundle (N12b, fail-closed) — exactly like
 * the demo cloud-init path ships the deterministic demo IRK priv. That is only
 * acceptable for a TEST identity in the gym env: it MUST NEVER be enabled on
 * prod. Prod uses the entitlement relay (entitlementRelay.ts), where the IRK
 * priv never leaves the phone. The route dispatcher gates this on the gym env
 * (see apps/com/src/controlPlaneRoutes.ts) so it cannot run in production.
 *
 * It deliberately REUSES the demo cloud-init builder
 * (`buildCloudConfigUserData`) — the same one handleAdminCloudInitNow uses —
 * which already ships the IRK priv to the box and drives the on-box
 * gen-identity → mint-entitlements → register dance. The ONLY difference from
 * the demo path is the provenance of the recipe: here the app composed + signed
 * the blob (verified against the username's registered IRK) instead of the
 * Worker deriving a deterministic demo recipe from the KEK.
 */

import {
  verifyAuthCode,
  verifyInstallBlob,
  ed,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import type { AuthCodeStorage, UsernameStorage } from "@flagship/storage";
import { buildCloudConfigUserData } from "./demoCloudConfig.js";
import type { ProvisioningHetznerClient } from "./demoProvisioningProvider.js";
import { HEX64, HEX128, equalHex, hexToBytes, bytesToHex } from "./hex.js";
import { SERIAL_RE } from "./authCode.js";
import {
  forbidden,
  malformed,
  notFound,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface GymProvisionDeps {
  usernames: UsernameStorage;
  authCodes: AuthCodeStorage;
  hetzner: ProvisioningHetznerClient;
  /** Hetzner numeric SSH key id attached to the box so it stays root-SSH
   *  debug-able (DEMO_PUBLIC_SSH_KEY_ID). Optional. */
  demoSshKeyId?: number;
  /** Default Hetzner location, e.g. "fsn1". */
  defaultRegion: string;
  /** Default Hetzner server_type, e.g. "cpx31" (the data stack needs headroom). */
  defaultSize: string;
  /** Ordered fallback server types tried on a 422. */
  fallbackServerTypes?: readonly string[];
  /** Hetzner OS image — defaults to "debian-12". */
  hetznerImage?: string;
  /** Max auth-code TTL (mirrors handleAuthCodeIssue). Default 24h. */
  maxExpiryMs?: number;
  random?: (n: number) => Uint8Array;
  now?: () => number;
}

export interface GymProvisionBody {
  /** The app-composed InstallBlob (JSON, InstallBlobJsonShort shape) with its
   *  embedded authCode + authCodeUserSignature. */
  installBlob?: unknown;
  /** Ed25519 signature over the InstallBlob's canonical bytes (hex). */
  blobSignature?: unknown;
  /** The app's TEST IRK private key (32-byte hex). Its pubkey MUST equal
   *  authCode.userPubKey — the box self-mints entitlements with it. */
  irkPrivHex?: unknown;
  region?: unknown;
  size?: unknown;
}

interface ParsedAuthCode {
  version: 1;
  serial: string;
  username: string;
  serverName: string;
  serverDomain: string;
  delegatedPubKey: string;
  userPubKey: string;
  issuedAt: number;
  expiresAt: number;
}

interface ParsedBlob {
  version: 2;
  serverDomain: string;
  username: string;
  serverName: string;
  phoneDelegatedPubKey: string;
  registrationUrl: string;
  authCode: ParsedAuthCode;
  authCodeUserSignature: string;
  installerGitRef: string;
  rckPubKey: string;
  diskEncryption?: "luks" | "none";
}

/**
 * Validate the JSON InstallBlob shape (the InstallBlobJsonShort the app sends).
 * Returns a typed view or null. This is a structural check only — crypto
 * verification happens against the registered IRK in the handler.
 */
function parseBlob(raw: unknown): ParsedBlob | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const ac = b.authCode;
  if (!ac || typeof ac !== "object") return null;
  const c = ac as Record<string, unknown>;
  const hexField = (v: unknown, re: RegExp): v is string =>
    typeof v === "string" && re.test(v);
  if (
    b.version !== 2 ||
    typeof b.serverDomain !== "string" ||
    typeof b.username !== "string" ||
    typeof b.serverName !== "string" ||
    !hexField(b.phoneDelegatedPubKey, HEX64) ||
    typeof b.registrationUrl !== "string" ||
    !hexField(b.authCodeUserSignature, HEX128) ||
    typeof b.installerGitRef !== "string" ||
    !hexField(b.rckPubKey, HEX64) ||
    c.version !== 1 ||
    typeof c.serial !== "string" ||
    !SERIAL_RE.test(c.serial) ||
    typeof c.username !== "string" ||
    typeof c.serverName !== "string" ||
    typeof c.serverDomain !== "string" ||
    !hexField(c.delegatedPubKey, HEX64) ||
    !hexField(c.userPubKey, HEX64) ||
    typeof c.issuedAt !== "number" ||
    typeof c.expiresAt !== "number"
  ) {
    return null;
  }
  const de = b.diskEncryption;
  if (de !== undefined && de !== "luks" && de !== "none") return null;
  return {
    version: 2,
    serverDomain: b.serverDomain,
    username: b.username,
    serverName: b.serverName,
    phoneDelegatedPubKey: b.phoneDelegatedPubKey,
    registrationUrl: b.registrationUrl,
    authCode: {
      version: 1,
      serial: c.serial,
      username: c.username,
      serverName: c.serverName,
      serverDomain: c.serverDomain,
      delegatedPubKey: c.delegatedPubKey,
      userPubKey: c.userPubKey,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    },
    authCodeUserSignature: b.authCodeUserSignature,
    installerGitRef: b.installerGitRef,
    rckPubKey: b.rckPubKey,
    ...(de !== undefined ? { diskEncryption: de } : {}),
  };
}

function toAuthCode(p: ParsedAuthCode): AuthCode {
  return {
    version: 1,
    serial: p.serial,
    username: p.username,
    serverName: p.serverName,
    serverDomain: p.serverDomain,
    delegatedPubKey: hexToBytes(p.delegatedPubKey),
    userPubKey: hexToBytes(p.userPubKey),
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
  };
}

function toInstallBlob(p: ParsedBlob): InstallBlob {
  return {
    version: 2,
    serverDomain: p.serverDomain,
    username: p.username,
    serverName: p.serverName,
    phoneDelegatedPubKey: hexToBytes(p.phoneDelegatedPubKey),
    registrationUrl: p.registrationUrl,
    authCode: toAuthCode(p.authCode),
    authCodeUserSignature: hexToBytes(p.authCodeUserSignature),
    installerGitRef: p.installerGitRef,
    rckPubKey: hexToBytes(p.rckPubKey),
    ...(p.diskEncryption !== undefined ? { diskEncryption: p.diskEncryption } : {}),
  };
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

export async function handleGymProvision(
  deps: GymProvisionDeps,
  body: GymProvisionBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const rand = deps.random ?? defaultRandom;
  const maxExpiryMs = deps.maxExpiryMs ?? 24 * 3_600_000;

  // 1. Parse + structurally validate the InstallBlob and the two hex inputs.
  const parsed = parseBlob(body?.installBlob);
  if (!parsed) return malformed("malformed installBlob");
  if (typeof body?.blobSignature !== "string" || !HEX128.test(body.blobSignature)) {
    return malformed("blobSignature must be 128-hex");
  }
  if (typeof body?.irkPrivHex !== "string" || !HEX64.test(body.irkPrivHex)) {
    return malformed("irkPrivHex must be 64-hex");
  }
  // Inner consistency: the embedded authCode must describe the same recipe.
  if (
    parsed.authCode.username !== parsed.username ||
    parsed.authCode.serverName !== parsed.serverName ||
    parsed.authCode.serverDomain !== parsed.serverDomain
  ) {
    return malformed("authCode does not match the installBlob");
  }

  // 2. The username must be registered; fetch its IRK pub.
  const registered = await deps.usernames.get(parsed.username);
  if (!registered) return notFound("username not registered");

  // 3. Verify both signatures against the OWNER's registered IRK, and that
  //    the blob's authCode is for that owner.
  if (!equalHex(registered.irkPubHex, parsed.authCode.userPubKey)) {
    return forbidden("authCode.userPubKey does not match registered IRK");
  }
  const blob = toInstallBlob(parsed);
  const ownerIrkPub = hexToBytes(registered.irkPubHex);
  if (!verifyInstallBlob(blob, hexToBytes(body.blobSignature), ownerIrkPub)) {
    return forbidden("invalid installBlob signature");
  }
  if (
    !verifyAuthCode(
      blob.authCode,
      hexToBytes(parsed.authCodeUserSignature),
      blob.authCode.userPubKey,
    )
  ) {
    return forbidden("invalid authCode signature");
  }

  // 4. Derive the pubkey from irkPrivHex and require it == authCode.userPubKey.
  //    The box self-mints its entitlement bundle with THIS key; a mismatch
  //    means the minted RootEntitlement would be signed by a non-owner key.
  let derivedIrkPubHex: string;
  try {
    derivedIrkPubHex = bytesToHex(ed.getPublicKey(hexToBytes(body.irkPrivHex)));
  } catch {
    return malformed("irkPrivHex is not a valid ed25519 private key");
  }
  if (!equalHex(derivedIrkPubHex, parsed.authCode.userPubKey)) {
    return malformed("irkPrivHex pubkey does not match authCode.userPubKey");
  }

  // 5. Record the AuthCode (mirror handleAuthCodeIssue's validations). The app
  //    may already have recorded it via /api/auth-code/issue — that is the
  //    expected case (recipe creation does), so an idempotent "already active" is
  //    fine: proceed. Any other persist failure is a conflict.
  if (
    blob.authCode.expiresAt - blob.authCode.issuedAt > maxExpiryMs ||
    blob.authCode.expiresAt <= blob.authCode.issuedAt
  ) {
    return malformed("authCode expiry out of range");
  }
  if (blob.authCode.expiresAt < now) return malformed("authCode already expired");

  const existing = await deps.authCodes.get(blob.authCode.serial);
  if (existing) {
    // Idempotent: the app already issued this exact code. Confirm it's the
    // same recipe + owner + still usable, then proceed without re-putting.
    const sameRecipe =
      existing.username === blob.authCode.username &&
      existing.serverDomain === blob.authCode.serverDomain &&
      equalHex(existing.userPubKeyHex, parsed.authCode.userPubKey);
    if (!sameRecipe) {
      return forbidden("authCode serial collides with a different recipe");
    }
    if (existing.status !== "active") {
      return malformed(`authCode is ${existing.status}`);
    }
  } else {
    const acResult = await deps.authCodes.put({
      serial: blob.authCode.serial,
      username: blob.authCode.username,
      serverName: blob.authCode.serverName,
      serverDomain: blob.authCode.serverDomain,
      delegatedPubKeyHex: parsed.authCode.delegatedPubKey,
      userPubKeyHex: parsed.authCode.userPubKey,
      userSignatureHex: parsed.authCodeUserSignature,
      issuedAt: blob.authCode.issuedAt,
      expiresAt: blob.authCode.expiresAt,
      status: "active",
      recordedAt: now,
    });
    if (!acResult.ok) {
      return { status: 409, body: { error: `auth-code persist failed: ${acResult.reason}` } };
    }
  }

  // 6. Build cloud-config from the APP'S blob, shipping the app's IRK priv so
  //    the box self-mints entitlements (the gym-only affordance). Reuses the
  //    exact builder the demo path uses; the blob JSON is passed through
  //    verbatim so what the box installs is byte-for-byte what the app signed.
  const userData = buildCloudConfigUserData({
    installBlobJson: JSON.stringify(body.installBlob),
    installerGitRef: blob.installerGitRef || "main",
    demoUserIrkPrivHex: body.irkPrivHex,
  });

  // 7. Provision Hetzner — mirrors handleAdminCloudInitNow, INCLUDING the SSH
  //    key so the box is debug-able.
  const region = typeof body?.region === "string" ? body.region : deps.defaultRegion;
  const size = typeof body?.size === "string" ? body.size : deps.defaultSize;
  let prov: { serverId: string; ipv4: string | null };
  try {
    prov = await deps.hetzner.createServerWithUserData({
      name: `flagship-gym-${blob.username}-${bytesToHex(rand(4))}`,
      location: region,
      serverType: size,
      image: deps.hetznerImage ?? "debian-12",
      userData,
      username: blob.username,
      ...(deps.demoSshKeyId !== undefined ? { sshKeyId: deps.demoSshKeyId } : {}),
      ...(deps.fallbackServerTypes
        ? { fallbackServerTypes: deps.fallbackServerTypes }
        : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 502,
      body: { error: "hetzner upstream rejected", detail: msg.slice(0, 280) },
    };
  }

  // 8. Done. The box boots, self-mints with the app IRK, and registers under
  //    the owner's account via /api/server/register.
  return {
    status: 200,
    body: {
      ok: true,
      serverDomain: blob.serverDomain,
      serverId: prov.serverId,
      ipv4: prov.ipv4,
    },
  };
}
