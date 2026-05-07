import { describe, expect, it } from "vitest";
import {
  ed,
  signEntitlementRevocationList,
  type EntitlementRevocationList,
  type Keypair,
} from "@flagship/protocol";
import {
  InMemoryEntitlementRevocationStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  handleGetEntitlementRevocations,
  handlePostEntitlementRevocations,
} from "../src/entitlementRevocations.js";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const USER = "harry";

async function setup(opts?: { issuedAt?: number }) {
  const usernames = new InMemoryUsernameStorage();
  const irk = makeKey();
  await usernames.put({
    username: USER,
    irkPubHex: hex(irk.publicKey),
    claimedAt: opts?.issuedAt ?? 1_000,
  });
  const storage = new InMemoryEntitlementRevocationStorage();
  return { usernames, irk, storage };
}

describe("handlePostEntitlementRevocations", () => {
  it("stores a properly-signed list", async () => {
    const s = await setup();
    const list: EntitlementRevocationList = {
      username: USER,
      certIds: ["aa".repeat(32), "bb".repeat(32)],
      issuedAt: Date.now(),
    };
    const sig = signEntitlementRevocationList(list, s.irk);
    const r = await handlePostEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      { request: list, signature: hex(sig) },
    );
    expect(r.status).toBe(200);
    const stored = await s.storage.get(USER);
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!.certIdsJson)).toEqual(list.certIds);
  });

  it("rejects an unknown username", async () => {
    const s = await setup();
    const list: EntitlementRevocationList = {
      username: "ghost",
      certIds: [],
      issuedAt: Date.now(),
    };
    const sig = signEntitlementRevocationList(list, s.irk);
    const r = await handlePostEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      { request: list, signature: hex(sig) },
    );
    expect(r.status).toBe(404);
  });

  it("rejects a signature from a different IRK", async () => {
    const s = await setup();
    const other = makeKey();
    const list: EntitlementRevocationList = {
      username: USER,
      certIds: ["cc".repeat(32)],
      issuedAt: Date.now(),
    };
    const sig = signEntitlementRevocationList(list, other);
    const r = await handlePostEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      { request: list, signature: hex(sig) },
    );
    expect(r.status).toBe(403);
  });

  it("rejects a stale list (issuedAt outside replay window)", async () => {
    const s = await setup();
    const list: EntitlementRevocationList = {
      username: USER,
      certIds: [],
      issuedAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60d ago, > 30d window
    };
    const sig = signEntitlementRevocationList(list, s.irk);
    const r = await handlePostEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      { request: list, signature: hex(sig) },
    );
    expect(r.status).toBe(403);
  });

  it("rejects a list whose issuedAt is not strictly newer than stored", async () => {
    const s = await setup();
    const list1: EntitlementRevocationList = {
      username: USER,
      certIds: ["aa".repeat(32)],
      issuedAt: Date.now(),
    };
    const sig1 = signEntitlementRevocationList(list1, s.irk);
    const r1 = await handlePostEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      { request: list1, signature: hex(sig1) },
    );
    expect(r1.status).toBe(200);

    // Replay with same issuedAt → 409
    const r2 = await handlePostEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      { request: list1, signature: hex(sig1) },
    );
    expect(r2.status).toBe(409);
  });

  it("rejects malformed certIds", async () => {
    const s = await setup();
    const list = {
      username: USER,
      certIds: ["not-hex"],
      issuedAt: Date.now(),
    } as unknown as EntitlementRevocationList;
    const sig = signEntitlementRevocationList(list, s.irk);
    const r = await handlePostEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      { request: list, signature: hex(sig) },
    );
    expect(r.status).toBe(400);
  });
});

describe("handleGetEntitlementRevocations", () => {
  it("returns the stored list", async () => {
    const s = await setup();
    const list: EntitlementRevocationList = {
      username: USER,
      certIds: ["dd".repeat(32)],
      issuedAt: Date.now(),
    };
    const sig = signEntitlementRevocationList(list, s.irk);
    await handlePostEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      { request: list, signature: hex(sig) },
    );
    const r = await handleGetEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      USER,
    );
    expect(r.status).toBe(200);
    const body = r.body as { certIds: string[]; signature: string };
    expect(body.certIds).toEqual(list.certIds);
    expect(body.signature).toBe(hex(sig));
  });

  it("returns an empty list when nothing has been posted", async () => {
    const s = await setup();
    const r = await handleGetEntitlementRevocations(
      { storage: s.storage, usernames: s.usernames },
      USER,
    );
    expect(r.status).toBe(200);
    const body = r.body as { certIds: string[]; signature: null };
    expect(body.certIds).toEqual([]);
    expect(body.signature).toBeNull();
  });
});
