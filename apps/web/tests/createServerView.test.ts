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
import {
  signInstallBlob,
  deriveIRK,
  ed,
  type InstallBlob,
} from "@flagship/protocol";
import { canonicalInstallBlob as jsCanonicalInstallBlob } from "../public/webapp/lib/buildDraft.js";

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

describe("create-server view — boot-unlock-mode chooser (§7a.1)", () => {
  it("renders the question prompt", () => {
    expect(INDEX_HTML).toContain(
      "How should this server unlock when it restarts?",
    );
  });

  it("offers both modes with the exact user-facing copy", () => {
    // Reboots-on-its-own (DEFAULT)
    expect(INDEX_HTML).toContain("🔄 Reboots on its own");
    expect(INDEX_HTML).toContain(
      "Restarts by itself, no phone needed — good for flaky power or connections. flagshipserver.com still can't read your disk key, and you can revoke a stolen server from your phone. Not theft-proof: someone who powers it on first could boot it.",
    );
    // Authorize-each-boot
    expect(INDEX_HTML).toContain("🔐 Authorize each boot");
    expect(INDEX_HTML).toContain(
      "Every restart waits for your Face ID / fingerprint. Nothing — not even flagshipserver.com — can start it without you. The cost: a power cut means it stays down until you approve.",
    );
  });

  it("wires both radio values under a single group", () => {
    expect(INDEX_HTML).toMatch(
      /<input type="radio" name="cs-boot-unlock" value="auto" checked/,
    );
    expect(INDEX_HTML).toMatch(
      /<input type="radio" name="cs-boot-unlock" value="approve"/,
    );
  });

  it("defaults to auto: only the auto radio is pre-checked", () => {
    // exactly one `checked` attribute in the boot-unlock group, on `auto`.
    const group = INDEX_HTML.slice(
      INDEX_HTML.indexOf('id="cs-boot-unlock"'),
      INDEX_HTML.indexOf('id="cs-boot-unlock"') + 1200,
    );
    const checks = group.match(/checked/g) || [];
    expect(checks.length).toBe(1);
    expect(group).toMatch(/value="auto" checked/);
    expect(group).not.toMatch(/value="approve"[^>]*checked/);
  });

  it("reads the mode (default auto) and threads it into the signed blob", () => {
    // The reader defaults to auto and only "approve" survives.
    expect(VIEW_SRC).toContain('name="cs-boot-unlock"');
    expect(VIEW_SRC).toMatch(/bootUnlockMode/);
    // Only "approve" is set on the blob (auto = absent field = legacy bytes).
    expect(VIEW_SRC).toMatch(
      /if \(bootUnlockMode === "approve"\) blob\.bootUnlockMode = "approve"/,
    );
    // The downloaded recipe carries whatever the blob carried.
    expect(VIEW_SRC).toMatch(/onWireBlob\.bootUnlockMode = blob\.bootUnlockMode/);
  });
});

describe("create-server view — server-name obeys the username rules (Change B)", () => {
  it("validates the server name with the RFC-1123 DNS-label regex (interior hyphens allowed)", () => {
    // Server names are LOOSER than usernames: a standalone DNS label with
    // interior hyphens. Mirror of validateServerLabel in labels.ts.
    expect(VIEW_SRC).toContain("SERVER_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/");
    expect(VIEW_SRC).not.toContain("SERVER_NAME_RE = /^[a-z0-9]{1,63}$/");
  });

  it("rejects reserved server labels client-side", () => {
    expect(VIEW_SRC).toContain("RESERVED_SERVER_LABELS");
    expect(VIEW_SRC).toMatch(/RESERVED_SERVER_LABELS\.has\(serverName\)/);
  });

  it("shows an inline hint + error for the server-name field", () => {
    expect(INDEX_HTML).toContain("cs-server-name-hint");
    expect(INDEX_HTML).toContain("cs-server-name-error");
    expect(VIEW_SRC).toContain("wireServerNameValidation");
  });

  it("the error copy explains hyphens are allowed but not at the start or end", () => {
    expect(VIEW_SRC).toMatch(/not at the start or end/);
  });
});

describe("create-server view — cancel-the-server frees the name (Change A)", () => {
  it("offers a 'Cancel server (free the name)' action on delivered drafts", () => {
    expect(VIEW_SRC).toContain("Cancel server (free the name)");
    expect(VIEW_SRC).toMatch(/data-action="cancel-server"/);
  });

  it("wires the cancel-server action to the release helper", () => {
    expect(VIEW_SRC).toMatch(/import \{ releaseServerName, serverDomainOf \}/);
    expect(VIEW_SRC).toMatch(/await releaseServerName\(/);
    expect(VIEW_SRC).toMatch(/async function cancelServer\(/);
  });

  it("also best-effort revokes the install auth-code", () => {
    expect(VIEW_SRC).toContain("flagship/auth-code-revoke/v1");
    expect(VIEW_SRC).toMatch(/revokeAuthCodeBestEffort/);
  });
});

describe("releaseServer helper — IRK-signed release of the name (Change A)", () => {
  it("posts the signed release to /api/server/release with the canonical tag", async () => {
    const { releaseServerName, serverDomainOf, TAG_RELEASE_SERVER_NAME } = await import(
      "../public/webapp/lib/releaseServer.js"
    );
    expect(TAG_RELEASE_SERVER_NAME).toBe("flagship/release-server-name/v1");
    expect(serverDomainOf("home", "harry")).toBe("home.harry.flagship.services");

    let captured: { url: string; body: unknown } | null = null;
    const fakeFetch = async (url: string, init: { body: string }) => {
      captured = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, routingReleased: true }),
      };
    };
    const signWithIrk = async () => new Uint8Array(64).fill(7);
    const out = await releaseServerName(
      {
        username: "harry",
        serverDomain: "home.harry.flagship.services",
        umk: new Uint8Array(32).fill(1),
        signWithIrk,
      },
      { fetch: fakeFetch, origin: "https://flagshipserver.com", now: () => 1700000000000 },
    );
    expect(out.ok).toBe(true);
    expect(captured!.url).toBe("https://flagshipserver.com/api/server/release");
    const body = captured!.body as {
      request: { username: string; serverDomain: string; issuedAt: number };
      signature: string;
    };
    expect(body.request.username).toBe("harry");
    expect(body.request.serverDomain).toBe("home.harry.flagship.services");
    expect(body.request.issuedAt).toBe(1700000000000);
    expect(body.signature).toBe("07".repeat(64));
  });

  it("throws (so the caller surfaces it) on a non-2xx response", async () => {
    const { releaseServerName } = await import("../public/webapp/lib/releaseServer.js");
    const fakeFetch = async () => ({ ok: false, status: 403, text: async () => "nope" });
    await expect(
      releaseServerName(
        {
          username: "harry",
          serverDomain: "home.harry.flagship.services",
          umk: new Uint8Array(32).fill(1),
          signWithIrk: async () => new Uint8Array(64),
        },
        { fetch: fakeFetch },
      ),
    ).rejects.toThrow(/release failed \(403\)/);
  });

  it("refuses to sign without an unlocked session (no umk)", async () => {
    const { releaseServerName } = await import("../public/webapp/lib/releaseServer.js");
    await expect(
      releaseServerName({
        username: "harry",
        serverDomain: "home.harry.flagship.services",
        umk: null,
        signWithIrk: async () => new Uint8Array(64),
      }),
    ).rejects.toThrow(/unlock the webapp first/);
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

  it("appends bootUnlockMode only when present, as the LAST '|'-joined field", async () => {
    const { canonicalInstallBlob } = await import("../public/webapp/lib/buildDraft.js");
    const base = {
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
    const legacy = new TextDecoder().decode(canonicalInstallBlob(base));
    // Absent field === legacy bytes (old signatures keep verifying).
    expect(legacy.split("|").length).toBe(12);
    // Present field is appended after rckPubKey, '|'-joined, as the LAST part.
    expect(
      new TextDecoder().decode(canonicalInstallBlob({ ...base, bootUnlockMode: "approve" })),
    ).toBe(legacy + "|approve");
    expect(
      new TextDecoder().decode(canonicalInstallBlob({ ...base, bootUnlockMode: "auto" })),
    ).toBe(legacy + "|auto");
  });
});

describe("canonicalInstallBlob — byte-parity with @flagship/protocol", () => {
  // Ed25519 is deterministic: identical message bytes under the same key
  // produce identical signatures. We sign the JS-mirror's canonical bytes
  // directly with `ed`, and compare to the TS `signInstallBlob` (which uses
  // the TS-internal canonicalInstallBlob). Equal sigs ⟺ identical bytes —
  // proving the webapp mirror is byte-for-byte the TS canonical form, with
  // AND without bootUnlockMode.
  const irk = deriveIRK({ seed: new Uint8Array(32).fill(7) });

  function makeBlob(bootUnlockMode?: "auto" | "approve"): InstallBlob {
    const blob: InstallBlob = {
      version: 2,
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      serverName: "home",
      phoneDelegatedPubKey: new Uint8Array(32).fill(0xaa),
      registrationUrl: "https://flagship.services/api/server/register",
      authCode: {
        version: 1,
        serial: "01ABCDEF0123456789ABCDEF01",
        username: "alice",
        serverName: "home",
        serverDomain: "home.alice.flagship.services",
        delegatedPubKey: new Uint8Array(32).fill(0xee),
        userPubKey: new Uint8Array(32).fill(0xbb),
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_360_000,
      },
      authCodeUserSignature: new Uint8Array(64).fill(0xcc),
      installerGitRef: "main",
      rckPubKey: new Uint8Array(32).fill(0xdd),
    };
    if (bootUnlockMode !== undefined) blob.bootUnlockMode = bootUnlockMode;
    return blob;
  }

  for (const mode of [undefined, "auto", "approve"] as const) {
    it(`matches the TS canonical bytes (bootUnlockMode=${mode ?? "absent"})`, () => {
      const blob = makeBlob(mode);
      const tsSig = signInstallBlob(blob, irk);
      const jsBytes = jsCanonicalInstallBlob(blob);
      const jsSig = ed.sign(jsBytes, irk.privateKey);
      // Identical signatures prove identical signed bytes across the two
      // implementations (deterministic Ed25519).
      expect(Array.from(jsSig)).toEqual(Array.from(tsSig));
    });
  }

  it("absence is byte-identical to legacy (pre-bootUnlockMode) blobs", () => {
    const legacy = jsCanonicalInstallBlob(makeBlob());
    const withAuto = jsCanonicalInstallBlob(makeBlob("auto"));
    // The legacy bytes are a strict prefix of the auto bytes (+'|auto').
    const legacyText = new TextDecoder().decode(legacy);
    const autoText = new TextDecoder().decode(withAuto);
    expect(autoText).toBe(legacyText + "|auto");
    // And the legacy blob still verifies under TS (no field appended).
    const sig = signInstallBlob(makeBlob(), irk);
    expect(ed.verify(sig, legacy, irk.publicKey)).toBe(true);
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
