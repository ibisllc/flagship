// H6 — `.flagshipkey` import runs the TAKEOVER re-pair, against whichever key
// the account really holds.
//
// The webapp used to sign the re-pair's OLD key as the web v1 derivation of the
// file's seed. An account made on Android (or iOS) registers that client's own
// derivation, so `.com` answered 403 "oldIrkPub does not match the current
// registered IRK" (Windows acceptance 2026-11-05, Failure 4). The import now
// finds the registered key among every client's derivation
// (packages/protocol/test-vectors/irk-lineage), rotates to the web scheme one
// version past it, and is accepted by the REAL control-plane handler for an
// account made by each client. A file for another account, an unknown account
// and a refused initiate all end in a translated sentence, never a raw body.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryStorage } from "@flagship/storage";
import { handleInitiateRePair, handleUsernameLookup } from "@flagship/control-plane";

const webapp = resolve(__dirname, "..", "public", "webapp");
const loadLib = () => import(pathToFileURL(resolve(webapp, "lib", "keyfileImportTakeover.js")).href);
const loadLineage = () => import(pathToFileURL(resolve(webapp, "lib", "irkLineage.js")).href);
const loadKeystore = () => import(pathToFileURL(resolve(webapp, "keystore.js")).href);

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/irk-lineage/vectors.json"), "utf8"),
);
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const UMK = fromHex(vectors.umkSeedHex);
const NOW = 1_760_000_000_000;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `.com` as the real handlers: username lookup + re-pair initiate. */
async function realCom(registeredPubHex: string, extra: Record<string, unknown> = {}) {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: "kestrel", irkPubHex: registeredPubHex, claimedAt: 1, accountType: "single", ...extra });
  const calls: string[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/username/kestrel") {
      const r = await handleUsernameLookup(s.usernames, "kestrel");
      return json(r.status, r.body);
    }
    if (path === "/api/users/kestrel/re-pair") {
      const r = await handleInitiateRePair(
        { usernames: s.usernames, pendingRePairs: s.pendingRePairs, auditEvents: s.auditEvents, webauthnRecovery: s.webauthnRecovery, recoveryProofSecret: "11".repeat(32), now: () => NOW } as any,
        "kestrel",
        JSON.parse(String(init?.body)),
      );
      return json(r.status, r.body);
    }
    return json(404, { error: "not found" });
  });
  return { s, f, calls };
}

describe("irk-lineage vectors", () => {
  it("every scheme's key matches the vectors, and the web scheme is the keystore's own", async () => {
    const { irkKeyFor } = await loadLineage();
    const keystore = await loadKeystore();
    for (const k of vectors.keys) {
      expect((await irkKeyFor(UMK, k.scheme, k.version)).pubHex).toBe(k.pubHex);
      if (k.scheme === "web") {
        expect(Buffer.from((await keystore.deriveIrkVersioned(UMK, k.version)).publicKey).toString("hex")).toBe(k.pubHex);
      }
    }
  });

  it("finds the registered key of an account made by any client, and none for another account", async () => {
    const { findRegisteredIrk, nextIrkVersion, irkKeyFor } = await loadLineage();
    for (const c of vectors.imports) {
      const found = await findRegisteredIrk(UMK, c.registeredPubHex);
      expect(found, c.name).toMatchObject(c.registered);
      const v = nextIrkVersion(found);
      expect(v).toBe(c.importer.web.newVersion);
      expect((await irkKeyFor(UMK, "web", v)).pubHex).toBe(c.importer.web.newPubHex);
    }
    for (const c of vectors.noMatch) expect(await findRegisteredIrk(UMK, c.registeredPubHex), c.name).toBeNull();
  });
});

describe("keyfileImportTakeover — accepted by the real .com for every creating client", () => {
  for (const c of vectors.imports) {
    it(`${c.name}: initiate accepted, rotated to web v${c.importer.web.newVersion}`, async () => {
      const { runKeyfileImportTakeover } = await loadLib();
      const com = await realCom(c.registeredPubHex);
      const out = await runKeyfileImportTakeover({
        username: "kestrel", seed: UMK, fetch: com.f, baseUrl: "https://com.test", now: () => NOW,
      });
      expect(com.calls).toEqual(["GET /api/username/kestrel", "POST /api/users/kestrel/re-pair"]);
      expect(out.newIrkVersion).toBe(c.importer.web.newVersion);
      expect(out.rePair.completesAt).toBeGreaterThan(NOW);
      const pending = await com.s.pendingRePairs.get("kestrel");
      expect(pending?.oldIrkPubHex).toBe(c.registeredPubHex);
      expect(pending?.newIrkPubHex).toBe(c.importer.web.newPubHex);
      // The swap is still ahead: the registered key is unchanged until the grace ends.
      expect((await com.s.usernames.get("kestrel"))?.irkPubHex).toBe(c.registeredPubHex);
      expect(out.profile).toMatchObject({ cloudName: "kestrel", deviceId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    });
  }
});

describe("cloud-recovery takeover (loginTakeover.runTakeover) — same lookup", () => {
  it("an account made on Android: signs with its registered key and rotates past it", async () => {
    const { runTakeover } = await import(pathToFileURL(resolve(webapp, "lib", "loginTakeover.js")).href);
    const { findRegisteredIrk } = await loadLineage();
    const keystore = await loadKeystore();
    const android = vectors.imports.find((c: any) => c.registered.scheme === "android" && c.registered.version === 1);
    const com = await realCom(android.registeredPubHex);
    const out = await runTakeover(
      { username: "kestrel", kind: "single", recovery: { present: true } },
      {
        recoverFromCloud: async () => UMK,
        bootstrapFromExistingSeed: async () => {},
        unlockSession: async () => {},
        localPassphrase: "fixed-local-passphrase",
        deriveIrkFromSeed: keystore.deriveIrkFromSeed,
        deriveIrkVersioned: keystore.deriveIrkVersioned,
        signWithIrkVersioned: keystore.signWithIrkVersioned,
        signWithIrk: keystore.signWithIrk,
        resolveRegisteredIrk: async (seed: Uint8Array) => findRegisteredIrk(seed, android.registeredPubHex),
        fetch: com.f,
        baseUrl: "https://com.test",
        now: () => NOW,
      },
    );
    expect(out.newIrkVersion).toBe(2);
    const pending = await com.s.pendingRePairs.get("kestrel");
    expect(pending?.oldIrkPubHex).toBe(android.registeredPubHex);
    expect(pending?.newIrkPubHex).toBe(android.importer.web.newPubHex);
  });
});

describe("keyfileImportTakeover — refusals are sentences and send nothing they shouldn't", () => {
  it("a key file for another account: refused before any re-pair is sent", async () => {
    const { runKeyfileImportTakeover, KeyfileImportRefusedError } = await loadLib();
    const com = await realCom(vectors.noMatch[0].registeredPubHex);
    const err = await runKeyfileImportTakeover({ username: "kestrel", seed: UMK, fetch: com.f, baseUrl: "https://com.test" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyfileImportRefusedError);
    expect((err as any).code).toBe("key-mismatch");
    expect((err as Error).message).toContain("kestrel");
    expect((err as Error).message).not.toMatch(/irk|403|\{/i);
    expect(com.calls).toEqual(["GET /api/username/kestrel"]);
  });

  it("an unknown account: account-not-found", async () => {
    const { runKeyfileImportTakeover } = await loadLib();
    const f = vi.fn(async () => json(404, { error: "not found" }));
    const err = await runKeyfileImportTakeover({ username: "nobody", seed: UMK, fetch: f, baseUrl: "https://com.test" }).catch((e: unknown) => e);
    expect((err as any).code).toBe("account-not-found");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a lying lookup cannot make it sign for a key outside the file: the real .com refuses", async () => {
    // .com says the account holds K (derived from this seed) but stores another key.
    const { runKeyfileImportTakeover } = await loadLib();
    const com = await realCom(vectors.noMatch[0].registeredPubHex);
    const err = await runKeyfileImportTakeover({
      username: "kestrel", seed: UMK, fetch: com.f, baseUrl: "https://com.test", now: () => NOW,
      registeredIrkPubHex: vectors.imports[2].registeredPubHex,
    }).catch((e: unknown) => e);
    expect((err as any).code).toBe("initiate-failed");
    expect((err as Error).message).not.toMatch(/oldIrkPub|403/);
    expect(await com.s.pendingRePairs.get("kestrel")).toBeFalsy();
  });

  it("a 401 totpProof routes to sign-in with the mobile copy", async () => {
    const { runKeyfileImportTakeover, SecondFactorRequiredError, SECOND_FACTOR_GUIDANCE } = await loadLib();
    const f = vi.fn(async (url: string) =>
      url.includes("/api/username/") ? json(200, { irkPub: vectors.imports[0].registeredPubHex }) : json(401, { error: "missing totpProof" }));
    await expect(runKeyfileImportTakeover({ username: "kestrel", seed: UMK, fetch: f, baseUrl: "https://com.test" }))
      .rejects.toBeInstanceOf(SecondFactorRequiredError);
    expect(SECOND_FACTOR_GUIDANCE).toContain('"Connect to an existing account"');
  });

  it("a rate limit keeps its own sentence", async () => {
    const { runKeyfileImportTakeover } = await loadLib();
    const f = vi.fn(async (url: string) =>
      url.includes("/api/username/") ? json(200, { irkPub: vectors.imports[0].registeredPubHex })
        : json(429, { error: "rate-limited", limit: "ip", retryAfterSec: 120 }));
    const err = await runKeyfileImportTakeover({ username: "kestrel", seed: UMK, fetch: f, baseUrl: "https://com.test" }).catch((e: unknown) => e);
    expect((err as any).rateLimited).toBe(true);
    expect((err as Error).message).toMatch(/Too many tries/);
  });

  it("guards: missing username, malformed seed", async () => {
    const { runKeyfileImportTakeover } = await loadLib();
    await expect(runKeyfileImportTakeover({ username: "", seed: UMK })).rejects.toThrow(/missing username/);
    await expect(runKeyfileImportTakeover({ username: "kestrel", seed: new Uint8Array(16) })).rejects.toThrow(/malformed/);
  });
});
