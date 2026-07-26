/**
 * Compose draft + download flow for a webapp-held identity.
 *
 * The full UI flow runs against a real browser (see the Playwright
 * spec at e2e/flows/s16-build-relay.spec.ts). This vitest file pins:
 *
 *   1. Static structure of the view's module surface — the IDs, the
 *      view registration, the download/save handlers — so a refactor
 *      can't accidentally drop them.
 *   2. The pure canonical-bytes helpers in lib/buildDraft.js still
 *      round-trip the InstallBlob format.
 *
 * The signed recipe is downloaded directly and opened in Flagship Studio;
 * the homepage relay is intentionally not part of this server-build flow.
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

describe("create-server view — SWK provisioning", () => {
  it("imports the box SWK derivation (deriveSwkFromSeed) from the keystore", () => {
    expect(VIEW_SRC).toMatch(/import \{[^}]*deriveSwkFromSeed[^}]*\} from "\.\.\/keystore\.js"/);
  });

  it("derives swkHex from the in-memory UMK seed + the box serverId and adds it to the bundle", () => {
    // Box derivation (DOTS via deriveSwkFromSeed), serverId = blob.serverDomain
    // (same as the STK), embedded as the recipe sibling.
    expect(VIEW_SRC).toMatch(
      /bundle\.swkHex = await deriveSwkFromSeed\(session\.umk, blob\.serverDomain\)/,
    );
  });

  it("carries the swkHex sibling into the downloaded recipe", () => {
    expect(VIEW_SRC).toMatch(/if \(blobBundle\.swkHex\) recipe\.swkHex = blobBundle\.swkHex/);
  });

  it("uses the protocol DOTS info (flagship.swk.v1), never the app-backup slashes form", () => {
    const KS_SRC = readFileSync(
      join(__dirname, "..", "public", "webapp", "keystore.js"),
      "utf8",
    );
    expect(KS_SRC).toMatch(/flagship\.swk\.v1\|\$\{serverId\}/);
    // deriveSwkFromSeed must NOT use the slash form "flagship/swk/v1".
    const fn = KS_SRC.slice(
      KS_SRC.indexOf("export async function deriveSwkFromSeed"),
      KS_SRC.indexOf("export async function deriveBakFromSeed"),
    );
    expect(fn).not.toMatch(/flagship\/swk\/v1/);
  });
});

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
  });

  it("wires Save Draft and the direct recipe download", () => {
    expect(VIEW_SRC).toMatch(/cs-save-draft.*addEventListener/s);
    expect(VIEW_SRC).toMatch(/cs-download-recipe.*addEventListener/s);
    expect(VIEW_SRC).toMatch(/downloadRecipe\(blobBundle\)/);
  });

  it("does not retain the retired homepage recipe relay", () => {
    expect(VIEW_SRC).not.toContain("cs-relay-session");
    expect(VIEW_SRC).not.toContain("/qr-pipe");
    expect(VIEW_SRC).not.toContain("Deliver to homepage");
    expect(INDEX_HTML).not.toContain("cs-match-code");
  });

  it("index.html has the view-create-server slot with every wired input", () => {
    expect(INDEX_HTML).toMatch(/<section id="view-create-server"/);
    expect(INDEX_HTML).toMatch(/id="cs-server-name"/);
    expect(INDEX_HTML).toMatch(/id="cs-download-recipe"/);
    expect(INDEX_HTML).toContain("flagshipserver.com/studio");
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
      "Every restart waits for your approval on your phone. Nothing — not even flagshipserver.com — can start it without you. The cost: a power cut means it stays down until you approve.",
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
    // Scope strictly to the group's own block (it ends at the first
    // `</div>` after the radios) so an unrelated `checked` control further
    // down the form can't leak into the count.
    const start = INDEX_HTML.indexOf('id="cs-boot-unlock"');
    const group = INDEX_HTML.slice(
      start,
      INDEX_HTML.indexOf("</div>", start) + "</div>".length,
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

describe("canonicalInstallBlob — diskEncryption byte-parity (FEATURE B / `de=`)", () => {
  // Same deterministic-Ed25519 trick: identical signatures ⟺ identical signed
  // bytes. The box re-derives these bytes when it verifies the recipe, so any
  // drift in the `de=` suffix fails box verification. We pin the EXACT suffix
  // and prove the webapp mirror matches @flagship/protocol byte-for-byte.
  const irk = deriveIRK({ seed: new Uint8Array(32).fill(7) });

  function makeBlob(opts: {
    bootUnlockMode?: "auto" | "approve";
    diskEncryption?: "luks" | "none";
  }): InstallBlob {
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
    if (opts.bootUnlockMode !== undefined) blob.bootUnlockMode = opts.bootUnlockMode;
    if (opts.diskEncryption !== undefined) blob.diskEncryption = opts.diskEncryption;
    return blob;
  }

  for (const de of ["none", "luks"] as const) {
    it(`emits the 'de=${de}' token and matches the TS canonical bytes`, () => {
      const blob = makeBlob({ diskEncryption: de });
      const jsBytes = jsCanonicalInstallBlob(blob);
      const text = new TextDecoder().decode(jsBytes);
      // de= is the final '|'-joined field (no boot/ca here).
      expect(text.endsWith(`|de=${de}`)).toBe(true);
      // Deterministic-Ed25519 byte-parity against @flagship/protocol.
      const tsSig = signInstallBlob(blob, irk);
      const jsSig = ed.sign(jsBytes, irk.privateKey);
      expect(Array.from(jsSig)).toEqual(Array.from(tsSig));
    });
  }

  it("absent diskEncryption ⇒ legacy bytes (no de= token; treated as luks)", () => {
    const text = new TextDecoder().decode(jsCanonicalInstallBlob(makeBlob({})));
    expect(text).not.toContain("de=");
    // The legacy blob still verifies under TS (no field appended).
    const blob = makeBlob({});
    const sig = signInstallBlob(blob, irk);
    expect(ed.verify(sig, jsCanonicalInstallBlob(blob), irk.publicKey)).toBe(true);
  });

  it("appends de= LAST, after bootUnlockMode", () => {
    const blob = makeBlob({
      bootUnlockMode: "approve",
      diskEncryption: "none",
    });
    const text = new TextDecoder().decode(jsCanonicalInstallBlob(blob));
    expect(text.endsWith("|approve|de=none")).toBe(true);
    // Byte-identical to the TS canonical form with both appends.
    const tsSig = signInstallBlob(blob, irk);
    const jsSig = ed.sign(jsCanonicalInstallBlob(blob), irk.privateKey);
    expect(Array.from(jsSig)).toEqual(Array.from(tsSig));
  });

  it("the de= form is exactly the legacy bytes + the appended token", () => {
    const baseText = new TextDecoder().decode(jsCanonicalInstallBlob(makeBlob({})));
    const withDe = new TextDecoder().decode(
      jsCanonicalInstallBlob(makeBlob({ diskEncryption: "none" })),
    );
    expect(withDe).toBe(baseText + "|de=none");
  });

  it("buildDraft.canonicalInstallBlob appends de= after bootUnlockMode", () => {
    const bootIdx = LIB_SRC.indexOf("b.bootUnlockMode !== undefined");
    const deIdx = LIB_SRC.indexOf("b.diskEncryption !== undefined");
    expect(bootIdx).toBeGreaterThan(-1);
    expect(deIdx).toBeGreaterThan(bootIdx);
    expect(LIB_SRC).toContain("`de=${b.diskEncryption}`");
  });
});

describe("create-server view — encrypt-disk toggle (FEATURE B)", () => {
  it("renders an 'Encrypt disk' checkbox, CHECKED (encrypted) by default", () => {
    expect(INDEX_HTML).toMatch(/<input type="checkbox" id="cs-encrypt-disk" checked/);
    expect(INDEX_HTML).toContain("Encrypt disk");
  });

  it("captions the unsafe trade-off + the Wi-Fi-only use case", () => {
    expect(INDEX_HTML).toContain("cs-encrypt-disk-hint");
    expect(INDEX_HTML).toMatch(/Wi-Fi-only/);
    expect(INDEX_HTML).toMatch(/not encrypted/);
    expect(INDEX_HTML).toMatch(/less safe/);
  });

  it("reads the checkbox (default luks) and threads diskEncryption onto the blob", () => {
    expect(VIEW_SRC).toContain("cs-encrypt-disk");
    expect(VIEW_SRC).toMatch(/export function readDiskEncryption\(/);
    // Default-safe: absent control ⇒ "luks"; unchecked ⇒ "none".
    expect(VIEW_SRC).toMatch(/return el\.checked \? "luks" : "none"/);
    // Only "none" is set on the blob (luks = absent field = legacy bytes).
    expect(VIEW_SRC).toMatch(
      /if \(inputs\.diskEncryption === "none"\) blob\.diskEncryption = "none"/,
    );
    // The downloaded recipe carries whatever the blob carried.
    expect(VIEW_SRC).toMatch(/onWireBlob\.diskEncryption = blob\.diskEncryption/);
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
