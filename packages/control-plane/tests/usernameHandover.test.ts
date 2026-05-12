/**
 * Username handover (#93) — rename with permanent alias map.
 *
 * Key security property: old usernames are PERMANENTLY consumed —
 * never re-issuable to anyone else. This stops stale invite links
 * from resolving to a different person after a rename.
 */
import { describe, expect, it } from "vitest";
import {
  handleGetUsernameAlias,
  handlePostUsernameRename,
} from "../src/usernameHandover.js";
import { handleUsernameClaim } from "../src/usernameClaim.js";
import {
  deriveIRK,
  signClaimUsername,
  signUsernameRename,
  type UsernameRename,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";

const trentUmk = { seed: new Uint8Array(32).fill(11) };
const trentIrk = deriveIRK(trentUmk);
const malloryUmk = { seed: new Uint8Array(32).fill(99) };
const malloryIrk = deriveIRK(malloryUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function claim(storage: InMemoryStorage, username: string, irk = trentIrk) {
  const claimRec = {
    username,
    irkPub: irk.publicKey,
    issuedAt: Date.now(),
  };
  const sig = signClaimUsername(claimRec, irk);
  const r = await handleUsernameClaim(
    { storage: storage.usernames },
    {
      request: {
        username,
        irkPub: bytesToHex(irk.publicKey),
        issuedAt: claimRec.issuedAt,
      },
      signature: bytesToHex(sig),
    },
  );
  if (r.status !== 200) throw new Error(`claim failed: ${JSON.stringify(r.body)}`);
}

describe("POST /api/username/rename (#93)", () => {
  it("happy path: rename succeeds; new lookup resolves; alias map records the chain", async () => {
    const storage = new InMemoryStorage();
    await claim(storage, "trent");
    const r: UsernameRename = {
      oldUsername: "trent",
      newUsername: "wendy",
      effectiveAt: Date.now(),
    };
    const sig = signUsernameRename(r, trentIrk);
    const out = await handlePostUsernameRename(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      { request: r, signature: bytesToHex(sig) },
    );
    expect(out.status).toBe(200);

    // New username resolves
    const newRec = await storage.usernames.get("wendy");
    expect(newRec?.irkPubHex).toBe(bytesToHex(trentIrk.publicKey));

    // Alias chain present
    const alias = await handleGetUsernameAlias(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      "trent",
    );
    const body = alias.body as { resolved: string; isAlias: boolean; chain: string[] };
    expect(body.resolved).toBe("wendy");
    expect(body.isAlias).toBe(true);
    expect(body.chain).toEqual(["trent", "wendy"]);
  });

  it("rejects rename signed by a different IRK", async () => {
    const storage = new InMemoryStorage();
    await claim(storage, "trent");
    const r: UsernameRename = {
      oldUsername: "trent",
      newUsername: "evil",
      effectiveAt: Date.now(),
    };
    const sig = signUsernameRename(r, malloryIrk);
    const out = await handlePostUsernameRename(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      { request: r, signature: bytesToHex(sig) },
    );
    expect(out.status).toBe(403);
  });

  it("rejects rename to an already-claimed username", async () => {
    const storage = new InMemoryStorage();
    await claim(storage, "trent");
    await claim(storage, "alice", malloryIrk);
    const r: UsernameRename = {
      oldUsername: "trent",
      newUsername: "alice",
      effectiveAt: Date.now(),
    };
    const sig = signUsernameRename(r, trentIrk);
    const out = await handlePostUsernameRename(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      { request: r, signature: bytesToHex(sig) },
    );
    expect(out.status).toBe(409);
  });

  it("PERMANENT CONSUMPTION: rename then attempt to re-issue old name → conflict", async () => {
    const storage = new InMemoryStorage();
    await claim(storage, "trent");
    const r1: UsernameRename = {
      oldUsername: "trent",
      newUsername: "wendy",
      effectiveAt: Date.now(),
    };
    await handlePostUsernameRename(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      { request: r1, signature: bytesToHex(signUsernameRename(r1, trentIrk)) },
    );

    // Try to rename someone else INTO the consumed name "trent".
    await claim(storage, "bob", malloryIrk);
    const r2: UsernameRename = {
      oldUsername: "bob",
      newUsername: "trent",
      effectiveAt: Date.now(),
    };
    const sig = signUsernameRename(r2, malloryIrk);
    const out = await handlePostUsernameRename(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      { request: r2, signature: bytesToHex(sig) },
    );
    expect(out.status).toBe(409);
    // Either path fires (the row is still in usernames OR the alias map
    // marks it as consumed) — both are the permanent-consumption
    // property in action.
    expect((out.body as { error: string }).error).toMatch(/already registered|consumed/);
  });

  it("rejects rename to the same name", async () => {
    const storage = new InMemoryStorage();
    await claim(storage, "trent");
    const r: UsernameRename = {
      oldUsername: "trent",
      newUsername: "trent",
      effectiveAt: Date.now(),
    };
    const out = await handlePostUsernameRename(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      { request: r, signature: bytesToHex(signUsernameRename(r, trentIrk)) },
    );
    expect(out.status).toBe(400);
  });

  it("rejects stale effectiveAt", async () => {
    const storage = new InMemoryStorage();
    await claim(storage, "trent");
    const r: UsernameRename = {
      oldUsername: "trent",
      newUsername: "wendy",
      effectiveAt: Date.now() - 1000 * 60 * 60,
    };
    const out = await handlePostUsernameRename(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      { request: r, signature: bytesToHex(signUsernameRename(r, trentIrk)) },
    );
    expect(out.status).toBe(400);
  });
});

describe("GET /api/username/alias/<u> (#93)", () => {
  it("returns no-alias for a never-renamed name", async () => {
    const storage = new InMemoryStorage();
    await claim(storage, "trent");
    const out = await handleGetUsernameAlias(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      "trent",
    );
    const body = out.body as { resolved: string; isAlias: boolean; chain: string[] };
    expect(body.isAlias).toBe(false);
    expect(body.chain).toEqual(["trent"]);
  });

  it("walks a multi-hop chain (trent → wendy → peggy)", async () => {
    const storage = new InMemoryStorage();
    await claim(storage, "trent");
    for (const [from, to] of [
      ["trent", "wendy"],
      ["wendy", "peggy"],
    ] as const) {
      const r: UsernameRename = { oldUsername: from, newUsername: to, effectiveAt: Date.now() };
      await handlePostUsernameRename(
        { usernames: storage.usernames, aliases: storage.usernameAliases },
        { request: r, signature: bytesToHex(signUsernameRename(r, trentIrk)) },
      );
    }
    const out = await handleGetUsernameAlias(
      { usernames: storage.usernames, aliases: storage.usernameAliases },
      "trent",
    );
    const body = out.body as { resolved: string; chain: string[] };
    expect(body.resolved).toBe("peggy");
    expect(body.chain).toEqual(["trent", "wendy", "peggy"]);
  });
});
