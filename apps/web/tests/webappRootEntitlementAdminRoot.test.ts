// Slice D Phase 2 (webapp) — the DEFERRED piece: the RootEntitlement is an
// ADMIN-ROOT order. Only admins bring a box online, so a reburned admin-pinned
// box REJECTS an IRK-signed RootEntitlement at HELLO (server-daemon
// entitlementRelay → authorizeSensitiveOrder: admin master root when pinned,
// owner IRK only as the pre-wipe fallback).
//
// This guards the WIRING (not just the gate primitive, which
// adminRootSigningGate.test.ts covers): `depositEntitlement` / `respondEntitlement`
// route the `flagship/root-entitlement/v1` carrier through the tag-routed
// sensitive signer, so:
//   • with an admin root in the session → the RootEntitlement signs under the
//     admin master root (NOT the IRK), while the co-signed mailbox-auth
//     (`device-endpoint-claim`) stays on the membership IRK the deposit lane needs;
//   • with no admin root (legacy / pre-wipe) → the RootEntitlement signs under the
//     owner IRK, byte-identical to pre-D.
//
// Static ESM imports keep bootApproval.js + state.js on ONE module graph, so
// mutating the session singleton is what the code under test observes.

import { afterEach, describe, expect, it } from "vitest";
import { depositEntitlement, satisfy } from "../public/webapp/lib/bootApproval.js";
import { getSession, lockSession } from "../public/webapp/lib/state.js";
import {
  adminRootPubHex,
  deriveIrkFromSeed,
  verifyWithEd25519Pub,
  hexToBytes,
} from "../public/webapp/keystore.js";

const te = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder("utf-8", { fatal: true });

const SERVER_DOMAIN = "foo.alice.flagship.services";
const STK_PUB_HEX = "ab".repeat(32);

function canonicalRootEntitlement(username: string, podPubKey: string, podCanonical: string, issuedAt: number) {
  return te(["flagship/root-entitlement/v1", username, podPubKey, podCanonical, issuedAt].join("|"));
}

/** Decode the deposited carrier hex → the parsed EntitlementBundle JSON. */
function carrierJson(carrierHex: string) {
  return JSON.parse(td.decode(hexToBytes(carrierHex)));
}

afterEach(() => lockSession());

describe("webapp RootEntitlement is admin-root signed (Slice D deferred piece)", () => {
  it("depositEntitlement signs the RootEntitlement under the ADMIN ROOT (mailbox-auth stays IRK)", async () => {
    const umk = new Uint8Array(32).fill(7);
    const adminSeed = crypto.getRandomValues(new Uint8Array(32));
    const session = getSession();
    session.umk = umk;
    session.username = "alice";
    session.adminRootSeed = adminSeed;

    const adminPub = hexToBytes(await adminRootPubHex(adminSeed));
    const irk = await deriveIrkFromSeed(umk);

    let captured: any = null;
    const fetchMock = async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return new Response("", { status: 200 });
    };
    const now = 1_700_000_000_000;
    await depositEntitlement(
      { serverDomain: SERVER_DOMAIN, stkPubHex: STK_PUB_HEX },
      { fetch: fetchMock as any, comBase: "https://com.test", now: () => now },
    );

    expect(captured).not.toBeNull();
    const json = carrierJson(captured.deposit.sealed);
    const canonical = canonicalRootEntitlement("alice", STK_PUB_HEX, SERVER_DOMAIN, now);
    const sig = hexToBytes(json.rootEntitlementSig);

    // The RootEntitlement verifies under the ADMIN ROOT — and NOT the IRK.
    expect(await verifyWithEd25519Pub(adminPub, sig, canonical)).toBe(true);
    expect(await verifyWithEd25519Pub(irk.publicKey, sig, canonical)).toBe(false);

    // The co-signed mailbox-auth (`device-endpoint-claim`) is NOT sensitive, so it
    // stays on the membership IRK the deposit lane authenticates against.
    const a = captured.auth;
    const authCanonical = te(
      ["flagship/device-endpoint-claim/v1", a.username, a.endpointLabel, a.phoneIrkPub, a.issuedAt, a.expiresAt, a.nonce].join("|"),
    );
    const authSig = hexToBytes(captured.authSignature);
    expect(await verifyWithEd25519Pub(irk.publicKey, authSig, authCanonical)).toBe(true);
    expect(await verifyWithEd25519Pub(adminPub, authSig, authCanonical)).toBe(false);
  });

  it("the entitlement inbox responder also signs the RootEntitlement under the ADMIN ROOT", async () => {
    const umk = new Uint8Array(32).fill(4);
    const adminSeed = crypto.getRandomValues(new Uint8Array(32));
    const session = getSession();
    session.umk = umk;
    session.username = "alice";
    session.adminRootSeed = adminSeed;

    const adminPub = hexToBytes(await adminRootPubHex(adminSeed));
    const irk = await deriveIrkFromSeed(umk);

    let sealedHex: string | null = null;
    const fetchMock = async (_url: string, init: any) => {
      sealedHex = JSON.parse(init.body).response.sealed;
      return new Response("", { status: 200 });
    };
    const now = 1_700_000_111_000;
    await satisfy(
      { serverDomain: SERVER_DOMAIN, requestNonceHex: "cd".repeat(32), purpose: "entitlement", directoryStkPubHex: STK_PUB_HEX } as any,
      { fetch: fetchMock as any, bootBase: "https://boot.test", now: () => now },
    );

    expect(sealedHex).not.toBeNull();
    const json = carrierJson(sealedHex!);
    const canonical = canonicalRootEntitlement("alice", STK_PUB_HEX, SERVER_DOMAIN, now);
    const sig = hexToBytes(json.rootEntitlementSig);
    expect(await verifyWithEd25519Pub(adminPub, sig, canonical)).toBe(true);
    expect(await verifyWithEd25519Pub(irk.publicKey, sig, canonical)).toBe(false);
  });

  it("falls back to the owner IRK when there is NO admin root (legacy / pre-wipe)", async () => {
    const umk = new Uint8Array(32).fill(9);
    const session = getSession();
    session.umk = umk;
    session.username = "alice";
    session.adminRootSeed = null; // legacy device

    const irk = await deriveIrkFromSeed(umk);

    let captured: any = null;
    const fetchMock = async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return new Response("", { status: 200 });
    };
    const now = 1_700_000_222_000;
    await depositEntitlement(
      { serverDomain: SERVER_DOMAIN, stkPubHex: STK_PUB_HEX },
      { fetch: fetchMock as any, comBase: "https://com.test", now: () => now },
    );

    const json = carrierJson(captured.deposit.sealed);
    const canonical = canonicalRootEntitlement("alice", STK_PUB_HEX, SERVER_DOMAIN, now);
    const sig = hexToBytes(json.rootEntitlementSig);
    // No admin root ⇒ the owner IRK signs it, byte-identical to pre-D.
    expect(await verifyWithEd25519Pub(irk.publicKey, sig, canonical)).toBe(true);
  });
});
