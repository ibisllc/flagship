import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyDebugAccessGrant } from "@flagship/protocol";
// Importing the SAME file we serve to clients means the test guards the exact
// bytes + carrier shape the webapp produces.
import { buildDebugGrant } from "../public/webapp/views/create-server.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3";

describe("webapp debug-friendly grant verifies under @flagship/protocol", () => {
  it("toggle ON: the embedded v2 grant names the pasted key, ends in 7 days and verifies under the admin root", async () => {
    const adminSeed = new Uint8Array(32).fill(0x5a);
    const adminPub = ed25519.getPublicKey(adminSeed);
    const serverDomain = "kitchen.alice.flagship.services";
    const issuedAt = 1_750_000_000_000;

    const sign = async (_umk: Uint8Array, bytes: Uint8Array) => ed25519.sign(bytes, adminSeed);
    const carrierJson = await buildDebugGrant({
      serverDomain,
      sshPublicKey: `${KEY} harry@laptop`,
      issuedAt,
      sign,
      umk: new Uint8Array(1),
    });

    // The recipe sibling is a JSON STRING `{grant,signatureHex}` (the shape the
    // builder + box consume).
    const carrier = JSON.parse(carrierJson) as {
      grant: { serverDomain: string; sshPublicKey: string; issuedAt: number; expiresAt: number };
      signatureHex: string;
    };
    expect(carrier.grant).toEqual({
      serverDomain,
      sshPublicKey: KEY,
      issuedAt,
      expiresAt: issuedAt + 7 * 24 * 60 * 60 * 1000,
    });
    expect(verifyDebugAccessGrant(carrier.grant, hexToBytes(carrier.signatureHex), adminPub)).toBe(true);
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(0x33));
    expect(verifyDebugAccessGrant(carrier.grant, hexToBytes(carrier.signatureHex), otherPub)).toBe(false);
  });

  it("refuses a missing or unusable key before signing", async () => {
    let signed = false;
    const sign = async () => {
      signed = true;
      return new Uint8Array(64);
    };
    const base = { serverDomain: "kitchen.alice.flagship.services", sign, umk: new Uint8Array(1) };
    await expect(buildDebugGrant({ ...base, sshPublicKey: "" })).rejects.toThrow("Debug access needs an SSH public key.");
    await expect(buildDebugGrant({ ...base, sshPublicKey: "hello" })).rejects.toThrow(
      "That isn't an SSH public key this server can use.",
    );
    expect(signed).toBe(false);
  });
});

// ── Static structure: the two Advanced toggles + exact copy + minter wiring ──
const CREATE_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "create-server.js"),
  "utf8",
);
const INDEX_HTML = readFileSync(
  join(__dirname, "..", "public", "webapp", "index.html"),
  "utf8",
);

describe("debug-friendly + embed-secrets toggle wiring (webapp)", () => {
  it("both Advanced toggles exist and default OFF", () => {
    expect(INDEX_HTML).toContain('id="cs-embed-secrets"');
    expect(INDEX_HTML).toContain('id="cs-debug-friendly"');
    expect(INDEX_HTML).not.toMatch(/id="cs-embed-secrets"[^>]*checked/);
    expect(INDEX_HTML).not.toMatch(/id="cs-debug-friendly"[^>]*checked/);
  });

  it("the embed-secrets subtext is the EXACT new string", () => {
    expect(INDEX_HTML).toContain(
      "This embeds security keys directly in the recipe, so the server can boot even when none of your devices is online.",
    );
  });

  it("the debug-friendly subtext warns about the key and the 7-day end, and asks for a key", () => {
    expect(INDEX_HTML).toContain(
      "Anyone with this key can read everything on this server while it's on. It turns off by itself 7 days from now.",
    );
    expect(INDEX_HTML).toContain('id="cs-debug-ssh-key"');
    expect(CREATE_SRC).toContain("debugSshKey = debugFriendly ? readDebugSshKey()");
  });

  it("debug-friendly is gated behind Advanced mode in readDebugFriendly", () => {
    expect(CREATE_SRC).toContain("export function readDebugFriendly()");
    expect(CREATE_SRC).toMatch(/if \(!adv \|\| !adv\.checked \|\| !dbg\) return false/);
  });

  it("the recipe embeds debugGrant ONLY when debugFriendly is on", () => {
    expect(CREATE_SRC).toContain("if (inputs.debugFriendly)");
    expect(CREATE_SRC).toContain("bundle.debugGrant = await buildDebugGrant");
    expect(CREATE_SRC).toContain("if (blobBundle.debugGrant) recipe.debugGrant = blobBundle.debugGrant");
  });
});
