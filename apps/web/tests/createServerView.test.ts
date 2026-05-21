/**
 * #24 — Compose draft + Deliver flow (webapp peer device) — v2 protocol.
 *
 * The full UI flow runs against a real browser (see the Playwright
 * spec at e2e/flows/s16-build-relay.spec.ts). This vitest file pins:
 *
 *   1. Static structure of the view's module surface — the IDs, the
 *      view registration, the deliver/save handlers — so a refactor
 *      can't accidentally drop them.
 *   2. The pure canonical-bytes helpers in lib/buildDraft.js still
 *      round-trip the InstallBlob format.
 *
 * v2 specifics:
 *   - The match code is derived from an ECDH shared secret inside the
 *     view itself (no helper export). Tested end-to-end by the e2e flow.
 *   - The view sends {kind:"hello"} then {kind:"deliver"} on /qr-pipe.
 *   - There is no "match-code mismatch" branch — the SAS comparison is
 *     a human visual check, not a programmatic equality assertion.
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

  it("renders the live match-code surface so users can compare across screens", () => {
    expect(VIEW_SRC).toMatch(/cs-match-code/);
  });

  it("uses the v2 wire shape — /qr-pipe + hello/deliver, no /build-relay", () => {
    expect(VIEW_SRC).toContain("/qr-pipe");
    expect(VIEW_SRC).toContain("phonePk");
    expect(VIEW_SRC).toContain("kind: \"deliver\"");
    expect(VIEW_SRC).not.toContain("/build-relay/");
    expect(VIEW_SRC).not.toContain("kind: \"blob\"");
  });

  it("derives the match code locally from the ECDH shared secret", () => {
    expect(VIEW_SRC).toContain("X25519");
    expect(VIEW_SRC).toContain("HKDF");
    expect(VIEW_SRC).toContain("flagship/qr/sas/v1");
  });

  it("gates Confirm behind a deliberate-pause timer (Tor-style 600ms)", () => {
    expect(VIEW_SRC).toContain("CONFIRM_GATE_MS");
    expect(VIEW_SRC).toContain("600");
  });

  it("dials the apex host explicitly (the webapp lives on web.flagshipserver.com)", () => {
    expect(VIEW_SRC).toContain("flagshipserver.com/qr-pipe");
  });

  it("index.html has the view-create-server slot with every wired input", () => {
    expect(INDEX_HTML).toMatch(/<section id="view-create-server"/);
    expect(INDEX_HTML).toMatch(/id="cs-server-name"/);
    expect(INDEX_HTML).toMatch(/id="cs-deliver"/);
    expect(INDEX_HTML).toMatch(/id="cs-match-code"/);
  });
});

describe("buildDraft helpers — pure functions (#24)", () => {
  it("canonicalInstallBlob produces deterministic '|'-joined bytes (v2)", async () => {
    const { canonicalInstallBlob } = await import("../public/webapp/lib/buildDraft.js");
    const blob = {
      version: 2,
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
      installerGitRef: "main",
      rckPubKey: new Uint8Array(32).fill(0xdd),
    };
    const bytes = canonicalInstallBlob(blob);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("flagship/install-blob/v1|2|home.alice.flagship.services|alice|home|")).toBe(true);
    expect(text).toContain("01ABCDEF0123456789ABCDEF01");
    expect(text).toContain("|main|");
    // v2 invariant: NO blob.issuedAt or blob.expiresAt field in canonical-bytes.
    expect(text.split("|").length).toBe(12);
    expect(new TextDecoder().decode(canonicalInstallBlob(blob))).toBe(text);
  });
});

describe("recipe TTL — single user-facing knob", () => {
  it("clampRecipeTtlMs floors at 5 minutes and ceilings at 24 hours", async () => {
    const { clampRecipeTtlMs, MIN_RECIPE_TTL_MS, MAX_RECIPE_TTL_MS, DEFAULT_RECIPE_TTL_MS } =
      await import("../public/webapp/views/create-server.js");
    expect(MIN_RECIPE_TTL_MS).toBe(5 * 60_000);
    expect(MAX_RECIPE_TTL_MS).toBe(24 * 60 * 60_000);
    expect(DEFAULT_RECIPE_TTL_MS).toBe(6 * 60 * 60_000);
    expect(clampRecipeTtlMs(0)).toBe(MIN_RECIPE_TTL_MS);
    expect(clampRecipeTtlMs(-1)).toBe(MIN_RECIPE_TTL_MS);
    expect(clampRecipeTtlMs(1_000_000_000)).toBe(MAX_RECIPE_TTL_MS);
    expect(clampRecipeTtlMs(60 * 60_000)).toBe(60 * 60_000);          // 1h
    expect(clampRecipeTtlMs(6 * 60 * 60_000)).toBe(6 * 60 * 60_000);  // 6h
    expect(clampRecipeTtlMs(NaN)).toBe(DEFAULT_RECIPE_TTL_MS);
    expect(clampRecipeTtlMs("not a number" as unknown as number)).toBe(DEFAULT_RECIPE_TTL_MS);
  });

  it("exposes a cs-ttl-hours input wired to clampRecipeTtlMs", () => {
    expect(INDEX_HTML).toMatch(/id="cs-ttl-hours"/);
    expect(VIEW_SRC).toContain("cs-ttl-hours");
    expect(VIEW_SRC).toContain("clampRecipeTtlMs");
    expect(VIEW_SRC).toContain("recipeTtlMs");
  });
});

describe("buildDraft library — file structure (#24)", () => {
  it("exports the persistence functions the view depends on", () => {
    for (const sym of ["saveDraft", "listDrafts", "getDraft", "deleteDraft"]) {
      expect(LIB_SRC).toMatch(new RegExp(`export (async )?function ${sym}\\(`));
    }
    expect(LIB_SRC).toMatch(/export (async )?function canonicalInstallBlob\(/);
  });

  it("uses IndexedDB so drafts persist across reloads", () => {
    expect(LIB_SRC).toMatch(/indexedDB\.open/);
    expect(LIB_SRC).toMatch(/buildDrafts/);
  });
});
