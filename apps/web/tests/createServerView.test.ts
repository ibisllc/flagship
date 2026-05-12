/**
 * #24 — Compose draft + Deliver now flow (webapp peer device).
 *
 * The full UI flow runs against a real browser (see the Playwright
 * spec at e2e/flows/s16-build-relay.spec.ts). This vitest file pins:
 *
 *   1. Static structure of the view's module surface — the IDs, the
 *      view registration, the deliver/save handlers — so a refactor
 *      can't accidentally drop them.
 *   2. The pure crypto + canonical-bytes helpers in lib/buildDraft.js.
 *      `deriveMatchCode` is tested against the SERVER-side
 *      `apps/com/src/buildRelay.ts deriveMatchCode` to guarantee both
 *      surfaces produce the same digits on identical inputs (the
 *      load-bearing security property — the user visually compares
 *      both surfaces before approving the transfer).
 *   3. `sealForBrowserKey` round-trips through an X25519 receiver
 *      derived from a fresh ephemeral keypair, proving the wire format
 *      ([ephPub || nonce || AES-GCM(plaintext)]) is decryptable on the
 *      other side.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VIEW_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "create-server.js"),
  "utf8",
);
const LIB_SRC = readFileSync(
  join(__dirname, "..", "public", "webapp", "lib", "buildDraft.js"),
  "utf8",
);
const INDEX_HTML = readFileSync(
  join(__dirname, "..", "public", "webapp", "index.html"),
  "utf8",
);

describe("create-server view — static structure (#24)", () => {
  it("registers view-create-server with the router", () => {
    expect(VIEW_SRC).toMatch(/registerView\(['"]view-create-server['"]\)/);
  });

  it("exports both entry hooks the app shell wires", () => {
    expect(VIEW_SRC).toMatch(/export function initCreateServerView\(/);
    expect(VIEW_SRC).toMatch(/export (async )?function enterCreateServer\(/);
  });

  it("provides the inputs the user fills in", () => {
    expect(VIEW_SRC).toMatch(/cs-server-name/);
    expect(VIEW_SRC).toMatch(/cs-backup-policy/);
    expect(VIEW_SRC).toMatch(/cs-llm-pref/);
    expect(VIEW_SRC).toMatch(/cs-relay-session/);
  });

  it("wires the two primary actions: Save Draft + Deliver Now", () => {
    expect(VIEW_SRC).toMatch(/cs-save-draft.*addEventListener/s);
    expect(VIEW_SRC).toMatch(/cs-deliver.*addEventListener/s);
  });

  it("renders the live match-code surface so users can compare with /build/", () => {
    expect(VIEW_SRC).toMatch(/cs-match-code/);
    expect(VIEW_SRC).toMatch(/deriveMatchCode/);
  });

  it("refuses to deliver when the local + relay-reported match codes disagree", () => {
    expect(VIEW_SRC).toMatch(/match.?code mismatch/i);
  });

  it("dials the apex host explicitly (the webapp lives on web.flagshipserver.com)", () => {
    expect(VIEW_SRC).toMatch(/web\.flagshipserver\.com.*flagshipserver\.com/);
  });

  it("index.html has the view-create-server slot with every wired input", () => {
    expect(INDEX_HTML).toMatch(/<section id="view-create-server"/);
    expect(INDEX_HTML).toMatch(/id="cs-server-name"/);
    expect(INDEX_HTML).toMatch(/id="cs-deliver"/);
    expect(INDEX_HTML).toMatch(/id="cs-match-code"/);
  });
});

describe("buildDraft helpers — pure functions (#24)", () => {
  it("canonicalInstallBlob produces deterministic '|'-joined bytes", async () => {
    const { canonicalInstallBlob } = await import("../public/webapp/lib/buildDraft.js");
    const blob = {
      version: 1,
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      serverName: "home",
      phoneDelegatedPubKey: new Uint8Array(32).fill(0xaa),
      registrationUrl: "https://flagship.services/api/server/register",
      authCode: {
        serial: "01ABCDEF0123456789ABCDEF01",
        userPubKey: new Uint8Array(32).fill(0xbb),
      },
      authCodeUserSignature: new Uint8Array(64).fill(0xcc),
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
      installerGitRef: "main",
      rckPubKey: new Uint8Array(32).fill(0xdd),
    };
    const bytes = canonicalInstallBlob(blob);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("flagship/install-blob/v1|1|home.alice.flagship.services|alice|home|")).toBe(true);
    expect(text).toContain("01ABCDEF0123456789ABCDEF01");
    expect(text).toContain("|main|");
    // Determinism: same inputs → same bytes.
    expect(new TextDecoder().decode(canonicalInstallBlob(blob))).toBe(text);
  });

  it("deriveMatchCode matches the server-side implementation byte-for-byte", async () => {
    const { deriveMatchCode: clientDerive } = await import(
      "../public/webapp/lib/buildDraft.js"
    );
    const { deriveMatchCode: serverDerive } = await import(
      "../../com/src/buildRelay.ts"
    );
    const sessionId = "s_test_0123456789";
    const browserPkHex = "11".repeat(32);
    const a = await clientDerive(sessionId, browserPkHex);
    const b = await serverDerive(sessionId, browserPkHex);
    expect(a).toBe(b);
    expect(a).toMatch(/^\d{6}$/);
  });

  it("deriveMatchCode is sensitive to both sessionId and browserPk", async () => {
    const { deriveMatchCode } = await import("../public/webapp/lib/buildDraft.js");
    const base = await deriveMatchCode("s_a", "22".repeat(32));
    const diffSession = await deriveMatchCode("s_b", "22".repeat(32));
    const diffKey = await deriveMatchCode("s_a", "33".repeat(32));
    expect(base).not.toBe(diffSession);
    expect(base).not.toBe(diffKey);
  });

  it("sealForBrowserKey produces an X25519-decryptable [ephPub || nonce || ct] envelope", async () => {
    const { sealForBrowserKey } = await import("../public/webapp/lib/buildDraft.js");
    // Generate a fresh recipient X25519 keypair (simulates the /build/ browser).
    const recipient = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
    const recipientPubBytes = new Uint8Array(
      await crypto.subtle.exportKey("raw", recipient.publicKey),
    );
    let recipientPubHex = "";
    for (const b of recipientPubBytes) recipientPubHex += b.toString(16).padStart(2, "0");

    const plaintext = new TextEncoder().encode("install-blob plaintext, this is secret");
    const sealed = await sealForBrowserKey(plaintext, recipientPubHex);

    expect(sealed.byteLength).toBe(32 + 12 + plaintext.byteLength + 16); // ephPub + nonce + GCM tag

    // Decrypt as the recipient would.
    const ephPub = sealed.slice(0, 32);
    const nonce = sealed.slice(32, 44);
    const ct = sealed.slice(44);
    const ephPubKey = await crypto.subtle.importKey("raw", ephPub, "X25519", false, []);
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "X25519", public: ephPubKey },
      recipient.privateKey,
      256,
    );
    const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
    const symBits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: ephPub,
        info: new TextEncoder().encode("flagship.seal.v1"),
      },
      hkdfKey,
      256,
    );
    const aesKey = await crypto.subtle.importKey("raw", symBits, "AES-GCM", false, ["decrypt"]);
    const decrypted = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ct),
    );
    expect(new TextDecoder().decode(decrypted)).toBe(
      "install-blob plaintext, this is secret",
    );
  });

  it("sealForBrowserKey rejects a non-32-byte recipient pubkey", async () => {
    const { sealForBrowserKey } = await import("../public/webapp/lib/buildDraft.js");
    await expect(
      sealForBrowserKey(new Uint8Array([1, 2, 3]), "deadbeef"),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe("buildDraft library — file structure (#24)", () => {
  it("exports the four functions the view depends on", () => {
    for (const sym of ["saveDraft", "listDrafts", "getDraft", "deleteDraft"]) {
      expect(LIB_SRC).toMatch(new RegExp(`export (async )?function ${sym}\\(`));
    }
    for (const sym of ["canonicalInstallBlob", "sealForBrowserKey", "deriveMatchCode"]) {
      expect(LIB_SRC).toMatch(new RegExp(`export (async )?function ${sym}\\(`));
    }
  });

  it("uses IndexedDB so drafts persist across reloads", () => {
    expect(LIB_SRC).toMatch(/indexedDB\.open/);
    expect(LIB_SRC).toMatch(/buildDrafts/);
  });
});
