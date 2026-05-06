/**
 * Tests for the app-alias handlers (URL multiplexing).
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signAliasDeclare,
  signAliasRelease,
  type AliasDeclareRequest,
  type AliasReleaseRequest,
  type Keypair,
} from "@flagship/protocol";
import {
  InMemoryAppAliasStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  handleAliasDeclare,
  handleAliasListByUser,
  handleAliasRelease,
  handleAliasResolve,
} from "../src/aliases.js";

function makeIrk(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = ""; for (const x of b) s += x.toString(16).padStart(2, "0"); return s;
}
async function seedUser(usernames: InMemoryUsernameStorage, name: string, irk: Keypair) {
  await usernames.put({ username: name, irkPubHex: bytesToHex(irk.publicKey), claimedAt: Date.now() });
}

function declarePayload(overrides: Partial<AliasDeclareRequest> = {}): AliasDeclareRequest {
  return {
    username: "john",
    slug: "game",
    fullLabel: "game",
    serverDomain: "home.john.flagship.services",
    issuedAt: Date.now(),
    ...overrides,
  };
}

describe("handleAliasDeclare", () => {
  it("creates a fresh alias", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    const claim = declarePayload();
    const sig = signAliasDeclare(claim, irk);
    const r = await handleAliasDeclare(
      { aliases, usernames },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; shortHost: string };
    expect(body.ok).toBe(true);
    expect(body.shortHost).toBe("game.john.flagship.services");
  });

  it("is idempotent on identical re-declare", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    const claim = declarePayload();
    const sig = signAliasDeclare(claim, irk);
    await handleAliasDeclare({ aliases, usernames }, { request: claim, signature: bytesToHex(sig) });
    const claim2 = declarePayload({ issuedAt: claim.issuedAt + 1 });
    const sig2 = signAliasDeclare(claim2, irk);
    const r = await handleAliasDeclare(
      { aliases, usernames },
      { request: claim2, signature: bytesToHex(sig2) },
    );
    expect(r.status).toBe(200);
    const body = r.body as { idempotent: boolean };
    expect(body.idempotent).toBe(true);
  });

  it("returns 409 + candidates on conflicting target", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    const a = declarePayload({ serverDomain: "home.john.flagship.services" });
    const sigA = signAliasDeclare(a, irk);
    await handleAliasDeclare({ aliases, usernames }, { request: a, signature: bytesToHex(sigA) });

    const b = declarePayload({
      serverDomain: "work.john.flagship.services",
      issuedAt: a.issuedAt + 1,
    });
    const sigB = signAliasDeclare(b, irk);
    const r = await handleAliasDeclare(
      { aliases, usernames },
      { request: b, signature: bytesToHex(sigB) },
    );
    expect(r.status).toBe(409);
    const body = r.body as { error: string; candidates: Array<{ server_domain: string }> };
    expect(body.error).toBe("conflict");
    expect(body.candidates).toHaveLength(2);
  });

  it("rejects when serverDomain doesn't belong to the user", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    const claim = declarePayload({ serverDomain: "home.alice.flagship.services" });
    const sig = signAliasDeclare(claim, irk);
    const r = await handleAliasDeclare(
      { aliases, usernames },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(403);
  });

  it("rejects unregistered usernames", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk();
    const claim = declarePayload({ username: "ghost" });
    const sig = signAliasDeclare(claim, irk);
    const r = await handleAliasDeclare(
      { aliases, usernames },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(404);
  });

  it("rejects wrong signature", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const real = makeIrk(); const evil = makeIrk();
    await seedUser(usernames, "john", real);
    const claim = declarePayload();
    const sig = signAliasDeclare(claim, evil);
    const r = await handleAliasDeclare(
      { aliases, usernames },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(403);
  });

  it("rejects reserved slugs", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    for (const reserved of ["www", "admin", "api", "marketplace"]) {
      const claim = declarePayload({ slug: reserved, fullLabel: reserved });
      const sig = signAliasDeclare(claim, irk);
      const r = await handleAliasDeclare(
        { aliases, usernames },
        { request: claim, signature: bytesToHex(sig) },
      );
      expect(r.status).toBe(400);
    }
  });

  it("fires onDeclared hook on first declare, not on idempotent re-declare", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    const fires: number[] = [];
    const claim = declarePayload();
    const sig = signAliasDeclare(claim, irk);
    await handleAliasDeclare(
      { aliases, usernames, onDeclared: async () => { fires.push(1); } },
      { request: claim, signature: bytesToHex(sig) },
    );
    const claim2 = declarePayload({ issuedAt: claim.issuedAt + 1 });
    const sig2 = signAliasDeclare(claim2, irk);
    await handleAliasDeclare(
      { aliases, usernames, onDeclared: async () => { fires.push(2); } },
      { request: claim2, signature: bytesToHex(sig2) },
    );
    expect(fires).toEqual([1]); // only the first call invokes the hook
  });
});

describe("handleAliasRelease", () => {
  it("removes the alias and fires onReleased", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    const decl = declarePayload();
    const declSig = signAliasDeclare(decl, irk);
    await handleAliasDeclare({ aliases, usernames }, { request: decl, signature: bytesToHex(declSig) });

    const releases: string[] = [];
    const rel: AliasReleaseRequest = { username: "john", slug: "game", issuedAt: Date.now() };
    const sig = signAliasRelease(rel, irk);
    const r = await handleAliasRelease(
      { aliases, usernames, onReleased: async (u, s) => { releases.push(`${u}/${s}`); } },
      { request: rel, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(200);
    expect(releases).toEqual(["john/game"]);
    expect(await aliases.get("john", "game")).toBeUndefined();
  });

  it("rejects wrong signature", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const real = makeIrk(); const evil = makeIrk();
    await seedUser(usernames, "john", real);
    const rel: AliasReleaseRequest = { username: "john", slug: "game", issuedAt: Date.now() };
    const sig = signAliasRelease(rel, evil);
    const r = await handleAliasRelease(
      { aliases, usernames },
      { request: rel, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(403);
  });
});

describe("handleAliasResolve", () => {
  it("returns single + longHost when alias exists", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    const claim = declarePayload();
    const sig = signAliasDeclare(claim, irk);
    await handleAliasDeclare({ aliases, usernames }, { request: claim, signature: bytesToHex(sig) });

    const r = await handleAliasResolve(
      { aliases, usernames },
      "game.john.flagship.services",
    );
    expect(r.status).toBe(200);
    const body = r.body as { kind: string; longHost: string };
    expect(body.kind).toBe("single");
    expect(body.longHost).toBe("game.home.john.flagship.services");
  });

  it("returns missing when alias is absent", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const r = await handleAliasResolve(
      { aliases, usernames },
      "ghost.john.flagship.services",
    );
    expect(r.status).toBe(200);
    const body = r.body as { kind: string };
    expect(body.kind).toBe("missing");
  });

  it("returns missing on a malformed host", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const r = await handleAliasResolve(
      { aliases, usernames },
      "not-a-flagship-host.example.com",
    );
    expect(r.status).toBe(200);
    const body = r.body as { kind: string };
    expect(body.kind).toBe("missing");
  });

  it("supports cross-creator alias collapse (game-peter → game)", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    const claim = declarePayload({
      slug: "game",
      fullLabel: "game-peter",
      serverDomain: "home.john.flagship.services",
    });
    const sig = signAliasDeclare(claim, irk);
    await handleAliasDeclare({ aliases, usernames }, { request: claim, signature: bytesToHex(sig) });

    const r = await handleAliasResolve(
      { aliases, usernames },
      "game.john.flagship.services",
    );
    const body = r.body as { kind: string; longHost: string };
    expect(body.kind).toBe("single");
    expect(body.longHost).toBe("game-peter.home.john.flagship.services");
  });
});

describe("handleAliasListByUser", () => {
  it("lists every alias the user has declared", async () => {
    const aliases = new InMemoryAppAliasStorage();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeIrk(); await seedUser(usernames, "john", irk);
    for (const slug of ["game", "notes", "photos"]) {
      const claim = declarePayload({ slug, fullLabel: slug });
      const sig = signAliasDeclare(claim, irk);
      await handleAliasDeclare({ aliases, usernames }, { request: claim, signature: bytesToHex(sig) });
    }
    const r = await handleAliasListByUser({ aliases, usernames }, "john");
    expect(r.status).toBe(200);
    const body = r.body as { aliases: Array<{ slug: string }> };
    expect(body.aliases.map((a) => a.slug).sort()).toEqual(["game", "notes", "photos"]);
  });
});
