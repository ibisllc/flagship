#!/usr/bin/env tsx
/**
 * Cross-language test-vectors generator — THE single authoritative source of
 * canonical-byte vectors that all four language implementations (TS, Swift,
 * Kotlin, webapp JS) verify against.
 *
 * Emits a JSON file at `test-vectors/canonical-bytes.json` containing, for
 * every covered canonical-bytes shape, a fixed deterministic input + the
 * canonical-bytes hex + (where a fixed test key applies) an Ed25519 signature
 * produced by a fixed-seed key.
 *
 * WHO LOADS THIS FILE (no transcribed copies — they read THIS file at test
 * time so a TS-only canonical-byte change can't ship green while a mirror
 * asserts a stale copy):
 *   - TS      packages/protocol/tests/canonicalBytesVectors.test.ts
 *   - webapp  apps/web/tests/canonicalBytesVectors.test.ts
 *   - Swift   apps/mobile/ios/Tests/FlagshipMobileTests/CanonicalBytesVectorsTests.swift
 *             (locates this file via #filePath — no Package.swift resource copy)
 *   - Kotlin  apps/mobile/android/.../core/CanonicalBytesVectorsTest.kt
 *             (walks up from user.dir, same pattern as MaintainersConformanceTest)
 *
 * Each client asserts ONLY the purposes it actually implements and skips the
 * rest with a note (recorded per-vector — see `clients` below). A client that
 * claims to cover a vector but computes different bytes fails loudly.
 *
 * Run:        npx tsx tools/test-vectors.ts          # (re)write the file
 * CI freshness: npx tsx tools/test-vectors.ts --check  # exit 1 if stale
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalBoxUnpair,
  canonicalPair,
  canonicalWiFiConfig,
  deriveBAK,
  deriveIRK,
  deriveSTK,
  deriveSWK,
  ed,
  PAIR_PROTOCOL_VERSION,
  signAccountRecovery,
  signAuthCode,
  signBoxUnpair,
  signDaemonStatusReport,
  signDeviceCapabilityGrant,
  signInstallBlob,
  signInvite,
  signInviteAcceptance,
  signJournalRequest,
  signMembershipMutation,
  signMigrationRequest,
  signPair,
  signPbAnnounce,
  signPbPeerConfirm,
  signPbRequestPeers,
  signPhoneOrder,
  signRebuildRequest,
  signRegisterServer,
  signRePairInitiate,
  signRePairObject,
  signRevocation,
  signRevokeDeviceCapabilityGrant,
  signServerRegister,
  signSetRoutingTarget,
  signTunnelHello,
  signWatchDelegateKey,
  type AccountRecovery,
  type AuthCode,
  type BoxUnpair,
  type DaemonStatusReport,
  type DeviceCapabilityGrant,
  type ImageRebuildRequest,
  type InstallBlob,
  type InviteAcceptance,
  type InviteToken,
  type JournalRequest,
  type Keypair,
  type MembershipMutation,
  type MigrationRequest,
  type PairPayload,
  type PbAnnounce,
  type PbPeerConfirm,
  type PbRequestPeers,
  type PhoneOrder,
  type RegisterServer,
  type RePairInitiate,
  type RePairObject,
  type RevokeDeviceCapabilityGrant,
  type ServerRegisterRequest,
  type ServerRevocation,
  type SetRoutingTarget,
  type TunnelHello,
  type WatchDelegateKey,
  type WiFiConfig,
} from "@flagship/protocol";

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function seedKeypair(fill: number): Keypair {
  const seed = new Uint8Array(32).fill(fill);
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

const FIXED_UMK_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) FIXED_UMK_SEED[i] = i;
const umk = { seed: FIXED_UMK_SEED };
const irk = deriveIRK(umk);
const bak = deriveBAK(umk, "srv-test");
const swk = deriveSWK(umk, "srv-test");
const stk = deriveSTK(swk);

// A SECOND account UMK — its IRK stands in for the "old" key in the recovery
// re-pair vectors (re-pair-object is signed by the OLD IRK).
const OLD_UMK_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) OLD_UMK_SEED[i] = (i + 0x40) & 0xff;
const oldIrk = deriveIRK({ seed: OLD_UMK_SEED });

// The Routing-Control-Key is a standalone keypair the phone generates (NOT
// UMK-derived); a fixed seed keeps the SetRoutingTarget vector reproducible.
const rck = seedKeypair(0x33);

// A fixed server-identity keypair (ServerRegister is signed by the box's
// identity key, not the owner IRK).
const identity = seedKeypair(0x55);

/** Which clients are expected to assert a given vector (the rest skip-with-note). */
type Client = "ts" | "webapp" | "swift" | "kotlin";
const ALL: Client[] = ["ts", "webapp", "swift", "kotlin"];
/** Clients that implement the device-side surface but not the webapp. */
const NO_WEBAPP: Client[] = ["ts", "swift", "kotlin"];
/**
 * Vectors only the TS suite asserts today. The NFC retail-tier envelopes
 * (pair / box-unpair / wifi-config) live in @flagship/protocol + its mobile
 * mirrors, but the Swift/Kotlin/webapp shared-fixture vector tests don't wire
 * NFC encoders (those clients dispatch by their own wired map and skip-with-
 * note anything unwired). The TS canonicalBytesVectors test covers them via
 * verifyPair / verifyBoxUnpair (it asserts EVERY signed vector regardless of
 * this tag), and nfcPair.test.ts pins the production bytes directly.
 */
const TS_ONLY: Client[] = ["ts"];

interface Vector {
  name: string;
  /** `"none"` for canonical-bytes-only fixtures (no signature). */
  signedBy: "irk" | "bak" | "stk" | "old-irk" | "rck" | "identity" | "none";
  input: unknown;
  /** Clients expected to assert this vector. */
  clients: Client[];
  /** Empty when signedBy === "none". */
  signatureHex: string;
  /**
   * Canonical-bytes hex. Recorded for EVERY vector now (a client can assert
   * the bytes directly, independent of a signature verify). For signed
   * vectors it is ALSO covered transitively by the signature, but a raw byte
   * compare pinpoints drift faster than a verify-false.
   */
  canonicalHex: string;
}

function makeVector(
  name: string,
  signedBy: Vector["signedBy"],
  input: unknown,
  sig: Uint8Array,
  canonical: Uint8Array,
  clients: Client[],
): Vector {
  return { name, signedBy, input, clients, signatureHex: hex(sig), canonicalHex: hex(canonical) };
}

const FIXED_NONCE = new Uint8Array(32);
for (let i = 0; i < 32; i++) FIXED_NONCE[i] = (i + 1) & 0xff;
const FIXED_INVITE_NONCE = new Uint8Array(32);
for (let i = 0; i < 32; i++) FIXED_INVITE_NONCE[i] = (i + 7) & 0xff;
const ISSUED_AT = 1735689600000;
// Fixed 32-byte device pubkey for the capability-grant / re-pair vectors.
const DEMO_DEVICE_PUB = new Uint8Array(32);
for (let i = 0; i < 32; i++) DEMO_DEVICE_PUB[i] = (i * 3 + 11) & 0xff;

function buildVectors(): Vector[] {
  const vectors: Vector[] = [];

  // ImageRebuildRequest (IRK)
  const rebuild: ImageRebuildRequest = {
    userId: "harry",
    newServerId: "srv-test",
    wifiSsid: "Home",
    wifiPskHash: new Uint8Array(32).fill(0xab),
    shareRatio: 0.5,
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "rebuild",
      "irk",
      { ...rebuild, wifiPskHash: hex(rebuild.wifiPskHash) },
      signRebuildRequest(rebuild, irk),
      payloadByName("rebuild", { ...rebuild, wifiPskHash: hex(rebuild.wifiPskHash) }),
      NO_WEBAPP,
    ),
  );

  // ServerRevocation (IRK)
  const revoke: ServerRevocation = {
    userId: "harry",
    revokedServerId: "srv-test",
    reason: "stolen",
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "revoke",
      "irk",
      revoke,
      signRevocation(revoke, irk),
      payloadByName("revoke", revoke as unknown as Record<string, unknown>),
      ALL,
    ),
  );

  // MembershipMutation (IRK)
  const mem: MembershipMutation = {
    serviceId: "habit-tracker",
    targetIrkPub: irk.publicKey,
    role: "parent",
    issuedAt: ISSUED_AT,
  };
  const memInput = { ...mem, targetIrkPub: hex(mem.targetIrkPub) };
  vectors.push(
    makeVector(
      "membership",
      "irk",
      memInput,
      signMembershipMutation(mem, irk),
      payloadByName("membership", memInput),
      NO_WEBAPP,
    ),
  );

  // MigrationRequest (IRK)
  const mig: MigrationRequest = {
    serviceId: "habit-tracker",
    fromUser: "harry",
    toUser: "sarah",
    mode: "cut",
    withData: true,
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "migration",
      "irk",
      mig,
      signMigrationRequest(mig, irk),
      payloadByName("migration", mig as unknown as Record<string, unknown>),
      NO_WEBAPP,
    ),
  );

  // InviteToken (IRK)
  const tok: InviteToken = {
    serviceId: "habit-tracker",
    role: "parent",
    nonce: FIXED_INVITE_NONCE,
    issuedAt: ISSUED_AT,
    expiresAt: ISSUED_AT + 14 * 24 * 60 * 60_000,
  };
  const tokInput = { ...tok, nonce: hex(tok.nonce) };
  vectors.push(
    makeVector("invite", "irk", tokInput, signInvite(tok, irk), payloadByName("invite", tokInput), NO_WEBAPP),
  );

  // InviteAcceptance (IRK by accepter)
  const acc: InviteAcceptance = {
    inviteNonce: FIXED_INVITE_NONCE,
    accepterIrkPub: irk.publicKey,
    acceptedAt: ISSUED_AT + 1000,
  };
  const accInput = {
    ...acc,
    inviteNonce: hex(acc.inviteNonce),
    accepterIrkPub: hex(acc.accepterIrkPub),
  };
  vectors.push(
    makeVector(
      "invite-acceptance",
      "irk",
      accInput,
      signInviteAcceptance(acc, irk),
      payloadByName("invite-acceptance", accInput),
      NO_WEBAPP,
    ),
  );

  // TunnelHello (BAK). Wire field is `controlledDomains` (was `subdomains`
  // pre-rename); serialize as `subdomains` for backward-compat with existing
  // Swift/Kotlin tests that index by the old name.
  const hello: TunnelHello = {
    serverId: "srv-test",
    controlledDomains: ["b.harry", "a.harry"],
    nonce: FIXED_NONCE,
    issuedAt: ISSUED_AT,
  };
  const helloInput = {
    serverId: hello.serverId,
    subdomains: hello.controlledDomains,
    nonce: hex(hello.nonce),
    issuedAt: hello.issuedAt,
  };
  vectors.push(
    makeVector(
      "tunnel-hello",
      "bak",
      helloInput,
      signTunnelHello(hello, bak),
      payloadByName("tunnel-hello", helloInput),
      NO_WEBAPP,
    ),
  );

  // RegisterServer (IRK) — phone registers the box's STK pubkey.
  const reg: RegisterServer = {
    userId: "harry",
    serverId: "srv-test",
    stkPub: stk.publicKey,
    issuedAt: ISSUED_AT,
  };
  const regInput = { ...reg, stkPub: hex(reg.stkPub) };
  vectors.push(
    makeVector(
      "register-server",
      "irk",
      regInput,
      signRegisterServer(reg, irk),
      payloadByName("register-server", regInput),
      NO_WEBAPP,
    ),
  );

  // AccountRecovery (IRK)
  const rec: AccountRecovery = {
    userId: "harry",
    newPushTokenHash: new Uint8Array(32).fill(0x42),
    platform: "apns",
    issuedAt: ISSUED_AT,
  };
  const recInput = { ...rec, newPushTokenHash: hex(rec.newPushTokenHash) };
  vectors.push(
    makeVector(
      "account-recovery",
      "irk",
      recInput,
      signAccountRecovery(rec, irk),
      payloadByName("account-recovery", recInput),
      NO_WEBAPP,
    ),
  );

  // PbAnnounce / PbRequestPeers / PbPeerConfirm (STK)
  const announce: PbAnnounce = {
    serverId: "srv-test",
    pledgedBytes: 100 * 1024 * 1024,
    shareRatio: 0.5,
    maxShardSize: 4 * 1024 * 1024,
    region: "us-east",
    tunnelEndpoint: "203.0.113.1:51820",
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "pb-announce",
      "stk",
      announce,
      signPbAnnounce(announce, stk),
      payloadByName("pb-announce", announce as unknown as Record<string, unknown>),
      NO_WEBAPP,
    ),
  );

  const reqPeers: PbRequestPeers = {
    requesterServerId: "srv-test",
    n: 16,
    shardSizeBytes: 4 * 1024 * 1024,
    durabilityHint: "high",
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "pb-request-peers",
      "stk",
      reqPeers,
      signPbRequestPeers(reqPeers, stk),
      payloadByName("pb-request-peers", reqPeers as unknown as Record<string, unknown>),
      NO_WEBAPP,
    ),
  );

  const peerConfirm: PbPeerConfirm = {
    peerServerId: "srv-test",
    requesterServerId: "owner-srv",
    shardId: "shard-001",
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "pb-peer-confirm",
      "stk",
      peerConfirm,
      signPbPeerConfirm(peerConfirm, stk),
      payloadByName("pb-peer-confirm", peerConfirm as unknown as Record<string, unknown>),
      NO_WEBAPP,
    ),
  );

  // ---- AuthCode (IRK) — the recipe's inner credential. Also embedded by the
  // InstallBlob + ServerRegister vectors below (same AuthCode object). ----
  const authCode: AuthCode = {
    version: 1,
    serial: "AAAA-BBBB-CCCC-DDDD",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: DEMO_DEVICE_PUB,
    userPubKey: irk.publicKey,
    issuedAt: ISSUED_AT,
    expiresAt: ISSUED_AT + 60 * 60_000,
  };
  const authCodeSig = signAuthCode(authCode, irk);
  const authCodeInput = {
    ...authCode,
    delegatedPubKey: hex(authCode.delegatedPubKey),
    userPubKey: hex(authCode.userPubKey),
  };
  vectors.push(
    makeVector(
      "auth-code",
      "irk",
      authCodeInput,
      authCodeSig,
      payloadByName("auth-code", authCodeInput),
      NO_WEBAPP,
    ),
  );

  // ---- InstallBlob (IRK) — the phone-signed recipe. Carries the AuthCode +
  // its IRK signature. This is THE most security-critical signed envelope. ----
  const blob: InstallBlob = {
    version: 2,
    serverDomain: "home.harry.flagship.services",
    username: "harry",
    serverName: "home",
    phoneDelegatedPubKey: DEMO_DEVICE_PUB,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature: authCodeSig,
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
    bootUnlockMode: "approve",
    diskEncryption: "luks",
  };
  const blobInput = {
    version: blob.version,
    serverDomain: blob.serverDomain,
    username: blob.username,
    serverName: blob.serverName,
    phoneDelegatedPubKey: hex(blob.phoneDelegatedPubKey),
    registrationUrl: blob.registrationUrl,
    authCodeSerial: blob.authCode.serial,
    authCodeUserPubKey: hex(blob.authCode.userPubKey),
    authCodeUserSignature: hex(blob.authCodeUserSignature),
    installerGitRef: blob.installerGitRef,
    rckPubKey: hex(blob.rckPubKey),
    bootUnlockMode: blob.bootUnlockMode,
    diskEncryption: blob.diskEncryption,
  };
  vectors.push(
    makeVector(
      "install-blob",
      "irk",
      blobInput,
      signInstallBlob(blob, irk),
      payloadByName("install-blob", blobInput),
      ALL,
    ),
  );

  // ---- ServerRegister (server identity) — the box proves its own identity
  // at /api/server/register, re-presenting the IRK-signed AuthCode. ----
  const serverReg: ServerRegisterRequest = {
    authCode,
    authCodeUserSignature: authCodeSig,
    serverIdentityPubKey: identity.publicKey,
    issuedAt: ISSUED_AT + 5000,
    nonce: FIXED_NONCE,
  };
  const serverRegInput = {
    authCodeSerial: serverReg.authCode.serial,
    authCodeServerDomain: serverReg.authCode.serverDomain,
    serverIdentityPubKey: hex(serverReg.serverIdentityPubKey),
    issuedAt: serverReg.issuedAt,
    nonce: hex(serverReg.nonce),
  };
  vectors.push(
    makeVector(
      "server-register",
      "identity",
      serverRegInput,
      signServerRegister(serverReg, identity),
      payloadByName("server-register", serverRegInput),
      NO_WEBAPP,
    ),
  );

  // ---- SetRoutingTarget (RCK) — phone re-aims a subdomain at a new identity. ----
  const setTarget: SetRoutingTarget = {
    subdomain: "home.harry",
    newTargetIdentityPubKey: identity.publicKey,
    issuedAt: ISSUED_AT,
    nonce: FIXED_NONCE,
  };
  const setTargetInput = {
    subdomain: setTarget.subdomain,
    newTargetIdentityPubKey: hex(setTarget.newTargetIdentityPubKey),
    issuedAt: setTarget.issuedAt,
    nonce: hex(setTarget.nonce),
  };
  vectors.push(
    makeVector(
      "rck-set-target",
      "rck",
      setTargetInput,
      signSetRoutingTarget(setTarget, rck),
      payloadByName("rck-set-target", setTargetInput),
      NO_WEBAPP,
    ),
  );

  // ---- PhoneOrder: set-front-page (IRK; daemon verifies against owner IRK) ----
  const frontPage: Extract<PhoneOrder, { type: "set-front-page" }> = {
    type: "set-front-page",
    serverId: "home.harry.flagship.services",
    label: "photos",
    issuedAt: ISSUED_AT,
  };
  const frontPageInput = { serverId: frontPage.serverId, label: frontPage.label, issuedAt: frontPage.issuedAt };
  vectors.push(
    makeVector(
      "order-set-front-page",
      "irk",
      frontPageInput,
      signPhoneOrder(frontPage, irk),
      payloadByName("order-set-front-page", frontPageInput),
      ALL,
    ),
  );

  // ---- PhoneOrder: power-off (IRK) — both modes (the daemon /api/power path). ----
  for (const mode of ["off", "restart"] as const) {
    const power: Extract<PhoneOrder, { type: "power-off" }> = {
      type: "power-off",
      serverId: "home.harry.flagship.services",
      mode,
      issuedAt: ISSUED_AT,
    };
    const powerInput = { serverId: power.serverId, mode: power.mode, issuedAt: power.issuedAt };
    vectors.push(
      makeVector(
        `order-power-off-${mode}`,
        "irk",
        powerInput,
        signPhoneOrder(power, irk),
        payloadByName(`order-power-off-${mode}`, powerInput),
        ALL,
      ),
    );
  }

  // ---- JournalRequest (IRK) — owner diagnostics over the box's own pipe. ----
  const journal: JournalRequest = {
    serverId: "home.harry.flagship.services",
    unit: "flagship-daemon",
    lines: 200,
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "journal-read",
      "irk",
      journal as unknown as Record<string, unknown>,
      signJournalRequest(journal, irk),
      payloadByName("journal-read", journal as unknown as Record<string, unknown>),
      ALL,
    ),
  );

  // ---- WatchDelegateKey (IRK) — single scope (boot-approval is the only one). ----
  const watch: WatchDelegateKey = {
    grantId: "550e8400-e29b-41d4-a716-446655440000",
    username: "harry",
    delegatePubKey: DEMO_DEVICE_PUB,
    scopes: ["boot-approval"],
    issuedAt: ISSUED_AT,
    expiresAt: ISSUED_AT + 7 * 24 * 60 * 60_000,
  };
  const watchInput = { ...watch, delegatePubKey: hex(watch.delegatePubKey) };
  vectors.push(
    makeVector(
      "watch-delegate-key",
      "irk",
      watchInput,
      signWatchDelegateKey(watch, irk),
      payloadByName("watch-delegate-key", watchInput),
      NO_WEBAPP,
    ),
  );

  // DeviceCapabilityGrant (IRK) — v2 device-addressing, MULTI-SCOPE (the
  // canonical bytes must sort by DEVICE_SCOPES index, NOT alphabetically;
  // unsorted-on-input proves the canonicalizer re-sorts).
  const dcg: DeviceCapabilityGrant = {
    grantId: "550e8400-e29b-41d4-a716-446655440000",
    username: "harry",
    deviceLabel: "ipad",
    devicePubKey: DEMO_DEVICE_PUB,
    scopes: ["install-service", "browse"],
    issuedAt: ISSUED_AT,
    expiresAt: ISSUED_AT + 90 * 24 * 60 * 60_000,
  };
  const dcgInput = { ...dcg, devicePubKey: hex(dcg.devicePubKey) };
  vectors.push(
    makeVector(
      "device-capability-grant",
      "irk",
      dcgInput,
      signDeviceCapabilityGrant(dcg, irk),
      payloadByName("device-capability-grant", dcgInput),
      NO_WEBAPP,
    ),
  );

  // RevokeDeviceCapabilityGrant (IRK)
  const rdcg: RevokeDeviceCapabilityGrant = {
    grantId: "550e8400-e29b-41d4-a716-446655440000",
    username: "harry",
    reason: "lost",
    issuedAt: ISSUED_AT + 1000,
  };
  vectors.push(
    makeVector(
      "revoke-device-capability-grant",
      "irk",
      rdcg,
      signRevokeDeviceCapabilityGrant(rdcg, irk),
      payloadByName("revoke-device-capability-grant", rdcg as unknown as Record<string, unknown>),
      NO_WEBAPP,
    ),
  );

  // ---- PushTokenRevoke (IRK) — already pinned cross-platform by hand; here it
  // joins the shared file too. ----
  const pushRevoke = { tokenId: "0123456789abcdef0123456789abcdef", issuedAt: 1_700_000_000_000 };
  vectors.push(
    makeVector(
      "push-token-revoke",
      "irk",
      pushRevoke,
      // signPushTokenRevoke takes a PushTokenRevoke; import-free path uses the
      // canonical fn via payloadByName + a direct ed.sign to avoid another import.
      ed.sign(payloadByName("push-token-revoke", pushRevoke), irk.privateKey),
      payloadByName("push-token-revoke", pushRevoke),
      ALL,
    ),
  );

  // ---- RePairInitiate (NEW IRK) / RePairObject (OLD IRK) — recovery takeover. ----
  const rePairInit: RePairInitiate = {
    username: "harry",
    newIrkPub: irk.publicKey,
    oldIrkPub: oldIrk.publicKey,
    issuedAt: ISSUED_AT,
  };
  const rePairInitInput = {
    username: rePairInit.username,
    newIrkPub: hex(rePairInit.newIrkPub),
    oldIrkPub: hex(rePairInit.oldIrkPub),
    issuedAt: rePairInit.issuedAt,
  };
  vectors.push(
    makeVector(
      "re-pair-initiate",
      "irk",
      rePairInitInput,
      signRePairInitiate(rePairInit, irk),
      payloadByName("re-pair-initiate", rePairInitInput),
      ALL,
    ),
  );

  const rePairObj: RePairObject = {
    username: "harry",
    newIrkPub: irk.publicKey,
    issuedAt: ISSUED_AT + 1000,
  };
  const rePairObjInput = {
    username: rePairObj.username,
    newIrkPub: hex(rePairObj.newIrkPub),
    issuedAt: rePairObj.issuedAt,
  };
  vectors.push(
    makeVector(
      "re-pair-object",
      "old-irk",
      rePairObjInput,
      signRePairObject(rePairObj, oldIrk),
      payloadByName("re-pair-object", rePairObjInput),
      NO_WEBAPP,
    ),
  );

  // ---- DaemonStatusReport (STK) — cert-fingerprint pinning. Two shapes: a
  // full report (cert present) + a liveness-only report (null cert fields). ----
  const daemon: DaemonStatusReport = {
    serverDomain: "home.harry.flagship.services",
    certSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    certValidUntil: ISSUED_AT + 90 * 24 * 60 * 60_000,
    certIssuer: "CN=YR2",
    appsServed: ["photos", "blog"],
    nonce: hex(FIXED_NONCE),
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "daemon-status",
      "stk",
      daemon as unknown as Record<string, unknown>,
      signDaemonStatusReport(daemon, stk),
      payloadByName("daemon-status", daemon as unknown as Record<string, unknown>),
      NO_WEBAPP,
    ),
  );

  const daemonLiveness: DaemonStatusReport = {
    serverDomain: "home.harry.flagship.services",
    certSha256: null,
    certValidUntil: null,
    certIssuer: null,
    appsServed: [],
    nonce: hex(FIXED_NONCE),
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "daemon-status-liveness",
      "stk",
      daemonLiveness as unknown as Record<string, unknown>,
      signDaemonStatusReport(daemonLiveness, stk),
      payloadByName("daemon-status-liveness", daemonLiveness as unknown as Record<string, unknown>),
      NO_WEBAPP,
    ),
  );

  // ---- NFC retail-tier envelopes (feat/retail). Signed PairPayload (STK, the
  // box's per-boot ephemeral) + BoxUnpair (IRK, owner rebind-only) +
  // canonical-bytes-only WiFiConfig (sealed under K_session post-pair, so a
  // signature adds nothing — the golden vector pins the plaintext shape the
  // seal consumes so a Swift/Kotlin encoder drift is caught). Fixed eBoxPub /
  // nonce / sessionId keep the PAIR signature deterministic. ----
  const FIXED_E_BOX_PUB = new Uint8Array(32);
  for (let i = 0; i < 32; i++) FIXED_E_BOX_PUB[i] = (i * 5 + 3) & 0xff;
  const PAIR_NONCE = new Uint8Array(16);
  for (let i = 0; i < 16; i++) PAIR_NONCE[i] = (i + 17) & 0xff;
  const PAIR_SESSION_ID = new Uint8Array(16);
  for (let i = 0; i < 16; i++) PAIR_SESSION_ID[i] = (i * 11 + 5) & 0xff;
  const suffix6 = hex(stk.publicKey).slice(-6);
  const pair: PairPayload = {
    v: PAIR_PROTOCOL_VERSION,
    stkPub: stk.publicKey,
    eBoxPub: FIXED_E_BOX_PUB,
    nonce: PAIR_NONCE,
    sessionId: PAIR_SESSION_ID,
    hint: {
      mdnsName: `flagship-${suffix6}.local`,
      cloudRendezvousId: `rndz-${suffix6}`,
      suffix6,
    },
  };
  const pairInput = {
    v: pair.v,
    stkPub: hex(pair.stkPub),
    eBoxPub: hex(pair.eBoxPub),
    nonce: hex(pair.nonce),
    sessionId: hex(pair.sessionId),
    hint: pair.hint,
  };
  vectors.push(
    makeVector("pair", "stk", pairInput, signPair(pair, stk), payloadByName("pair", pairInput), TS_ONLY),
  );

  // BoxUnpair (IRK) — owner-side rebind-only unpair. boxId is the box's stkPub hex.
  const unpair: BoxUnpair = {
    userId: "harry",
    boxId: hex(stk.publicKey),
    issuedAt: ISSUED_AT,
  };
  const unpairInput = { userId: unpair.userId, boxId: unpair.boxId, issuedAt: unpair.issuedAt };
  vectors.push(
    makeVector(
      "box-unpair",
      "irk",
      unpairInput,
      signBoxUnpair(unpair, irk),
      payloadByName("box-unpair", unpairInput),
      TS_ONLY,
    ),
  );

  // WiFiConfig (canonical-bytes only — the sealed-plaintext shape).
  const wifi: WiFiConfig = {
    ssid: "Home",
    psk: "correct-horse-battery-staple",
    regulatoryRegion: "US",
    issuedAt: ISSUED_AT,
  };
  const wifiInput = {
    ssid: wifi.ssid,
    psk: wifi.psk,
    regulatoryRegion: wifi.regulatoryRegion,
    issuedAt: wifi.issuedAt,
  };
  vectors.push(
    makeVector("wifi-config", "none", wifiInput, new Uint8Array(0), payloadByName("wifi-config", wifiInput), TS_ONLY),
  );

  return vectors;
}

/**
 * Build the file object. Centralized so `main`, `--check`, AND the vitest
 * freshness test (which imports this) produce IDENTICAL bytes — the gate
 * compares this against the on-disk test-vectors/canonical-bytes.json.
 */
export function buildFile(): { json: string } {
  const vectors = buildVectors();
  selfCheck(vectors);
  const file = {
    metadata: {
      umkSeedHex: hex(FIXED_UMK_SEED),
      oldUmkSeedHex: hex(OLD_UMK_SEED),
      irkPubHex: hex(irk.publicKey),
      oldIrkPubHex: hex(oldIrk.publicKey),
      bakPubHex: hex(bak.publicKey),
      stkPubHex: hex(stk.publicKey),
      rckPubHex: hex(rck.publicKey),
      identityPubHex: hex(identity.publicKey),
      version: 2,
      generatedAt: ISSUED_AT,
      note:
        "Deterministic canonical-bytes test vectors — THE single source. TS, " +
        "webapp, Swift, and Kotlin tests LOAD this file and assert byte-equality " +
        "for the purposes each implements (see each vector's `clients`). " +
        "Regenerate with `npx tsx tools/test-vectors.ts`; CI fails if stale.",
    },
    vectors,
  };
  return { json: JSON.stringify(file, null, 2) + "\n" };
}

/**
 * Sanity-check: every recorded signature verifies under its signer's pubkey,
 * and every vector's recorded canonicalHex equals what `payloadByName`
 * recomputes (catches generator self-inconsistency).
 */
function selfCheck(vectors: Vector[]): void {
  const verifyKeys: Record<string, Keypair> = {
    irk,
    bak,
    stk,
    "old-irk": oldIrk,
    rck,
    identity,
  };
  for (const v of vectors) {
    const got = hex(payloadByName(v.name, v.input as Record<string, unknown>));
    if (got !== v.canonicalHex) {
      throw new Error(`vector ${v.name}: canonical-bytes self-check mismatch`);
    }
    if (v.signedBy === "none") {
      if (v.signatureHex !== "") throw new Error(`vector ${v.name}: none-vector has a signature`);
      continue;
    }
    const k = verifyKeys[v.signedBy];
    if (!k) throw new Error(`unknown signer: ${v.signedBy}`);
    if (!ed.verify(hexFromString(v.signatureHex), payloadByName(v.name, v.input as Record<string, unknown>), k.publicKey)) {
      throw new Error(`vector ${v.name}: roundtrip verification failed`);
    }
  }
  // Cross-check the NFC vectors' hand-rolled payloadByName layout against the
  // PRODUCTION encoders in @flagship/protocol — so a future field-reorder in
  // canonicalPair/canonicalBoxUnpair/canonicalWiFiConfig can't drift past the
  // self-consistency check above (which only ties payloadByName to itself).
  for (const v of vectors) {
    const i = v.input as Record<string, unknown>;
    const fromHex = (k: string) => hexFromString(i[k] as string);
    let prod: Uint8Array | undefined;
    if (v.name === "pair") {
      prod = canonicalPair({
        v: i.v as typeof PAIR_PROTOCOL_VERSION,
        stkPub: fromHex("stkPub"),
        eBoxPub: fromHex("eBoxPub"),
        nonce: fromHex("nonce"),
        sessionId: fromHex("sessionId"),
        hint: i.hint as PairPayload["hint"],
      });
    } else if (v.name === "box-unpair") {
      prod = canonicalBoxUnpair({
        userId: i.userId as string,
        boxId: i.boxId as string,
        issuedAt: i.issuedAt as number,
      });
    } else if (v.name === "wifi-config") {
      prod = canonicalWiFiConfig({
        ssid: i.ssid as string,
        psk: i.psk as string,
        regulatoryRegion: i.regulatoryRegion as string,
        issuedAt: i.issuedAt as number,
      });
    }
    if (prod && hex(prod) !== v.canonicalHex) {
      throw new Error(`vector ${v.name}: production-encoder canonical-bytes mismatch`);
    }
  }
}

function hexFromString(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Re-derive the canonical-bytes payload locally from the recorded `input`.
// This INTENTIONALLY duplicates the field-order rules (it's a self-test that
// keeps the recorded canonicalHex honest, and documents the exact byte layout
// each client must reproduce). The production encoders are the authority; this
// must agree with them or the self-check above throws.
function payloadByName(name: string, i: Record<string, unknown>): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  switch (name) {
    case "rebuild":
      return enc(
        `flagship/rebuild/v1|${i.userId}|${i.newServerId}|${i.wifiSsid}|${i.wifiPskHash}|${i.shareRatio}|${i.issuedAt}`,
      );
    case "revoke":
      return enc(`flagship/revoke/v1|${i.userId}|${i.revokedServerId}|${i.reason}|${i.issuedAt}`);
    case "membership":
      return enc(`flagship/membership/v1|${i.serviceId}|${i.targetIrkPub}|${i.role ?? "REMOVE"}|${i.issuedAt}`);
    case "migration":
      return enc(
        `flagship/migration/v1|${i.serviceId}|${i.fromUser}|${i.toUser}|${i.mode}|${i.withData ? "1" : "0"}|${i.issuedAt}`,
      );
    case "invite":
      return enc(`flagship/invite/v1|${i.serviceId}|${i.role}|${i.nonce}|${i.issuedAt}|${i.expiresAt}`);
    case "invite-acceptance":
      return enc(`flagship/invite-accept/v1|${i.inviteNonce}|${i.accepterIrkPub}|${i.acceptedAt}`);
    case "tunnel-hello": {
      const subs = [...(i.subdomains as string[])].sort().join(",");
      return enc(`flagship/tunnel-hello/v1|${i.serverId}|${subs}|${i.nonce}|${i.issuedAt}`);
    }
    case "register-server":
      return enc(`flagship/register-server/v1|${i.userId}|${i.serverId}|${i.stkPub}|${i.issuedAt}`);
    case "account-recovery":
      return enc(`flagship/account-recovery/v1|${i.userId}|${i.newPushTokenHash}|${i.platform}|${i.issuedAt}`);
    case "pb-announce":
      return enc(
        ["pb/announce/v1", i.serverId, i.pledgedBytes, i.shareRatio, i.maxShardSize, i.region ?? "", i.tunnelEndpoint, i.issuedAt].join("|"),
      );
    case "pb-request-peers":
      return enc(["pb/request-peers/v1", i.requesterServerId, i.n, i.shardSizeBytes, i.durabilityHint, i.issuedAt].join("|"));
    case "pb-peer-confirm":
      return enc(["pb/peer-confirm/v1", i.peerServerId, i.requesterServerId, i.shardId, i.issuedAt].join("|"));
    case "auth-code":
      return enc(
        [
          "flagship/auth-code/v1",
          i.version,
          i.serial,
          i.username,
          i.serverName,
          i.serverDomain,
          i.delegatedPubKey,
          i.userPubKey,
          i.issuedAt,
          i.expiresAt,
        ].join("|"),
      );
    case "install-blob": {
      const parts: (string | number)[] = [
        "flagship/install-blob/v1",
        i.version as number,
        i.serverDomain as string,
        i.username as string,
        i.serverName as string,
        i.phoneDelegatedPubKey as string,
        i.registrationUrl as string,
        i.authCodeSerial as string,
        i.authCodeUserPubKey as string,
        i.authCodeUserSignature as string,
        i.installerGitRef as string,
        i.rckPubKey as string,
      ];
      if (i.bootUnlockMode !== undefined) parts.push(i.bootUnlockMode as string);
      if (i.diskEncryption !== undefined) parts.push(`de=${i.diskEncryption}`);
      return enc(parts.join("|"));
    }
    case "server-register":
      return enc(
        [
          "flagship/server-register/v1",
          i.authCodeSerial,
          i.authCodeServerDomain,
          i.serverIdentityPubKey,
          i.issuedAt,
          i.nonce,
        ].join("|"),
      );
    case "rck-set-target":
      return enc(
        ["flagship/rck-set-target/v1", i.subdomain, i.newTargetIdentityPubKey, i.issuedAt, i.nonce].join("|"),
      );
    case "order-set-front-page":
      return enc(["flagship/order/set-front-page/v1", i.serverId, i.label, i.issuedAt].join("|"));
    case "order-power-off-off":
      return enc(["flagship/order/power-off/v1", i.serverId, "off", i.issuedAt].join("|"));
    case "order-power-off-restart":
      return enc(["flagship/order/power-off/v1", i.serverId, "restart", i.issuedAt].join("|"));
    case "journal-read":
      return enc(["flagship/journal-read/v1", i.serverId, i.unit, String(i.lines), String(i.issuedAt)].join("|"));
    case "watch-delegate-key": {
      const order = ["boot-approval"];
      const idx = (s: string) => order.indexOf(s);
      const sorted = [...(i.scopes as string[])].sort((a, b) => idx(a) - idx(b)).join(",");
      return enc(
        [
          "flagship/watch-delegate-key/v1",
          i.grantId,
          i.username,
          i.delegatePubKey,
          sorted,
          i.issuedAt,
          i.expiresAt,
        ].join("|"),
      );
    }
    case "device-capability-grant": {
      // Sort by the canonical DEVICE_SCOPES index (NOT alphabetical).
      const order = [
        "browse",
        "install-service",
        "vibe-code",
        "add-device",
        "manage-services",
        "revoke-others",
        "demo-provision",
        "admin",
      ];
      const idx = (s: string) => order.indexOf(s);
      const sorted = [...(i.scopes as string[])].sort((a, b) => idx(a) - idx(b)).join(",");
      return enc(
        [
          "flagship/device-capability-grant/v1",
          i.grantId,
          i.username,
          i.deviceLabel,
          i.devicePubKey,
          sorted,
          i.issuedAt,
          i.expiresAt,
        ].join("|"),
      );
    }
    case "revoke-device-capability-grant":
      return enc(["flagship/revoke-device-capability-grant/v1", i.grantId, i.username, i.reason, i.issuedAt].join("|"));
    case "push-token-revoke":
      return enc(["flagship/push-token-revoke/v1", i.tokenId, i.issuedAt].join("|"));
    case "re-pair-initiate":
      return enc(["flagship/re-pair-initiate/v1", i.username, i.newIrkPub, i.oldIrkPub, i.issuedAt].join("|"));
    case "re-pair-object":
      return enc(["flagship/re-pair-object/v1", i.username, i.newIrkPub, i.issuedAt].join("|"));
    case "daemon-status":
    case "daemon-status-liveness": {
      const apps = [...(i.appsServed as string[])].sort().join(",");
      return enc(
        [
          "flagship/daemon-status/v1",
          i.serverDomain,
          (i.certSha256 as string | null) ?? "",
          String((i.certValidUntil as number | null) ?? ""),
          (i.certIssuer as string | null) ?? "",
          apps,
          i.nonce,
          String(i.issuedAt),
        ].join("|"),
      );
    }
    case "pair": {
      const hint = i.hint as { mdnsName: string; cloudRendezvousId: string; suffix6: string };
      return enc(
        [
          "flagship/pair/v1",
          i.v,
          i.stkPub,
          i.eBoxPub,
          i.nonce,
          i.sessionId,
          hint.mdnsName,
          hint.cloudRendezvousId,
          hint.suffix6,
        ].join("|"),
      );
    }
    case "box-unpair":
      return enc(["flagship/box-unpair/v1", i.userId, i.boxId, i.issuedAt].join("|"));
    case "wifi-config":
      return enc(
        ["flagship/wifi-config/v1", i.ssid, i.psk, i.regulatoryRegion, i.issuedAt].join("|"),
      );
  }
  throw new Error(`unknown vector ${name}`);
}

async function main() {
  const check = process.argv.includes("--check");
  const { json } = buildFile();
  const outDir = resolve("test-vectors");
  const outPath = resolve(outDir, "canonical-bytes.json");

  if (check) {
    let existing: string;
    try {
      existing = await readFile(outPath, "utf8");
    } catch {
      console.error(
        `test-vectors/canonical-bytes.json is MISSING. Run \`npx tsx tools/test-vectors.ts\` and commit it.`,
      );
      process.exit(1);
      return;
    }
    if (existing !== json) {
      console.error(
        `test-vectors/canonical-bytes.json is STALE vs tools/test-vectors.ts.\n` +
          `Run \`npx tsx tools/test-vectors.ts\` and commit the result.`,
      );
      process.exit(1);
      return;
    }
    console.log("test-vectors/canonical-bytes.json is up to date.");
    return;
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, json);
  const n = buildVectors().length;
  console.log(`Wrote ${n} vectors → test-vectors/canonical-bytes.json`);
}

// Run only when invoked as a script (tsx tools/test-vectors.ts [--check]),
// NOT when imported by the vitest freshness test.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /test-vectors\.ts$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
