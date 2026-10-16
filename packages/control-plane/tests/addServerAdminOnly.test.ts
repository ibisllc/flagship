/**
 * Adding a server to an account is admin-only, and `.com` enforces it (owner
 * rule 2026-10-16; docs/service-access-gating.md "Account members"): the
 * AuthCode issue needs the admin root's approval of the AuthCode that pins
 * that very root, RCK registration and a take-over claim need the admin root,
 * an account with no admin root adds nothing, and a demo account keeps its
 * old path. Keys and signatures come from test-vectors/add-server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ed,
  signAuthCode,
  signAuthCodeAdmin,
  signRegisterRck,
  signServerRegister,
  signServerTransferClaim,
  signServerTransferOffer,
  type AuthCode,
  type Keypair,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { ADD_SERVER_ADMIN_ONLY, ADD_SERVER_ADMIN_ONLY_CODE } from "../src/adminAuthorityGate.js";
import { handleAuthCodeIssue } from "../src/authCode.js";
import { handleRegisterRck } from "../src/routing.js";
import { handleServerRegister } from "../src/serverRegister.js";
import { handlePostTransferClaim } from "../src/serverTransfer.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = JSON.parse(
  readFileSync(join(__dirname, "../../protocol/test-vectors/add-server/vectors.json"), "utf8"),
) as any;

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (seedHex: string): Keypair => {
  const priv = fromHex(seedHex);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
};
const irk = key(V.keys.irkSeedHex);
const admin = key(V.keys.adminRootSeedHex);
const other = key(V.keys.otherRootSeedHex);
const device = key(V.keys.deviceSeedHex);
const F = V.authCode.fields;
const NOW = F.issuedAt as number;

type Account = "pinned" | "unpinned" | "demo-unpinned" | "demo-pinned";

async function storageWith(kind: Account): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: "harry",
    irkPubHex: hex(irk.publicKey),
    claimedAt: 1,
    ...(kind === "pinned" || kind === "demo-pinned" ? { adminRootPubHex: hex(admin.publicKey) } : {}),
    ...(kind.startsWith("demo") ? { isDemo: true } : {}),
  });
  return s;
}

function code(root: Keypair | null, serial = F.serial as string): AuthCode {
  return {
    version: 1,
    serial,
    username: "harry",
    serverName: F.serverName,
    serverDomain: F.serverDomain,
    delegatedPubKey: fromHex(F.delegatedPubKey),
    userPubKey: irk.publicKey,
    issuedAt: F.issuedAt,
    expiresAt: F.expiresAt,
    ...(root ? { adminRootPubKey: root.publicKey } : {}),
  };
}

function issueBody(c: AuthCode, adminSigner: Keypair | null) {
  return {
    code: {
      ...c,
      delegatedPubKey: hex(c.delegatedPubKey),
      userPubKey: hex(c.userPubKey),
      ...(c.adminRootPubKey ? { adminRootPubKey: hex(c.adminRootPubKey) } : {}),
    },
    signature: hex(signAuthCode(c, irk)),
    ...(adminSigner && c.adminRootPubKey ? { adminSignature: hex(signAuthCodeAdmin(c, adminSigner)) } : {}),
  };
}

async function issue(s: InMemoryStorage, body: unknown) {
  return handleAuthCodeIssue(
    { storage: s.authCodes, usernames: s.usernames, grants: s.deviceCapabilityGrants, now: () => NOW },
    body as never,
  );
}

function expectRefused(r: { status: number; body: unknown }) {
  expect(r.status).toBe(403);
  expect(r.body).toEqual({ error: ADD_SERVER_ADMIN_ONLY, code: ADD_SERVER_ADMIN_ONLY_CODE });
}

describe("auth-code issue: creating a server is admin-only", () => {
  it("the vectors' admin approval issues", async () => {
    const s = await storageWith("pinned");
    const r = await issue(s, {
      code: F,
      signature: V.authCode.irkSignatureHex,
      adminSignature: V.authCode.adminSignatureHex,
    });
    expect(r.status).toBe(200);
  });

  it("refuses an IRK-only issue, an IRK or device approval, and an approval of the plain AuthCode", async () => {
    const s = await storageWith("pinned");
    expectRefused(await issue(s, issueBody(code(admin), null)));
    for (const r of V.reject) {
      expectRefused(
        await issue(s, { code: F, signature: V.authCode.irkSignatureHex, adminSignature: r.signatureHex }),
      );
    }
    expectRefused(await issue(s, issueBody(code(admin), device)));
  });

  it("refuses a code pinning another root, even approved by that root", async () => {
    const s = await storageWith("pinned");
    expectRefused(await issue(s, issueBody(code(other), other)));
    expectRefused(
      await issue(s, {
        code: V.wrongRoot.fields,
        signature: hex(signAuthCode(code(other), irk)),
        adminSignature: V.wrongRoot.adminSignatureHex,
      }),
    );
  });

  it("refuses a code with no admin root on a pinned account", async () => {
    const s = await storageWith("pinned");
    expectRefused(await issue(s, issueBody(code(null), null)));
  });

  it("refuses an account with no admin root (legacy): no device can add a server", async () => {
    const s = await storageWith("unpinned");
    expectRefused(await issue(s, issueBody(code(null), null)));
    expectRefused(await issue(s, issueBody(code(admin), admin)));
  });

  it("a demo account still issues with the IRK alone", async () => {
    expect((await issue(await storageWith("demo-unpinned"), issueBody(code(null), null))).status).toBe(200);
    expect((await issue(await storageWith("demo-pinned"), issueBody(code(null), null))).status).toBe(200);
  });
});

describe("RCK registration: admin-only on real accounts", () => {
  async function register(s: InMemoryStorage, signer: Keypair) {
    const rck = key("66".repeat(32));
    const claim = { username: "harry", subdomain: F.serverDomain, rckPubKey: rck.publicKey, issuedAt: NOW };
    return handleRegisterRck(
      { routing: s.routing, usernames: s.usernames, now: () => NOW },
      {
        request: { username: "harry", subdomain: F.serverDomain, rckPubKey: hex(rck.publicKey), issuedAt: NOW },
        signature: hex(signRegisterRck(claim, signer)),
      },
    );
  }

  it("takes the admin root and refuses the IRK and a device key", async () => {
    expectRefused(await register(await storageWith("pinned"), irk));
    expectRefused(await register(await storageWith("pinned"), device));
    expect((await register(await storageWith("pinned"), admin)).status).toBe(200);
  });

  it("refuses a legacy account; a demo account keeps its gate", async () => {
    expectRefused(await register(await storageWith("unpinned"), irk));
    expect((await register(await storageWith("demo-unpinned"), irk)).status).toBe(200);
    expect((await register(await storageWith("demo-pinned"), irk)).status).toBe(403);
    expect((await register(await storageWith("demo-pinned"), admin)).status).toBe(200);
  });
});

describe("server register: the box presents the AuthCode `.com` admitted", () => {
  async function issued(s: InMemoryStorage): Promise<AuthCode> {
    const c = code(admin);
    expect((await issue(s, issueBody(c, admin))).status).toBe(200);
    return c;
  }
  function registerBody(c: AuthCode) {
    const identity = key("77".repeat(32));
    const nonce = new Uint8Array(16).fill(9);
    const userSig = signAuthCode(c, irk);
    const req: ServerRegisterRequest = {
      authCode: c,
      authCodeUserSignature: userSig,
      serverIdentityPubKey: identity.publicKey,
      issuedAt: NOW + 1,
      nonce,
    };
    return {
      request: {
        authCode: {
          ...c,
          delegatedPubKey: hex(c.delegatedPubKey),
          userPubKey: hex(c.userPubKey),
          ...(c.adminRootPubKey ? { adminRootPubKey: hex(c.adminRootPubKey) } : {}),
        },
        authCodeUserSignature: hex(userSig),
        serverIdentityPubKey: hex(identity.publicKey),
        issuedAt: NOW + 1,
        nonce: hex(nonce),
      },
      signature: hex(signServerRegister(req, identity)),
    };
  }
  const deps = (s: InMemoryStorage) => ({
    authCodes: s.authCodes,
    servers: s.servers,
    usernames: s.usernames,
    now: () => NOW + 1,
  });

  it("registers the admitted AuthCode", async () => {
    const s = await storageWith("pinned");
    const c = await issued(s);
    expect((await handleServerRegister(deps(s), registerBody(c))).status).toBe(200);
  });

  it("refuses the same serial re-signed with another admin root", async () => {
    const s = await storageWith("pinned");
    await issued(s);
    const r = await handleServerRegister(deps(s), registerBody(code(other)));
    expect(r.status).toBe(403);
  });

  it("refuses an AuthCode whose root is no longer the account's", async () => {
    const s = await storageWith("pinned");
    const c = await issued(s);
    const rec = await s.usernames.get("harry");
    await s.usernames.put({ ...rec!, adminRootPubHex: hex(other.publicKey) });
    expectRefused(await handleServerRegister(deps(s), registerBody(c)));
  });
});

describe("take over a box: the acquirer's admin root, named and signing", () => {
  const HOST = "home.alice.flagship.services";
  const aliceAdmin = key("88".repeat(32));
  const aliceIrk = key("99".repeat(32));

  async function world(acquirer: Account) {
    const s = await storageWith(acquirer);
    await s.usernames.put({
      username: "alice",
      irkPubHex: hex(aliceIrk.publicKey),
      adminRootPubHex: hex(aliceAdmin.publicKey),
      claimedAt: 1,
    });
    await s.servers.put({ serverDomain: HOST, username: "alice", identityPubKeyHex: "11".repeat(32), registeredAt: 1 });
    const nonce = "ab".repeat(32);
    const offer = { serverDomain: HOST, transferNonce: nonce, issuedAt: NOW, expiresAt: NOW + 60_000 };
    // The offer's own gate is covered in serverTransfer.test.ts; seed it.
    await s.serverTransfers.putOffer({
      ...offer,
      giverUsername: "alice",
      giverIrkPubHex: hex(aliceIrk.publicKey),
      offerSignatureHex: hex(signServerTransferOffer(offer, aliceAdmin)),
      claimedAt: null,
      acquirerUsername: null,
      acquirerIrkPubHex: null,
      claimIssuedAt: null,
      claimSignatureHex: null,
      acquirerAdminRootPubHex: null,
      adminHandoffOldRootHex: null,
      adminHandoffNewRootHex: null,
      adminHandoffIssuedAt: null,
      adminHandoffSigHex: null,
      diskKeyHandoffHex: null,
      diskKeyHandoffAt: null,
      rehomeAuthIssuedAt: null,
      rehomeAuthSigHex: null,
    });
    const deps = {
      servers: s.servers,
      usernames: s.usernames,
      routing: s.routing,
      serverTransfers: s.serverTransfers,
      now: () => NOW,
    };
    return { deps, nonce };
  }

  function claim(nonce: string, named: string, signer: Keypair) {
    const c = {
      serverDomain: HOST,
      transferNonce: nonce,
      acquirerUsername: "harry",
      acquirerIrkPub: irk.publicKey,
      acquirerAdminRootPubHex: named,
      issuedAt: NOW,
    };
    return {
      claim: { ...c, acquirerIrkPub: hex(irk.publicKey), acquirerAdminRootPub: named },
      claimSignature: hex(signServerTransferClaim(c, signer)),
    };
  }

  it("refuses an IRK signature, another named root and an unnamed root", async () => {
    const w = await world("pinned");
    expectRefused(await handlePostTransferClaim(w.deps, HOST, claim(w.nonce, hex(admin.publicKey), irk)));
    expectRefused(await handlePostTransferClaim(w.deps, HOST, claim(w.nonce, hex(other.publicKey), other)));
    expectRefused(await handlePostTransferClaim(w.deps, HOST, claim(w.nonce, "", admin)));
    expect((await handlePostTransferClaim(w.deps, HOST, claim(w.nonce, hex(admin.publicKey), admin))).status).toBe(200);
  });

  it("refuses a legacy acquirer; a demo acquirer keeps its IRK path", async () => {
    const legacy = await world("unpinned");
    expectRefused(await handlePostTransferClaim(legacy.deps, HOST, claim(legacy.nonce, "", irk)));
    const demo = await world("demo-unpinned");
    expect((await handlePostTransferClaim(demo.deps, HOST, claim(demo.nonce, "", irk))).status).toBe(200);
  });
});
