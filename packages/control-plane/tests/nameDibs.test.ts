import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  nameDibsChallenge,
  signNameDibsInitiate,
  signNameDibsVerify,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  allocateDibsName,
  dibsWindowState,
  handleNameDibsInitiate,
  handleNameDibsVerify,
  handleNameDibsWindow,
  parseDibsWindow,
  reservedForDotComHolder,
  type DibsFetch,
  type NameDibsDeps,
} from "../src/nameDibs.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const NOW = Date.UTC(2026, 10, 1);
const WINDOW = { start: Date.UTC(2026, 9, 15), end: Date.UTC(2027, 9, 15) };

const alice = deriveIRK({ seed: new Uint8Array(32).fill(1) });
const bob = deriveIRK({ seed: new Uint8Array(32).fill(2) });

/** A scripted internet: which .com names are registered, their TXT records and
 *  well-known files. `failDns` makes every DoH lookup error. */
function net(opts: {
  registered?: string[];
  txt?: Record<string, string[]>;
  files?: Record<string, { status: number; body: string }>;
  failDns?: boolean;
}): { fetch: DibsFetch; requests: Array<{ url: string; redirect?: string }> } {
  const requests: Array<{ url: string; redirect?: string }> = [];
  const fetch: DibsFetch = async (url, init) => {
    requests.push({ url, redirect: init?.redirect });
    const u = new URL(url);
    if (u.hostname === "cloudflare-dns.com") {
      if (opts.failDns) return { ok: false, status: 502, json: async () => ({}), text: async () => "" };
      const name = u.searchParams.get("name")!;
      const type = u.searchParams.get("type");
      if (type === "NS") {
        const reg = (opts.registered ?? []).includes(name);
        return { ok: true, status: 200, text: async () => "", json: async () => (reg ? { Status: 0, Answer: [{ type: 2, data: "ns1.example." }] } : { Status: 3 }) };
      }
      const recs = opts.txt?.[name];
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => (recs ? { Status: 0, Answer: recs.map((d) => ({ type: 16, data: d })) } : { Status: 3 }),
      };
    }
    const f = opts.files?.[url];
    if (!f) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    return { ok: f.status === 200, status: f.status, json: async () => ({}), text: async () => f.body };
  };
  return { fetch, requests };
}

async function setup(fetchOpts: Parameters<typeof net>[0], window = WINDOW) {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: "fresh-poppy", irkPubHex: hex(alice.publicKey), claimedAt: 1 });
  await storage.usernames.put({ username: "rapid-bison", irkPubHex: hex(bob.publicKey), claimedAt: 1 });
  const n = net(fetchOpts);
  let nonceN = 0;
  const deps: NameDibsDeps = {
    usernames: storage.usernames,
    claims: storage.nameDibsClaims,
    window,
    fetch: n.fetch,
    now: () => NOW,
    newNonce: () => (++nonceN).toString(16).padStart(64, "0"),
  };
  return { storage, deps, requests: n.requests };
}

function initiate(username: string, name: string, k: Keypair, issuedAt = NOW) {
  const request = { username, name, irkPubHex: hex(k.publicKey), issuedAt };
  return { request, signature: hex(signNameDibsInitiate(request, k)) };
}
function verify(username: string, name: string, nonce: string, k: Keypair) {
  const request = { username, name, nonce, issuedAt: NOW };
  return { request, signature: hex(signNameDibsVerify(request, k)) };
}
const record = (name: string, k: Keypair, nonce: string) =>
  `flagship-claim:${nameDibsChallenge(name, hex(k.publicKey), nonce)}`;

describe("dibs window", () => {
  it("parses ISO dates, rejects junk and inverted ranges", () => {
    expect(parseDibsWindow("2026-10-15", "2027-10-15")).toEqual({ start: Date.UTC(2026, 9, 15), end: Date.UTC(2027, 9, 15) });
    expect(parseDibsWindow("garbage", "2027-10-15")).toEqual({});
    expect(parseDibsWindow("2027-10-15", "2026-10-15")).toEqual({});
    expect(parseDibsWindow(undefined, undefined)).toEqual({});
  });

  it("is open only between start and end", () => {
    expect(dibsWindowState(WINDOW, NOW).open).toBe(true);
    expect(dibsWindowState(WINDOW, WINDOW.start - 1).open).toBe(false);
    expect(dibsWindowState(WINDOW, WINDOW.end).open).toBe(false);
    expect(dibsWindowState({}, NOW)).toMatchObject({ configured: false, open: false });
  });

  it("the public window endpoint reports scope and price", () => {
    expect(handleNameDibsWindow({ window: WINDOW, now: () => NOW }).body).toMatchObject({
      open: true, scope: ".com", priceUsd: 20,
    });
  });
});

describe("reservedForDotComHolder", () => {
  it("reserves a registered .com only while the window is open", async () => {
    const { fetch } = net({ registered: ["acme.com"] });
    expect(await reservedForDotComHolder({ window: WINDOW, fetch, now: () => NOW }, "acme")).toBe(true);
    expect(await reservedForDotComHolder({ window: WINDOW, fetch, now: () => NOW }, "nobody-owns-this")).toBe(false);
    expect(await reservedForDotComHolder({ window: WINDOW, fetch, now: () => WINDOW.end + 1 }, "acme")).toBe(false);
    expect(await reservedForDotComHolder({ window: {}, fetch, now: () => NOW }, "acme")).toBe(false);
  });

  it("fails closed: a DNS failure counts as reserved", async () => {
    const { fetch } = net({ failDns: true });
    expect(await reservedForDotComHolder({ window: WINDOW, fetch, now: () => NOW }, "acme")).toBe(true);
  });
});

describe("POST /api/name-dibs/initiate", () => {
  it("returns a challenge bound to the claimant's key and a fresh nonce", async () => {
    const { deps } = await setup({ registered: ["acme.com"] });
    const r = await handleNameDibsInitiate(deps, initiate("fresh-poppy", "acme", alice));
    expect(r.status).toBe(200);
    const body = r.body as { nonce: string; challenge: string; record: string; publishAt: { dns: { name: string } } };
    expect(body.challenge).toBe(nameDibsChallenge("acme", hex(alice.publicKey), body.nonce));
    expect(body.record).toBe(`flagship-claim:${body.challenge}`);
    expect(body.publishAt.dns.name).toBe("_flagship-claim.acme.com");
  });

  it("refuses outside the window, an unregistered .com, a taken name and reserved words", async () => {
    const closed = await setup({ registered: ["acme.com"] }, {});
    expect((await handleNameDibsInitiate(closed.deps, initiate("fresh-poppy", "acme", alice))).status).toBe(409);
    const { deps } = await setup({ registered: ["acme.com", "rapid-bison.com", "admin.com"] });
    expect((await handleNameDibsInitiate(deps, initiate("fresh-poppy", "unregistered-name", alice))).status).toBe(409);
    expect((await handleNameDibsInitiate(deps, initiate("fresh-poppy", "rapid-bison", alice))).status).toBe(409);
    expect((await handleNameDibsInitiate(deps, initiate("fresh-poppy", "admin", alice))).status).toBe(400);
  });

  it("refuses a signature by another key and a stale request", async () => {
    const { deps } = await setup({ registered: ["acme.com"] });
    expect((await handleNameDibsInitiate(deps, initiate("fresh-poppy", "acme", bob))).status).toBe(403);
    expect((await handleNameDibsInitiate(deps, initiate("fresh-poppy", "acme", alice, NOW - 10 * 60_000))).status).toBe(403);
  });

  it("answers 503 (not 'not reserved') when the registration lookup fails", async () => {
    const { deps } = await setup({ failDns: true });
    expect((await handleNameDibsInitiate(deps, initiate("fresh-poppy", "acme", alice))).status).toBe(503);
  });

  it("re-initiating a pending claim returns the same nonce, so a published record stays valid", async () => {
    const { deps } = await setup({ registered: ["acme.com"] });
    const a = (await handleNameDibsInitiate(deps, initiate("fresh-poppy", "acme", alice))).body as { nonce: string };
    const b = (await handleNameDibsInitiate(deps, initiate("fresh-poppy", "acme", alice))).body as { nonce: string };
    expect(b.nonce).toBe(a.nonce);
    // …until it expires.
    deps.now = () => NOW + 8 * 24 * 60 * 60_000;
    const c = (await handleNameDibsInitiate(deps, initiate("fresh-poppy", "acme", alice, NOW + 8 * 24 * 60 * 60_000))).body as { nonce: string };
    expect(c.nonce).not.toBe(a.nonce);
  });

  it("rate-limits fresh claim starts per account", async () => {
    const registered = Array.from({ length: 11 }, (_, i) => `brand${i}.com`);
    const { deps } = await setup({ registered });
    for (let i = 0; i < 10; i++) {
      expect((await handleNameDibsInitiate(deps, initiate("fresh-poppy", `brand${i}`, alice))).status).toBe(200);
    }
    expect((await handleNameDibsInitiate(deps, initiate("fresh-poppy", "brand10", alice))).status).toBe(429);
  });
});

describe("POST /api/name-dibs/verify", () => {
  async function started(fetchOpts: Parameters<typeof net>[0]) {
    const s = await setup({ registered: ["acme.com"], ...fetchOpts });
    const r = await handleNameDibsInitiate(s.deps, initiate("fresh-poppy", "acme", alice));
    return { ...s, nonce: (r.body as { nonce: string }).nonce };
  }
  const nonce1 = "1".padStart(64, "0");

  it("accepts the proof as a DNS TXT record (quoted, split segments)", async () => {
    const rec = record("acme", alice, nonce1);
    const half = Math.floor(rec.length / 2);
    const { deps, nonce } = await started({ txt: { "_flagship-claim.acme.com": [`"${rec.slice(0, half)}" "${rec.slice(half)}"`] } });
    const r = await handleNameDibsVerify(deps, verify("fresh-poppy", "acme", nonce, alice));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ verified: true, method: "dns" });
  });

  it("accepts the proof as an HTTPS file and never follows redirects", async () => {
    const { deps, nonce, requests } = await started({
      files: { "https://acme.com/.well-known/flagship-claim": { status: 200, body: `${record("acme", alice, nonce1)}\n` } },
    });
    const r = await handleNameDibsVerify(deps, verify("fresh-poppy", "acme", nonce, alice));
    expect(r.body).toMatchObject({ verified: true, method: "http" });
    expect(requests.find((q) => q.url.startsWith("https://acme.com"))?.redirect).toBe("manual");
  });

  it("ignores a redirect response and a record made for another key", async () => {
    const redirected = await started({
      files: { "https://acme.com/.well-known/flagship-claim": { status: 302, body: record("acme", alice, nonce1) } },
    });
    expect((await handleNameDibsVerify(redirected.deps, verify("fresh-poppy", "acme", redirected.nonce, alice))).status).toBe(409);
    const wrongKey = await started({ txt: { "_flagship-claim.acme.com": [`"${record("acme", bob, nonce1)}"`] } });
    expect((await handleNameDibsVerify(wrongKey.deps, verify("fresh-poppy", "acme", wrongKey.nonce, alice))).status).toBe(409);
  });

  it("the first verified claimant wins", async () => {
    const s = await setup({ registered: ["acme.com"] });
    const a = await handleNameDibsInitiate(s.deps, initiate("fresh-poppy", "acme", alice));
    const b = await handleNameDibsInitiate(s.deps, initiate("rapid-bison", "acme", bob));
    const na = (a.body as { nonce: string }).nonce;
    const nb = (b.body as { nonce: string }).nonce;
    // Both publish valid proofs (e.g. the domain changed hands mid-window).
    s.deps.fetch = net({
      registered: ["acme.com"],
      txt: { "_flagship-claim.acme.com": [`"${record("acme", alice, na)}"`, `"${record("acme", bob, nb)}"`] },
    }).fetch;
    expect((await handleNameDibsVerify(s.deps, verify("fresh-poppy", "acme", na, alice))).status).toBe(200);
    expect((await handleNameDibsVerify(s.deps, verify("rapid-bison", "acme", nb, bob))).status).toBe(409);
    // …and a later initiate by the loser is refused outright.
    expect((await handleNameDibsInitiate(s.deps, initiate("rapid-bison", "acme", bob))).status).toBe(409);
  });

  it("refuses an unknown nonce and an expired claim", async () => {
    const { deps, nonce } = await started({});
    expect((await handleNameDibsVerify(deps, verify("fresh-poppy", "acme", "f".repeat(64), alice))).status).toBe(404);
    deps.now = () => NOW + 8 * 24 * 60 * 60_000;
    const late = { request: { username: "fresh-poppy", name: "acme", nonce, issuedAt: NOW + 8 * 24 * 60 * 60_000 }, signature: "" };
    late.signature = hex(signNameDibsVerify(late.request, alice));
    expect((await handleNameDibsVerify(deps, late)).status).toBe(409);
  });
});

describe("allocateDibsName", () => {
  async function verified() {
    const s = await setup({ registered: ["acme.com"] });
    const r = await handleNameDibsInitiate(s.deps, initiate("fresh-poppy", "acme", alice));
    const nonce = (r.body as { nonce: string }).nonce;
    s.deps.fetch = net({ registered: ["acme.com"], txt: { "_flagship-claim.acme.com": [`"${record("acme", alice, nonce)}"`] } }).fetch;
    await handleNameDibsVerify(s.deps, verify("fresh-poppy", "acme", nonce, alice));
    return s;
  }

  it("needs an entitlement, renames, then the claim can't be reused", async () => {
    const { storage } = await verified();
    let entitlements = 1;
    const renames: string[] = [];
    const deps = {
      usernames: storage.usernames,
      claims: storage.nameDibsClaims,
      now: () => NOW,
      consumeEntitlement: async () => (entitlements > 0 ? (entitlements--, true) : false),
      rename: async (a: { oldUsername: string; newUsername: string }) => {
        renames.push(`${a.oldUsername}->${a.newUsername}`);
        return { ok: true as const };
      },
    };
    expect(await allocateDibsName(deps, { username: "fresh-poppy", name: "acme" })).toEqual({ ok: true, newUsername: "acme" });
    expect(renames).toEqual(["fresh-poppy->acme"]);
    expect((await allocateDibsName(deps, { username: "fresh-poppy", name: "acme" })).ok).toBe(false);
    expect(renames).toHaveLength(1);
  });

  it("without an entitlement nothing is renamed", async () => {
    const { storage } = await verified();
    let renamed = false;
    const r = await allocateDibsName(
      {
        usernames: storage.usernames,
        claims: storage.nameDibsClaims,
        consumeEntitlement: async () => false,
        rename: async () => ((renamed = true), { ok: true as const }),
      },
      { username: "fresh-poppy", name: "acme" },
    );
    expect(r).toMatchObject({ ok: false, status: 402 });
    expect(renamed).toBe(false);
  });

  it("restores the entitlement when the rename fails, and the claim stays usable", async () => {
    const { storage } = await verified();
    let entitlements = 1;
    let fail = true;
    const deps = {
      usernames: storage.usernames,
      claims: storage.nameDibsClaims,
      consumeEntitlement: async () => (entitlements > 0 ? (entitlements--, true) : false),
      restoreEntitlement: async () => {
        entitlements++;
      },
      rename: async () => (fail ? { ok: false as const, reason: "boom" } : { ok: true as const }),
    };
    expect(await allocateDibsName(deps, { username: "fresh-poppy", name: "acme" })).toMatchObject({ ok: false, status: 409 });
    expect(entitlements).toBe(1);
    fail = false;
    expect((await allocateDibsName(deps, { username: "fresh-poppy", name: "acme" })).ok).toBe(true);
  });

  it("refuses a claimant who isn't the verified winner", async () => {
    const { storage } = await verified();
    const r = await allocateDibsName(
      {
        usernames: storage.usernames,
        claims: storage.nameDibsClaims,
        consumeEntitlement: async () => true,
        rename: async () => ({ ok: true as const }),
      },
      { username: "rapid-bison", name: "acme" },
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
});
