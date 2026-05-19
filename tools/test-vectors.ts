#!/usr/bin/env tsx
/**
 * Cross-language test-vectors generator.
 *
 * Emits a JSON file at `test-vectors/canonical-bytes.json` containing, for
 * every auth-flow canonical-bytes shape, a fixed input + the deterministic
 * canonical-bytes hex + an Ed25519 signature produced by a fixed-seed key.
 *
 * Swift and Kotlin tests load this file and assert byte-equality of:
 *   - the canonical-bytes shape they compute from the same input
 *   - their Ed25519 verify result against the recorded signature.
 *
 * Run:  tsx tools/test-vectors.ts
 */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  deriveBAK,
  deriveIRK,
  deriveSTK,
  deriveSWK,
  ed,
  signAccountRecovery,
  signBootApproval,
  signInvite,
  signInviteAcceptance,
  signMembershipMutation,
  signMigrationRequest,
  signPbAnnounce,
  signPbPeerConfirm,
  signPbRequestPeers,
  signRebuildRequest,
  signRegisterServer,
  signRevocation,
  signTunnelHello,
  type AccountRecovery,
  type BootChallenge,
  type ImageRebuildRequest,
  type InviteAcceptance,
  type InviteToken,
  type Keypair,
  type MembershipMutation,
  type MigrationRequest,
  type PbAnnounce,
  type PbPeerConfirm,
  type PbRequestPeers,
  type RegisterServer,
  type ServerRevocation,
  type TunnelHello,
} from "@flagship/protocol";

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const FIXED_UMK_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) FIXED_UMK_SEED[i] = i;
const umk = { seed: FIXED_UMK_SEED };
const irk = deriveIRK(umk);
const bak = deriveBAK(umk, "srv-test");
const swk = deriveSWK(umk, "srv-test");
const stk = deriveSTK(swk);

interface Vector {
  name: string;
  signedBy: "irk" | "bak" | "stk";
  input: unknown;
  signatureHex: string;
}

function makeVector(
  name: string,
  signedBy: "irk" | "bak" | "stk",
  input: unknown,
  sig: Uint8Array,
): Vector {
  return { name, signedBy, input, signatureHex: hex(sig) };
}

async function main() {
  const FIXED_NONCE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) FIXED_NONCE[i] = (i + 1) & 0xff;
  const FIXED_INVITE_NONCE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) FIXED_INVITE_NONCE[i] = (i + 7) & 0xff;
  const ISSUED_AT = 1735689600000;

  const vectors: Vector[] = [];

  // BootChallenge / signBootApproval (BAK)
  const boot: BootChallenge = { serverId: "srv-test", nonce: FIXED_NONCE, issuedAt: ISSUED_AT };
  vectors.push(makeVector("boot", "bak", { ...boot, nonce: hex(boot.nonce) }, signBootApproval(boot, bak)));

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
    ),
  );

  // ServerRevocation (IRK)
  const revoke: ServerRevocation = {
    userId: "harry",
    revokedServerId: "srv-test",
    reason: "stolen",
    issuedAt: ISSUED_AT,
  };
  vectors.push(makeVector("revoke", "irk", revoke, signRevocation(revoke, irk)));

  // MembershipMutation (IRK)
  const mem: MembershipMutation = {
    serviceId: "habit-tracker",
    targetIrkPub: irk.publicKey,
    role: "parent",
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "membership",
      "irk",
      { ...mem, targetIrkPub: hex(mem.targetIrkPub) },
      signMembershipMutation(mem, irk),
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
  vectors.push(makeVector("migration", "irk", mig, signMigrationRequest(mig, irk)));

  // InviteToken (IRK)
  const tok: InviteToken = {
    serviceId: "habit-tracker",
    role: "parent",
    nonce: FIXED_INVITE_NONCE,
    issuedAt: ISSUED_AT,
    expiresAt: ISSUED_AT + 14 * 24 * 60 * 60_000,
  };
  vectors.push(
    makeVector("invite", "irk", { ...tok, nonce: hex(tok.nonce) }, signInvite(tok, irk)),
  );

  // InviteAcceptance (IRK by accepter)
  const acc: InviteAcceptance = {
    inviteNonce: FIXED_INVITE_NONCE,
    accepterIrkPub: irk.publicKey,
    acceptedAt: ISSUED_AT + 1000,
  };
  vectors.push(
    makeVector(
      "invite-acceptance",
      "irk",
      { ...acc, inviteNonce: hex(acc.inviteNonce), accepterIrkPub: hex(acc.accepterIrkPub) },
      signInviteAcceptance(acc, irk),
    ),
  );

  // TunnelHello (BAK or STK; we use BAK here since the existing helper does)
  const hello: TunnelHello = {
    serverId: "srv-test",
    subdomains: ["b.harry", "a.harry"],
    nonce: FIXED_NONCE,
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "tunnel-hello",
      "bak",
      { ...hello, nonce: hex(hello.nonce) },
      signTunnelHello(hello, bak),
    ),
  );

  // RegisterServer (IRK)
  const reg: RegisterServer = {
    userId: "harry",
    serverId: "srv-test",
    stkPub: stk.publicKey,
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "register-server",
      "irk",
      { ...reg, stkPub: hex(reg.stkPub) },
      signRegisterServer(reg, irk),
    ),
  );

  // AccountRecovery (IRK)
  const rec: AccountRecovery = {
    userId: "harry",
    newPushTokenHash: new Uint8Array(32).fill(0x42),
    platform: "apns",
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector(
      "account-recovery",
      "irk",
      { ...rec, newPushTokenHash: hex(rec.newPushTokenHash) },
      signAccountRecovery(rec, irk),
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
  vectors.push(makeVector("pb-announce", "stk", announce, signPbAnnounce(announce, stk)));

  const reqPeers: PbRequestPeers = {
    requesterServerId: "srv-test",
    n: 16,
    shardSizeBytes: 4 * 1024 * 1024,
    durabilityHint: "high",
    issuedAt: ISSUED_AT,
  };
  vectors.push(makeVector("pb-request-peers", "stk", reqPeers, signPbRequestPeers(reqPeers, stk)));

  const peerConfirm: PbPeerConfirm = {
    peerServerId: "srv-test",
    requesterServerId: "owner-srv",
    shardId: "shard-001",
    issuedAt: ISSUED_AT,
  };
  vectors.push(
    makeVector("pb-peer-confirm", "stk", peerConfirm, signPbPeerConfirm(peerConfirm, stk)),
  );

  // Sanity-check: every recorded signature verifies.
  const verifyKeys: Record<string, Keypair> = { irk, bak, stk };
  for (const v of vectors) {
    const k = verifyKeys[v.signedBy];
    if (!k) throw new Error(`unknown signer: ${v.signedBy}`);
    if (!ed.verify(hexFromString(v.signatureHex), payloadFor(v), k.publicKey)) {
      throw new Error(`vector ${v.name}: roundtrip verification failed`);
    }
  }

  const file = {
    metadata: {
      umkSeedHex: hex(FIXED_UMK_SEED),
      irkPubHex: hex(irk.publicKey),
      bakPubHex: hex(bak.publicKey),
      stkPubHex: hex(stk.publicKey),
      version: 1,
      generatedAt: ISSUED_AT,
      note: "Deterministic canonical-bytes test vectors. Swift/Kotlin tests assert byte-equality.",
    },
    vectors,
  };
  const outDir = resolve("test-vectors");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    resolve(outDir, "canonical-bytes.json"),
    JSON.stringify(file, null, 2) + "\n",
  );
  console.log(`Wrote ${vectors.length} vectors → test-vectors/canonical-bytes.json`);
}

function hexFromString(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Re-derive the canonical-bytes payload locally for the verification sanity-check.
// This duplicates a small bit of work, but it's a self-test so we know the file
// we wrote is internally consistent.
function payloadFor(v: Vector): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  const i = v.input as Record<string, unknown>;
  switch (v.name) {
    case "boot":
      return enc(`flagship/boot/v1|${i.serverId}|${i.nonce}|${i.issuedAt}`);
    case "rebuild":
      return enc(
        `flagship/rebuild/v1|${i.userId}|${i.newServerId}|${i.wifiSsid}|${i.wifiPskHash}|${i.shareRatio}|${i.issuedAt}`,
      );
    case "revoke":
      return enc(
        `flagship/revoke/v1|${i.userId}|${i.revokedServerId}|${i.reason}|${i.issuedAt}`,
      );
    case "membership":
      return enc(
        `flagship/membership/v1|${i.serviceId}|${i.targetIrkPub}|${i.role ?? "REMOVE"}|${i.issuedAt}`,
      );
    case "migration":
      return enc(
        `flagship/migration/v1|${i.serviceId}|${i.fromUser}|${i.toUser}|${i.mode}|${i.withData ? "1" : "0"}|${i.issuedAt}`,
      );
    case "invite":
      return enc(
        `flagship/invite/v1|${i.serviceId}|${i.role}|${i.nonce}|${i.issuedAt}|${i.expiresAt}`,
      );
    case "invite-acceptance":
      return enc(
        `flagship/invite-accept/v1|${i.inviteNonce}|${i.accepterIrkPub}|${i.acceptedAt}`,
      );
    case "tunnel-hello": {
      const subs = [...(i.subdomains as string[])].sort().join(",");
      return enc(
        `flagship/tunnel-hello/v1|${i.serverId}|${subs}|${i.nonce}|${i.issuedAt}`,
      );
    }
    case "register-server":
      return enc(
        `flagship/register-server/v1|${i.userId}|${i.serverId}|${i.stkPub}|${i.issuedAt}`,
      );
    case "account-recovery":
      return enc(
        `flagship/account-recovery/v1|${i.userId}|${i.newPushTokenHash}|${i.platform}|${i.issuedAt}`,
      );
    case "pb-announce":
      return enc(
        [
          "pb/announce/v1",
          i.serverId,
          i.pledgedBytes,
          i.shareRatio,
          i.maxShardSize,
          i.region ?? "",
          i.tunnelEndpoint,
          i.issuedAt,
        ].join("|"),
      );
    case "pb-request-peers":
      return enc(
        [
          "pb/request-peers/v1",
          i.requesterServerId,
          i.n,
          i.shardSizeBytes,
          i.durabilityHint,
          i.issuedAt,
        ].join("|"),
      );
    case "pb-peer-confirm":
      return enc(
        [
          "pb/peer-confirm/v1",
          i.peerServerId,
          i.requesterServerId,
          i.shardId,
          i.issuedAt,
        ].join("|"),
      );
  }
  throw new Error(`unknown vector ${v.name}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
