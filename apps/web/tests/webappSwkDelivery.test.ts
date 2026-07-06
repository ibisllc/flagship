import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  carrierHexToSwkDelivery,
  openAndVerifySwkDelivery,
} from "@flagship/protocol";
// The browser-shipping SWK-delivery internals — importing the SAME file we
// serve to clients means the test guards the exact bytes the webapp produces.
import { _internal } from "../public/webapp/lib/bootApproval.js";

const buildSwkDeliveryCarrier = (_internal as unknown as {
  buildSwkDeliveryCarrier: (a: {
    serverDomain: string;
    swk: Uint8Array;
    boxIdentityPub: Uint8Array;
    issuedAt: number;
    signWithIrk: (umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>;
    umk: Uint8Array;
  }) => Promise<string>;
}).buildSwkDeliveryCarrier;

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("webapp SWK-delivery carrier verifies under @flagship/protocol", () => {
  it("the deposited carrier is accepted by openAndVerifySwkDelivery (box seal + owner-IRK sig)", async () => {
    const irkSeed = new Uint8Array(32).fill(0x07);
    const irkPub = ed25519.getPublicKey(irkSeed);
    const boxSeed = new Uint8Array(32).fill(0x09);
    const boxPub = ed25519.getPublicKey(boxSeed);
    const serverDomain = "kitchen.alice.flagship.services";
    const swk = new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff);
    const issuedAt = 1_750_000_000_000;

    const signWithIrk = async (_umk: Uint8Array, bytes: Uint8Array) =>
      ed25519.sign(bytes, irkSeed);

    const carrierHex = await buildSwkDeliveryCarrier({
      serverDomain,
      swk,
      boxIdentityPub: boxPub,
      issuedAt,
      signWithIrk,
      umk: new Uint8Array(0),
    });

    // Parse + verify EXACTLY the way the box (daemon) does.
    const parsed = carrierHexToSwkDelivery(carrierHex);
    expect(parsed).not.toBeNull();
    const opened = openAndVerifySwkDelivery({
      delivery: parsed!.delivery,
      signature: parsed!.signature,
      ownerIrkPub: irkPub,
      boxIdentityPriv: boxSeed,
      serverDomain,
    });
    expect(opened).not.toBeNull();
    expect(toHex(opened!)).toBe(toHex(swk));

    // Negative control: a different owner IRK must NOT verify.
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(0x33));
    expect(
      openAndVerifySwkDelivery({
        delivery: parsed!.delivery,
        signature: parsed!.signature,
        ownerIrkPub: otherPub,
        boxIdentityPriv: boxSeed,
        serverDomain,
      }),
    ).toBeNull();
  });
});

// ── Static structure: the Advanced toggle + secret-free gating wiring ──
const CREATE_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "create-server.js"),
  "utf8",
);
const SWK_DEPOSIT_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "lib", "swkDeposit.js"),
  "utf8",
);
const HOME_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "home.js"),
  "utf8",
);
const INDEX_HTML = readFileSync(
  join(__dirname, "..", "public", "webapp", "index.html"),
  "utf8",
);

describe("secret-free recipe wiring (webapp)", () => {
  it("the Advanced + embed-secrets controls exist, default OFF", () => {
    expect(INDEX_HTML).toContain('id="cs-advanced"');
    expect(INDEX_HTML).toContain('id="cs-embed-secrets"');
    expect(INDEX_HTML).toContain('id="cs-advanced-options"');
    // The advanced sub-options are hidden by default (Advanced off).
    expect(INDEX_HTML).toMatch(/id="cs-advanced-options"[^>]*class="hidden"/);
    // Neither checkbox is `checked` in the HTML (default OFF = secret-free).
    expect(INDEX_HTML).not.toMatch(/id="cs-advanced"[^>]*checked/);
    expect(INDEX_HTML).not.toMatch(/id="cs-embed-secrets"[^>]*checked/);
  });

  it("embed-secrets is gated behind Advanced mode in readEmbedSecrets", () => {
    // Returns false unless BOTH cs-advanced is checked AND cs-embed-secrets is.
    expect(CREATE_SRC).toContain("export function readEmbedSecrets()");
    expect(CREATE_SRC).toMatch(/if \(!adv \|\| !adv\.checked \|\| !embed\) return false/);
  });

  it("the recipe embeds swkHex ONLY when embedSecrets is on, else marks a deposit pending", () => {
    expect(CREATE_SRC).toContain("if (inputs.embedSecrets)");
    expect(CREATE_SRC).toContain("bundle.swkHex = await deriveSwkFromSeed");
    expect(CREATE_SRC).toContain("markSwkDepositPending(blob.serverDomain)");
    expect(CREATE_SRC).toContain("clearSwkDeposit(blob.serverDomain)");
  });

  it("home reconcile deposits the SWK once a box registers with an identity pub", () => {
    expect(HOME_SRC).toContain("depositSwkIfNeeded");
    expect(HOME_SRC).toContain("pod?.identityPubKey");
  });

  it("the deposit store + coordinator helper exist", () => {
    expect(SWK_DEPOSIT_SRC).toContain("export function markSwkDepositPending");
    expect(SWK_DEPOSIT_SRC).toContain("export function markSwkDeposited");
    expect(SWK_DEPOSIT_SRC).toContain("export async function depositSwkIfNeeded");
  });
});
