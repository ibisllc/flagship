import { describe, expect, it } from "vitest";
import { ed, signSetCustomDomain, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleSetCustomDomain,
  handleGetCustomDomain,
} from "../src/customDomain.js";
import { handleGetAppLinks } from "../src/appRename.js";

const USER = "alice";
const APP = "alice-game1";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function seed(s: InMemoryStorage, irk: Keypair) {
  await s.usernames.put({ username: USER, irkPubHex: bytesToHex(irk.publicKey), claimedAt: 1 });
  await s.servers.put({
    serverDomain: "home.alice.flagship.services",
    username: USER,
    identityPubKeyHex: "11".repeat(32),
    registeredAt: 1,
  });
}

function deps(s: InMemoryStorage, now: () => number) {
  return { usernames: s.usernames, customDomainOrders: s.customDomainOrders, now };
}

function signedBody(irk: Keypair, fqdn: string, issuedAt: number, over?: Partial<{ username: string; appId: string; fqdn: string }>) {
  const claim = {
    username: over?.username ?? USER,
    appId: over?.appId ?? APP,
    fqdn: over?.fqdn ?? fqdn,
    issuedAt,
  };
  const sig = signSetCustomDomain(claim, irk);
  return { request: claim, signature: bytesToHex(sig) };
}

describe("handleSetCustomDomain (#79A)", () => {
  it("records a valid signed request as pending; getAppLinks surfaces it unconfirmed", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const NOW = 1_000_000;
    const r = await handleSetCustomDomain(
      deps(s, () => NOW), USER, APP, signedBody(irk, "shop.example.com", NOW),
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recorded: true });
    const row = await s.customDomainOrders.get(USER, APP);
    expect(row).toMatchObject({ fqdn: "shop.example.com", status: "pending", lastChanged: NOW });

    const links = await handleGetAppLinks(
      {
        usernames: s.usernames, userAppAliases: s.userAppAliases, voiciLinks: s.voiciLinks,
        servers: s.servers, auditEvents: s.auditEvents, customDomainOrders: s.customDomainOrders,
      },
      USER, APP,
    );
    expect(links.body).toMatchObject({ customDomain: "shop.example.com", customDomainConfirmed: false });
  });

  it("enforces the 300s rate limit with the exact iOS-Mock 429 string", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const T0 = 5_000_000;
    await handleSetCustomDomain(deps(s, () => T0), USER, APP, signedBody(irk, "a.example.com", T0));
    // 100s later → still inside the 300s window.
    const T1 = T0 + 100_000;
    const r = await handleSetCustomDomain(deps(s, () => T1), USER, APP, signedBody(irk, "b.example.com", T1));
    expect(r.status).toBe(429);
    expect((r.body as { error: string }).error).toBe("Too soon — try again in 200s.");
    // Unchanged — the rate-limited request must not have replaced the row.
    expect((await s.customDomainOrders.get(USER, APP))?.fqdn).toBe("a.example.com");
  });

  it("after the window elapses, a new request destructively replaces the prior", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const T0 = 9_000_000;
    await handleSetCustomDomain(deps(s, () => T0), USER, APP, signedBody(irk, "old.example.com", T0));
    const T1 = T0 + 300_001;
    const r = await handleSetCustomDomain(deps(s, () => T1), USER, APP, signedBody(irk, "new.example.com", T1));
    expect(r.status).toBe(200);
    const row = await s.customDomainOrders.get(USER, APP);
    expect(row).toMatchObject({ fqdn: "new.example.com", status: "pending", createdAt: T0, lastChanged: T1 });
  });

  it("rejects an apex domain with subdomain guidance (400, structural)", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const NOW = 2_000_000;
    const r = await handleSetCustomDomain(deps(s, () => NOW), USER, APP, signedBody(irk, "example.com", NOW));
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/apex domains are not supported/);
  });

  it("rejects a non-hostname fqdn (scheme/path)", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const NOW = 2_500_000;
    const r = await handleSetCustomDomain(deps(s, () => NOW), USER, APP, signedBody(irk, "https://x.example.com/p", NOW));
    expect(r.status).toBe(400);
  });

  it("rejects a wrong-key signature (only the account IRK can attach)", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const NOW = 3_000_000;
    const attacker = makeKey();
    const r = await handleSetCustomDomain(
      deps(s, () => NOW), USER, APP, signedBody(attacker, "shop.example.com", NOW),
    );
    expect(r.status).toBe(403);
  });

  it("rejects a stale request", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const NOW = 4_000_000;
    const r = await handleSetCustomDomain(
      deps(s, () => NOW), USER, APP, signedBody(irk, "shop.example.com", NOW - 10 * 60_000),
    );
    expect(r.status).toBe(403);
  });

  it("rejects a username / url mismatch", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const NOW = 4_500_000;
    const r = await handleSetCustomDomain(
      deps(s, () => NOW), USER, APP, signedBody(irk, "shop.example.com", NOW, { username: "mallory" }),
    );
    expect(r.status).toBe(403);
  });
});

describe("handleGetCustomDomain (#79A)", () => {
  it("returns {fqdn:null} when none, then the row + confirmed flag", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const NOW = 7_000_000;
    expect((await handleGetCustomDomain(deps(s, () => NOW), USER, APP)).body).toEqual({ fqdn: null });

    await handleSetCustomDomain(deps(s, () => NOW), USER, APP, signedBody(irk, "shop.example.com", NOW));
    expect((await handleGetCustomDomain(deps(s, () => NOW), USER, APP)).body).toEqual({
      fqdn: "shop.example.com", status: "pending", confirmed: false,
    });

    // Phase-4 verifier confirms it.
    await s.customDomainOrders.setStatus(USER, APP, "shop.example.com", "active", NOW + 1);
    expect((await handleGetCustomDomain(deps(s, () => NOW), USER, APP)).body).toEqual({
      fqdn: "shop.example.com", status: "active", confirmed: true,
    });
  });
});
