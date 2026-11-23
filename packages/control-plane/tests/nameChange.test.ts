import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENTS_CONFIG,
  finalizeVoucher,
  newVoucherRequest,
  voucherNullifier,
  type Voucher,
  deriveIRK,
  nameDibsChallenge,
  signNameChange,
  signNameDibsInitiate,
  signNameDibsVerify,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryBlindVoucherStorage, InMemoryStorage, InMemoryVoucherStorage } from "@flagship/storage";
import { handleVoucherIssue, voucherSigningKeysFromEnv } from "../src/blindVouchers.js";
import { handleNameChange, handleNameChangeQuote, SIGNUP_RENAME_WINDOW_MS, type NameChangeDeps } from "../src/nameChange.js";
import { resolveVoiciPath } from "../src/voici.js";
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

const here = dirname(fileURLToPath(import.meta.url));
const keyFile = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8"));
const blindKeys = voucherSigningKeysFromEnv(JSON.stringify([{ jwk: keyFile.jwk }]));
const blindKey = blindKeys[0]!.pub;

/** `n` blind $1 vouchers, issued and unblinded as an app does after a purchase. */
function mintBlind(n: number): Voucher[] {
  const reqs = Array.from({ length: n }, () => newVoucherRequest(blindKey));
  const r = handleVoucherIssue({ keys: blindKeys, config: DEFAULT_PAYMENTS_CONFIG }, { k: blindKey.keyId, blinded: reqs.map((q) => q.blinded) });
  const sigs = (r.body as { sigs: string[] }).sigs;
  return reqs.map((q, i) => finalizeVoucher(blindKey, q.pending, sigs[i]!));
}

async function setup(opts: { window?: typeof WINDOW | object; registered?: string[]; adminRootPinned?: boolean; claimedAt?: number } = {}) {
  const storage = new InMemoryStorage();
  const vouchers = new InMemoryVoucherStorage();
  const blindStore = new InMemoryBlindVoucherStorage();
  await storage.usernames.put({
    username: "fresh-poppy",
    irkPubHex: hex(irk.publicKey),
    claimedAt: opts.claimedAt ?? 1,
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
    names: storage.names,
    blind: { keys: blindKeys, config: DEFAULT_PAYMENTS_CONFIG, store: blindStore },
    auditEvents: storage.auditEvents,
    window: opts.window ?? WINDOW,
    fetch: dns(opts.registered ?? []),
    now: () => NOW,
  };
  const voucher = async (kind: "name-change" | "dibs-claim") => (await issueVoucher({ vouchers, now: () => NOW }, { kind })).code;
  return { storage, vouchers, blindStore, deps, voucher };
}

function rename(newUsername: string, voucherCode: string, signer: Keypair = irk, over: Partial<{ aidPubHex: string; oldUsername: string; issuedAt: number }> = {}) {
  const request = { aidPubHex: AID, oldUsername: "fresh-poppy", newUsername, issuedAt: NOW, ...over };
  return { request, signature: hex(signNameChange(request, signer)), voucherCode };
}

function renameWithVouchers(newUsername: string, vouchers: Voucher[], over: Partial<{ oldUsername: string }> = {}) {
  const request = { aidPubHex: AID, oldUsername: "fresh-poppy", newUsername, issuedAt: NOW, ...over };
  return { request, signature: hex(signNameChange(request, irk)), vouchers };
}

const page = { removedAt: null, takenDownAt: null, indexJson: "{}" };
function voici(storage: InMemoryStorage, pagesOf: string[] = []) {
  return (path: string) =>
    resolveVoiciPath({ names: storage.names, pages: { getPage: async (u: string) => (pagesOf.includes(u) ? (page as never) : undefined) }, now: () => NOW }, path);
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

describe("the names registry moves with the rename", () => {
  it("claims the new name (voi.ci/<new> serves its page) and holds the old one, redirecting, for 30 days", async () => {
    const { storage, deps, voucher } = await setup();
    const r = await handleNameChange(deps, rename("acme-tools", await voucher("name-change")));
    expect(r.body).toMatchObject({ ok: true, oldNameReleased: false });
    expect(await storage.names.activeUsername("acme-tools")).toMatchObject({ name: "acme-tools", status: "active" });
    const resolve = voici(storage, ["acme-tools"]);
    expect(await resolve("/acme-tools")).toMatchObject({ kind: "page", username: "acme-tools" });
    expect(await resolve("/fresh-poppy")).toEqual({ kind: "redirect", location: "https://voi.ci/acme-tools" });
    expect(await storage.names.isTaken("fresh-poppy")).toBe(true);
  });

  it("a first rename within the sign-up window releases the suggested name at once (no redirect)", async () => {
    const { storage, deps, voucher } = await setup({ claimedAt: NOW - 5 * 60_000 });
    const r = await handleNameChange(deps, rename("acme-tools", await voucher("name-change")));
    expect(r.body).toMatchObject({ ok: true, oldNameReleased: true });
    expect(await voici(storage)("/fresh-poppy")).toEqual({ kind: "not-found" });
    expect(await storage.names.isTaken("fresh-poppy")).toBe(false);
    // …and anyone may claim it again.
    expect(await storage.usernames.put({ username: "fresh-poppy", irkPubHex: hex(other.publicKey), claimedAt: NOW })).toMatchObject({ ok: true });
  });

  it("past the sign-up window the old name is held", async () => {
    const { storage, deps, voucher } = await setup({ claimedAt: NOW - SIGNUP_RENAME_WINDOW_MS - 1 });
    expect((await handleNameChange(deps, rename("acme-tools", await voucher("name-change")))).body).toMatchObject({ oldNameReleased: false });
    expect(await storage.names.isTaken("fresh-poppy")).toBe(true);
  });

  it("refuses a look-alike of a live name with code `taken`, keeping the payment", async () => {
    const { storage, deps, voucher } = await setup();
    await storage.usernames.put({ username: "rapid-bison", irkPubHex: hex(other.publicKey), claimedAt: 1 });
    const code = await voucher("name-change");
    const r = await handleNameChange(deps, rename("rapidbis0n", code));
    expect(r).toMatchObject({ status: 409, body: { code: "taken" } });
    expect((await handleNameChange(deps, rename("acme-tools", code))).status).toBe(200);
  });

  it("the suggester no longer offers the new name or its look-alikes", async () => {
    const { storage, deps, voucher } = await setup();
    await handleNameChange(deps, rename("acme-tools", await voucher("name-change")));
    // randomUsername.ts drops a candidate the registry calls taken.
    expect(await storage.names.isTaken("acme-tools")).toBe(true);
    expect(await storage.names.isTaken("acmet00ls")).toBe(true);
  });

  it("a sign-up rename may take a look-alike of the suggested name itself", async () => {
    const { deps, voucher } = await setup({ claimedAt: NOW - 60_000 });
    expect((await handleNameChange(deps, rename("freshpoppy", await voucher("name-change")))).status).toBe(200);
  });
});

describe("paying with blind $1 vouchers", () => {
  it("10 vouchers pay a name change; they are spent once", async () => {
    const { storage, deps, blindStore } = await setup();
    const v = mintBlind(10);
    const r = await handleNameChange(deps, renameWithVouchers("acme-tools", v));
    expect(r.status).toBe(200);
    expect(await storage.usernames.get("acme-tools")).toBeDefined();
    expect(await blindStore.spend([{ nullifier: voucherNullifier(v[0]!), keyId: v[0]!.k }], "2026-11-01")).toEqual([false]);
  });

  it("refuses the wrong count, a bad voucher and a spent one, spending nothing", async () => {
    const { storage, deps, blindStore } = await setup();
    expect(await handleNameChange(deps, renameWithVouchers("acme-tools", mintBlind(9)))).toMatchObject({ status: 400, body: { code: "wrong-amount", units: 10 } });
    const forged = mintBlind(10);
    forged[3] = { ...forged[3]!, s: forged[4]!.s };
    expect(await handleNameChange(deps, renameWithVouchers("acme-tools", forged))).toMatchObject({ status: 400, body: { code: "bad-voucher" } });
    const v = mintBlind(10);
    await blindStore.spend([{ nullifier: voucherNullifier(v[9]!), keyId: v[9]!.k }], "2026-11-01");
    const r = await handleNameChange(deps, renameWithVouchers("acme-tools", v));
    expect(r).toMatchObject({ status: 409, body: { code: "voucher-spent", spent: [voucherNullifier(v[9]!)] } });
    // The other nine were put back.
    expect(await blindStore.spend([{ nullifier: voucherNullifier(v[0]!), keyId: v[0]!.k }], "2026-11-01")).toEqual([true]);
    expect(await storage.usernames.get("fresh-poppy")).toBeDefined();
  });

  it("a failed rename puts the vouchers back", async () => {
    const { deps } = await setup();
    const v = mintBlind(10);
    const failing: NameChangeDeps = {
      ...deps,
      nameChanges: { ...deps.nameChanges, renameAccount: async () => ({ ok: false, reason: "name already taken" }), countSince: async () => 0, history: async () => [] },
    };
    expect(await handleNameChange(failing, renameWithVouchers("acme-tools", v))).toMatchObject({ status: 409, body: { code: "taken" } });
    expect((await handleNameChange(deps, renameWithVouchers("acme-tools", v))).status).toBe(200);
  });

  it("the quote names the voucher count, and two payments at once are refused", async () => {
    const { deps, voucher } = await setup();
    expect((await handleNameChangeQuote(deps, { username: "fresh-poppy", newUsername: "acme-tools" })).body).toMatchObject({ priceUsd: 10, units: 10 });
    const both = { ...renameWithVouchers("acme-tools", mintBlind(10)), voucherCode: await voucher("name-change") };
    expect((await handleNameChange(deps, both)).status).toBe(400);
  });
});

describe("POST /api/account/name-change/quote", () => {
  it("prices an open name, explains a held one, and refuses a taken one", async () => {
    const { storage, deps } = await setup({ registered: ["acme.com"] });
    await storage.usernames.put({ username: "rapid-bison", irkPubHex: hex(other.publicKey), claimedAt: 1 });
    expect((await handleNameChangeQuote(deps, { username: "fresh-poppy", newUsername: "acme-tools" })).body).toEqual({ available: true, kind: "name-change", priceUsd: 10, units: 10 });
    expect((await handleNameChangeQuote(deps, { username: "fresh-poppy", newUsername: "acme" })).body).toMatchObject({ available: false, code: "dibs-held", heldUntil: WINDOW.end });
    expect((await handleNameChangeQuote(deps, { username: "fresh-poppy", newUsername: "rapid-bison" })).body).toMatchObject({ available: false, reason: "that name is taken" });
  });
});
