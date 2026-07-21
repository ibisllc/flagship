import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  deriveIRK,
  signPhoneOrder,
  openPairingOrderEnvelope,
  openSealedFromEd25519Recipient,
} from "@flagship/protocol";
// The browser-shipping modules — importing the SAME files we serve to clients
// means the test guards the exact bytes the webapp produces.
import {
  pairingOrderToJson,
  buildPairingOrder,
  depositPairingOrder,
  _internal,
} from "../public/webapp/lib/bootApproval.js";
import { unlockSession } from "../public/webapp/lib/state.js";

const sealForBoxStk = (_internal as unknown as {
  sealForBoxStk: (pt: Uint8Array, stkEdPub: Uint8Array) => Promise<Uint8Array>;
}).sealForBoxStk;

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// The owner UMK seed → IRK + the pinned create-time order from
// packages/protocol/tests/pairingOrder.test.ts.
const UMK_SEED = new Uint8Array(32).fill(7);
const irk = deriveIRK({ seed: UMK_SEED });
const SERVER_ID = "kitchen.alice.flagship.services";
const ISSUED_AT = 1_750_000_000_000;
const TOKEN = "a".repeat(64);

describe("webapp pairingOrderToJson matches the protocol vector byte-for-byte", () => {
  it("reproduces the pinned plaintext envelope JSON", () => {
    const order = {
      type: "add-paired-session" as const,
      serverId: SERVER_ID,
      token: TOKEN,
      issuedAt: ISSUED_AT,
    };
    const signature = signPhoneOrder(order, irk);
    const json = pairingOrderToJson(
      { serverId: SERVER_ID, token: TOKEN, issuedAt: ISSUED_AT },
      signature,
    );
    // Byte-identical to the protocol's pairingOrderToJson (the daemon parses
    // this). v2 carries NO label — a session is named by its opaque
    // token-derived code, so there is no human string in the envelope.
    expect(json).toBe(
      JSON.stringify({
        request: {
          type: "add-paired-session",
          serverId: SERVER_ID,
          token: TOKEN,
          issuedAt: ISSUED_AT,
        },
        signature: toHex(signature),
      }),
    );
    expect(json).not.toContain("label");
    // And the box's open chain accepts it under the owner IRK.
    const opened = openPairingOrderEnvelope({
      json,
      ownerIrkPub: irk.publicKey,
      expectedServerId: SERVER_ID,
    });
    expect(opened).not.toBeNull();
    expect(opened!.token).toBe(TOKEN);
  });
});

describe("buildPairingOrder + depositPairingOrder (secret-free, default online)", () => {
  beforeEach(async () => {
    // Unlock a session so getSession() returns the owner UMK + username.
    await unlockSession(UMK_SEED, "alice");
  });

  it("builds an owner-IRK-signed order the box verifies, with a fresh token", async () => {
    const built = await buildPairingOrder(
      { serverDomain: SERVER_ID },
      { now: () => ISSUED_AT, token: TOKEN },
    );
    expect(built.token).toBe(TOKEN);
    const opened = openPairingOrderEnvelope({
      json: built.pairingOrderJson,
      ownerIrkPub: irk.publicKey,
      expectedServerId: SERVER_ID,
    });
    expect(opened).not.toBeNull();
    expect(opened!.token).toBe(TOKEN);
    expect(built.pairingOrderJson).not.toContain("label");
  });

  it("the default deposit seals the order JSON to the box identity (box opens it verbatim)", async () => {
    const built = await buildPairingOrder(
      { serverDomain: SERVER_ID },
      { now: () => ISSUED_AT, token: TOKEN },
    );

    // The box's identity key — the deposit is sealed to its directory pub.
    const boxSeed = new Uint8Array(32).fill(0x09);
    const boxPub = ed25519.getPublicKey(boxSeed);

    let posted: { stkPub: string; sealed: string } | undefined;
    const fakeFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { deposit: { stkPub: string; sealed: string } };
      posted = body.deposit;
      return { ok: true, status: 200, text: async () => "" } as Response;
    });

    const res = await depositPairingOrder(
      { serverDomain: SERVER_ID, identityPubKeyHex: toHex(boxPub), pairingOrderJson: built.pairingOrderJson },
      { fetch: fakeFetch as unknown as typeof fetch, now: () => ISSUED_AT },
    );
    expect(res).toEqual({ ok: true });
    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(posted!.stkPub).toBe(toHex(boxPub));

    // The box unseals deposit.sealed with its identity seed → the EXACT order
    // JSON. Open via the protocol's noble-based opener (the daemon's move; node's
    // WebCrypto rejects the X25519 import-usage the browser opener relies on).
    const opened = openSealedFromEd25519Recipient(hexToBytes(posted!.sealed), boxSeed);
    expect(new TextDecoder().decode(opened)).toBe(built.pairingOrderJson);
  });
});

// ── Static structure: the secret-free pairing wiring across the surfaces ──
const CREATE_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "create-server.js"),
  "utf8",
);
const HOME_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "home.js"),
  "utf8",
);
const BOOT_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "lib", "bootApproval.js"),
  "utf8",
);
const PAIRING_DEPOSIT_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "lib", "pairingDeposit.js"),
  "utf8",
);

describe("secret-free pairing wiring (webapp)", () => {
  it("NO pairing keypair / pairingKeyPrivHex remains in the client", () => {
    expect(BOOT_SRC).not.toContain("pairingKeyPrivHex");
    expect(BOOT_SRC).not.toContain("depositCreateTimePairing");
    expect(CREATE_SRC).not.toMatch(/bundle\.pairingKeyPrivHex/);
    // The downloaded-recipe builder embeds `pairingOrder`, never the dead key.
    expect(CREATE_SRC).toContain("recipe.pairingOrder = blobBundle.pairingOrder");
  });

  it("OFFLINE embeds the plaintext pairingOrder; DEFAULT stashes a pending deposit", () => {
    // embed-secrets ON → bake the plaintext order into the recipe, NO deposit.
    expect(CREATE_SRC).toContain("bundle.pairingOrder = pairingOrderJson");
    expect(CREATE_SRC).toContain("clearPairingDeposit(blob.serverDomain)");
    // embed-secrets OFF → stash the order so the Home reconcile seals + deposits.
    expect(CREATE_SRC).toContain("markPairingDepositPending(blob.serverDomain, pairingOrderJson)");
    // The token is persisted as this device's session token in BOTH modes.
    expect(CREATE_SRC).toContain("setSessionToken(pairing.token)");
  });

  it("home reconcile deposits the pairing order once a box registers", () => {
    expect(HOME_SRC).toContain("depositPairingIfNeeded");
    expect(HOME_SRC).toContain("pod?.identityPubKey");
  });

  it("the pairing deposit store + reconcile helper exist", () => {
    expect(PAIRING_DEPOSIT_SRC).toContain("export function markPairingDepositPending");
    expect(PAIRING_DEPOSIT_SRC).toContain("export function pendingPairingOrder");
    expect(PAIRING_DEPOSIT_SRC).toContain("export async function depositPairingIfNeeded");
  });
});
