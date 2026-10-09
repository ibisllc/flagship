import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  nameDibsChallenge,
  signNameChange,
  signNameDibsInitiate,
  signNameDibsVerify,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage, InMemoryVoucherStorage } from "@flagship/storage";
import { handleNameChange, handleNameChangeQuote, type NameChangeDeps } from "../src/nameChange.js";
import { handleNameDibsInitiate, handleNameDibsVerify, type DibsFetch } from "../src/nameDibs.js";
import { issueVoucher } from "../src/voucher.js";

// One test per §5 ship-blocker (docs/naming-recovery-and-name-change.md) plus
// the refund-on-failure path, the dibs routes and the quote.

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const NOW = Date.UTC(2026, 10, 1);
const WINDOW = { start: Date.UTC(2026, 9, 15), end: Date.UTC(2027, 9, 15) };
const irk = deriveIRK({ seed: new Uint8Array(32).fill(1) });
const other = deriveIRK({ seed: new Uint8Array(32).fill(2) });
const adminRoot = deriveIRK({ seed: new Uint8Array(32).fill(3) });
const AID = "ad".repeat(32);

function dns(registered: string[], txt: Record<string, string[]> = {}): DibsFetch {
  return async (url) => {
    const u = new URL(url);
    const name = u.searchParams.get("name") ?? "";
    if (u.searchParams.get("type") === "NS") {
      const reg = registered.includes(name);
      return { ok: true, status: 200, text: async () => "", json: async () => (reg ? { Status: 0, Answer: [{ data: "ns." }] } : { Status: 3 }) };
    }
    const recs = txt[name];
    return { ok: true, status: 200, text: async () => "", json: async () => (recs ? { Status: 0, Answer: recs.map((d) => ({ data: d })) } : { Status: 3 }) };
  };
}

async function setup(opts: { window?: typeof WINDOW | object; registered?: string[]; adminRootPinned?: boolean } = {}) {
  const storage = new InMemoryStorage();
  const vouchers = new InMemoryVoucherStorage();
  await storage.usernames.put({
    username: "fresh-poppy",
    irkPubHex: hex(irk.publicKey),
    claimedAt: 1,
    aidPubHex: AID,
    ...(opts.adminRootPinned ? { adminRootPubHex: hex(adminRoot.publicKey) } : {}),
  });
  const deps: NameChangeDeps = {
    usernames: storage.usernames,
    nameChanges: storage.nameChanges,
    vouchers,
    claims: storage.nameDibsClaims,
    servers: storage.servers,
    offers: storage.usernameOffers,
    aliases: storage.usernameAliases,
    auditEvents: storage.auditEvents,
    window: opts.window ?? WINDOW,
    fetch: dns(opts.registered ?? []),
    now: () => NOW,
  };
  const voucher = async (kind: "name-change" | "dibs-claim") => (await issueVoucher({ vouchers, now: () => NOW }, { kind })).code;
  return { storage, vouchers, deps, voucher };
}

function rename(newUsername: string, voucherCode: string, signer: Keypair = irk, over: Partial<{ aidPubHex: string; oldUsername: string; issuedAt: number }> = {}) {
  const request = { aidPubHex: AID, oldUsername: "fresh-poppy", newUsername, issuedAt: NOW, ...over };
  return { request, signature: hex(signNameChange(request, signer)), voucherCode };
}

describe("POST /api/account/name-change", () => {
  it("renames with a name-change voucher, carrying the account's identity", async () => {
    const { storage, deps, voucher } = await setup();
    const r = await handleNameChange(deps, rename("acme-tools", await voucher("name-change")));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, oldUsername: "fresh-poppy", newUsername: "acme-tools", kind: "name-change", previousUsernames: ["fresh-poppy"] });
    expect(await storage.usernames.get("fresh-poppy")).toBeUndefined();
    expect(await storage.usernames.get("acme-tools")).toMatchObject({ irkPubHex: hex(irk.publicKey), aidPubHex: AID });
    const events = await storage.auditEvents.list("acme-tools", 0, 10);
    expect(events.map((e) => e.eventKind)).toContain("account-renamed");
  });

  it("(1) needs an unused voucher of the right kind; a refusal changes nothing", async () => {
    const { storage, deps, voucher } = await setup();
    expect((await handleNameChange(deps, rename("acme-tools", "FLAG-NOPE-NOPE-NOPE-NOPE"))).status).toBe(402);
    const dibs = await voucher("dibs-claim");
    expect((await handleNameChange(deps, rename("acme-tools", dibs))).status).toBe(402);
    expect(await storage.usernames.get("fresh-poppy")).toBeDefined();
  });

  it("(1) two racing requests with one voucher yield exactly one rename", async () => {
    const { deps, voucher } = await setup();
    const code = await voucher("name-change");
    const [a, b] = await Promise.all([
      handleNameChange(deps, rename("acme-tools", code)),
      handleNameChange(deps, rename("acme-works", code)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
  });

  it("(1) a failed rename puts the voucher back", async () => {
    const { deps, voucher, vouchers } = await setup();
    const code = await voucher("name-change");
    const failing: NameChangeDeps = {
      ...deps,
      nameChanges: { ...deps.nameChanges, renameAccount: async () => ({ ok: false, reason: "name already taken" }), countSince: async () => 0, history: async () => [] },
    };
    expect((await handleNameChange(failing, rename("acme-tools", code))).status).toBe(409);
    // The same code still pays for a later rename.
    expect((await handleNameChange(deps, rename("acme-tools", code))).status).toBe(200);
    expect(vouchers).toBeDefined();
  });

  it("(2) applies the grammar and the reserved list", async () => {
    const { deps, voucher } = await setup();
    expect((await handleNameChange(deps, rename("admin", await voucher("name-change")))).status).toBe(400);
    expect((await handleNameChange(deps, rename("e2e", await voucher("name-change")))).status).toBe(400);
    expect((await handleNameChange(deps, rename("Bad--Name", await voucher("name-change")))).status).toBe(400);
  });

  it("(2) refuses a taken name without consuming the voucher", async () => {
    const { storage, deps, voucher } = await setup();
    await storage.usernames.put({ username: "rapid-bison", irkPubHex: hex(other.publicKey), claimedAt: 1 });
    const code = await voucher("name-change");
    expect((await handleNameChange(deps, rename("rapid-bison", code))).status).toBe(409);
    expect((await handleNameChange(deps, rename("acme-tools", code))).status).toBe(200);
  });

  it("(3) refuses a name currently offered to someone signing up", async () => {
    const { storage, deps, voucher } = await setup();
    await storage.usernameOffers.record("happy-otter-4821", "device-1", NOW - 60_000);
    expect((await handleNameChange(deps, rename("happy-otter-4821", await voucher("name-change")))).status).toBe(409);
  });

  it("(4) during the window a registered .com's name is held for its proven holder", async () => {
    const { deps, voucher } = await setup({ registered: ["acme.com"] });
    const r = await handleNameChange(deps, rename("acme", await voucher("name-change")));
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/held for whoever controls acme\.com/);
  });

  it("(4) the proven holder pays with a dibs voucher (a name-change voucher isn't enough)", async () => {
    const { storage, deps, voucher } = await setup({ registered: ["acme.com"] });
    const dibsDeps = { usernames: storage.usernames, claims: storage.nameDibsClaims, window: WINDOW, fetch: deps.fetch, now: () => NOW, newNonce: () => "0".repeat(63) + "1" };
    const initReq = { username: "fresh-poppy", name: "acme", irkPubHex: hex(irk.publicKey), issuedAt: NOW };
    await handleNameDibsInitiate(dibsDeps, { request: initReq, signature: hex(signNameDibsInitiate(initReq, irk)) });
    const record = `flagship-claim:${nameDibsChallenge("acme", hex(irk.publicKey), "0".repeat(63) + "1")}`;
    dibsDeps.fetch = dns(["acme.com"], { "_flagship-claim.acme.com": [`"${record}"`] });
    const verReq = { username: "fresh-poppy", name: "acme", nonce: "0".repeat(63) + "1", issuedAt: NOW };
    expect((await handleNameDibsVerify(dibsDeps, { request: verReq, signature: hex(signNameDibsVerify(verReq, irk)) })).status).toBe(200);

    expect((await handleNameChange(deps, rename("acme", await voucher("name-change")))).status).toBe(402);
    const r = await handleNameChange(deps, rename("acme", await voucher("dibs-claim")));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "dibs-claim", newUsername: "acme" });
  });

  it("(4) after the window a registered .com's name is open to anyone at the normal price", async () => {
    const { deps, voucher } = await setup({ registered: ["acme.com"], window: {} });
    expect((await handleNameChange(deps, rename("acme", await voucher("name-change")))).status).toBe(200);
  });

  it("(5) one rename per account per 30 days", async () => {
    const { deps, voucher } = await setup();
    expect((await handleNameChange(deps, rename("acme-tools", await voucher("name-change")))).status).toBe(200);
    const again = rename("acme-works", await voucher("name-change"), irk, { oldUsername: "acme-tools" });
    expect((await handleNameChange(deps, again)).status).toBe(429);
  });

  it("refuses a signature by another key, a stale request and a foreign AID", async () => {
    const { deps, voucher } = await setup();
    expect((await handleNameChange(deps, rename("acme-tools", await voucher("name-change"), other))).status).toBe(403);
    expect((await handleNameChange(deps, rename("acme-tools", await voucher("name-change"), irk, { issuedAt: NOW - 10 * 60_000 }))).status).toBe(403);
    expect((await handleNameChange(deps, rename("acme-tools", await voucher("name-change"), irk, { aidPubHex: "be".repeat(32) }))).status).toBe(403);
  });

  it("with an admin root pinned, only the admin authority may rename", async () => {
    const { deps, voucher } = await setup({ adminRootPinned: true });
    expect((await handleNameChange(deps, rename("acme-tools", await voucher("name-change"), irk))).status).toBe(403);
    expect((await handleNameChange(deps, rename("acme-tools", await voucher("name-change"), adminRoot))).status).toBe(200);
  });

  it("refuses an account with a live server (box re-home isn't built yet) and a demo account", async () => {
    const { storage, deps, voucher } = await setup();
    await storage.servers.put({ serverDomain: "home.fresh-poppy.flagship.services", username: "fresh-poppy", identityPubKeyHex: "aa".repeat(32), registeredAt: 1 });
    expect((await handleNameChange(deps, rename("acme-tools", await voucher("name-change")))).status).toBe(409);

    const demo = await setup();
    await demo.storage.usernames.setDemo("fresh-poppy", true);
    expect((await handleNameChange(demo.deps, rename("acme-tools", await demo.voucher("name-change")))).status).toBe(403);
  });
});

describe("POST /api/account/name-change/quote", () => {
  it("prices an open name, explains a held one, and refuses a taken one", async () => {
    const { storage, deps } = await setup({ registered: ["acme.com"] });
    await storage.usernames.put({ username: "rapid-bison", irkPubHex: hex(other.publicKey), claimedAt: 1 });
    expect((await handleNameChangeQuote(deps, { username: "fresh-poppy", newUsername: "acme-tools" })).body).toEqual({ available: true, kind: "name-change", priceUsd: 10 });
    expect((await handleNameChangeQuote(deps, { username: "fresh-poppy", newUsername: "acme" })).body).toMatchObject({ available: false });
    expect((await handleNameChangeQuote(deps, { username: "fresh-poppy", newUsername: "rapid-bison" })).body).toMatchObject({ available: false, reason: "that name is taken" });
  });
});
