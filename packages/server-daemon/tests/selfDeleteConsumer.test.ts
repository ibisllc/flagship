/**
 * Box-side account-death content-wipe consumer
 * (docs/account-deletion-and-name-reclaim.md §5).
 *
 * The daemon polls the `self-delete` mailbox lane; when `.com` has deposited
 * the owner-IRK-signed servers-self-delete order it re-verifies the order under
 * the CONFIG-PINNED owner IRK (never anything `.com` asserts) and wipes content.
 * These tests cover:
 *   - the happy path: a verified order → wipeContent runs once + a marker is
 *     written + a power-off (if supplied) fires;
 *   - idempotency: a re-poll after the marker is present never re-wipes;
 *   - 404 (no order deposited) → no wipe;
 *   - rejection without wiping for a forged sig, a wrong-account order, and a
 *     junk carrier (never act on bad input);
 *   - the carrier decode/verify helper directly.
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signServersSelfDelete,
  type Keypair,
  type ServersSelfDelete,
} from "@flagship/protocol";
import {
  claimAndRunSelfDelete,
  decodeAndVerifySelfDeleteCarrier,
  type SelfDeleteMarkerStore,
} from "../src/selfDeleteConsumer.js";

const DOMAIN = "home.alice.flagship.services";
const USERNAME = "alice";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function utf8ToHex(s: string): string {
  return hex(new TextEncoder().encode(s));
}

/** Build the deposited carrier hex (the `{request,signature}` JSON envelope). */
function carrier(username: string, irk: Keypair, issuedAt = 1_000): string {
  const order: ServersSelfDelete = { username, issuedAt };
  return utf8ToHex(
    JSON.stringify({ request: { username, issuedAt }, signature: hex(signServersSelfDelete(order, irk)) }),
  );
}

/** A fetch that returns a 200 self-delete reply with the given carrier, or 404. */
function fetchReturning(sealedHex: string | null): typeof fetch {
  return (async () => {
    if (sealedHex === null) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify({ serverDomain: DOMAIN, sealed: sealedHex }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function inMemMarker(): SelfDeleteMarkerStore & { marked: boolean } {
  const m = {
    marked: false,
    async has() {
      return m.marked;
    },
    async mark() {
      m.marked = true;
    },
  };
  return m;
}

describe("decodeAndVerifySelfDeleteCarrier", () => {
  it("returns the verified order for a good carrier", () => {
    const irk = makeKey(1);
    const order = decodeAndVerifySelfDeleteCarrier({
      sealedHex: carrier(USERNAME, irk),
      ownerIrkPub: irk.publicKey,
      username: USERNAME,
    });
    expect(order.username).toBe(USERNAME);
    expect(order.issuedAt).toBe(1_000);
  });

  it("throws on a wrong-owner signature", () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    expect(() =>
      decodeAndVerifySelfDeleteCarrier({
        sealedHex: carrier(USERNAME, wrong),
        ownerIrkPub: irk.publicKey,
        username: USERNAME,
      }),
    ).toThrow(/does not verify/);
  });

  it("throws when the order names a different account", () => {
    const irk = makeKey(1);
    expect(() =>
      decodeAndVerifySelfDeleteCarrier({
        sealedHex: carrier("someoneelse", irk),
        ownerIrkPub: irk.publicKey,
        username: USERNAME,
      }),
    ).toThrow(/not this box's owner/);
  });

  it("throws on junk hex / non-JSON", () => {
    const irk = makeKey(1);
    expect(() =>
      decodeAndVerifySelfDeleteCarrier({ sealedHex: "zzzz", ownerIrkPub: irk.publicKey, username: USERNAME }),
    ).toThrow(/not valid hex/);
    expect(() =>
      decodeAndVerifySelfDeleteCarrier({ sealedHex: utf8ToHex("nope"), ownerIrkPub: irk.publicKey, username: USERNAME }),
    ).toThrow(/not valid JSON/);
  });
});

describe("claimAndRunSelfDelete", () => {
  it("wipes once on a verified order, marks it, and powers off", async () => {
    const irk = makeKey(1);
    let wipes = 0;
    let poweredOff = false;
    const marker = inMemMarker();
    const out = await claimAndRunSelfDelete({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      username: USERNAME,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fetchReturning(carrier(USERNAME, irk)),
      wipeContent: async () => {
        wipes++;
      },
      powerOff: async () => {
        poweredOff = true;
      },
      markerStore: marker,
    });
    expect(out).toEqual({ wiped: true });
    expect(wipes).toBe(1);
    expect(poweredOff).toBe(true);
    expect(marker.marked).toBe(true);
  });

  it("never re-wipes once the marker is present (idempotent)", async () => {
    const irk = makeKey(1);
    let wipes = 0;
    const marker = inMemMarker();
    marker.marked = true; // a prior wipe already ran
    const out = await claimAndRunSelfDelete({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      username: USERNAME,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fetchReturning(carrier(USERNAME, irk)),
      wipeContent: async () => {
        wipes++;
      },
      markerStore: marker,
    });
    expect(out).toEqual({ wiped: false, reason: "already-wiped" });
    expect(wipes).toBe(0);
  });

  it("does nothing on a 404 (no order deposited)", async () => {
    const irk = makeKey(1);
    let wipes = 0;
    const out = await claimAndRunSelfDelete({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      username: USERNAME,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fetchReturning(null),
      wipeContent: async () => {
        wipes++;
      },
      markerStore: inMemMarker(),
    });
    expect(out).toEqual({ wiped: false, reason: "no-order" });
    expect(wipes).toBe(0);
  });

  it("rejects (no wipe) a forged order", async () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    let wipes = 0;
    const out = await claimAndRunSelfDelete({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      username: USERNAME,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fetchReturning(carrier(USERNAME, wrong)),
      wipeContent: async () => {
        wipes++;
      },
      markerStore: inMemMarker(),
    });
    expect(out).toEqual({ wiped: false, reason: "rejected" });
    expect(wipes).toBe(0);
  });

  it("rejects (no wipe) an order for a different account", async () => {
    const irk = makeKey(1);
    let wipes = 0;
    const out = await claimAndRunSelfDelete({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      username: USERNAME,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fetchReturning(carrier("eve", irk)),
      wipeContent: async () => {
        wipes++;
      },
      markerStore: inMemMarker(),
    });
    expect(out).toEqual({ wiped: false, reason: "rejected" });
    expect(wipes).toBe(0);
  });

  it("still marks (no loop) when wipeContent itself fails", async () => {
    const irk = makeKey(1);
    const marker = inMemMarker();
    const out = await claimAndRunSelfDelete({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      username: USERNAME,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: fetchReturning(carrier(USERNAME, irk)),
      wipeContent: async () => {
        throw new Error("docker not installed");
      },
      markerStore: marker,
    });
    expect(out).toEqual({ wiped: true });
    expect(marker.marked).toBe(true);
  });
});
