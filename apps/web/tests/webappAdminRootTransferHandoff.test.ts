// Slice D §9.8 — transfer-a-box ADMIN AUTHORITY hand-off (webapp giver side).
//
// Exercises the shipped lib/adminRootTransfer.js (dependency-injected, DOM-free):
//   1. the flagship/admin-root-transfer/v1 canonical is the EXACT fixed wire
//      bytes (the backend twin is built to the same contract in parallel);
//   2. runGiverAdminHandoff signs with the GIVER's admin root + POSTs the
//      admin-handoff deposit with the claim's values ("" acquirer root ⇒ ""
//      newAdminRootPub = unpin);
//   3. no admin root in session ⇒ silent skip, no deposit;
//   4. a failed deposit is a retryable warning, never a transfer failure
//      (ownership already moved) — mirrored by the claim-watch retry loop.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed } from "@flagship/protocol";

function loadWebapp(rel: string) {
  const path = resolve(__dirname, "..", "public", "webapp", rel);
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}
const loadHandoff = () => loadWebapp("lib/adminRootTransfer.js");
const loadKeystore = () => loadWebapp("keystore.js");

const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const HOST = "home.alice.flagship.services";
const NONCE = "ab".repeat(32);

// The giver's admin-root seed IS a raw Ed25519 seed (webapp keystore model).
const giverSeed = new Uint8Array(32).fill(0x11);
const giverRootPub = toHex(ed.getPublicKey(giverSeed));
const acquirerRootPub = toHex(ed.getPublicKey(new Uint8Array(32).fill(0x22)));

/** The FIXED hand-off canonical, built independently of the lib. */
function handoffCanonical(t: {
  serverDomain: string;
  giverUsername: string;
  acquirerUsername: string;
  oldAdminRootPub: string;
  newAdminRootPub: string;
  transferNonce: string;
  issuedAt: number;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      "flagship/admin-root-transfer/v1",
      t.serverDomain.toLowerCase(),
      t.giverUsername.toLowerCase(),
      t.acquirerUsername.toLowerCase(),
      t.oldAdminRootPub.toLowerCase(),
      t.newAdminRootPub.toLowerCase(),
      t.transferNonce.toLowerCase(),
      t.issuedAt,
    ].join("|"),
  );
}

async function handoffDeps(k: any, overrides: Record<string, unknown> = {}) {
  const posted: Array<{ url: string; body: any }> = [];
  const deps = {
    adminRootPubHex: k.adminRootPubHex,
    signWithAdminRoot: k.signWithAdminRoot,
    bytesToHex: k.bytesToHex,
    now: () => 1735689600000,
    origin: "https://x",
    fetch: vi.fn(async (url: string, init: any) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({}) };
    }),
    ...overrides,
  };
  return { deps, posted };
}

function handoffArgs(overrides: Record<string, unknown> = {}) {
  return {
    serverDomain: HOST,
    giverUsername: "alice",
    acquirerUsername: "bob",
    acquirerAdminRootPub: acquirerRootPub,
    transferNonce: NONCE,
    adminRootSeed: giverSeed,
    ...overrides,
  };
}

describe("§9.8 — admin-root transfer canonical bytes", () => {
  it("is the EXACT fixed wire bytes, all string fields lowercased", async () => {
    const lib = await loadHandoff();
    expect(lib.TAG_ADMIN_ROOT_TRANSFER).toBe("flagship/admin-root-transfer/v1");
    const bytes = lib.adminRootTransferCanonicalBytes({
      serverDomain: HOST.toUpperCase(),
      giverUsername: "Alice",
      acquirerUsername: "BOB",
      oldAdminRootPub: giverRootPub.toUpperCase(),
      newAdminRootPub: acquirerRootPub.toUpperCase(),
      transferNonce: NONCE.toUpperCase(),
      issuedAt: 1735689600000,
    });
    expect(new TextDecoder().decode(bytes)).toBe(
      `flagship/admin-root-transfer/v1|${HOST}|alice|bob|${giverRootPub}|${acquirerRootPub}|${NONCE}|1735689600000`,
    );
  });

  it('newAdminRootPub "" ⇒ EMPTY field (unpin), not omitted', async () => {
    const lib = await loadHandoff();
    const bytes = lib.adminRootTransferCanonicalBytes({
      serverDomain: HOST,
      giverUsername: "alice",
      acquirerUsername: "bob",
      oldAdminRootPub: giverRootPub,
      newAdminRootPub: "",
      transferNonce: NONCE,
      issuedAt: 7,
    });
    expect(new TextDecoder().decode(bytes)).toBe(
      `flagship/admin-root-transfer/v1|${HOST}|alice|bob|${giverRootPub}||${NONCE}|7`,
    );
  });

  it("rejects a '|' in a string field (canonical guard) + a malformed pub", async () => {
    const lib = await loadHandoff();
    const base = {
      serverDomain: HOST,
      giverUsername: "alice",
      acquirerUsername: "bob",
      oldAdminRootPub: giverRootPub,
      newAdminRootPub: "",
      transferNonce: NONCE,
      issuedAt: 7,
    };
    expect(() => lib.adminRootTransferCanonicalBytes({ ...base, giverUsername: "al|ice" }))
      .toThrow(/separator/);
    expect(() => lib.adminRootTransferCanonicalBytes({ ...base, serverDomain: "a|b" }))
      .toThrow(/separator/);
    expect(() => lib.adminRootTransferCanonicalBytes({ ...base, oldAdminRootPub: "xyz" }))
      .toThrow(/32-byte hex/);
    expect(() => lib.adminRootTransferCanonicalBytes({ ...base, newAdminRootPub: "xyz" }))
      .toThrow(/32-byte hex/);
  });
});

describe("§9.8 — runGiverAdminHandoff (giver at claim-received)", () => {
  it("signs with the giver root + POSTs the deposit with the claim's values", async () => {
    const k = await loadKeystore();
    const lib = await loadHandoff();
    const { deps, posted } = await handoffDeps(k);

    const out = await lib.runGiverAdminHandoff(handoffArgs(), deps);
    expect(out.status).toBe("deposited");

    expect(posted).toHaveLength(1);
    // Deposit path = the box's OLD canonical.
    expect(posted[0]!.url).toBe(`https://x/api/server/${encodeURIComponent(HOST)}/transfer/admin-handoff`);
    const { handoff, signatureHex } = posted[0]!.body;
    expect(handoff).toEqual({
      serverDomain: HOST,
      giverUsername: "alice",
      acquirerUsername: "bob",
      oldAdminRootPub: giverRootPub,
      newAdminRootPub: acquirerRootPub,
      transferNonce: NONCE,
      issuedAt: 1735689600000,
    });

    // The signature verifies under the GIVER's admin root over the exact
    // contract bytes — and under nothing else.
    const bytes = handoffCanonical(handoff);
    expect(ed.verify(fromHex(signatureHex), bytes, ed.getPublicKey(giverSeed))).toBe(true);
    expect(ed.verify(fromHex(signatureHex), bytes, fromHex(acquirerRootPub))).toBe(false);
  });

  it('"" / null acquirer root ⇒ newAdminRootPub "" (unpin), still giver-signed', async () => {
    const k = await loadKeystore();
    const lib = await loadHandoff();
    for (const acquirerAdminRootPub of ["", null, undefined]) {
      const { deps, posted } = await handoffDeps(k);
      const out = await lib.runGiverAdminHandoff(handoffArgs({ acquirerAdminRootPub }), deps);
      expect(out.status).toBe("deposited");
      const { handoff, signatureHex } = posted[0]!.body;
      expect(handoff.newAdminRootPub).toBe("");
      expect(ed.verify(fromHex(signatureHex), handoffCanonical(handoff), ed.getPublicKey(giverSeed))).toBe(true);
    }
  });

  it("no admin root in session ⇒ silent skip, NO deposit", async () => {
    const k = await loadKeystore();
    const lib = await loadHandoff();
    const { deps, posted } = await handoffDeps(k, {
      loadAdminRootSeed: vi.fn(async () => null),
    });
    const out = await lib.runGiverAdminHandoff(
      handoffArgs({ adminRootSeed: null, umkSeed: new Uint8Array(32).fill(0xaa) }),
      deps,
    );
    expect(out.status).toBe("skipped");
    expect(posted).toHaveLength(0);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("falls back to loading the stored admin root from the umk seed", async () => {
    const k = await loadKeystore();
    const lib = await loadHandoff();
    const load = vi.fn(async () => giverSeed);
    const { deps, posted } = await handoffDeps(k, { loadAdminRootSeed: load });
    const umkSeed = new Uint8Array(32).fill(0xaa);
    const out = await lib.runGiverAdminHandoff(
      handoffArgs({ adminRootSeed: null, umkSeed }),
      deps,
    );
    expect(out.status).toBe("deposited");
    expect(load).toHaveBeenCalledWith(umkSeed);
    expect(posted[0]!.body.handoff.oldAdminRootPub).toBe(giverRootPub);
  });

  it("a failed deposit resolves { status:'failed' } — never throws (ownership already moved)", async () => {
    const k = await loadKeystore();
    const lib = await loadHandoff();
    for (const fetchImpl of [
      async () => ({ ok: false, status: 503, json: async () => ({ error: "broker down" }) }),
      async () => { throw new Error("network sank"); },
    ]) {
      const { deps } = await handoffDeps(k, { fetch: fetchImpl });
      const out = await lib.runGiverAdminHandoff(handoffArgs(), deps);
      expect(out.status).toBe("failed");
      expect(String(out.error)).toMatch(/broker down|network sank/);
    }
  });
});

describe("§9.8 — watchClaimThenHandoff (the giver claim-received hook)", () => {
  it("polls to the claim, then hands off with the claim's acquirer values", async () => {
    const lib = await loadHandoff();
    const polls = [
      { claimed: false },
      { claimed: true, acquirerUsername: "bob", acquirerAdminRootPub: acquirerRootPub },
    ];
    const handoff = vi.fn(async () => ({ status: "deposited" }));
    const statuses: any[] = [];
    const out = await lib.watchClaimThenHandoff({
      poll: async () => polls.shift(),
      handoff,
      onStatus: (res: any, claim: any) => statuses.push([res.status, claim.acquirerUsername]),
      sleep: async () => {},
    });
    expect(out.status).toBe("deposited");
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0]![0]).toMatchObject({
      acquirerUsername: "bob",
      acquirerAdminRootPub: acquirerRootPub,
    });
    expect(statuses).toEqual([["deposited", "bob"]]);
  });

  it("a failed deposit surfaces the warning and RETRIES while active — the flow completes", async () => {
    const lib = await loadHandoff();
    const results = [{ status: "failed", error: "503" }, { status: "deposited" }];
    const statuses: string[] = [];
    const out = await lib.watchClaimThenHandoff({
      poll: async () => ({ claimed: true, acquirerUsername: "bob", acquirerAdminRootPub: "" }),
      handoff: async () => results.shift(),
      onStatus: (res: any) => statuses.push(res.status),
      sleep: async () => {},
    });
    expect(statuses).toEqual(["failed", "deposited"]);
    expect(out.status).toBe("deposited");
  });

  it("tolerates transient poll errors and stops when no longer active", async () => {
    const lib = await loadHandoff();
    let ticks = 0;
    const out = await lib.watchClaimThenHandoff({
      poll: async () => { throw new Error("flaky"); },
      handoff: vi.fn(),
      isActive: () => ticks < 3,
      sleep: async () => { ticks++; },
    });
    expect(out.status).toBe("inactive");
  });

  it("skipped (no admin root) ends the watch silently", async () => {
    const lib = await loadHandoff();
    const statuses: string[] = [];
    const out = await lib.watchClaimThenHandoff({
      poll: async () => ({ claimed: true, acquirerUsername: "bob", acquirerAdminRootPub: "" }),
      handoff: async () => ({ status: "skipped" }),
      onStatus: (res: any) => statuses.push(res.status),
      sleep: async () => {},
    });
    expect(out.status).toBe("skipped");
    expect(statuses).toEqual(["skipped"]);
  });
});

describe("§9.8 — view wiring (source pins)", () => {
  it("the giver transfer dialog starts the claim-watch and surfaces the retryable warning", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      resolve(__dirname, "..", "public", "webapp", "views", "server-detail.js"), "utf8");
    expect(src).toContain("watchClaimThenHandoff");
    expect(src).toContain("runGiverAdminHandoff");
    // The claim's admin pub (or "" = unpin) + the offer's nonce feed the hand-off.
    expect(src).toContain('acquirerAdminRootPub: claim.acquirerAdminRootPub || ""');
    expect(src).toContain("transferNonce: out.qr.transferNonce");
    // A failed deposit is a RETRYABLE warning, not a transfer failure.
    expect(src).toContain("TRANSFER_ADMIN_HANDOFF_WARNING");
    expect(src).toContain('if (res.status === "failed")');
    // No admin root ⇒ the watch never starts (silent skip).
    expect(src).toContain("if (session.adminRootSeed)");
    expect(src).toContain("hand-off before re-homing");
  });

  it("the acquirer claim view binds the session admin root pub ('' fallback) into the claim", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      resolve(__dirname, "..", "public", "webapp", "views", "transfer-claim.js"), "utf8");
    expect(src).toContain("acquirerAdminRootPubHex: session.adminRootSeed");
    expect(src).toContain("await adminRootPubHex(session.adminRootSeed)");
    expect(src).toContain(': "",');
  });
});
