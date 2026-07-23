/**
 * Phase 1 gym recipe→Hetzner pipeline — POST /api/gym/provision handler tests.
 *
 * Covers:
 *   (a) a correctly app-signed blob + matching irkPriv → provisions
 *       (hetzner called with userData containing the blob; authCode recorded),
 *   (b) a forged blobSignature → 403, no provision,
 *   (c) irkPriv whose pubkey != authCode.userPubKey → 400, no provision,
 *   (d) an unregistered username → rejected (404),
 *   plus: idempotent re-provision against an already-recorded auth-code, and
 *   that the box ends up owned by the app's IRK (the shipped IRK priv == the
 *   blob's authCode.userPubKey).
 *
 * The test composes the SAME shape the real app composes: mint +
 * self-sign an AuthCode under the app's device IRK, sign the InstallBlob, and
 * serialize the InstallBlobJsonShort. There is no demo-IRK / KEK here — the
 * recipe's owner is whatever IRK the app holds.
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signAuthCode,
  signInstallBlob,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";
import {
  InMemoryAuthCodeStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  handleGymProvision,
  type GymProvisionDeps,
  type ProvisioningHetznerClient,
} from "../src/index.js";

const hex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

// The app's device IRK = the account owner. Deterministic 32-byte seed so the
// test is reproducible; in the real app this is the device-held test IRK.
const IRK_PRIV = new Uint8Array(32).fill(0x07);
const IRK = { privateKey: IRK_PRIV, publicKey: ed.getPublicKey(IRK_PRIV) };
const IRK_PRIV_HEX = hex(IRK_PRIV);
const IRK_PUB_HEX = hex(IRK.publicKey);

// A throwaway delegated + RCK keypair (the phone generates these per-server).
const DELEGATED_PUB = ed.getPublicKey(new Uint8Array(32).fill(0x11));
const RCK_PUB = ed.getPublicKey(new Uint8Array(32).fill(0x22));

const APEX = "gym.flagship.services";
const CONTROL_APEX = "gym.flagshipserver.com";
const USERNAME = "gymalice";
const SERVER_NAME = "home";
const SERVER_DOMAIN = `${SERVER_NAME}.${USERNAME}.${APEX}`;
const NOW = 2_000_000_000_000;

interface FakeHetzner extends ProvisioningHetznerClient {
  calls: Array<{
    name: string;
    location: string;
    serverType: string;
    image?: string;
    userData: string;
    username: string;
    sshKeyId?: number;
    fallbackServerTypes?: readonly string[];
  }>;
  failNext?: Error;
}

function makeHetzner(): FakeHetzner {
  const calls: FakeHetzner["calls"] = [];
  return {
    calls,
    async createServerWithUserData(args) {
      if (this.failNext) {
        const e = this.failNext;
        this.failNext = undefined;
        throw e;
      }
      calls.push(args);
      return { serverId: "srv-gym-xyz", ipv4: "192.0.2.10" };
    },
  };
}

/** Compose the app-signed recipe exactly like the real recipe-download flow. */
function composeRecipe(opts: { issuedAt?: number; expiresAt?: number } = {}): {
  blob: InstallBlob;
  blobJson: unknown;
  blobSigHex: string;
} {
  const issuedAt = opts.issuedAt ?? NOW;
  const expiresAt = opts.expiresAt ?? NOW + 60 * 60_000;
  const serial = "gymserial0001abcd";
  const authCode: AuthCode = {
    version: 1,
    serial,
    username: USERNAME,
    serverName: SERVER_NAME,
    serverDomain: SERVER_DOMAIN,
    delegatedPubKey: DELEGATED_PUB,
    userPubKey: IRK.publicKey,
    issuedAt,
    expiresAt,
  };
  const authCodeSig = signAuthCode(authCode, IRK);
  const blob: InstallBlob = {
    version: 2,
    serverDomain: SERVER_DOMAIN,
    username: USERNAME,
    serverName: SERVER_NAME,
    phoneDelegatedPubKey: DELEGATED_PUB,
    registrationUrl: `https://${CONTROL_APEX}/api/server/register`,
    authCode,
    authCodeUserSignature: authCodeSig,
    installerGitRef: "main",
    rckPubKey: RCK_PUB,
  };
  const blobSig = signInstallBlob(blob, IRK);
  const blobJson = {
    version: 2,
    serverDomain: SERVER_DOMAIN,
    username: USERNAME,
    serverName: SERVER_NAME,
    phoneDelegatedPubKey: hex(DELEGATED_PUB),
    registrationUrl: blob.registrationUrl,
    authCode: {
      version: 1,
      serial,
      username: USERNAME,
      serverName: SERVER_NAME,
      serverDomain: SERVER_DOMAIN,
      delegatedPubKey: hex(DELEGATED_PUB),
      userPubKey: IRK_PUB_HEX,
      issuedAt,
      expiresAt,
    },
    authCodeUserSignature: hex(authCodeSig),
    installerGitRef: "main",
    rckPubKey: hex(RCK_PUB),
  };
  return { blob, blobJson, blobSigHex: hex(blobSig) };
}

async function mkDeps(opts: { register?: boolean } = {}): Promise<{
  deps: GymProvisionDeps;
  hetzner: FakeHetzner;
  authCodes: InMemoryAuthCodeStorage;
}> {
  const hetzner = makeHetzner();
  const usernames = new InMemoryUsernameStorage();
  const authCodes = new InMemoryAuthCodeStorage();
  if (opts.register ?? true) {
    await usernames.put({
      username: USERNAME,
      irkPubHex: IRK_PUB_HEX,
      claimedAt: 1_000_000,
      isDemo: false,
    });
  }
  let counter = 0;
  const rand = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (counter + i) & 0xff;
    counter += n;
    return out;
  };
  const deps: GymProvisionDeps = {
    usernames,
    authCodes,
    hetzner,
    demoSshKeyId: 4242,
    defaultRegion: "fsn1",
    defaultSize: "cpx31",
    random: rand,
    now: () => NOW,
  };
  return { deps, hetzner, authCodes };
}

describe("handleGymProvision (Phase 1)", () => {
  it("(a) app-signed blob + matching irkPriv → provisions; blob in userData; authCode recorded", async () => {
    const { deps, hetzner, authCodes } = await mkDeps();
    const { blobJson, blobSigHex } = composeRecipe();

    const r = await handleGymProvision(deps, {
      installBlob: blobJson,
      blobSignature: blobSigHex,
      irkPrivHex: IRK_PRIV_HEX,
    });

    expect(r.status).toBe(200);
    const body = r.body as {
      ok: boolean;
      serverDomain: string;
      serverId: string;
      ipv4: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.serverDomain).toBe(SERVER_DOMAIN);
    expect(body.serverId).toBe("srv-gym-xyz");
    expect(body.ipv4).toBe("192.0.2.10");

    // Hetzner got a debian-12 cloud-config carrying the app's blob + the SSH
    // key so the box is debug-able.
    expect(hetzner.calls).toHaveLength(1);
    const call = hetzner.calls[0]!;
    expect(call.image).toBe("debian-12");
    expect(call.username).toBe(USERNAME);
    expect(call.location).toBe("fsn1");
    expect(call.serverType).toBe("cpx31");
    expect(call.sshKeyId).toBe(4242);
    expect(call.name.startsWith(`flagship-gym-${USERNAME}-`)).toBe(true);
    expect(call.userData.startsWith("#cloud-config\n")).toBe(true);
    expect(call.userData).toContain("/var/flagship/install-blob.json");

    // The inlined blob is byte-for-byte the app's recipe.
    const m = call.userData.match(
      /install-blob\.json[\s\S]*?content:\s*([A-Za-z0-9+/=]+)/,
    );
    expect(m).not.toBeNull();
    const inlined = JSON.parse(Buffer.from(m![1]!, "base64").toString("utf8"));
    expect(inlined.serverDomain).toBe(SERVER_DOMAIN);
    expect(inlined.username).toBe(USERNAME);
    expect(inlined.authCode.userPubKey).toBe(IRK_PUB_HEX);

    // The box is owned by the app's IRK: the shipped IRK priv (3rd content
    // block) equals the blob's authCode.userPubKey when re-derived.
    const all = [...call.userData.matchAll(/content:\s*([A-Za-z0-9+/=]+)/g)];
    expect(all.length).toBe(3);
    const shippedPrivHex = Buffer.from(all[2]![1]!, "base64")
      .toString("utf8")
      .trim();
    expect(shippedPrivHex).toBe(IRK_PRIV_HEX);
    expect(hex(ed.getPublicKey(Buffer.from(shippedPrivHex, "hex")))).toBe(
      IRK_PUB_HEX,
    );

    // The auth-code was recorded active under the owner's IRK.
    const rec = await authCodes.get("gymserial0001abcd");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("active");
    expect(rec!.username).toBe(USERNAME);
    expect(rec!.userPubKeyHex).toBe(IRK_PUB_HEX);
    expect(rec!.serverDomain).toBe(SERVER_DOMAIN);
  });

  it("(b) forged blobSignature → 403, no provision, no auth-code written", async () => {
    const { deps, hetzner, authCodes } = await mkDeps();
    const { blobJson } = composeRecipe();
    // A syntactically valid but wrong signature (all zeros).
    const forged = "0".repeat(128);

    const r = await handleGymProvision(deps, {
      installBlob: blobJson,
      blobSignature: forged,
      irkPrivHex: IRK_PRIV_HEX,
    });

    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toMatch(/installBlob signature/);
    expect(hetzner.calls).toHaveLength(0);
    expect(await authCodes.get("gymserial0001abcd")).toBeUndefined();
  });

  it("(c) irkPriv whose pubkey != authCode.userPubKey → 400, no provision", async () => {
    const { deps, hetzner } = await mkDeps();
    const { blobJson, blobSigHex } = composeRecipe();
    // A different, valid IRK priv — its pubkey won't match authCode.userPubKey.
    const otherPriv = hex(new Uint8Array(32).fill(0x55));

    const r = await handleGymProvision(deps, {
      installBlob: blobJson,
      blobSignature: blobSigHex,
      irkPrivHex: otherPriv,
    });

    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(
      /irkPrivHex pubkey does not match/,
    );
    expect(hetzner.calls).toHaveLength(0);
  });

  it("(d) unregistered username → 404, no provision", async () => {
    const { deps, hetzner } = await mkDeps({ register: false });
    const { blobJson, blobSigHex } = composeRecipe();

    const r = await handleGymProvision(deps, {
      installBlob: blobJson,
      blobSignature: blobSigHex,
      irkPrivHex: IRK_PRIV_HEX,
    });

    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toMatch(/not registered/);
    expect(hetzner.calls).toHaveLength(0);
  });

  it("rejects an authCode.userPubKey that is not the owner's registered IRK (403)", async () => {
    const { deps, hetzner } = await mkDeps();
    const { blobJson, blobSigHex } = composeRecipe();
    // Tamper the embedded authCode.userPubKey to a non-owner key. (The
    // signature won't match either, but the registered-IRK guard fires first.)
    (blobJson as { authCode: { userPubKey: string } }).authCode.userPubKey =
      hex(ed.getPublicKey(new Uint8Array(32).fill(0x99)));

    const r = await handleGymProvision(deps, {
      installBlob: blobJson,
      blobSignature: blobSigHex,
      irkPrivHex: IRK_PRIV_HEX,
    });

    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toMatch(/registered IRK/);
    expect(hetzner.calls).toHaveLength(0);
  });

  it("is idempotent when the app already recorded the auth-code (proceeds, provisions once)", async () => {
    const { deps, hetzner, authCodes } = await mkDeps();
    const { blob, blobJson, blobSigHex } = composeRecipe();
    // Pre-record the EXACT auth-code the app would have issued via
    // /api/auth-code/issue before signing the blob (the expected case).
    await authCodes.put({
      serial: blob.authCode.serial,
      username: USERNAME,
      serverName: SERVER_NAME,
      serverDomain: SERVER_DOMAIN,
      delegatedPubKeyHex: hex(DELEGATED_PUB),
      userPubKeyHex: IRK_PUB_HEX,
      userSignatureHex: hex(blob.authCodeUserSignature),
      issuedAt: blob.authCode.issuedAt,
      expiresAt: blob.authCode.expiresAt,
      status: "active",
      recordedAt: NOW - 1000,
    });

    const r = await handleGymProvision(deps, {
      installBlob: blobJson,
      blobSignature: blobSigHex,
      irkPrivHex: IRK_PRIV_HEX,
    });

    expect(r.status).toBe(200);
    expect(hetzner.calls).toHaveLength(1);
    // Still exactly one record (not double-put).
    const rec = await authCodes.get(blob.authCode.serial);
    expect(rec!.recordedAt).toBe(NOW - 1000);
  });

  it("502s when the Hetzner client throws (auth-code already recorded is fine)", async () => {
    const { deps, hetzner } = await mkDeps();
    const { blobJson, blobSigHex } = composeRecipe();
    hetzner.failNext = new Error("hetzner upstream 503");

    const r = await handleGymProvision(deps, {
      installBlob: blobJson,
      blobSignature: blobSigHex,
      irkPrivHex: IRK_PRIV_HEX,
    });

    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/hetzner/);
  });

  it("malformed inputs are rejected with 400", async () => {
    const { deps } = await mkDeps();
    // Missing installBlob.
    expect(
      (await handleGymProvision(deps, { blobSignature: "0".repeat(128), irkPrivHex: IRK_PRIV_HEX }))
        .status,
    ).toBe(400);
    // Bad-length blobSignature.
    const { blobJson } = composeRecipe();
    expect(
      (await handleGymProvision(deps, { installBlob: blobJson, blobSignature: "abc", irkPrivHex: IRK_PRIV_HEX }))
        .status,
    ).toBe(400);
    // Bad-length irkPrivHex.
    const { blobJson: bj2, blobSigHex } = composeRecipe();
    expect(
      (await handleGymProvision(deps, { installBlob: bj2, blobSignature: blobSigHex, irkPrivHex: "ff" }))
        .status,
    ).toBe(400);
  });

  it("rejects an expired authCode (400)", async () => {
    const { deps, hetzner } = await mkDeps();
    const { blobJson, blobSigHex } = composeRecipe({
      issuedAt: NOW - 2 * 60 * 60_000,
      expiresAt: NOW - 60 * 60_000,
    });

    const r = await handleGymProvision(deps, {
      installBlob: blobJson,
      blobSignature: blobSigHex,
      irkPrivHex: IRK_PRIV_HEX,
    });

    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/expired/);
    expect(hetzner.calls).toHaveLength(0);
  });
});
