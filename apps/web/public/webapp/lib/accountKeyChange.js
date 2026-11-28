// Changing the account key from the browser (docs/account-key-rotation.md): the rotator, the receiver, the
// receive key and the move off a derived device key.
//
// Rotator (an admin browser holding the bare admin root): plan who stays (planRotation), build one request
// (buildRotationRequest: the hop, kept devices, deliveries sealed to each kept device, replacement grants,
// re-encrypted profiles, the admin-root change first when the removed device may have held the root), keep
// the new key and the request in a pending slot, POST, and make the new key current only once `.com` applied
// it (promoteNewUmk), or on the next start when `.com` already serves the new key (resumePendingRotation).
//
// Receiver (every kept browser): when `.com` serves an account key this browser does not hold, fetch its
// delivery, replay the lane from the admin root it pinned, check it is in the kept list, open the delivery,
// check the opened key derives the hop's IRK and AID, install it (the old key stays retired), acknowledge.
//
// The browser never signs a hybrid companion (keyless-web rule), so an account under strict is changed from
// the iPhone or Android app. Pure functions take everything they need; the IO ones take `deps` test seams.

import { ed25519 } from "../vendor/noble-post-quantum/pq-seal.js";
import * as rot from "./accountKeyRotation.js";
import { verifyEd25519Sync } from "./edKey.js";
import { hybridSealKeygen } from "./voiciCore.js";
import { controlApex } from "./apex.js";
import {
  canonicalAccountProfile,
  canonicalDeviceManagedProfile,
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  encryptProfile,
} from "./accountMetadata.js";
import { deviceGrantCanonicalBytes } from "./crossDevicePairing.js";
import { adminRootRotationCanonicalBytes } from "./adminRootRotation.js";
import { isAdminRootKey, withAdminRoot } from "./keyCustody.js";
import { tr } from "./i18n.js";

export const ACCOUNT_KEY_CAPABILITY = "account-key-rotation/v1";
export const OWN_SCHEME = "web";
const GRANT_TTL_MS = 90 * 24 * 3_600_000;
const RESUBMIT_WINDOW_MS = 15 * 60_000;
const HEX32 = /^[0-9a-f]{64}$/;

/** Every sentence of the flow, in one place (the views and tests read them from here). */
export const ACCOUNT_KEY_COPY = Object.freeze({
  question: tr("Could someone else unlock this device?"),
  answerNo: tr("No: it's lost and locked, or I erased it"),
  answerYes: tr("Yes, or I'm not sure"),
  browserAdvice: tr("This was a browser. Someone with the computer could try to guess its passphrase, so changing your account key is safer."),
  title: tr("Change your account key"),
  othersKeep: tr("Your other devices keep working. They get the new key the next time they open Flagship."),
  serversFollow: tr("Your servers switch to the new key by themselves. Nothing needs pairing again."),
  mustReAdd: tr("These devices must be added again:"),
  reasonDerived: (name) => tr("{0}: its key came from the old account key", name),
  reasonNoReceiveKey: (name) => tr("{0}: it can't receive the new key safely", name),
  browsersApprove: tr("Browsers signed in to your servers will need to be approved again."),
  recoveryAgain: tr("Set up cloud recovery again afterwards."),
  oldBackups: tr("Old backups still open with the old key, and so do copies on the removed device."),
  adminFirst: (name) => tr("{0} held the admin key, so the admin key changes first.", name),
  addedOn: (name, when) => tr("{0}, added {1}", name, when),
  keptHeading: tr("These devices keep the account:"),
  change: tr("Change account key"),
  cancel: tr("Cancel"),
  changing: tr("Changing the account key…"),
  changed: tr("Account key changed"),
  updateServers: (name) => tr("Update every server first: {0} can't follow an account key change yet.", name),
  strictWeb: tr("Under quantum-safe protection, change the account key from the iPhone or Android app."),
  conflict: tr("Another admin device changed the account key first. Open Flagship again to get the new key."),
  failed: tr("The account key could not be changed. Nothing was changed. Try again."),
  notAdmin: tr("Only an admin device of this account can change the account key."),
  bannerPlain: tr("Your account key was changed. Unlock to continue."),
  bannerDone: tr("This device has the new account key."),
  receiveFailed: tr("This device couldn't check the new account key. Ask an admin device to add it again."),
  progressTitle: tr("Account key change"),
  devicesUpdated: (n, total) => tr("Devices updated: {0} of {1}", n, total),
  serversUpdated: (n, total) => tr("Servers on the new key: {0} of {1}", n, total),
  waitingFor: (name) => tr("Waiting for {0}", name),
  stillToDo: (name, what) => tr("Still to do on {0}: {1}", name, what),
  retry: tr("Retry"),
  recoveryOff: tr("Cloud recovery is off since the account key changed. Set it up again."),
  setUpRecovery: tr("Set up cloud recovery"),
  pushBody: tr("Your account key was changed. Open Flagship to keep using this device."),
});

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function unhex(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const pubOf = (seed) => hex(ed25519.getPublicKey(seed));
const signEd = (seed, msg) => hex(ed25519.sign(msg, seed));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const lower = (s) => String(s ?? "").toLowerCase();

function scopesOf(grant) {
  if (!grant) return [];
  if (Array.isArray(grant.scopes)) return grant.scopes;
  try {
    const s = JSON.parse(grant.scopesJson ?? "[]");
    return Array.isArray(s) ? s : [];
  } catch {
    return [];
  }
}

/** The new IRK / AID public keys a UMK gives in a scheme (version 1). */
export function rotatedKeysOf(umk, scheme = OWN_SCHEME) {
  return { irkPubHex: pubOf(rot.deriveIrkSeedInScheme(umk, scheme, 1)), aidPubHex: pubOf(rot.deriveAidSeed(umk)) };
}

/** A verified receive key for `device`, or null (wrong device key, bad signature, malformed key). */
export function verifiedReceiveKey(username, device, receiveKeys) {
  const rec = (receiveKeys ?? []).find((k) => k.deviceId === device.deviceId);
  if (!rec || lower(rec.devicePubHex) !== lower(device.devicePubHex)) return null;
  const k = { username, deviceId: rec.deviceId, devicePubHex: lower(rec.devicePubHex), xwingPubHex: lower(rec.xwingPubHex), issuedAt: rec.issuedAt };
  return rot.verifyDeviceReceiveKey(k, lower(rec.signatureHex)) ? unhex(k.xwingPubHex) : null;
}

// ── Planning ───────────────────────────────────────────────────────────────

/**
 * Who keeps the account. `directory` is fetchDecryptedDirectory's answer plus `receiveKeys`. Returns
 * `{ removed, kept: [{device, receiveKey}], excluded: [{device, reason}], removedHeldAdmin }`; throws
 * `{code: "self-derived"}` when this browser's own key still comes from the account key (migrate it first).
 */
export function planRotation({ username, directory, removedDeviceId, selfDeviceId, umk, strict = false }) {
  const active = (directory.devices ?? []).filter((d) => d.revokedAt === null || d.revokedAt === undefined);
  const removed = active.find((d) => d.deviceId === removedDeviceId);
  if (!removed) throw Object.assign(new Error("removed device not found"), { code: "removed-not-found" });
  const kept = [];
  const excluded = [];
  for (const d of active) {
    if (d.deviceId === removedDeviceId) continue;
    const pub = lower(d.devicePubHex);
    const derived = rot.deviceKeyIsUmkDerived(umk, username, d.deviceId, pub);
    if (d.deviceId === selfDeviceId) {
      if (derived) throw Object.assign(new Error("this browser's device key comes from the account key"), { code: "self-derived" });
      kept.push({ device: d, receiveKey: null, self: true });
      continue;
    }
    if (derived) {
      excluded.push({ device: d, reason: "derived" });
      continue;
    }
    const receiveKey = verifiedReceiveKey(username, d, directory.receiveKeys);
    if (strict && !receiveKey) {
      excluded.push({ device: d, reason: "no-receive-key" });
      continue;
    }
    kept.push({ device: d, receiveKey, self: false });
  }
  if (!kept.some((k) => k.self)) throw Object.assign(new Error("this browser is not an active device of the account"), { code: "self-missing" });
  return { removed, kept, excluded, removedHeldAdmin: scopesOf(removed.grant).includes("admin") };
}

// ── Building the request ──────────────────────────────────────────────────

/**
 * The whole POST body. `adminRootSeed` is the raw seed of the root `.com` pins now (opened for this one
 * request). `account` is `{ username, keyEpoch, irkPubHex, aidPubHex }`: the current keys, which the caller
 * checked against `.com`. Returns `{ body, newUmk, toEpoch, newAdminRootSeed, signingRootPubHex }`.
 */
export async function buildRotationRequest({ plan, account, adminRootSeed, directory, now = Date.now(), newUmk = random(32), newRootSeed = null, nonceHex = hex(random(16)) }) {
  const u = account.username;
  const oldRootPub = pubOf(adminRootSeed);
  let signingSeed = adminRootSeed;
  let adminRootRotation;
  let newAdminRootSeed = null;
  if (plan.removedHeldAdmin) {
    newAdminRootSeed = newRootSeed ?? random(32);
    const r = { username: u, oldAdminRootPub: oldRootPub, newAdminRootPub: pubOf(newAdminRootSeed), issuedAt: now };
    adminRootRotation = { rotation: r, signatureHex: signEd(adminRootSeed, adminRootRotationCanonicalBytes(r)) };
    signingSeed = newAdminRootSeed;
  }
  const signingRootPubHex = pubOf(signingSeed);
  const newIrkSeed = rot.deriveIrkSeedInScheme(newUmk, OWN_SCHEME, 1);
  const newAidSeed = rot.deriveAidSeed(newUmk);
  const keptList = plan.kept.map((k) => ({ deviceId: k.device.deviceId, devicePubHex: lower(k.device.devicePubHex) }));
  const removedIds = [plan.removed.deviceId, ...plan.excluded.map((e) => e.device.deviceId)];
  const rotation = {
    username: u,
    fromEpoch: account.keyEpoch,
    toEpoch: account.keyEpoch + 1,
    oldIrkPubHex: lower(account.irkPubHex),
    newIrkPubHex: pubOf(newIrkSeed),
    newIrkScheme: OWN_SCHEME,
    oldAidPubHex: lower(account.aidPubHex),
    newAidPubHex: pubOf(newAidSeed),
    adminRootPubHex: signingRootPubHex,
    removedDeviceIds: removedIds,
    keptDevicesDigestHex: rot.keptDevicesDigestHex(keptList),
    recoveryRecordDigestHex: null,
    nonceHex,
    issuedAt: now,
  };
  const signatures = rot.signAccountKeyRotation(rotation, { adminRootSeed: signingSeed, newIrkSeed, newAidSeed });

  const deliveries = [];
  const grants = [];
  for (const k of plan.kept) {
    const d = k.device;
    const devicePubHex = lower(d.devicePubHex);
    if (!k.self) {
      // A kept device that may hold the bare root gets the new one with its key.
      const carriesRoot = !!newAdminRootSeed && scopesOf(d.grant).includes("admin") && d.grant?.signerRoot === "admin-root";
      const plaintext = rot.encodeUmkRotationPlaintext({ umk: newUmk, irkScheme: OWN_SCHEME, adminRootSeed: carriesRoot ? newAdminRootSeed : null });
      const recipient = k.receiveKey ? { kind: "xwing", publicKey: k.receiveKey } : { kind: "ed25519", devicePub: unhex(devicePubHex) };
      const sealed = rot.sealUmkRotation({ rotation, deviceId: d.deviceId, plaintext, recipient, issuedAt: now });
      const built = rot.buildUmkRotationDelivery({ rotation, deviceId: d.deviceId, devicePubHex, sealed: sealed.sealed, issuedAt: now, adminRootSeed: signingSeed });
      deliveries.push({ delivery: built.delivery, signatureHex: built.signatureHex, sealKind: sealed.kind, sealedHex: hex(sealed.sealed) });
      plaintext.fill(0);
    }
    // A kept device whose live grant the old account key signed gets one from the admin root, same scopes.
    if (d.grant && d.grant.signerRoot !== "admin-root") {
      const scopes = scopesOf(d.grant);
      const g = { grantId: crypto.randomUUID().toLowerCase(), username: u, deviceId: d.deviceId, devicePubHex, scopes, issuedAt: now, expiresAt: now + GRANT_TTL_MS };
      grants.push({
        grant: { grantId: g.grantId, username: u, deviceId: d.deviceId, devicePubKey: devicePubHex, scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt },
        signature: signEd(signingSeed, deviceGrantCanonicalBytes(g)),
        signerRoot: "admin-root",
      });
    }
  }

  // Names stay readable: the account profile and the managed device names, under the new account key.
  let accountProfile;
  if (directory.accountProfile && directory.accountDisplayName) {
    const revision = (directory.accountProfile.revision ?? 0) + 1;
    const enc = await encryptProfile(directory.accountDisplayName, await deriveAccountProfileKey(newUmk), { accountId: u, recordType: "account-profile", revision, keyVersion: 1 });
    const unsigned = { accountId: u, revision, keyVersion: 1, ...enc, issuedAt: now, signerPubHex: signingRootPubHex };
    accountProfile = { ...unsigned, signatureHex: signEd(signingSeed, canonicalAccountProfile(unsigned)) };
  }
  const managedProfiles = [];
  const directoryKey = await deriveDeviceDirectoryKey(newUmk);
  for (const k of plan.kept) {
    const d = k.device;
    const current = (directory.managedProfiles ?? []).find((p) => p.deviceId === d.deviceId);
    if (!current || !d.managedDisplayName) continue;
    const revision = (current.revision ?? 0) + 1;
    const enc = await encryptProfile(d.managedDisplayName, directoryKey, { accountId: u, deviceId: d.deviceId, recordType: "device-managed-profile", revision, keyVersion: 1 });
    const unsigned = { accountId: u, deviceId: d.deviceId, revision, keyVersion: 1, ...enc, locked: current.locked === true, issuedAt: now, signerPubHex: signingRootPubHex };
    managedProfiles.push({ ...unsigned, signatureHex: signEd(signingSeed, canonicalDeviceManagedProfile(unsigned)) });
  }

  const body = {
    rotation,
    signatures,
    kept: keptList,
    deliveries,
    grants,
    ...(accountProfile ? { accountProfile } : {}),
    ...(managedProfiles.length ? { managedProfiles } : {}),
    ...(adminRootRotation ? { adminRootRotation } : {}),
  };
  return { body, newUmk, toEpoch: rotation.toEpoch, newAdminRootSeed, signingRootPubHex };
}

// ── The receiver's checks ──────────────────────────────────────────────────

/**
 * Replays `.com`'s lane from what this device holds: `pinnedRoot` (the admin root it pinned) and its current
 * IRK and AID. Admin-root rotations are followed only from the pinned root and only when the old root signed
 * them; an account-key hop counts only when it starts from this device's IRK (then from the previous hop's)
 * and verifies under the root pinned at that point. Returns `{ hops: [{rotation, kept}], adminRootPubHex }`.
 * Throws AccountKeyRotationError("not-kept") when a hop leaves this device out.
 */
export function verifyLaneForDevice({ username, lane, pinnedRoot, irkPubHex, aidPubHex, self }) {
  let root = lower(pinnedRoot);
  let irk = lower(irkPubHex);
  let aid = aidPubHex ? lower(aidPubHex) : null;
  let epoch = null;
  const hops = [];
  for (const ev of lane ?? []) {
    if (ev?.kind === "admin-root-rotation") {
      const r = ev.rotation ?? {};
      if (lower(r.oldAdminRootPubHex) !== root || typeof ev.signatureHex !== "string") continue;
      let ok = false;
      try {
        const msg = adminRootRotationCanonicalBytes({ username: r.username, oldAdminRootPub: lower(r.oldAdminRootPubHex), newAdminRootPub: lower(r.newAdminRootPubHex), issuedAt: r.issuedAt });
        ok = lower(r.username) === username && verifyEd25519Sync(unhex(root), unhex(lower(ev.signatureHex)), msg);
      } catch {
        ok = false;
      }
      if (ok) root = lower(r.newAdminRootPubHex);
      continue;
    }
    if (ev?.kind !== "account-key-rotation" || !ev.rotation) continue;
    const r = ev.rotation;
    if (r.oldIrkPubHex !== irk) continue;
    rot.verifyAccountKeyRotation({
      rotation: r,
      signatures: ev.signatures,
      state: { username, epoch: epoch ?? r.fromEpoch, irkPubHex: irk, aidPubHex: aid, adminRootPubHex: root },
    });
    rot.verifyKeptDevice({ rotation: r, kept: ev.kept ?? [], self });
    hops.push({ rotation: r, kept: ev.kept });
    irk = r.newIrkPubHex;
    aid = r.newAidPubHex;
    epoch = r.toEpoch;
  }
  return { hops, adminRootPubHex: root };
}

/** Opens this device's delivery for one verified hop. `secrets` = `{ receiveSeed?, deviceSeed }`. */
export function openDeliveryForHop({ rotation, deliveries, self, secrets }) {
  const d = (deliveries ?? []).find((x) => x?.toEpoch === rotation.toEpoch && x?.delivery);
  if (!d) throw new rot.AccountKeyRotationError("no-delivery");
  const kind = d.sealKind === "xwing" ? "xwing" : "ed25519";
  const secret = kind === "xwing" ? secrets.receiveSeed : secrets.deviceSeed;
  if (!(secret instanceof Uint8Array)) throw new rot.AccountKeyRotationError("open-failed");
  return rot.openUmkRotationDelivery({ rotation, delivery: d.delivery, signatureHex: lower(d.signatureHex), sealed: unhex(lower(d.sealedHex)), kind, self, secret });
}

// ── Progress ──────────────────────────────────────────────────────────────

/**
 * `{ devices: {updated, total}, servers: {updated, total, waiting: [names], rekeyDue: [{name, what}]} }`.
 * A kept device counts as updated once its own profile is back in the directory (`.com` dropped every self
 * profile at the hop, and each device publishes its own again under the new key).
 */
export function rotationProgress({ keyEpoch, kept, selfProfiles, serverStatuses }) {
  const ids = new Set((selfProfiles ?? []).map((p) => p.deviceId));
  const keptIds = (kept ?? []).map((k) => k.deviceId);
  const servers = serverStatuses ?? [];
  const on = servers.filter((s) => typeof s.status?.trustedEpoch === "number" && s.status.trustedEpoch >= keyEpoch);
  return {
    devices: { updated: keptIds.filter((id) => ids.has(id)).length, total: keptIds.length },
    servers: {
      updated: on.length,
      total: servers.length,
      waiting: servers.filter((s) => !on.includes(s)).map((s) => s.name),
      rekeyDue: on.filter((s) => Array.isArray(s.status?.rekeyDue) && s.status.rekeyDue.length).map((s) => ({ name: s.name, what: s.status.rekeyDue.join(", ") })),
    },
  };
}

/** True when the progress card has nothing left to show. */
export function rotationComplete(p) {
  return p.devices.updated >= p.devices.total && p.servers.updated >= p.servers.total;
}

// ── IO ─────────────────────────────────────────────────────────────────────

async function json(r) {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

/** `.com`'s public view of the account: `{ irkPub, adminRootPub, keyEpoch }`. */
export async function fetchAccountKeys(username, deps = {}) {
  const f = deps.fetch ?? fetch;
  const r = await f(`${deps.baseUrl ?? controlApex()}/api/username/${encodeURIComponent(username)}`, { cache: "no-store" });
  if (!r.ok) throw Object.assign(new Error(`account lookup failed (${r.status})`), { status: r.status });
  const b = await json(r);
  return { irkPub: lower(b?.irkPub), adminRootPub: b?.adminRootPub ? lower(b.adminRootPub) : null, keyEpoch: typeof b?.keyEpoch === "number" ? b.keyEpoch : 0 };
}

const PIN_PREFIX = "flagship.adminRootPin.";

/** The admin root this browser pinned for its account (its own, or the join bundle's). */
export function pinnedAdminRoot(accountId) {
  try {
    const v = globalThis.localStorage?.getItem(PIN_PREFIX + lower(accountId));
    return v && HEX32.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function pinAdminRoot(accountId, pubHex) {
  if (!HEX32.test(lower(pubHex))) return;
  try {
    globalThis.localStorage?.setItem(PIN_PREFIX + lower(accountId), lower(pubHex));
  } catch { /* best-effort, like the other local pins */ }
}

/**
 * The admin root this browser trusts: its own (it holds the root), else the one it pinned from its
 * SAS-authenticated join bundle. Never `.com`'s word alone: a browser with neither stays unpinned, and the
 * receiver then refuses (it has to be added again).
 */
export async function ensureAdminRootPin(accountId, { adminRootPubHex = null } = {}) {
  if (adminRootPubHex && HEX32.test(lower(adminRootPubHex))) {
    pinAdminRoot(accountId, adminRootPubHex);
    return lower(adminRootPubHex);
  }
  return pinnedAdminRoot(accountId);
}

/** GET /api/screens/account-key/status on every server. `[{ name, domain, status|null }]`. */
export async function fetchServerKeyStatuses(pods, deps) {
  const out = [];
  for (const p of pods ?? []) {
    const domain = lower(p.serverDomain);
    if (!domain || p.revokedAt) continue;
    let status = null;
    try {
      status = (await deps.screensFetchForPod(domain, "/api/screens/account-key/status"))?.status ?? null;
    } catch {
      status = null;
    }
    out.push({ name: p.name ?? domain, domain, status });
  }
  return out;
}

/** The first server that can't follow a change (no status, or not the capability), or null. */
export function serverNotReady(statuses) {
  return statuses.find((s) => s.status?.capability !== ACCOUNT_KEY_CAPABILITY) ?? null;
}

/** Publish this device's receive key when `.com` doesn't hold it for the current device key. */
export async function ensureReceiveKey({ session, profile }, deps) {
  const umk = session?.umk;
  if (!(umk instanceof Uint8Array) || !profile?.accountId || !/^[0-9a-f]{32}$/.test(profile.deviceId ?? "")) return "skipped";
  const deviceSeed = await deps.deriveAccountDeviceSeed(umk, profile.accountId, profile.deviceId);
  const devicePubHex = pubOf(deviceSeed);
  let held = await deps.loadReceiveKeySeed(umk, profile.accountId, profile.deviceId);
  if (!held) {
    held = { seed: random(32), publishedFor: null };
    await deps.persistReceiveKeySeed(umk, profile.accountId, profile.deviceId, held.seed, null);
  }
  if (held.publishedFor === devicePubHex) return "current";
  const { publicKey } = hybridSealKeygen(held.seed);
  const receiveKey = { username: lower(profile.accountId), deviceId: profile.deviceId, devicePubHex, xwingPubHex: hex(publicKey), issuedAt: Date.now() };
  const signatureHex = rot.signDeviceReceiveKey(receiveKey, deviceSeed);
  const path = `/api/accounts/${encodeURIComponent(lower(profile.accountId))}/devices/${profile.deviceId}/receive-key`;
  const r = await deps.signedDirectoryFetch(path, { method: "PUT", body: JSON.stringify({ receiveKey, signatureHex }) });
  if (!r.ok) return `refused-${r.status}`;
  await deps.persistReceiveKeySeed(umk, profile.accountId, profile.deviceId, held.seed, devicePubHex);
  return "published";
}

/**
 * Moves an admin browser off a device key derived from the account key (flagship/device-key-rotate/v1):
 * a random key, signed by itself and the admin root, with a grant for it (same scopes, admin root). Returns
 * "random" (nothing to do), "not-admin", "migrated", or "refused-<status>".
 */
export async function migrateDerivedDeviceKey({ session, profile, grant }, deps) {
  const umk = session?.umk;
  if (!(umk instanceof Uint8Array) || !profile?.accountId || !/^[0-9a-f]{32}$/.test(profile.deviceId ?? "")) return "skipped";
  const u = lower(profile.accountId);
  const oldSeed = await deps.deriveAccountDeviceSeed(umk, u, profile.deviceId);
  const oldPub = pubOf(oldSeed);
  if (!rot.deviceKeyIsUmkDerived(umk, u, profile.deviceId, oldPub)) return "random";
  if (!isAdminRootKey(session.adminRootSeed)) return "not-admin";
  const newSeed = random(32);
  const now = Date.now();
  const rotate = { username: u, deviceId: profile.deviceId, oldDevicePubHex: oldPub, newDevicePubHex: pubOf(newSeed), issuedAt: now };
  const scopes = scopesOf(grant);
  const signed = await (deps.withAdminRoot ?? withAdminRoot)(session.adminRootSeed, ({ edSeed }) => {
    const sigs = rot.signDeviceKeyRotate(rotate, { newKeySeed: newSeed, adminRootSeed: edSeed });
    if (!scopes.length) return { sigs, grant: null };
    const g = { grantId: crypto.randomUUID().toLowerCase(), username: u, deviceId: profile.deviceId, devicePubHex: rotate.newDevicePubHex, scopes, issuedAt: now, expiresAt: now + GRANT_TTL_MS };
    return {
      sigs,
      grant: {
        grant: { grantId: g.grantId, username: u, deviceId: g.deviceId, devicePubKey: g.devicePubHex, scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt },
        signature: signEd(edSeed, deviceGrantCanonicalBytes(g)),
        signerRoot: "admin-root",
      },
    };
  }, { reason: tr("Give this browser its own device key") });
  const f = deps.fetch ?? fetch;
  const r = await f(`${deps.baseUrl ?? controlApex()}/api/accounts/${encodeURIComponent(u)}/devices/${profile.deviceId}/key`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rotate, ...signed.sigs, ...(signed.grant ? { grant: signed.grant } : {}) }),
  });
  if (!r.ok) return `refused-${r.status}`;
  await deps.persistAccountDeviceSeed(umk, u, profile.deviceId, newSeed);
  return "migrated";
}

/**
 * Makes `newUmk` this browser's account key after `.com` applied the hop: the device-local secrets move under
 * it (the old key stays retired, reachable through the same passphrase), the IRK starts again at version 1 of
 * `scheme`, a new admin root is kept, and the session reopens on the new key.
 */
export async function promoteNewUmk({ session, profile, oldUmk, newUmk, toEpoch, scheme = OWN_SCHEME, newAdminRootSeed = null }, deps) {
  const u = lower(profile.accountId);
  const deviceSeed = await deps.deriveAccountDeviceSeed(oldUmk, u, profile.deviceId);
  const receive = await deps.loadReceiveKeySeed(oldUmk, u, profile.deviceId);
  await deps.installSuccessorUmk(oldUmk, newUmk, toEpoch);
  await deps.persistAccountDeviceSeed(newUmk, u, profile.deviceId, deviceSeed);
  if (receive) await deps.persistReceiveKeySeed(newUmk, u, profile.deviceId, receive.seed, receive.publishedFor);
  if (newAdminRootSeed) {
    await deps.persistAdminRootSeed(newUmk, newAdminRootSeed);
    pinAdminRoot(u, pubOf(newAdminRootSeed));
  }
  deps.adoptRegisteredIrk({ scheme, version: 1 });
  await deps.clearPendingRotation();
  await deps.unlockSession(newUmk, session.username ?? u);
  deps.clearAccountReadTokens?.();
}

function rotationError(status, b) {
  const code = b?.code ?? b?.error ?? null;
  if (status === 409) return Object.assign(new Error(ACCOUNT_KEY_COPY.conflict), { code: code ?? "rotation-conflict", status });
  if (code === "strict-requires-hybrid" || code === "strict-requires-xwing-delivery") return Object.assign(new Error(ACCOUNT_KEY_COPY.strictWeb), { code, status });
  return Object.assign(new Error(ACCOUNT_KEY_COPY.failed), { code, status });
}

/** POST the request. Resolves the parsed 200 answer; throws with `.code` / `.status` and a sentence otherwise. */
export async function postRotation(username, body, deps = {}) {
  const f = deps.fetch ?? fetch;
  const r = await f(`${deps.baseUrl ?? controlApex()}/api/users/${encodeURIComponent(username)}/account-key-rotation`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const b = await json(r);
  if (r.ok) return b ?? {};
  throw rotationError(r.status, b);
}

/**
 * The rotator end to end, once the person confirmed the summary. `ctx` = `{ session, profile, plan,
 * directory, account }`; `deps` adds the keystore and network seams. Resolves `{ toEpoch, revokedDeviceIds }`.
 */
export async function runRotation(ctx, deps) {
  const { session, profile, plan, directory, account } = ctx;
  if (!isAdminRootKey(session.adminRootSeed)) throw Object.assign(new Error(ACCOUNT_KEY_COPY.notAdmin), { code: "not-admin" });
  const oldUmk = session.umk;
  const built = await (deps.withAdminRoot ?? withAdminRoot)(
    session.adminRootSeed,
    ({ edSeed }) => buildRotationRequest({ plan, account, adminRootSeed: edSeed, directory }),
    { reason: ACCOUNT_KEY_COPY.title },
  );
  await deps.putPendingRotation(oldUmk, { newUmk: built.newUmk, toEpoch: built.toEpoch, body: built.body, issuedAt: built.body.rotation.issuedAt });
  let answer;
  try {
    answer = await deps.postRotation(account.username, built.body);
  } catch (e) {
    if (e?.status === 409) {
      // Applied meanwhile (a retry that raced), or another admin won: `.com`'s key decides.
      const now = await deps.fetchAccountKeys(account.username).catch(() => null);
      if (now && now.irkPub === built.body.rotation.newIrkPubHex) answer = { keyEpoch: built.toEpoch, revokedDeviceIds: [] };
      else await deps.clearPendingRotation();
    } else if (typeof e?.status === "number") {
      await deps.clearPendingRotation();
    }
    if (!answer) throw e;
  }
  await promoteNewUmk({ session, profile, oldUmk, newUmk: built.newUmk, toEpoch: built.toEpoch, newAdminRootSeed: built.newAdminRootSeed }, deps);
  deps.markRotationDone?.({ keyEpoch: built.toEpoch, kept: built.body.kept, recoveryWasOn: ctx.recoveryWasOn === true });
  return { toEpoch: built.toEpoch, revokedDeviceIds: answer.revokedDeviceIds ?? [] };
}

/**
 * On start, with a pending slot: `.com` already on the new key → promote; still on this key and the request
 * fresh → send the same body once more; otherwise drop it. Resolves "none" | "promoted" | "resent" | "dropped".
 */
export async function resumePendingRotation({ session, profile }, deps) {
  const umk = session?.umk;
  if (!(umk instanceof Uint8Array)) return "none";
  const pending = await deps.loadPendingRotation(umk);
  if (!pending) return "none";
  const account = await deps.fetchAccountKeys(lower(profile.accountId));
  const next = rotatedKeysOf(pending.newUmk, pending.body?.rotation?.newIrkScheme ?? OWN_SCHEME);
  const promote = async () => {
    await promoteNewUmk({ session, profile, oldUmk: umk, newUmk: pending.newUmk, toEpoch: pending.toEpoch }, deps);
    deps.markRotationDone?.({ keyEpoch: pending.toEpoch, kept: pending.body?.kept ?? [], recoveryWasOn: false });
  };
  if (account.irkPub === next.irkPubHex) {
    await promote();
    return "promoted";
  }
  const current = hex(session.irk?.publicKey ?? new Uint8Array());
  if (account.irkPub === current && Date.now() - (pending.issuedAt ?? 0) < RESUBMIT_WINDOW_MS) {
    try {
      await deps.postRotation(lower(profile.accountId), pending.body);
      await promote();
      return "resent";
    } catch {
      /* fall through: dropped */
    }
  }
  await deps.clearPendingRotation();
  return "dropped";
}

/**
 * The receiver. Resolves `{ state }`: "current" (nothing to do), "updated" (`toEpoch`), "removed" (`.com`
 * says this device is no longer on the account; the account-gone screen takes over), or throws with a
 * protocol code when the change can't be checked.
 */
export async function receiveAccountKey({ session, profile }, deps) {
  const umk = session?.umk;
  if (!(umk instanceof Uint8Array) || !profile?.accountId || !/^[0-9a-f]{32}$/.test(profile.deviceId ?? "")) return { state: "locked" };
  const u = lower(profile.accountId);
  const account = await deps.fetchAccountKeys(u);
  const localIrk = hex(session.irk?.publicKey ?? new Uint8Array());
  if (!account.irkPub || account.irkPub === localIrk) return { state: "current" };
  const path = `/api/accounts/${encodeURIComponent(u)}/devices/${profile.deviceId}/umk-rotation`;
  const r = await deps.signedDirectoryFetch(path, { method: "GET" });
  if (r.status === 403 || r.status === 401) return { state: "removed" };
  if (!r.ok) throw Object.assign(new Error(`delivery fetch failed (${r.status})`), { code: "fetch-failed" });
  const answer = (await json(r)) ?? {};
  const pinned = await ensureAdminRootPin(u, { adminRootPubHex: deps.ownAdminRootPubHex ?? null });
  if (!pinned) throw new rot.AccountKeyRotationError("wrong-admin-root");
  const deviceSeed = await deps.deriveAccountDeviceSeed(umk, u, profile.deviceId);
  const self = { deviceId: profile.deviceId, devicePubHex: pubOf(deviceSeed) };
  const localAid = pubOf(rot.deriveAidSeed(umk));
  const { hops, adminRootPubHex } = verifyLaneForDevice({ username: u, lane: answer.lane, pinnedRoot: pinned, irkPubHex: localIrk, aidPubHex: localAid, self });
  if (!hops.length) throw new rot.AccountKeyRotationError("wrong-old-irk");
  const receive = await deps.loadReceiveKeySeed(umk, u, profile.deviceId);
  // Open every delivery first: nothing is installed unless all of them open and check.
  const opened = hops.map((h) => ({ hop: h, p: openDeliveryForHop({ rotation: h.rotation, deliveries: answer.deliveries, self, secrets: { receiveSeed: receive?.seed ?? null, deviceSeed } }) }));
  let current = umk;
  for (const { hop, p } of opened) {
    await promoteNewUmk({ session, profile, oldUmk: current, newUmk: p.umk, toEpoch: hop.rotation.toEpoch, scheme: p.irkScheme, newAdminRootSeed: p.adminRootSeed }, deps);
    current = p.umk;
    try {
      await deps.signedDirectoryFetch(`${path}/ack`, { method: "POST", body: JSON.stringify({ toEpoch: hop.rotation.toEpoch }) });
    } catch { /* the delivery waits; acknowledging again is harmless */ }
  }
  pinAdminRoot(u, adminRootPubHex);
  const last = hops[hops.length - 1].rotation;
  return { state: "updated", toEpoch: last.toEpoch };
}
