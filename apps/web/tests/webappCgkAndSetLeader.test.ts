import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  deriveIRK,
  carrierHexToCgkDelivery,
  openAndVerifyCgkDelivery,
  verifySetLeader,
} from "@flagship/protocol";
// The browser-shipping modules — importing the SAME files we serve to clients
// means these tests guard the exact bytes the webapp produces.
import { _internal } from "../public/webapp/lib/bootApproval.js";
import { leadsOf } from "../public/webapp/views/home.js";

async function loadKeystore() {
  const path = resolve(__dirname, "..", "public", "webapp", "keystore.js");
  return import(pathToFileURL(path).href);
}
async function loadState() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "state.js");
  return import(pathToFileURL(path).href);
}
async function loadBootApproval() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "bootApproval.js");
  return import(pathToFileURL(path).href);
}

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const buildCgkDeliveryCarrier = (_internal as unknown as {
  buildCgkDeliveryCarrier: (a: {
    serverDomain: string;
    cgk: Uint8Array;
    boxIdentityPub: Uint8Array;
    issuedAt: number;
    signWithIrk: (umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>;
    umk: Uint8Array;
  }) => Promise<string>;
}).buildCgkDeliveryCarrier;

// ── 1. Pinned CGK derivation vector ──────────────────────────────────
describe("webapp deriveCgkFromSeed — pinned vector + protocol parity", () => {
  it("deriveCgkFromSeed(32×0x07) === the cross-platform CGK vector", async () => {
    const k = await loadKeystore();
    const seed = new Uint8Array(32).fill(0x07);
    expect(await k.deriveCgkFromSeed(seed)).toBe(
      "1d8e3bc393a91de22edec0b862a0539856bdc73b42ab60a26d7d51fbb091badd",
    );
  });

  it("matches @flagship/protocol deriveCGK byte-for-byte (per-cloud, NO serverId)", async () => {
    const { deriveCGK } = await import("@flagship/protocol");
    const k = await loadKeystore();
    const seed = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
    expect(await k.deriveCgkFromSeed(seed)).toBe(toHex(deriveCGK(seed)));
  });
});

// ── 2. CGK-delivery carrier round-trips through @flagship/protocol ───
describe("webapp CGK-delivery carrier verifies under @flagship/protocol", () => {
  it("the deposited carrier opens back to the CGK (box seal + owner-IRK sig)", async () => {
    const irkSeed = new Uint8Array(32).fill(0x07);
    const irkPub = ed25519.getPublicKey(irkSeed);
    const boxSeed = new Uint8Array(32).fill(0x09);
    const boxPub = ed25519.getPublicKey(boxSeed);
    const serverDomain = "kitchen.alice.flagship.services";
    const cgk = new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff);
    const issuedAt = 1_750_000_000_000;

    const signWithIrk = async (_umk: Uint8Array, bytes: Uint8Array) =>
      ed25519.sign(bytes, irkSeed);

    const carrierHex = await buildCgkDeliveryCarrier({
      serverDomain,
      cgk,
      boxIdentityPub: boxPub,
      issuedAt,
      signWithIrk,
      umk: new Uint8Array(0),
    });

    // Parse + open EXACTLY the way the box (daemon) does.
    const parsed = carrierHexToCgkDelivery(carrierHex);
    expect(parsed).not.toBeNull();
    const opened = openAndVerifyCgkDelivery({
      delivery: parsed!.delivery,
      signature: parsed!.signature,
      ownerIrkPub: irkPub,
      boxIdentityPriv: boxSeed,
      serverDomain,
    });
    expect(opened).not.toBeNull();
    expect(toHex(opened!)).toBe(toHex(cgk));

    // Negative control: a different owner IRK must NOT verify.
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(0x33));
    expect(
      openAndVerifyCgkDelivery({
        delivery: parsed!.delivery,
        signature: parsed!.signature,
        ownerIrkPub: otherPub,
        boxIdentityPriv: boxSeed,
        serverDomain,
      }),
    ).toBeNull();
  });
});

// ── 3. depositCgk builds the right deposit body + verifiable carrier ─
describe("webapp depositCgk — deposit body + carrier round-trip", () => {
  it("POSTs the {auth,…,deposit} body to cgk-deposit; carrier opens to the CGK", async () => {
    const { unlockSession } = await loadState();
    const { depositCgk } = await loadBootApproval();
    const k = await loadKeystore();

    const seed = new Uint8Array(32).fill(0x11);
    await unlockSession(seed, "harry");
    const ownerIrkPub = deriveIRK({ seed } as never).publicKey;

    const serverDomain = "frank.harry.flagship.services";
    const boxSeed = new Uint8Array(32).fill(0x22);
    const boxPub = ed25519.getPublicKey(boxSeed);
    const cgkHex = await k.deriveCgkFromSeed(seed);

    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    });

    await depositCgk(
      { serverDomain, stkPubHex: toHex(boxPub), cgkHex },
      { fetch: fetchMock as unknown as typeof fetch, comBase: "https://com", now: () => 1_750_000_000_000 },
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(`https://com/api/server/${serverDomain}/cgk-deposit`);
    const dep = (captured!.body as { deposit: Record<string, unknown> }).deposit;
    expect(dep.serverDomain).toBe(serverDomain);
    expect(dep.stkPub).toBe(toHex(boxPub));
    expect(typeof (captured!.body as { authSignature: string }).authSignature).toBe("string");

    // The deposited carrier opens back to the CGK under the owner IRK.
    const parsed = carrierHexToCgkDelivery(String(dep.sealed));
    expect(parsed).not.toBeNull();
    const opened = openAndVerifyCgkDelivery({
      delivery: parsed!.delivery,
      signature: parsed!.signature,
      ownerIrkPub,
      boxIdentityPriv: boxSeed,
      serverDomain,
    });
    expect(opened).not.toBeNull();
    expect(toHex(opened!)).toBe(cgkHex);
  });
});

// ── 4. depositSetLeader builds a vote that verifies under @flagship/protocol ─
describe("webapp depositSetLeader — set-leader vote body + signature", () => {
  it("POSTs {auth,…,deposit,vote,signature}; the vote verifies under the owner IRK", async () => {
    const { unlockSession } = await loadState();
    const { depositSetLeader } = await loadBootApproval();

    const seed = new Uint8Array(32).fill(0x44);
    await unlockSession(seed, "harry");
    const ownerIrkPub = deriveIRK({ seed } as never).publicKey;

    const serverDomain = "kitchen.harry.flagship.services";
    const preferredStkPubHex = toHex(ed25519.getPublicKey(new Uint8Array(32).fill(0x55)));

    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    });

    await depositSetLeader(
      { serverDomain, preferredStkPubHex },
      { fetch: fetchMock as unknown as typeof fetch, comBase: "https://com", now: () => 1_750_000_000_000 },
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(`https://com/api/server/${serverDomain}/set-leader`);
    const body = captured!.body as {
      deposit: { serverDomain: string; requestNonceHex: string };
      vote: { user: string; preferredStkPubHex: string; issuedAt: number; nonce: string };
      signature: string;
    };
    expect(body.deposit.serverDomain).toBe(serverDomain);
    expect(body.vote.user).toBe("harry");
    expect(body.vote.preferredStkPubHex).toBe(preferredStkPubHex);
    expect(body.vote.issuedAt).toBe(1_750_000_000_000);

    // The vote verifies under @flagship/protocol's verifySetLeader (byte-identical
    // canonical bytes: flagship/set-leader/v1|user|pref|issuedAt|nonce).
    const sig = new Uint8Array(body.signature.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(verifySetLeader(body.vote, sig, ownerIrkPub)).toBe(true);

    // Negative control: a different owner IRK must NOT verify.
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(0x66));
    expect(verifySetLeader(body.vote, sig, otherPub)).toBe(false);
  });
});

// ── 5. Lead display (leadsOf) — tolerant of absence ──────────────────
describe("webapp leadsOf — /pods leadsServices surfacing", () => {
  it("returns the cleaned slug list when present", () => {
    expect(leadsOf({ leadsServices: ["blog", " notes ", ""] })).toEqual(["blog", "notes"]);
  });
  it("yields [] when leadsServices is absent / not an array (tolerant)", () => {
    expect(leadsOf({})).toEqual([]);
    expect(leadsOf(null)).toEqual([]);
    expect(leadsOf({ leadsServices: "blog" })).toEqual([]);
    expect(leadsOf({ leadsServices: [] })).toEqual([]);
  });
});
