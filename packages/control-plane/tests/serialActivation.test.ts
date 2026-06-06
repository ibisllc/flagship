import { describe, expect, it, beforeEach } from "vitest";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { InMemoryStorage } from "@flagship/storage";
import {
  enforceActivated,
  handleRendezvousLookup,
  handleSerialActivate,
  handleSerialStatus,
} from "../src/serialActivation.js";

const SECRET = "test-retailer-secret";

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function signActivation(args: {
  serial: string;
  sku: string;
  retailerId: string;
  at: number;
}): string {
  const canonical = new TextEncoder().encode(
    [
      "flagship/serial-activate/v1",
      args.serial,
      args.sku,
      args.retailerId,
      args.at,
    ].join("|"),
  );
  return hex(hmac(sha256, new TextEncoder().encode(SECRET), canonical));
}

function authHeader(args: {
  serial: string;
  sku: string;
  retailerId: string;
  at: number;
}): string {
  return `Flagship-Retailer-v1 ${signActivation(args)}`;
}

describe("N-CLOUD-1: serial activation (HMAC-authed)", () => {
  let storage: InMemoryStorage;
  let now = 1_700_000_000_000;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.boxSerials.create({
      serial: "BX0001",
      sku: "flagship-mini-v1",
      createdAt: now,
    });
  });

  const deps = () => ({
    serials: storage.boxSerials,
    retailerHmacSecret: SECRET,
    now: () => now,
  });

  it("happy path: activates a known serial with valid HMAC", async () => {
    const body = { serial: "BX0001", sku: "flagship-mini-v1", retailerId: "store-42", at: now };
    const r = await handleSerialActivate(deps(), body, authHeader(body));
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    expect((r.body as { alreadyActivated: boolean }).alreadyActivated).toBe(false);
    const rec = await storage.boxSerials.get("BX0001");
    expect(rec?.activatedAt).toBe(now);
    expect(rec?.activatedBy).toBe("store-42");
  });

  it("replay returns alreadyActivated:true (idempotent)", async () => {
    const body = { serial: "BX0001", sku: "flagship-mini-v1", retailerId: "store-42", at: now };
    await handleSerialActivate(deps(), body, authHeader(body));
    const r = await handleSerialActivate(deps(), body, authHeader(body));
    expect(r.status).toBe(200);
    expect((r.body as { alreadyActivated: boolean }).alreadyActivated).toBe(true);
  });

  it("rejects with no HMAC secret configured (503-equivalent → 403)", async () => {
    const r = await handleSerialActivate(
      { serials: storage.boxSerials, now: () => now },
      { serial: "BX0001", sku: "flagship-mini-v1", at: now },
      authHeader({ serial: "BX0001", sku: "flagship-mini-v1", retailerId: "", at: now }),
    );
    expect(r.status).toBe(403);
  });

  it("rejects malformed body (missing fields)", async () => {
    const r = await handleSerialActivate(
      deps(),
      { serial: "BX0001" } as unknown as { serial: string; sku: string; at: number },
      authHeader({ serial: "BX0001", sku: "flagship-mini-v1", retailerId: "", at: now }),
    );
    expect(r.status).toBe(400);
  });

  it("rejects stale timestamp (outside 5 min)", async () => {
    const body = { serial: "BX0001", sku: "flagship-mini-v1", retailerId: "", at: now - 10 * 60_000 };
    const r = await handleSerialActivate(deps(), body, authHeader(body));
    expect(r.status).toBe(403);
  });

  it("rejects missing Authorization header", async () => {
    const r = await handleSerialActivate(
      deps(),
      { serial: "BX0001", sku: "flagship-mini-v1", retailerId: "", at: now },
      undefined,
    );
    expect(r.status).toBe(403);
  });

  it("rejects wrong prefix in Authorization", async () => {
    const body = { serial: "BX0001", sku: "flagship-mini-v1", retailerId: "", at: now };
    const r = await handleSerialActivate(
      deps(),
      body,
      `Bearer ${signActivation(body)}`,
    );
    expect(r.status).toBe(403);
  });

  it("rejects HMAC mismatch (wrong secret)", async () => {
    const body = { serial: "BX0001", sku: "flagship-mini-v1", retailerId: "", at: now };
    const canonical = new TextEncoder().encode(
      ["flagship/serial-activate/v1", body.serial, body.sku, body.retailerId, body.at].join("|"),
    );
    const wrong = hex(
      hmac(sha256, new TextEncoder().encode("wrong-secret"), canonical),
    );
    const r = await handleSerialActivate(deps(), body, `Flagship-Retailer-v1 ${wrong}`);
    expect(r.status).toBe(403);
  });

  it("rejects HMAC mismatch when body field differs (forgery resistance)", async () => {
    // Sign for serial BX0001 but submit a body for BX0002 → HMAC mismatches.
    await storage.boxSerials.create({ serial: "BX0002", sku: "flagship-mini-v1", createdAt: now });
    const signed = authHeader({ serial: "BX0001", sku: "flagship-mini-v1", retailerId: "", at: now });
    const body = { serial: "BX0002", sku: "flagship-mini-v1", retailerId: "", at: now };
    const r = await handleSerialActivate(deps(), body, signed);
    expect(r.status).toBe(403);
  });

  it("rejects unknown serial (404)", async () => {
    const body = { serial: "BX9999", sku: "flagship-mini-v1", retailerId: "", at: now };
    const r = await handleSerialActivate(deps(), body, authHeader(body));
    expect(r.status).toBe(404);
  });
});

describe("N-CLOUD-1: serial status (public read)", () => {
  let storage: InMemoryStorage;
  const now = 1_700_000_000_000;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.boxSerials.create({ serial: "BX0001", sku: "sku-a", createdAt: now });
  });

  it("reports unactivated status", async () => {
    const r = await handleSerialStatus({ serials: storage.boxSerials }, "BX0001");
    expect(r.status).toBe(200);
    expect((r.body as { activated: boolean; bound: boolean }).activated).toBe(false);
    expect((r.body as { bound: boolean }).bound).toBe(false);
  });

  it("reports activated + bound state after activate + bind", async () => {
    await storage.boxSerials.activate({ serial: "BX0001", activatedBy: "store-1", at: now });
    await storage.boxSerials.bindStk({
      serial: "BX0001",
      stkPubHex: "00".repeat(29) + "abcdef",
      suffix6: "abcdef",
      at: now + 1000,
    });
    const r = await handleSerialStatus({ serials: storage.boxSerials }, "BX0001");
    const body = r.body as {
      activated: boolean;
      bound: boolean;
      suffix6: string | null;
    };
    expect(body.activated).toBe(true);
    expect(body.bound).toBe(true);
    expect(body.suffix6).toBe("abcdef");
  });

  it("404s an unknown serial", async () => {
    const r = await handleSerialStatus({ serials: storage.boxSerials }, "BX9999");
    expect(r.status).toBe(404);
  });

  it("400s on empty serial", async () => {
    const r = await handleSerialStatus({ serials: storage.boxSerials }, "");
    expect(r.status).toBe(400);
  });
});

describe("N-CLOUD-3: rendezvous lookup by suffix6", () => {
  let storage: InMemoryStorage;
  const now = 1_700_000_000_000;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    for (const [serial, suffix6] of [
      ["BX0001", "aaaaaa"],
      ["BX0002", "bbbbbb"],
      ["BX0003", "aaaaaa"], // duplicate suffix6 — the disambiguation case
    ] as const) {
      await storage.boxSerials.create({ serial, sku: "sku-x", createdAt: now });
      await storage.boxSerials.activate({ serial, activatedBy: null, at: now });
      await storage.boxSerials.bindStk({
        serial,
        stkPubHex: "00".repeat(29) + suffix6,
        suffix6,
        at: now + 1,
      });
    }
  });

  it("returns the candidate matching the suffix", async () => {
    const r = await handleRendezvousLookup({ serials: storage.boxSerials }, "bbbbbb");
    expect(r.status).toBe(200);
    const cands = (r.body as { candidates: { serial: string }[] }).candidates;
    expect(cands).toHaveLength(1);
    expect(cands[0]!.serial).toBe("BX0002");
  });

  it("returns multiple candidates when suffix6 collides", async () => {
    const r = await handleRendezvousLookup({ serials: storage.boxSerials }, "aaaaaa");
    const cands = (r.body as { candidates: { serial: string }[] }).candidates;
    expect(cands.map((c) => c.serial).sort()).toEqual(["BX0001", "BX0003"]);
  });

  it("returns empty candidates for a no-match suffix", async () => {
    const r = await handleRendezvousLookup({ serials: storage.boxSerials }, "cccccc");
    const cands = (r.body as { candidates: unknown[] }).candidates;
    expect(cands).toHaveLength(0);
  });

  it("400s on a malformed suffix (not 6 hex)", async () => {
    const r = await handleRendezvousLookup({ serials: storage.boxSerials }, "zzzzzz");
    expect(r.status).toBe(400);
    const r2 = await handleRendezvousLookup({ serials: storage.boxSerials }, "abc");
    expect(r2.status).toBe(400);
  });
});

describe("N-CLOUD-2: enforceActivated helper", () => {
  let storage: InMemoryStorage;
  const now = 1_700_000_000_000;
  const stkPub = "00".repeat(29) + "deadbe";

  beforeEach(async () => {
    storage = new InMemoryStorage();
  });

  it("rejects when the serial is unknown", async () => {
    const r = await enforceActivated(
      { serials: storage.boxSerials },
      { serial: "BX0001", stkPubHex: stkPub, suffix6: "deadbe", at: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown serial");
  });

  it("rejects when the serial isn't activated", async () => {
    await storage.boxSerials.create({ serial: "BX0001", sku: "x", createdAt: now });
    const r = await enforceActivated(
      { serials: storage.boxSerials },
      { serial: "BX0001", stkPubHex: stkPub, suffix6: "deadbe", at: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not activated");
  });

  it("binds on first call + reports alreadyBound on idempotent retry with same stkPub", async () => {
    await storage.boxSerials.create({ serial: "BX0001", sku: "x", createdAt: now });
    await storage.boxSerials.activate({ serial: "BX0001", activatedBy: null, at: now });
    const a = await enforceActivated(
      { serials: storage.boxSerials },
      { serial: "BX0001", stkPubHex: stkPub, suffix6: "deadbe", at: now },
    );
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.alreadyBound).toBe(false);
    const b = await enforceActivated(
      { serials: storage.boxSerials },
      { serial: "BX0001", stkPubHex: stkPub, suffix6: "deadbe", at: now + 1 },
    );
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.alreadyBound).toBe(true);
  });

  it("rejects bind with a different stkPub on the same serial", async () => {
    await storage.boxSerials.create({ serial: "BX0001", sku: "x", createdAt: now });
    await storage.boxSerials.activate({ serial: "BX0001", activatedBy: null, at: now });
    await enforceActivated(
      { serials: storage.boxSerials },
      { serial: "BX0001", stkPubHex: stkPub, suffix6: "deadbe", at: now },
    );
    const other = "11".repeat(29) + "ffeedd";
    const r = await enforceActivated(
      { serials: storage.boxSerials },
      { serial: "BX0001", stkPubHex: other, suffix6: "ffeedd", at: now + 1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("already bound");
  });
});
