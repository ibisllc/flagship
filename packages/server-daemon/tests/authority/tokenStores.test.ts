import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityHub, GrantIndex, OperationLedger, TokenFamily, tokenFingerprint } from "../../src/authority/index.js";
import { FilePairedSessionStore } from "../../src/pairedSessionStore.js";
import { InMemoryMcpKeyStore } from "../../src/buildmodes/mcpKeyStore.js";

async function hub() {
  const dir = await mkdtemp(join(tmpdir(), "tokens-"));
  const grants = new GrantIndex(join(dir, "g.json"));
  await grants.load();
  await grants.issue({ id: "root", kind: "owner-session", issuer: "a", subject: "a", accountGeneration: 1, audience: "box", capability: "owner", policyRevision: 1, issuedAt: Date.now() });
  const ledger = new OperationLedger(join(dir, "o.json"), { grantsLive: () => true, currentRevision: () => 0, verifyApproval: () => false });
  return { dir, h: new AuthorityHub(grants, ledger, undefined, 50) };
}

const req = (token: string) => ({ method: "GET", path: "/x", headers: { "x-flagship-session": token }, query: {}, body: new Uint8Array() }) as never;

describe("paired sessions under the authority index", () => {
  it("refuses a token the index revoked, and removes it from the store", async () => {
    const { dir, h } = await hub();
    const store = new FilePairedSessionStore(join(dir, "ps.json"));
    const owner = new TokenFamily(h, "owner-session", "account");
    const companion = new TokenFamily(h, "companion-session", "account");
    await store.add("a".repeat(32));
    await store.attachAuthority({ owner, companion, parentOf: () => ["root"] });
    expect(store.check(req("a".repeat(32)))).toBeNull();
    await h.revoke(owner.grantId(tokenFingerprint("a".repeat(32))), "device removed");
    expect(store.check(req("a".repeat(32)))?.status).toBe(401);
    expect(store.has("a".repeat(32))).toBe(false);
  });

  it("revoking the root ends every session, owner and companion", async () => {
    const { dir, h } = await hub();
    const store = new FilePairedSessionStore(join(dir, "ps.json"));
    await store.attachAuthority({ owner: new TokenFamily(h, "owner-session", "account"), companion: new TokenFamily(h, "companion-session", "account"), parentOf: () => ["root"] });
    await store.add("b".repeat(32));
    await store.addCompanion({ token: "c".repeat(32), addedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    await h.revoke("root", "recovery");
    expect(store.check(req("b".repeat(32)))?.status).toBe(401);
    expect(store.check(req("c".repeat(32)))?.status).toBe(401);
  });

  it("a session minted before the index existed is adopted at attach, not signed out", async () => {
    const { dir, h } = await hub();
    const store = new FilePairedSessionStore(join(dir, "ps.json"));
    await store.add("d".repeat(32));
    await store.attachAuthority({ owner: new TokenFamily(h, "owner-session", "account"), companion: new TokenFamily(h, "companion-session", "account"), parentOf: () => ["root"] });
    expect(store.check(req("d".repeat(32)))).toBeNull();
  });

  it("removing a session revokes its grant and stops work running under it", async () => {
    const { dir, h } = await hub();
    const store = new FilePairedSessionStore(join(dir, "ps.json"));
    const owner = new TokenFamily(h, "owner-session", "account");
    await store.attachAuthority({ owner, companion: new TokenFamily(h, "companion-session", "account"), parentOf: () => ["root"] });
    await store.add("e".repeat(32));
    let stopped = false;
    h.registerWork([owner.grantId(tokenFingerprint("e".repeat(32)))], { label: "stream", cancel: () => void (stopped = true) });
    await store.remove("e".repeat(32));
    expect(stopped).toBe(true);
  });
});

describe("IDE keys under the authority index", () => {
  it("a replaced key stops resolving and a revoked grant removes the key", async () => {
    const { h } = await hub();
    const { FileMcpKeyStore } = await import("../../src/buildmodes/mcpKeyStore.js");
    const dir = await mkdtemp(join(tmpdir(), "mcp-"));
    const store = new FileMcpKeyStore(dir, new Uint8Array(32).fill(1));
    await store.load();
    await store.attachAuthority({ family: new TokenFamily(h, "mcp-key", "account"), parentOf: () => ["root"] });
    const first = await store.mint("build1");
    expect(await store.resolve(first.key)).toBe("build1");
    const second = await store.mint("build1");
    expect(await store.resolve(first.key)).toBeNull();
    expect(await store.resolve(second.key)).toBe("build1");
    await h.revoke("root", "recovery");
    expect(await store.resolve(second.key)).toBeNull();
    expect(await store.get("build1")).toBeNull();
    void InMemoryMcpKeyStore;
  });
});
