import { describe, expect, it } from "vitest";
import {
  deriveSTK,
  deriveSWK,
  verifyMintReservation,
  type Keypair,
} from "@flagship/protocol";
import {
  acquireMintReservation,
  releaseMintReservation,
  shouldMintNow,
  type FetchImpl,
} from "../src/acme/mintReservationClient.js";

const umk = { seed: new Uint8Array(32).fill(7) };
function kp(label: string): Keypair {
  return deriveSTK(deriveSWK(umk, label));
}
function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Mock fetch that records every call and replays a queued response. */
function mockFetch(
  responder: (rec: Recorded) => { ok: boolean; status: number; json: unknown } | Error,
): { fetchImpl: FetchImpl; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const rec: Recorded = {
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
    };
    calls.push(rec);
    const r = responder(rec);
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status, json: async () => r.json };
  };
  return { fetchImpl, calls };
}

describe("acquireMintReservation", () => {
  it("POSTs a holder-signed claim to the right URL and returns acquired+holder", async () => {
    const holder = kp("box-a");
    const holderPubHex = hex(holder.publicKey);
    const { fetchImpl, calls } = mockFetch(() => ({
      ok: true,
      status: 200,
      json: {
        acquired: true,
        holder: {
          username: "alice",
          holderPubKey: holderPubHex,
          acquiredAt: 1_000,
          expiresAt: 1_000 + 300_000,
        },
      },
    }));

    const res = await acquireMintReservation({
      baseUrl: "https://flagshipserver.com/",
      username: "Alice",
      holderKeypair: holder,
      ttlMs: 300_000,
      fetchImpl,
      now: () => 1_000,
    });

    expect(res).toEqual({
      acquired: true,
      holder: {
        username: "alice",
        holderPubKey: holderPubHex,
        acquiredAt: 1_000,
        expiresAt: 301_000,
      },
    });

    // exactly one call, to the canonical lower-cased path (trailing slash trimmed)
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://flagshipserver.com/api/users/alice/mint-reservation");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");

    // the wire body matches the control-plane ClaimBody shape and is correctly
    // signed by the HOLDER over the canonical MintReservationClaim bytes
    const body = calls[0]!.body as {
      claim: { username: string; holderPubKey: string; expiresAt: number };
      signature: string;
    };
    expect(body.claim).toEqual({
      username: "alice",
      holderPubKey: holderPubHex,
      expiresAt: 301_000,
    });
    const sigOk = verifyMintReservation(
      {
        username: body.claim.username,
        holderPubKey: holder.publicKey,
        expiresAt: body.claim.expiresAt,
      },
      Buffer.from(body.signature, "hex"),
      holder.publicKey,
    );
    expect(sigOk).toBe(true);
  });

  it("backs off (acquired=false) when the lease is held by another minter", async () => {
    const self = kp("box-a");
    const other = kp("box-b");
    const { fetchImpl } = mockFetch(() => ({
      ok: true,
      status: 200,
      json: {
        acquired: false,
        holder: {
          username: "alice",
          holderPubKey: hex(other.publicKey),
          acquiredAt: 500,
          expiresAt: 500 + 300_000,
        },
      },
    }));

    const res = await acquireMintReservation({
      baseUrl: "https://flagshipserver.com",
      username: "alice",
      holderKeypair: self,
      ttlMs: 300_000,
      fetchImpl,
      now: () => 2_000,
    });

    expect(res.acquired).toBe(false);
    expect(res.fallback).toBeUndefined();
    expect(res.holder?.holderPubKey).toBe(hex(other.publicKey));
  });

  it("falls back to the deterministic local lead when .com is UNREACHABLE (fetch throws)", async () => {
    const self = kp("box-b"); // box-b has the lowest sha among {a,b,c} → it IS the lead
    const peers = [hex(kp("box-a").publicKey), hex(kp("box-c").publicKey)];
    const { fetchImpl, calls } = mockFetch(() => new Error("ECONNREFUSED"));

    const res = await acquireMintReservation({
      baseUrl: "https://flagshipserver.com",
      username: "alice",
      holderKeypair: self,
      ttlMs: 300_000,
      peers,
      fetchImpl,
    });

    expect(calls).toHaveLength(1); // it DID try .com first
    expect(res.fallback).toBe(true);
    expect(res.holder).toBeUndefined();
    // box-b is the deterministic lead, so the fallback says mint
    expect(res.acquired).toBe(true);
    expect(res.acquired).toBe(shouldMintNow({ peers, selfPubHex: hex(self.publicKey) }));
  });

  it("fallback says DO NOT mint when self is not the deterministic lead", async () => {
    const self = kp("box-a"); // a is NOT the lowest sha among {a,b,c}
    const peers = [hex(kp("box-b").publicKey), hex(kp("box-c").publicKey)];
    const { fetchImpl } = mockFetch(() => new Error("network down"));

    const res = await acquireMintReservation({
      baseUrl: "https://flagshipserver.com",
      username: "alice",
      holderKeypair: self,
      ttlMs: 300_000,
      peers,
      fetchImpl,
    });

    expect(res.fallback).toBe(true);
    expect(res.acquired).toBe(false);
    expect(res.acquired).toBe(shouldMintNow({ peers, selfPubHex: hex(self.publicKey) }));
  });

  it("falls back on a non-2xx response too (coordination unavailable, renewal must proceed)", async () => {
    const self = kp("box-b"); // the lead with no peers → always mints
    const { fetchImpl } = mockFetch(() => ({ ok: false, status: 503, json: { error: "down" } }));

    const res = await acquireMintReservation({
      baseUrl: "https://flagshipserver.com",
      username: "alice",
      holderKeypair: self,
      ttlMs: 300_000,
      peers: [],
      fetchImpl,
    });

    expect(res.fallback).toBe(true);
    // a lone minter (no peers) is trivially the lead
    expect(res.acquired).toBe(true);
  });
});

describe("releaseMintReservation", () => {
  it("POSTs a signed claim to the /release sub-path and reports released", async () => {
    const holder = kp("box-a");
    const { fetchImpl, calls } = mockFetch(() => ({ ok: true, status: 200, json: { ok: true } }));

    const res = await releaseMintReservation({
      baseUrl: "https://flagshipserver.com",
      username: "Alice",
      holderKeypair: holder,
      fetchImpl,
      now: () => 9_000,
    });

    expect(res).toEqual({ released: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://flagshipserver.com/api/users/alice/mint-reservation/release",
    );
    const body = calls[0]!.body as { claim: { holderPubKey: string }; signature: string };
    expect(body.claim.holderPubKey).toBe(hex(holder.publicKey));
    expect(typeof body.signature).toBe("string");
  });

  it("swallows failure (released:false) when .com is unreachable", async () => {
    const holder = kp("box-a");
    const { fetchImpl } = mockFetch(() => new Error("ETIMEDOUT"));
    const res = await releaseMintReservation({
      baseUrl: "https://flagshipserver.com",
      username: "alice",
      holderKeypair: holder,
      fetchImpl,
    });
    expect(res).toEqual({ released: false });
  });

  it("reports released:false on a non-2xx without throwing", async () => {
    const holder = kp("box-a");
    const { fetchImpl } = mockFetch(() => ({ ok: false, status: 403, json: {} }));
    const res = await releaseMintReservation({
      baseUrl: "https://flagshipserver.com",
      username: "alice",
      holderKeypair: holder,
      fetchImpl,
    });
    expect(res).toEqual({ released: false });
  });
});

describe("shouldMintNow", () => {
  it("is true iff self has the lexicographically-lowest sha256 among peers+self", () => {
    const a = hex(kp("box-a").publicKey); // sha b60a...
    const b = hex(kp("box-b").publicKey); // sha 3212...  ← lowest
    const c = hex(kp("box-c").publicKey); // sha edb5...
    expect(shouldMintNow({ peers: [a, c], selfPubHex: b })).toBe(true);
    expect(shouldMintNow({ peers: [b, c], selfPubHex: a })).toBe(false);
    expect(shouldMintNow({ peers: [a, b], selfPubHex: c })).toBe(false);
  });

  it("a lone minter (no peers) is always the lead", () => {
    expect(shouldMintNow({ peers: [], selfPubHex: hex(kp("box-a").publicKey) })).toBe(true);
  });

  it("exactly one member of any set is the lead (deterministic, no split-brain)", () => {
    const members = ["box-a", "box-b", "box-c", "box-d", "box-e"].map((l) => hex(kp(l).publicKey));
    const leads = members.filter((self) =>
      shouldMintNow({ peers: members.filter((m) => m !== self), selfPubHex: self }),
    );
    expect(leads).toHaveLength(1);
  });

  it("is order- and case-insensitive and ignores self duplicated into peers", () => {
    const a = hex(kp("box-a").publicKey);
    const b = hex(kp("box-b").publicKey);
    const c = hex(kp("box-c").publicKey);
    // self listed in peers, mixed case, reordered — same verdict
    expect(
      shouldMintNow({ peers: [c.toUpperCase(), b, a], selfPubHex: a.toUpperCase() }),
    ).toBe(false);
    expect(shouldMintNow({ peers: [a, b, c, b], selfPubHex: b })).toBe(true);
  });
});
