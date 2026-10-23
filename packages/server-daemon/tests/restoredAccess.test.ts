import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signRestoredAccessApprove, type RestoredAccessApproval } from "@flagship/protocol";
import { ServiceAccessStore, buildServiceAccessHttp } from "../src/serviceAccess.js";
import { RestoredAccessDrafts, draftDigest } from "../src/restoredAccessDrafts.js";
import type { HttpRequest } from "../src/runtime.js";

const FQDN = "home.alice.flagship.services";
const NOW = 1_700_000_000_000;
const SERVICE = "alice--notes";
const adminPriv = new Uint8Array(32).fill(21);
const admin = { privateKey: adminPriv, publicKey: ed.getPublicKey(adminPriv) };
const ownerPriv = new Uint8Array(32).fill(22);
const owner = { privateKey: ownerPriv, publicKey: ed.getPublicKey(ownerPriv) };
const friend = "ab".repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "restored-"));
  const store = new ServiceAccessStore(join(dir, "service-access.json"));
  await store.load();
  const drafts = new RestoredAccessDrafts(join(dir, "restored.json"), () => NOW);
  await drafts.load();
  const access = buildServiceAccessHttp({
    serverId: FQDN, ownerIrkPub: owner.publicKey, adminRootPub: admin.publicKey, store, serviceInstalled: (r) => r === SERVICE,
    controlPlaneBaseUrl: "https://flagshipserver.com", username: "alice", drafts, now: () => NOW,
  } as never);
  const entry = { mode: "restricted" as const, allow: [friend], groups: { inv1: [friend] } };
  // What a restore does: hold the draft, leave the app members-only with nobody on the list.
  const info = await drafts.put(SERVICE, entry);
  await store.importEntry(SERVICE, { mode: "restricted", allow: [], groups: {} });
  return { dir, store, drafts, access, entry, info };
}

const post = (body: unknown): HttpRequest => ({ method: "POST", path: "/api/service-access/restored", headers: {}, body: Buffer.from(JSON.stringify(body)) });
const signed = (o: RestoredAccessApproval, key = admin) => ({ request: o, signature: hex(signRestoredAccessApprove(o, key)) });

describe("restored permissions wait for an admin", () => {
  it("until approved the restored people are not let in", async () => {
    const { store } = await rig();
    expect(store.isAllowed(SERVICE, friend)).toBe(false);
    expect(store.mode(SERVICE)).toBe("restricted");
  });

  it("an admin's signature over the exact draft applies it, once", async () => {
    const { store, drafts, access, info } = await rig();
    const r = await access.handle(post(signed({ serviceRef: SERVICE, draftSha256: info.sha256, issuedAt: NOW })));
    expect(r?.status).toBe(200);
    expect(store.isAllowed(SERVICE, friend)).toBe(true);
    expect(drafts.get(SERVICE)).toBeNull();
    const again = await access.handle(post(signed({ serviceRef: SERVICE, draftSha256: info.sha256, issuedAt: NOW })));
    expect(again?.status).toBe(404);
  });

  it("the owner's account key alone is not enough on a box with an admin root", async () => {
    const { store, access, info } = await rig();
    const r = await access.handle(post(signed({ serviceRef: SERVICE, draftSha256: info.sha256, issuedAt: NOW }, owner)));
    expect(r?.status).toBe(403);
    expect(store.isAllowed(SERVICE, friend)).toBe(false);
  });

  it("a signature for another draft, or an old one, does not approve a replaced draft", async () => {
    const { store, drafts, access, info } = await rig();
    const stale = signed({ serviceRef: SERVICE, draftSha256: info.sha256, issuedAt: NOW });
    await drafts.put(SERVICE, { mode: "open", allow: [friend, "cd".repeat(32)], groups: {} });
    const r = await access.handle(post(stale));
    expect(r?.status).toBe(409);
    expect(store.isAllowed(SERVICE, friend)).toBe(false);
    const wrongApp = await access.handle(post(signed({ serviceRef: "alice--other", draftSha256: info.sha256, issuedAt: NOW })));
    expect(wrongApp?.status).toBe(404);
  });

  it("a stale order is refused", async () => {
    const { access, info } = await rig();
    const r = await access.handle(post(signed({ serviceRef: SERVICE, draftSha256: info.sha256, issuedAt: NOW - 3_600_000 })));
    expect(r?.status).toBe(403);
  });
});

describe("RestoredAccessDrafts", () => {
  it("survives a reload, and the digest does not depend on list order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restored-"));
    const a = new RestoredAccessDrafts(join(dir, "r.json"), () => NOW);
    await a.load();
    await a.put(SERVICE, { mode: "restricted", allow: ["b".repeat(64), "a".repeat(64)], groups: {} });
    const b = new RestoredAccessDrafts(join(dir, "r.json"), () => NOW);
    await b.load();
    expect(b.list()).toEqual([{ serviceRef: SERVICE, sha256: draftDigest(SERVICE, { mode: "restricted", allow: ["a".repeat(64), "b".repeat(64)], groups: {} }), people: 2, mode: "restricted", restoredAt: NOW }]);
    expect(await b.remove(SERVICE)).toBe(true);
    expect(await b.remove(SERVICE)).toBe(false);
  });
});
