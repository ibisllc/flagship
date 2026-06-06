import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ed,
  verifyAccountRecovery,
  verifyDeviceCapabilityGrant,
  verifyInvite,
  verifyInviteAcceptance,
  verifyMembershipMutation,
  verifyMigrationRequest,
  verifyPbAnnounce,
  verifyPbPeerConfirm,
  verifyPbRequestPeers,
  verifyRebuildRequest,
  verifyRegisterServer,
  verifyRevocation,
  verifyRevokeDeviceCapabilityGrant,
  verifyTunnelHello,
  type DeviceScope,
} from "../src/index.js";

const PATH = resolve(__dirname, "..", "..", "..", "test-vectors", "canonical-bytes.json");

interface Vector {
  name: string;
  signedBy: "irk" | "bak" | "stk" | "none";
  input: Record<string, unknown>;
  signatureHex: string;
  /** Only present on canonical-bytes-only vectors (no signature). */
  canonicalHex?: string;
}

interface File {
  metadata: {
    umkSeedHex: string;
    irkPubHex: string;
    bakPubHex: string;
    stkPubHex: string;
    version: number;
  };
  vectors: Vector[];
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("cross-language canonical-bytes vectors", () => {
  if (!existsSync(PATH)) {
    it.skip("vectors not generated — run `npx tsx tools/test-vectors.ts`", () => {
      // generation step is opt-in for now
    });
    return;
  }

  const file = JSON.parse(readFileSync(PATH, "utf8")) as File;
  const irkPub = hexToBytes(file.metadata.irkPubHex);
  const bakPub = hexToBytes(file.metadata.bakPubHex);
  const stkPub = hexToBytes(file.metadata.stkPubHex);
  void ed; // imported for parity with Swift/Kotlin tests that do explicit verify calls

  const verifyByName = (v: Vector): boolean => {
    const sig = hexToBytes(v.signatureHex);
    const i = v.input;
    const fromHex = (k: string) =>
      typeof i[k] === "string" ? hexToBytes(i[k] as string) : new Uint8Array(0);
    switch (v.name) {
      case "rebuild":
        return verifyRebuildRequest(
          {
            userId: i.userId as string,
            newServerId: i.newServerId as string,
            wifiSsid: i.wifiSsid as string,
            wifiPskHash: fromHex("wifiPskHash"),
            shareRatio: i.shareRatio as number,
            issuedAt: i.issuedAt as number,
          },
          sig,
          irkPub,
        );
      case "revoke":
        return verifyRevocation(
          {
            userId: i.userId as string,
            revokedServerId: i.revokedServerId as string,
            reason: i.reason as "lost" | "stolen" | "decommissioned",
            issuedAt: i.issuedAt as number,
          },
          sig,
          irkPub,
        );
      case "membership":
        return verifyMembershipMutation(
          {
            serviceId: i.serviceId as string,
            targetIrkPub: fromHex("targetIrkPub"),
            role: (i.role as string | null) ?? null,
            issuedAt: i.issuedAt as number,
          },
          sig,
          irkPub,
        );
      case "migration":
        return verifyMigrationRequest(
          {
            serviceId: i.serviceId as string,
            fromUser: i.fromUser as string,
            toUser: i.toUser as string,
            mode: i.mode as "cut" | "copy",
            withData: i.withData as boolean,
            issuedAt: i.issuedAt as number,
          },
          sig,
          irkPub,
        );
      case "invite":
        return verifyInvite(
          {
            serviceId: i.serviceId as string,
            role: i.role as string,
            nonce: fromHex("nonce"),
            issuedAt: i.issuedAt as number,
            expiresAt: i.expiresAt as number,
          },
          sig,
          irkPub,
        );
      case "invite-acceptance":
        return verifyInviteAcceptance(
          {
            inviteNonce: fromHex("inviteNonce"),
            accepterIrkPub: fromHex("accepterIrkPub"),
            acceptedAt: i.acceptedAt as number,
          },
          sig,
          irkPub,
        );
      case "tunnel-hello":
        return verifyTunnelHello(
          {
            serverId: i.serverId as string,
            controlledDomains: i.subdomains as string[],
            nonce: fromHex("nonce"),
            issuedAt: i.issuedAt as number,
          },
          sig,
          bakPub,
        );
      case "register-server":
        return verifyRegisterServer(
          {
            userId: i.userId as string,
            serverId: i.serverId as string,
            stkPub: fromHex("stkPub"),
            issuedAt: i.issuedAt as number,
          },
          sig,
          irkPub,
        );
      case "account-recovery":
        return verifyAccountRecovery(
          {
            userId: i.userId as string,
            newPushTokenHash: fromHex("newPushTokenHash"),
            platform: i.platform as "apns" | "fcm",
            issuedAt: i.issuedAt as number,
          },
          sig,
          irkPub,
        );
      case "pb-announce":
        return verifyPbAnnounce(
          {
            serverId: i.serverId as string,
            pledgedBytes: i.pledgedBytes as number,
            shareRatio: i.shareRatio as number,
            maxShardSize: i.maxShardSize as number,
            region: i.region as string | undefined,
            tunnelEndpoint: i.tunnelEndpoint as string,
            issuedAt: i.issuedAt as number,
          },
          sig,
          stkPub,
        );
      case "pb-request-peers":
        return verifyPbRequestPeers(
          {
            requesterServerId: i.requesterServerId as string,
            n: i.n as number,
            shardSizeBytes: i.shardSizeBytes as number,
            durabilityHint: i.durabilityHint as "high" | "best-effort",
            issuedAt: i.issuedAt as number,
          },
          sig,
          stkPub,
        );
      case "pb-peer-confirm":
        return verifyPbPeerConfirm(
          {
            peerServerId: i.peerServerId as string,
            requesterServerId: i.requesterServerId as string,
            shardId: i.shardId as string,
            issuedAt: i.issuedAt as number,
          },
          sig,
          stkPub,
        );
      case "device-capability-grant":
        return verifyDeviceCapabilityGrant(
          {
            grantId: i.grantId as string,
            username: i.username as string,
            deviceLabel: i.deviceLabel as string,
            devicePubKey: fromHex("devicePubKey"),
            scopes: i.scopes as DeviceScope[],
            issuedAt: i.issuedAt as number,
            expiresAt: i.expiresAt as number,
          },
          sig,
          irkPub,
        );
      case "revoke-device-capability-grant":
        return verifyRevokeDeviceCapabilityGrant(
          {
            grantId: i.grantId as string,
            username: i.username as string,
            reason: i.reason as "lost" | "stolen" | "decommissioned" | "replaced",
            issuedAt: i.issuedAt as number,
          },
          sig,
          irkPub,
        );
    }
    throw new Error(`unknown vector name: ${v.name}`);
  };

  /**
   * Recompute the canonical-bytes for a "signedBy:none" vector and
   * byte-compare against the recorded `canonicalHex`. Drift in
   * Swift/Kotlin encoders will surface as a string mismatch here.
   */
  const recomputeCanonical = (v: Vector): string => {
    throw new Error(`canonical recompute not wired for ${v.name}`);
  };

  for (const v of file.vectors) {
    if (v.signedBy === "none") {
      it(`vector "${v.name}" canonical-bytes round-trip`, () => {
        expect(v.canonicalHex).toBeDefined();
        expect(recomputeCanonical(v)).toBe(v.canonicalHex);
      });
      continue;
    }
    it(`vector "${v.name}" (signed by ${v.signedBy}) verifies`, () => {
      expect(verifyByName(v)).toBe(true);
    });
  }
});
