/**
 * Account master-key rotation on `.com` (docs/account-key-rotation.md).
 *
 * Wire contract:
 *   POST /api/users/:u/account-key-rotation             handleApplyAccountKeyRotation   (admin root)
 *   GET  /api/users/:u/account-key-rotations            handleListAccountKeyRotations   (account read token)
 *   GET  /api/accounts/:u/devices/:id/umk-rotation      handleGetUmkRotationDeliveries  (device-signed)
 *   POST /api/accounts/:u/devices/:id/umk-rotation/ack  handleAckUmkRotationDeliveries  (device-signed)
 *   POST /api/accounts/:u/devices/:id/key               handleRotateDeviceKey           (new key + admin root)
 *   PUT  /api/accounts/:u/devices/:id/receive-key       handlePutDeviceReceiveKey       (device-signed)
 *
 * A hop moves the account from key epoch N to N+1. It is authorised by the bare admin root the account
 * pins (no admin-device key, never the IRK: whoever held the old account key holds the IRK too), and the
 * new IRK and AID sign the same bytes. `.com` checks the hop against its own state, then applies the
 * whole step in one storage transaction: the IRK/AID swap, the lane entry, the revocation of every device
 * not kept (identity, grants, push tokens), replacement grants for kept devices, the recovery record
 * swapped or deleted, re-encrypted profiles, the sealed deliveries and the audit row. A lost race or a
 * changed precondition applies nothing (409). Re-sending an applied hop answers 200 `applied: false`.
 *
 * `.com` relays the hop; it can never forge one (it holds no admin root). Boxes and devices verify the
 * lane themselves under the admin root they pin.
 */
import { sha256 } from "@noble/hashes/sha256";
import {
  AccountKeyRotationError,
  PqTrustError,
  RELAY_LOG_GRANT_ID,
  ed,
  isAcceptableEd25519PublicKey,
  accountKeyRotationDigestHex,
  canonicalUmkRotationDelivery,
  checkRecoveryEvolution,
  isSensitiveScope,
  keptDevicesDigestHex,
  legacyPolicyState,
  recoveryRecordDigest,
  verifyAccountKeyRotation,
  verifyAccountKeyRotationPq,
  verifyAccountProfile,
  verifyDeviceCapabilityGrant,
  verifyDeviceKeyRotate,
  verifyDeviceManagedProfile,
  verifyDeviceReceiveKey,
  verifyPqKeyBinding,
  verifyRecoveryRecord,
  DEVICE_SCOPES,
  type AccountKeyRotation,
  type AccountKeyRotationSignatures,
  type AccountProfileEnvelope,
  type DeviceCapabilityGrant,
  type DeviceKeyRotate,
  type DeviceManagedProfileEnvelope,
  type DeviceReceiveKey,
  type DeviceScope,
  type KeptDevice,
  type PqKeyBindingWire,
  type RecoveryRecordV2,
  type StoredRecoveryState,
  type UmkRotationDelivery,
  type VerifiedPqKeyBinding,
} from "@flagship/protocol";
import type {
  AccountKeyRotationRecovery,
  AccountKeyRotationStorage,
  AccountProfileRecord,
  AccountProfileStorage,
  AdminRootRotationStorage,
  DeviceCapabilityGrantRecord,
  DeviceCapabilityGrantStorage,
  DeviceIdentityStorage,
  DeviceManagedProfileRecord,
  DeviceManagedProfileStorage,
  PqTrustStorage,
  PushTokenRecord,
  PushTokenStorage,
  ServerStorage,
  UmkRotationDeliveryRecord,
  UsernameStorage,
  VoiciCallStorage,
  WebauthnRecoveryRecord,
  WebauthnRecoveryStorage,
} from "@flagship/storage";
import { bindingWire } from "./accountPqTrust.js";
import { authorizeActiveDevice, deviceRefusal, type DirectoryAuthorization, type DirectoryNonceStore } from "./accountDirectory.js";
import { handleApplyAdminRootRotation, handleListAdminRootRotations } from "./adminRootRotation.js";
import { HEX64, HEX128, bytesToHex, hexToBytes } from "./hex.js";
import { badEd25519Key } from "./edKey.js";
import { dropVoiciCallKeysOfRevokedDevices } from "./voiciCallKeyCleanup.js";
import { accountUnderStrict, passkeyFromAttestation } from "./webauthnRecovery.js";
import { recoveryPasskeyPolicy, type PasskeyPolicy } from "./passkeyAssertion.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

/**
 * Owner decision (2026-11-27): under strict, a kept device gets its new account key only over X-Wing; one
 * without a receive key is added again by QR. Outside strict the classical seal to its identity key is
 * accepted (a device that published a receive key always gets X-Wing).
 */
export const STRICT_REQUIRES_XWING_DELIVERY = true;
/**
 * Owner decision (2026-11-27): outside strict, a hybrid companion that is sent is still checked (refused
 * when it does not verify); only a companion `.com` holds no admin-root binding for is relayed unchecked.
 */
export const COMPAT_VERIFIES_SENT_COMPANION = true;

/** How long a delivery waits for its device before the device has to be added again. */
export const DELIVERY_TTL_MS = 30 * 86_400_000;
const MAX_AGE_MS = 15 * 60_000;
const MAX_DEVICES = 64;
const MAX_SEALED_HEX = 16_384;
const MAX_CIPHERTEXT_BYTES = 16 * 1024;
const NO_STORE = { "cache-control": "private, no-store" };

export interface AccountKeyRotationDeps {
  usernames: UsernameStorage;
  rotations: AccountKeyRotationStorage;
  adminRootRotations: AdminRootRotationStorage;
  identities: DeviceIdentityStorage;
  grants: DeviceCapabilityGrantStorage;
  pushTokens: PushTokenStorage;
  webauthnRecovery: WebauthnRecoveryStorage;
  accountProfiles: AccountProfileStorage;
  managedProfiles: DeviceManagedProfileStorage;
  nonces: DirectoryNonceStore;
  /** Bindings (admin root's, to check a companion; the new IRK's, stored) and the strict policy. */
  pqTrust?: PqTrustStorage;
  /** With `pqTrust`: which servers' policies decide whether the account is under strict. */
  servers?: Pick<ServerStorage, "listForUser">;
  callKeys?: Pick<VoiciCallStorage, "deleteCallKeyForDevice">;
  /** Content-free wake for the kept devices ("fetch your new key"). */
  notifyKeyRotated?: (targets: PushTokenRecord[]) => Promise<void>;
  /** Content-free wake for the devices that were removed (they ask `.com` and hear `device-removed`). */
  notifyDeviceRemoved?: (targets: PushTokenRecord[]) => Promise<void>;
  passkeyPolicy?: PasskeyPolicy;
  now?: () => number;
}

const refuse = (status: 400 | 403 | 409, code: string, error = code): HandlerResponseWithHeaders => ({ status, body: { error, code } });

function errorStatus(code: string): 400 | 403 | 409 {
  if (code === "stale-epoch" || code === "epoch-gap" || code === "wrong-old-irk" || code === "wrong-old-aid" || code === "wrong-admin-root") return 409;
  if (code === "malformed" || code === "weak-key" || code === "key-not-new" || code === "bad-epoch-step") return 400;
  return 403;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : "");

function parseRotation(v: unknown): AccountKeyRotation | null {
  if (!isObj(v)) return null;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.removedDeviceIds) || !r.removedDeviceIds.every((x) => typeof x === "string")) return null;
  if (r.recoveryRecordDigestHex !== null && typeof r.recoveryRecordDigestHex !== "string") return null;
  for (const k of ["username", "oldIrkPubHex", "newIrkPubHex", "newIrkScheme", "oldAidPubHex", "newAidPubHex", "adminRootPubHex", "keptDevicesDigestHex", "nonceHex"]) {
    if (typeof r[k] !== "string") return null;
  }
  for (const k of ["fromEpoch", "toEpoch", "issuedAt"]) if (typeof r[k] !== "number") return null;
  return {
    username: r.username as string,
    fromEpoch: r.fromEpoch as number,
    toEpoch: r.toEpoch as number,
    oldIrkPubHex: r.oldIrkPubHex as string,
    newIrkPubHex: r.newIrkPubHex as string,
    newIrkScheme: r.newIrkScheme as AccountKeyRotation["newIrkScheme"],
    oldAidPubHex: r.oldAidPubHex as string,
    newAidPubHex: r.newAidPubHex as string,
    adminRootPubHex: r.adminRootPubHex as string,
    removedDeviceIds: r.removedDeviceIds as string[],
    keptDevicesDigestHex: r.keptDevicesDigestHex as string,
    recoveryRecordDigestHex: (r.recoveryRecordDigestHex as string | null) ?? null,
    nonceHex: r.nonceHex as string,
    issuedAt: r.issuedAt as number,
  };
}

function parseSignatures(v: unknown): AccountKeyRotationSignatures | null {
  if (!isObj(v)) return null;
  const s = { adminRootSignatureHex: str(v.adminRootSignatureHex), newIrkSignatureHex: str(v.newIrkSignatureHex), newAidSignatureHex: str(v.newAidSignatureHex) };
  return HEX128.test(s.adminRootSignatureHex) && HEX128.test(s.newIrkSignatureHex) && HEX128.test(s.newAidSignatureHex) ? s : null;
}

async function storedRootBinding(store: PqTrustStorage, username: string, rootHex: string, now: number): Promise<VerifiedPqKeyBinding | null> {
  const rec = await store.getBinding("admin-root", username);
  if (!rec || rec.ed25519PubHex.toLowerCase() !== rootHex) return null;
  try {
    return verifyPqKeyBinding(bindingWire(rec), { role: "admin-root", subjectId: username, ed25519PubHex: rootHex, now: Math.max(now, rec.issuedAt) });
  } catch {
    return null;
  }
}

function b64Bytes(s: unknown): Uint8Array | null {
  if (typeof s !== "string") return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length > 0 && out.length <= MAX_CIPHERTEXT_BYTES ? out : null;
  } catch {
    return null;
  }
}

const sha256Hex = (b: Uint8Array): string => bytesToHex(sha256(b));

function storedRecoveryState(rec: WebauthnRecoveryRecord): StoredRecoveryState {
  const digestOf = (b64: string | undefined) => (b64 ? sha256Hex(b64Bytes(b64) ?? new Uint8Array()) : undefined);
  const adminRootDigestHex = digestOf(rec.wrappedAdminRootB64);
  const acmeKeyDigestHex = digestOf(rec.wrappedAcmeAccountKeyB64);
  return {
    digestHex: rec.signed?.digestHex ?? "legacy",
    generation: rec.signed?.generation ?? 0,
    wrappedUmkDigestHex: digestOf(rec.wrappedUmkB64)!,
    ...(adminRootDigestHex ? { adminRootDigestHex } : {}),
    ...(acmeKeyDigestHex ? { acmeKeyDigestHex } : {}),
  };
}

/** The replacement recovery record: signed by the NEW IRK, naming the pinned admin root, digest in the hop. */
async function checkReplacementRecovery(
  deps: AccountKeyRotationDeps,
  rotation: AccountKeyRotation,
  adminRootHex: string,
  existing: WebauthnRecoveryRecord | undefined,
  body: unknown,
  strict: boolean,
  now: number,
): Promise<{ plan: AccountKeyRotationRecovery } | { response: HandlerResponseWithHeaders }> {
  if (!isObj(body) || !isObj(body.claim) || typeof body.signature !== "string" || !HEX128.test(body.signature)) {
    return { response: malformed("recovery: a signed v2 record is required") };
  }
  const claim = body.claim as unknown as RecoveryRecordV2;
  if (claim.op !== "put" || claim.username !== rotation.username) return { response: malformed("recovery: wrong operation or account") };
  if (claim.irkPubHex !== rotation.newIrkPubHex || claim.adminRootPubHex !== adminRootHex) {
    return { response: forbidden("recovery: the record must name the new account key and the pinned admin root") };
  }
  let digest: string;
  let verified = false;
  try {
    digest = recoveryRecordDigest(claim);
    verified = verifyRecoveryRecord(claim, hexToBytes(body.signature), hexToBytes(rotation.newIrkPubHex));
  } catch {
    return { response: malformed("recovery: the record is not canonical") };
  }
  if (digest !== rotation.recoveryRecordDigestHex) return { response: refuse(400, "recovery-digest-mismatch") };
  if (!verified) return { response: forbidden("recovery: invalid signature") };
  const umk = b64Bytes(body.wrappedUmk);
  if (!umk || sha256Hex(umk) !== claim.wrappedUmkDigestHex) return { response: forbidden("recovery: the wrapped UMK is not the one that was signed") };
  const admin = body.wrappedAdminRoot === undefined ? null : b64Bytes(body.wrappedAdminRoot);
  const acme = body.wrappedAcmeAccountKey === undefined ? null : b64Bytes(body.wrappedAcmeAccountKey);
  if ((claim.adminRoot.change === "replace") !== !!admin || (claim.acmeKey.change === "replace") !== !!acme) {
    return { response: malformed("recovery: escrow ciphertexts must accompany exactly the fields the record replaces") };
  }
  if (admin && claim.adminRoot.change === "replace" && sha256Hex(admin) !== claim.adminRoot.digestHex) return { response: forbidden("recovery: wrapped admin root mismatch") };
  if (acme && claim.acmeKey.change === "replace" && sha256Hex(acme) !== claim.acmeKey.digestHex) return { response: forbidden("recovery: wrapped ACME key mismatch") };
  const verdict = checkRecoveryEvolution(existing ? storedRecoveryState(existing) : undefined, claim);
  if (!verdict.ok) return { response: refuse(409, `recovery-${verdict.reason}`) };
  let passkey: { coseHex: string; alg: number } | undefined;
  if (body.passkeyAttestationObject !== undefined) {
    const read = await passkeyFromAttestation(body.passkeyAttestationObject, claim.credentialIdHex, deps.passkeyPolicy ?? recoveryPasskeyPolicy());
    if ("response" in read) return { response: read.response };
    passkey = read.passkey;
  }
  if (!passkey && strict) return { response: refuse(403, "passkey-required-strict") };
  const keptAdmin = claim.adminRoot.change === "keep" ? existing?.wrappedAdminRootB64 : undefined;
  const keptAcme = claim.acmeKey.change === "keep" ? existing?.wrappedAcmeAccountKeyB64 : undefined;
  const adminB64 = admin ? (body.wrappedAdminRoot as string) : keptAdmin;
  const acmeB64 = acme ? (body.wrappedAcmeAccountKey as string) : keptAcme;
  const record: WebauthnRecoveryRecord = {
    username: rotation.username,
    credentialIdHex: claim.credentialIdHex,
    wrappedUmkB64: body.wrappedUmk as string,
    irkPubHex: claim.irkPubHex,
    fetchTokenHashHex: claim.fetchTokenHashHex,
    prfSaltHashHex: claim.prfSaltHashHex,
    ...(acmeB64 ? { wrappedAcmeAccountKeyB64: acmeB64 } : {}),
    ...(adminB64 ? { wrappedAdminRootB64: adminB64 } : {}),
    signed: { digestHex: digest, generation: claim.generation, signedClaimJson: JSON.stringify(claim), signatureHex: body.signature },
    ...(passkey ? { passkey } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return { plan: { kind: "replace", record, expectedPriorDigest: existing ? (existing.signed?.digestHex ?? "legacy") : "genesis" } };
}

function parseGrantScopes(raw: unknown): DeviceScope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const valid = new Set<string>(DEVICE_SCOPES);
  return raw.every((s) => typeof s === "string" && valid.has(s)) ? (raw as DeviceScope[]) : null;
}

/** A fresh grant for a kept device: by the admin root, or (member scopes only) by the new IRK. */
function checkReplacementGrant(
  raw: unknown,
  rotation: AccountKeyRotation,
  kept: Map<string, string>,
  adminRootHex: string,
  now: number,
): DeviceCapabilityGrantRecord | string {
  if (!isObj(raw) || !isObj(raw.grant) || typeof raw.signature !== "string" || !HEX128.test(raw.signature)) return "malformed grant";
  const g = raw.grant;
  const signerRoot = raw.signerRoot === "membership" ? "membership" : raw.signerRoot === "admin-root" ? "admin-root" : null;
  const scopes = parseGrantScopes(g.scopes);
  if (
    !signerRoot || !scopes || typeof g.grantId !== "string" || !RELAY_LOG_GRANT_ID.test(g.grantId.toLowerCase()) ||
    typeof g.deviceId !== "string" || typeof g.devicePubKey !== "string" || !HEX64.test(g.devicePubKey.toLowerCase()) ||
    typeof g.issuedAt !== "number" || typeof g.expiresAt !== "number" || g.username !== rotation.username
  ) return "malformed grant";
  const deviceId = g.deviceId.toLowerCase();
  const pub = g.devicePubKey.toLowerCase();
  if (kept.get(deviceId) !== pub) return "a replacement grant must be for a kept device and its key";
  if (signerRoot === "membership" && scopes.some((s) => isSensitiveScope(s))) return "a grant signed by the account key carries member scopes only";
  if (g.expiresAt <= now) return "grant already expired";
  const grant: DeviceCapabilityGrant = {
    grantId: g.grantId, username: rotation.username, deviceId: g.deviceId, devicePubKey: hexToBytes(pub), scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt,
  };
  const signer = signerRoot === "admin-root" ? adminRootHex : rotation.newIrkPubHex;
  if (!verifyDeviceCapabilityGrant(grant, hexToBytes(raw.signature.toLowerCase()), hexToBytes(signer))) return "invalid grant signature";
  return {
    grantId: g.grantId, username: rotation.username, deviceId, devicePubHex: pub, scopesJson: JSON.stringify(scopes),
    issuedAt: g.issuedAt, expiresAt: g.expiresAt, signatureHex: raw.signature.toLowerCase(), revokedAt: null, signerRoot,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/account-key-rotation
// ──────────────────────────────────────────────────────────────────────

export async function handleApplyAccountKeyRotation(
  deps: AccountKeyRotationDeps,
  usernameFromPath: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const u = usernameFromPath.toLowerCase();
  if (!isObj(body)) return malformed("malformed body");
  const rotation = parseRotation(body.rotation);
  const signatures = parseSignatures(body.signatures);
  if (!rotation || !signatures) return malformed("malformed body");
  if (rotation.username !== u) return malformed("rotation username does not match path");
  let digest: string;
  try {
    digest = accountKeyRotationDigestHex(rotation);
  } catch {
    return malformed("the rotation is not canonical");
  }

  // Applied already: the same hop again is a no-op.
  const prior = await deps.rotations.getByDigest(digest);
  if (prior) {
    if (prior.username !== u) return conflict("rotation belongs to another account");
    return ok({ ok: true, applied: false, username: u, keyEpoch: prior.toEpoch }, NO_STORE);
  }
  if (Math.abs(now - rotation.issuedAt) > MAX_AGE_MS) return refuse(403, "stale-request");

  // An admin-root rotation sent with it is applied first (the removed device may have held the old root).
  if (body.adminRootRotation !== undefined) {
    const res = await handleApplyAdminRootRotation(
      { usernames: deps.usernames, rotations: deps.adminRootRotations, ...(deps.pqTrust ? { pqTrust: deps.pqTrust } : {}), now: () => now },
      u,
      body.adminRootRotation as Parameters<typeof handleApplyAdminRootRotation>[2],
    );
    if (res.status !== 200) return res;
  }

  const user = await deps.usernames.get(u);
  if (!user) return notFound("username not registered");
  if (user.isDemo) return refuse(403, "demo-account");
  const adminRoot = user.adminRootPubHex?.toLowerCase();
  if (!adminRoot) return refuse(400, "no-admin-root", "account has no admin root");
  const bad = badEd25519Key(rotation.newIrkPubHex) ?? badEd25519Key(rotation.newAidPubHex);
  if (bad) return bad;
  try {
    verifyAccountKeyRotation({
      rotation,
      signatures,
      state: { username: u, epoch: user.keyEpoch ?? 0, irkPubHex: user.irkPubHex, aidPubHex: user.aidPubHex ?? null, adminRootPubHex: adminRoot },
    });
  } catch (e) {
    const code = e instanceof AccountKeyRotationError ? e.code : "malformed";
    return refuse(errorStatus(code), code);
  }

  const strict = deps.pqTrust && deps.servers
    ? await accountUnderStrict({ servers: deps.servers, pqTrust: deps.pqTrust, identities: deps.identities }, u)
    : false;
  let newIrkBinding: PqKeyBindingWire | null = null;
  if (body.pq !== undefined && body.pq !== null) {
    if (!deps.pqTrust) return refuse(403, "pq-unsupported");
    try {
      verifyAccountKeyRotationPq({
        rotation,
        pq: body.pq,
        adminRootBinding: await storedRootBinding(deps.pqTrust, u, adminRoot, now),
        policy: legacyPolicyState({ kind: "installation", id: "com" }),
        now,
      });
      newIrkBinding = (body.pq as { newIrkBinding: PqKeyBindingWire }).newIrkBinding;
    } catch (e) {
      const code = e instanceof PqTrustError ? e.code : "bad-signature";
      // Relayed unchecked only outside strict and only when `.com` holds no binding to check it with.
      if (strict || code !== "no-binding" || !COMPAT_VERIFIES_SENT_COMPANION) return refuse(403, code);
    }
  } else if (strict) {
    return refuse(403, "strict-requires-hybrid");
  }

  // Kept devices: the digest the hop signed, each one active on the key it names.
  if (!Array.isArray(body.kept) || body.kept.length === 0 || body.kept.length > MAX_DEVICES) return malformed("kept devices required");
  const keptList: KeptDevice[] = [];
  for (const k of body.kept) {
    if (!isObj(k) || typeof k.deviceId !== "string" || typeof k.devicePubHex !== "string") return malformed("malformed kept device");
    keptList.push({ deviceId: k.deviceId.toLowerCase(), devicePubHex: k.devicePubHex.toLowerCase() });
  }
  let keptDigest: string;
  try {
    keptDigest = keptDevicesDigestHex(keptList);
  } catch {
    return malformed("malformed kept devices");
  }
  if (keptDigest !== rotation.keptDevicesDigestHex) return refuse(400, "kept-digest-mismatch");
  const kept = new Map(keptList.map((k) => [k.deviceId, k.devicePubHex]));
  const identities = await deps.identities.listForAccount(u);
  const byId = new Map(identities.map((d) => [d.deviceId, d]));
  for (const k of keptList) {
    const d = byId.get(k.deviceId);
    if (!d || d.revokedAt !== null || d.devicePubHex !== k.devicePubHex) return refuse(409, "kept-device-not-active");
  }
  for (const id of rotation.removedDeviceIds) {
    if (!byId.has(id) || kept.has(id)) return refuse(400, "bad-removed-device");
  }

  // Replacement grants; a kept device whose live grant was signed by the old account key needs one.
  const newGrants: DeviceCapabilityGrantRecord[] = [];
  const rawGrants = body.grants === undefined ? [] : body.grants;
  if (!Array.isArray(rawGrants) || rawGrants.length > MAX_DEVICES) return malformed("malformed grants");
  for (const raw of rawGrants) {
    const g = checkReplacementGrant(raw, rotation, kept, adminRoot, now);
    if (typeof g === "string") return refuse(403, "bad-grant", g);
    if (newGrants.some((x) => x.deviceId === g.deviceId)) return malformed("one replacement grant per device");
    newGrants.push(g);
  }
  const allGrants = await deps.grants.listForUser(u);
  for (const g of allGrants) {
    if (g.revokedAt !== null || !kept.has(g.deviceId.toLowerCase())) continue;
    if ((g.signerRoot ?? "membership") !== "admin-root" && !newGrants.some((x) => x.deviceId === g.deviceId.toLowerCase())) {
      return refuse(400, "kept-device-needs-grant");
    }
  }

  // Deliveries: admin-root-signed, for this hop, a kept device, these sealed bytes.
  const receiveKeys = new Map((await deps.rotations.listReceiveKeys(u)).map((k) => [k.deviceId, k]));
  const deliveries: UmkRotationDeliveryRecord[] = [];
  const rawDeliveries = body.deliveries === undefined ? [] : body.deliveries;
  if (!Array.isArray(rawDeliveries) || rawDeliveries.length > MAX_DEVICES) return malformed("malformed deliveries");
  for (const raw of rawDeliveries) {
    if (!isObj(raw) || !isObj(raw.delivery) || typeof raw.signatureHex !== "string" || typeof raw.sealedHex !== "string") return malformed("malformed delivery");
    const sealKind = raw.sealKind === "xwing" ? "xwing" : raw.sealKind === "ed25519" ? "ed25519" : null;
    const sealedHex = raw.sealedHex.toLowerCase();
    if (!sealKind || sealedHex.length > MAX_SEALED_HEX || !/^(?:[0-9a-f]{2})+$/.test(sealedHex)) return malformed("malformed delivery");
    const d = raw.delivery as unknown as UmkRotationDelivery;
    let msg: Uint8Array;
    try {
      msg = canonicalUmkRotationDelivery(d);
    } catch {
      return malformed("the delivery is not canonical");
    }
    const sig = raw.signatureHex.toLowerCase();
    if (!HEX128.test(sig)) return malformed("malformed delivery");
    if (!isAcceptableEd25519PublicKey(adminRoot) || !ed.verify(hexToBytes(sig), msg, hexToBytes(adminRoot))) return refuse(403, "bad-delivery-signature");
    if (d.username !== u || d.toEpoch !== rotation.toEpoch || d.rotationDigestHex !== digest) return refuse(400, "delivery-rotation-mismatch");
    if (kept.get(d.deviceId) !== d.devicePubHex) return refuse(400, "delivery-not-kept");
    if (d.sealedDigestHex !== sha256Hex(hexToBytes(sealedHex))) return refuse(400, "delivery-sealed-mismatch");
    if (deliveries.some((x) => x.deviceId === d.deviceId)) return malformed("one delivery per device");
    if (sealKind === "ed25519") {
      if (strict && STRICT_REQUIRES_XWING_DELIVERY) return refuse(403, "strict-requires-xwing-delivery");
      if (receiveKeys.has(d.deviceId)) return refuse(409, "receive-key-available");
    }
    deliveries.push({
      username: u, toEpoch: rotation.toEpoch, deviceId: d.deviceId, devicePubHex: d.devicePubHex, sealKind, sealedHex,
      deliveryJson: JSON.stringify(d), signatureHex: sig, createdAt: now, expiresAt: now + DELIVERY_TTL_MS, ackedAt: null,
    });
  }

  // The recovery record is swapped (the hop names the new record's digest) or deleted (it names none).
  const existingRecovery = await deps.webauthnRecovery.get(u);
  let recovery: AccountKeyRotationRecovery;
  if (rotation.recoveryRecordDigestHex === null) {
    if (body.recovery !== undefined && body.recovery !== null) return malformed("the rotation names no recovery record");
    recovery = existingRecovery ? { kind: "delete", expectedDigest: existingRecovery.signed?.digestHex ?? "legacy" } : { kind: "absent" };
  } else {
    const checked = await checkReplacementRecovery(deps, rotation, adminRoot, existingRecovery, body.recovery, strict, now);
    if ("response" in checked) return checked.response;
    recovery = checked.plan;
  }

  // Profiles re-encrypted under the new account key, signed by the admin root, one revision on.
  let accountProfile: AccountProfileRecord | null = null;
  if (body.accountProfile !== undefined && body.accountProfile !== null) {
    const p = body.accountProfile as AccountProfileEnvelope;
    const existing = await deps.accountProfiles.get(u);
    if (!isObj(p) || p.accountId?.toLowerCase() !== u || p.signerPubHex !== adminRoot || !verifyAccountProfile(p, hexToBytes(adminRoot))) {
      return refuse(403, "bad-account-profile");
    }
    if (p.revision !== (existing?.revision ?? 0) + 1) return refuse(409, "account-profile-revision");
    accountProfile = { ...p, accountId: u, updatedAt: now };
  }
  const managedProfiles: DeviceManagedProfileRecord[] = [];
  const rawManaged = body.managedProfiles === undefined ? [] : body.managedProfiles;
  if (!Array.isArray(rawManaged) || rawManaged.length > MAX_DEVICES) return malformed("malformed managed profiles");
  for (const raw of rawManaged) {
    const p = raw as DeviceManagedProfileEnvelope;
    if (!isObj(p) || typeof p.deviceId !== "string" || !kept.has(p.deviceId) || p.accountId?.toLowerCase() !== u || p.signerPubHex !== adminRoot ||
      !verifyDeviceManagedProfile(p, hexToBytes(adminRoot))) {
      return refuse(403, "bad-managed-profile");
    }
    const existing = await deps.managedProfiles.get(u, p.deviceId);
    if (p.revision !== (existing?.revision ?? 0) + 1 || managedProfiles.some((x) => x.deviceId === p.deviceId)) return refuse(409, "managed-profile-revision");
    managedProfiles.push({ ...p, accountId: u, updatedAt: now });
  }

  const removedTokens = (await deps.pushTokens.listByUser(u)).filter((t) => !kept.has(t.deviceId.toLowerCase()));
  const keptTokens = (await deps.pushTokens.listByUser(u)).filter((t) => kept.has(t.deviceId.toLowerCase()));
  const hop = { rotation, signatures, ...(body.pq !== undefined && body.pq !== null ? { pq: body.pq } : {}) };
  const applied = await deps.rotations.apply({
    rotation: {
      username: u,
      fromEpoch: rotation.fromEpoch,
      toEpoch: rotation.toEpoch,
      rotationDigestHex: digest,
      adminRootPubHex: adminRoot,
      oldIrkPubHex: rotation.oldIrkPubHex,
      newIrkPubHex: rotation.newIrkPubHex,
      hopJson: JSON.stringify(hop),
      keptJson: JSON.stringify(keptList),
      appliedAt: now,
    },
    expectedAdminRootPubHex: adminRoot,
    newAidPubHex: rotation.newAidPubHex,
    kept: keptList,
    newGrants,
    recovery,
    accountProfile,
    managedProfiles,
    deliveries,
    audit: {
      username: u,
      eventKind: "account-key-rotated",
      detail: `Account key changed (epoch ${rotation.toEpoch})`,
      devicePrefix: rotation.newIrkPubHex.slice(0, 8),
      postedAt: now,
    },
    at: now,
  });
  if (!applied.ok) {
    const again = await deps.rotations.getByDigest(digest);
    if (again && again.username === u) return ok({ ok: true, applied: false, username: u, keyEpoch: again.toEpoch }, NO_STORE);
    return refuse(409, "rotation-conflict", "the account changed while this rotation was applied; refresh and retry");
  }

  // After the commit, best effort: call keys of devices left without a live grant, the new IRK's binding, the wakes.
  const revokedDeviceIds = identities.filter((d) => d.revokedAt === null && !kept.has(d.deviceId)).map((d) => d.deviceId);
  try {
    await dropVoiciCallKeysOfRevokedDevices({ grants: deps.grants, callKeys: deps.callKeys }, u, identities.map((d) => d.deviceId));
  } catch {
    /* a revoked device's call key is refused on use anyway */
  }
  if (newIrkBinding && deps.pqTrust) {
    try {
      await deps.pqTrust.putBinding({
        role: "account-irk", subjectId: newIrkBinding.subjectId, ed25519PubHex: newIrkBinding.ed25519PubHex, mldsaPubHex: newIrkBinding.mldsaPubHex,
        issuedAt: newIrkBinding.issuedAt, signatureHex: newIrkBinding.signature, storedAt: now,
      });
    } catch {
      /* the lane carries the binding to every box */
    }
  }
  for (const [notify, targets] of [[deps.notifyDeviceRemoved, removedTokens], [deps.notifyKeyRotated, keptTokens]] as const) {
    if (!notify || targets.length === 0) continue;
    try {
      await notify(targets);
    } catch {
      /* a device that missed the wake hears the new epoch on its next call */
    }
  }
  return ok({ ok: true, applied: true, username: u, keyEpoch: rotation.toEpoch, revokedDeviceIds }, NO_STORE);
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/users/:u/account-key-rotations (the route checks the read token)
// ──────────────────────────────────────────────────────────────────────

export type AccountKeyLaneEvent =
  | { kind: "admin-root-rotation"; seq: number; rotation: { username: string; oldAdminRootPubHex: string; newAdminRootPubHex: string; issuedAt: number }; signatureHex: string; pq?: unknown }
  | { kind: "account-key-rotation"; rotation: AccountKeyRotation; signatures: AccountKeyRotationSignatures; pq?: unknown; kept: KeptDevice[] };

/**
 * The account's lane in the order verifiers replay it: each account-key hop right after the admin-root
 * rotation that pinned the root which signed it (admin roots are random, so the root places it), hops
 * under one root by epoch.
 */
export async function buildAccountKeyLane(
  deps: Pick<AccountKeyRotationDeps, "usernames" | "rotations" | "adminRootRotations">,
  username: string,
): Promise<{ keyEpoch: number; lane: AccountKeyLaneEvent[] }> {
  const u = username.toLowerCase();
  const [user, hops, rootsRes] = await Promise.all([
    deps.usernames.get(u),
    deps.rotations.list(u),
    handleListAdminRootRotations({ usernames: deps.usernames, rotations: deps.adminRootRotations }, u),
  ]);
  const chain = ((rootsRes.body as { rotations?: Array<{ seq: number; oldAdminRootPub: string; newAdminRootPub: string; issuedAt: number; signatureHex: string; pq?: unknown }> }).rotations) ?? [];
  const roots = chain.length ? [chain[0]!.oldAdminRootPub, ...chain.map((c) => c.newAdminRootPub)] : [user?.adminRootPubHex?.toLowerCase() ?? ""];
  const hopEvents = hops.map((h) => {
    let parsed: { rotation: AccountKeyRotation; signatures: AccountKeyRotationSignatures; pq?: unknown };
    let keptDevices: KeptDevice[] = [];
    try {
      parsed = JSON.parse(h.hopJson);
      keptDevices = JSON.parse(h.keptJson);
    } catch {
      parsed = { rotation: {} as AccountKeyRotation, signatures: {} as AccountKeyRotationSignatures };
    }
    const at = roots.lastIndexOf(h.adminRootPubHex);
    const event: AccountKeyLaneEvent = { kind: "account-key-rotation", rotation: parsed.rotation, signatures: parsed.signatures, ...(parsed.pq !== undefined ? { pq: parsed.pq } : {}), kept: keptDevices };
    return { at: at < 0 ? roots.length : at, epoch: h.toEpoch, event };
  });
  const lane: AccountKeyLaneEvent[] = [];
  for (let k = 0; k <= roots.length; k++) {
    for (const h of hopEvents.filter((x) => x.at === k).sort((a, b) => a.epoch - b.epoch)) lane.push(h.event);
    const c = chain[k];
    if (c) {
      lane.push({
        kind: "admin-root-rotation",
        seq: c.seq,
        rotation: { username: u, oldAdminRootPubHex: c.oldAdminRootPub, newAdminRootPubHex: c.newAdminRootPub, issuedAt: c.issuedAt },
        signatureHex: c.signatureHex,
        ...(c.pq !== undefined ? { pq: c.pq } : {}),
      });
    }
  }
  return { keyEpoch: user?.keyEpoch ?? 0, lane };
}

export async function handleListAccountKeyRotations(
  deps: Pick<AccountKeyRotationDeps, "usernames" | "rotations" | "adminRootRotations">,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  if (!(await deps.usernames.get(u))) return notFound("username not registered");
  const { keyEpoch, lane } = await buildAccountKeyLane(deps, u);
  return ok({ username: u, keyEpoch, lane }, NO_STORE);
}

// ──────────────────────────────────────────────────────────────────────
// Kept devices: their deliveries, and the acknowledgement
// ──────────────────────────────────────────────────────────────────────

export async function handleGetUmkRotationDeliveries(
  deps: AccountKeyRotationDeps,
  accountId: string,
  deviceId: string,
  auth: DirectoryAuthorization | undefined,
): Promise<HandlerResponseWithHeaders> {
  const u = accountId.toLowerCase();
  const id = deviceId.toLowerCase();
  const path = `/api/accounts/${u}/devices/${id}/umk-rotation`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: u, method: "GET", path });
  if (!caller) return await deviceRefusal(deps, auth, { accountId: u, method: "GET", path });
  if (caller.deviceId !== id) return forbidden("not authorized");
  const now = (deps.now ?? Date.now)();
  const [pending, { keyEpoch, lane }] = await Promise.all([deps.rotations.listPendingDeliveries(u, id, now), buildAccountKeyLane(deps, u)]);
  const deliveries = pending.map((d) => {
    let delivery: unknown = null;
    try {
      delivery = JSON.parse(d.deliveryJson);
    } catch {
      /* stored by the apply handler from parsed JSON */
    }
    return { toEpoch: d.toEpoch, delivery, signatureHex: d.signatureHex, sealKind: d.sealKind, sealedHex: d.sealedHex, expiresAt: d.expiresAt };
  });
  return ok({ accountId: u, deviceId: id, keyEpoch, deliveries, lane }, NO_STORE);
}

export async function handleAckUmkRotationDeliveries(
  deps: AccountKeyRotationDeps,
  accountId: string,
  deviceId: string,
  auth: DirectoryAuthorization | undefined,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const u = accountId.toLowerCase();
  const id = deviceId.toLowerCase();
  const path = `/api/accounts/${u}/devices/${id}/umk-rotation/ack`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: u, method: "POST", path });
  if (!caller) return await deviceRefusal(deps, auth, { accountId: u, method: "POST", path });
  if (caller.deviceId !== id) return forbidden("not authorized");
  const toEpoch = isObj(body) ? body.toEpoch : undefined;
  if (typeof toEpoch !== "number" || !Number.isSafeInteger(toEpoch) || toEpoch < 1) return malformed("toEpoch required");
  const acked = await deps.rotations.ackDeliveries(u, id, toEpoch, (deps.now ?? Date.now)());
  return ok({ ok: true, acked }, NO_STORE);
}

// ──────────────────────────────────────────────────────────────────────
// PUT /api/accounts/:u/devices/:id/receive-key
// ──────────────────────────────────────────────────────────────────────

export async function handlePutDeviceReceiveKey(
  deps: AccountKeyRotationDeps,
  accountId: string,
  deviceId: string,
  auth: DirectoryAuthorization | undefined,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const u = accountId.toLowerCase();
  const id = deviceId.toLowerCase();
  const path = `/api/accounts/${u}/devices/${id}/receive-key`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: u, method: "PUT", path });
  if (!caller) return await deviceRefusal(deps, auth, { accountId: u, method: "PUT", path });
  if (caller.deviceId !== id) return forbidden("not authorized");
  if (!isObj(body) || !isObj(body.receiveKey) || typeof body.signatureHex !== "string") return malformed("malformed body");
  const k = body.receiveKey as unknown as DeviceReceiveKey;
  const now = (deps.now ?? Date.now)();
  if (k.username !== u || k.deviceId !== id || k.devicePubHex !== caller.signerPubHex) return forbidden("not authorized");
  if (typeof k.issuedAt !== "number" || Math.abs(now - k.issuedAt) > MAX_AGE_MS) return refuse(403, "stale-request");
  if (!verifyDeviceReceiveKey(k, body.signatureHex.toLowerCase())) return forbidden("invalid signature");
  await deps.rotations.putReceiveKey({
    accountId: u, deviceId: id, devicePubHex: k.devicePubHex, xwingPubHex: k.xwingPubHex, issuedAt: k.issuedAt,
    signatureHex: body.signatureHex.toLowerCase(), updatedAt: now,
  });
  return ok({ ok: true }, NO_STORE);
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/accounts/:u/devices/:id/key (device-key-rotate)
// ──────────────────────────────────────────────────────────────────────

/**
 * Replaces a device's key with a random one: the new key proves possession and the bare admin root
 * authorises it. The device's live grant names the old key, so a replacement grant for the new key comes
 * with it (admin root, or the account key for member scopes).
 */
export async function handleRotateDeviceKey(
  deps: AccountKeyRotationDeps,
  accountId: string,
  deviceId: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const u = accountId.toLowerCase();
  const id = deviceId.toLowerCase();
  const now = (deps.now ?? Date.now)();
  if (!isObj(body) || !isObj(body.rotate)) return malformed("malformed body");
  const r = body.rotate as unknown as DeviceKeyRotate;
  const sigs = { newKeySignatureHex: str(body.newKeySignatureHex), adminRootSignatureHex: str(body.adminRootSignatureHex) };
  if (r.username !== u || r.deviceId !== id) return malformed("rotate does not match path");
  if (typeof r.issuedAt !== "number" || Math.abs(now - r.issuedAt) > MAX_AGE_MS) return refuse(403, "stale-request");
  const user = await deps.usernames.get(u);
  if (!user) return notFound("username not registered");
  const adminRoot = user.adminRootPubHex?.toLowerCase();
  if (!adminRoot) return refuse(400, "no-admin-root", "account has no admin root");
  const bad = typeof r.newDevicePubHex === "string" ? badEd25519Key(r.newDevicePubHex) : malformed("malformed body");
  if (bad) return bad;
  if (!verifyDeviceKeyRotate(r, sigs, adminRoot)) return forbidden("invalid signature");
  const identity = await deps.identities.get(u, id);
  if (!identity || identity.revokedAt !== null || identity.devicePubHex !== r.oldDevicePubHex) return refuse(409, "device-key-changed");
  if (await deps.identities.getByPub(u, r.newDevicePubHex)) return refuse(409, "device-key-in-use");
  const active = (await deps.grants.listForUser(u)).filter((g) => g.revokedAt === null && g.deviceId.toLowerCase() === id);
  let newGrant: DeviceCapabilityGrantRecord | null = null;
  if (body.grant !== undefined && body.grant !== null) {
    const pseudo = { username: u, newIrkPubHex: user.irkPubHex.toLowerCase() } as AccountKeyRotation;
    const g = checkReplacementGrant(body.grant, pseudo, new Map([[id, r.newDevicePubHex]]), adminRoot, now);
    if (typeof g === "string") return refuse(403, "bad-grant", g);
    newGrant = g;
  } else if (active.length > 0) {
    return refuse(400, "grant-required", "the device's grant names its old key: send a grant for the new one");
  }
  if (!(await deps.nonces.claim(`device-key-rotate|${u}|${sigs.adminRootSignatureHex}`, now + MAX_AGE_MS, now))) return refuse(409, "replay");
  const done = await deps.rotations.rotateDeviceKey({
    accountId: u, deviceId: id, oldDevicePubHex: r.oldDevicePubHex, newDevicePubHex: r.newDevicePubHex,
    revokeGrantIds: active.map((g) => g.grantId), newGrant, at: now,
  });
  if (!done) return refuse(409, "device-key-changed");
  return ok({ ok: true, deviceId: id, devicePubHex: r.newDevicePubHex }, NO_STORE);
}

/** For the box doorbell and `/pods`: the epoch and a stamp of the lane (changes whenever the lane does). */
export function accountKeyLaneStamp(lane: readonly AccountKeyLaneEvent[]): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(lane)))).slice(0, 24);
}
