import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRoutingReplayRing,
  handleRegisterRck,
  handleRoutingLookup,
  handleSetRoutingTarget,
} from "../src/routing.js";
import { handleUsernameClaim } from "../src/usernameClaim.js";
import {
  signClaimUsername,
  signRegisterRck,
  signSetRoutingTarget,
  type RegisterRck,
  type SetRoutingTarget,
} from "@flagship/protocol";
import { deriveIRK, ed } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const malloryIrk = deriveIRK(malloryUmk);

function freshKeypair(seed = 0) {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 31 + i * 13 + 7) & 0xff;
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function setUpClaimedHarry() {
  const storage = new InMemoryStorage();
  const claim = {
    username: "harry",
    irkPub: harryIrk.publicKey,
    issuedAt: Date.now(),
  };
  const sig = signClaimUsername(claim, harryIrk);
  await handleUsernameClaim(
    { storage: storage.usernames },
    {
      request: {
        username: "harry",
        irkPub: bytesToHex(harryIrk.publicKey),
        issuedAt: claim.issuedAt,
      },
      signature: bytesToHex(sig),
    },
  );
  return storage;
}

// Reset module-level ring before each test so the replay-defense state
// doesn't leak across cases.
beforeEach(() => __resetRoutingReplayRing());

describe("POST /api/routing/register-rck", () => {
  it("happy path: IRK-signed registration creates the routing record", async () => {
    const storage = await setUpClaimedHarry();
    const rck = freshKeypair(1);
    const claim: RegisterRck = {
      username: "harry",
      subdomain: "home.harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: Date.now(),
    };
    const sig = signRegisterRck(claim, harryIrk);
    const r = await handleRegisterRck(
      { routing: storage.routing, usernames: storage.usernames },
      {
        request: {
          username: claim.username,
          subdomain: claim.subdomain,
          rckPubKey: bytesToHex(claim.rckPubKey),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(200);
    const rec = await storage.routing.get("home.harry.flagship.services");
    expect(rec?.rckPubKeyHex).toBe(bytesToHex(rck.publicKey));
    expect(rec?.currentTargetHex).toBe("");
  });

  it("403 when signed by a different IRK than the registered one", async () => {
    const storage = await setUpClaimedHarry();
    const rck = freshKeypair(2);
    const claim: RegisterRck = {
      username: "harry",
      subdomain: "home.harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: Date.now(),
    };
    const sig = signRegisterRck(claim, malloryIrk);
    const r = await handleRegisterRck(
      { routing: storage.routing, usernames: storage.usernames },
      {
        request: {
          username: claim.username,
          subdomain: claim.subdomain,
          rckPubKey: bytesToHex(claim.rckPubKey),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(403);
  });

  it("400 when the server-label segment is malformed (M5 hardening)", async () => {
    const storage = await setUpClaimedHarry();
    const rck = freshKeypair(4);
    // Leading dash violates RFC 1035 label rules.
    const claim: RegisterRck = {
      username: "harry",
      subdomain: "-bad.harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: Date.now(),
    };
    const sig = signRegisterRck(claim, harryIrk);
    const r = await handleRegisterRck(
      { routing: storage.routing, usernames: storage.usernames },
      {
        request: {
          username: claim.username,
          subdomain: claim.subdomain,
          rckPubKey: bytesToHex(claim.rckPubKey),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(400);
  });

  it("400 when the server label is empty (no leftmost segment) (M5)", async () => {
    const storage = await setUpClaimedHarry();
    const rck = freshKeypair(5);
    // ".harry.flagship.services" — leftmost segment is empty.
    const claim: RegisterRck = {
      username: "harry",
      subdomain: ".harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: Date.now(),
    };
    const sig = signRegisterRck(claim, harryIrk);
    const r = await handleRegisterRck(
      { routing: storage.routing, usernames: storage.usernames },
      {
        request: {
          username: claim.username,
          subdomain: claim.subdomain,
          rckPubKey: bytesToHex(claim.rckPubKey),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(400);
  });

  it("400 when subdomain doesn't match the username segment", async () => {
    const storage = await setUpClaimedHarry();
    const rck = freshKeypair(3);
    const claim: RegisterRck = {
      username: "harry",
      subdomain: "home.bob.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: Date.now(),
    };
    const sig = signRegisterRck(claim, harryIrk);
    const r = await handleRegisterRck(
      { routing: storage.routing, usernames: storage.usernames },
      {
        request: {
          username: claim.username,
          subdomain: claim.subdomain,
          rckPubKey: bytesToHex(claim.rckPubKey),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(400);
  });
});

describe("POST /api/routing/set-target", () => {
  async function registerForTarget(storage: InMemoryStorage) {
    const rck = freshKeypair(11);
    const claim: RegisterRck = {
      username: "harry",
      subdomain: "home.harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: Date.now(),
    };
    const sig = signRegisterRck(claim, harryIrk);
    await handleRegisterRck(
      { routing: storage.routing, usernames: storage.usernames },
      {
        request: {
          username: claim.username,
          subdomain: claim.subdomain,
          rckPubKey: bytesToHex(claim.rckPubKey),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    return rck;
  }

  it("RCK-signed target update mutates the routing record", async () => {
    const storage = await setUpClaimedHarry();
    const rck = await registerForTarget(storage);
    const target = freshKeypair(12);
    const setReq: SetRoutingTarget = {
      subdomain: "home.harry.flagship.services",
      newTargetIdentityPubKey: target.publicKey,
      issuedAt: Date.now(),
      nonce: new Uint8Array(16).fill(7),
    };
    const sig = signSetRoutingTarget(setReq, rck);
    const r = await handleSetRoutingTarget(
      { routing: storage.routing, usernames: storage.usernames },
      {
        request: {
          subdomain: setReq.subdomain,
          newTargetIdentityPubKey: bytesToHex(setReq.newTargetIdentityPubKey),
          issuedAt: setReq.issuedAt,
          nonce: bytesToHex(setReq.nonce),
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(200);
    const rec = await storage.routing.get("home.harry.flagship.services");
    expect(rec?.currentTargetHex).toBe(bytesToHex(target.publicKey));
  });

  it("rejects a target update signed with a different keypair", async () => {
    const storage = await setUpClaimedHarry();
    await registerForTarget(storage);
    const wrongKey = freshKeypair(13);
    const target = freshKeypair(14);
    const setReq: SetRoutingTarget = {
      subdomain: "home.harry.flagship.services",
      newTargetIdentityPubKey: target.publicKey,
      issuedAt: Date.now(),
      nonce: new Uint8Array(16).fill(7),
    };
    const sig = signSetRoutingTarget(setReq, wrongKey);
    const r = await handleSetRoutingTarget(
      { routing: storage.routing, usernames: storage.usernames },
      {
        request: {
          subdomain: setReq.subdomain,
          newTargetIdentityPubKey: bytesToHex(setReq.newTargetIdentityPubKey),
          issuedAt: setReq.issuedAt,
          nonce: bytesToHex(setReq.nonce),
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(403);
  });

  it("rejects in-window replay of the SAME nonce (M6 ring buffer)", async () => {
    const storage = await setUpClaimedHarry();
    const rck = await registerForTarget(storage);
    const target = freshKeypair(16);
    const setReq: SetRoutingTarget = {
      subdomain: "home.harry.flagship.services",
      newTargetIdentityPubKey: target.publicKey,
      issuedAt: Date.now(),
      nonce: new Uint8Array(16).fill(0xab),
    };
    const sig = signSetRoutingTarget(setReq, rck);
    const send = () =>
      handleSetRoutingTarget(
        { routing: storage.routing, usernames: storage.usernames },
        {
          request: {
            subdomain: setReq.subdomain,
            newTargetIdentityPubKey: bytesToHex(setReq.newTargetIdentityPubKey),
            issuedAt: setReq.issuedAt,
            nonce: bytesToHex(setReq.nonce),
          },
          signature: bytesToHex(sig),
        },
      );
    expect((await send()).status).toBe(200);
    // Identical envelope replayed: the ring catches it before storage.
    const replay = await send();
    expect(replay.status).toBe(409);
    expect(typeof replay.body === "object" && replay.body !== null && "error" in replay.body).toBe(true);
  });

  it("rejects replay of an older nonce", async () => {
    const storage = await setUpClaimedHarry();
    const rck = await registerForTarget(storage);
    const target = freshKeypair(15);
    const send = async (nonceFill: number) => {
      const setReq: SetRoutingTarget = {
        subdomain: "home.harry.flagship.services",
        newTargetIdentityPubKey: target.publicKey,
        issuedAt: Date.now(),
        nonce: new Uint8Array(16).fill(nonceFill),
      };
      const sig = signSetRoutingTarget(setReq, rck);
      return handleSetRoutingTarget(
        { routing: storage.routing, usernames: storage.usernames },
        {
          request: {
            subdomain: setReq.subdomain,
            newTargetIdentityPubKey: bytesToHex(setReq.newTargetIdentityPubKey),
            issuedAt: setReq.issuedAt,
            nonce: bytesToHex(setReq.nonce),
          },
          signature: bytesToHex(sig),
        },
      );
    };
    expect((await send(0x10)).status).toBe(200);
    expect((await send(0x05)).status).toBe(409);
    expect((await send(0x20)).status).toBe(200);
  });
});

describe("GET /api/routing/lookup", () => {
  it("returns the current target for a subdomain", async () => {
    const storage = await setUpClaimedHarry();
    const rck = freshKeypair(21);
    const claim: RegisterRck = {
      username: "harry",
      subdomain: "home.harry.flagship.services",
      rckPubKey: rck.publicKey,
      issuedAt: Date.now(),
    };
    const sig = signRegisterRck(claim, harryIrk);
    await handleRegisterRck(
      { routing: storage.routing, usernames: storage.usernames },
      {
        request: {
          username: claim.username,
          subdomain: claim.subdomain,
          rckPubKey: bytesToHex(claim.rckPubKey),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    const r = await handleRoutingLookup(
      { routing: storage.routing, usernames: storage.usernames },
      "home.harry.flagship.services",
    );
    expect(r.status).toBe(200);
    const body = r.body as { rckPubKey: string; currentTarget: string };
    expect(body.rckPubKey).toBe(bytesToHex(rck.publicKey));
    expect(body.currentTarget).toBe("");
  });

  it("404 on unregistered subdomain", async () => {
    const storage = await setUpClaimedHarry();
    const r = await handleRoutingLookup(
      { routing: storage.routing, usernames: storage.usernames },
      "ghost.harry.flagship.services",
    );
    expect(r.status).toBe(404);
  });
});
