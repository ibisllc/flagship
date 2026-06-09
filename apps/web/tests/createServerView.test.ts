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
    expect(VIEW_SRC).toMatch(/cs-cert-autonomy/);
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

describe("canonicalInstallBlob — certAutonomy byte-parity (per-user-cert)", () => {
  // Same deterministic-Ed25519 trick as above: identical signatures ⟺
  // identical signed bytes. We additionally pin the exact `ca=<mode>:<days>`
  // suffix the webapp must emit, since the box re-derives these bytes when it
  // verifies the recipe — any drift fails box verification.
  const irk = deriveIRK({ seed: new Uint8Array(32).fill(7) });

  type CertAutonomy = { mode: "managed" | "autonomous"; offlineWindowDays?: number };

  function makeBlob(opts: {
    bootUnlockMode?: "auto" | "approve";
    certAutonomy?: CertAutonomy;
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
    if (opts.certAutonomy !== undefined) blob.certAutonomy = opts.certAutonomy;
    return blob;
  }

  // The picker's finite options + the Indefinite escape hatch, mapped to the
  // exact certAutonomy object the view threads onto the blob.
  const cases: { label: string; ca: CertAutonomy; suffix: string }[] = [
    { label: "managed:3", ca: { mode: "managed", offlineWindowDays: 3 }, suffix: "ca=managed:3" },
    { label: "managed:7", ca: { mode: "managed", offlineWindowDays: 7 }, suffix: "ca=managed:7" },
    { label: "managed:15", ca: { mode: "managed", offlineWindowDays: 15 }, suffix: "ca=managed:15" },
    { label: "managed:30", ca: { mode: "managed", offlineWindowDays: 30 }, suffix: "ca=managed:30" },
    { label: "managed:90", ca: { mode: "managed", offlineWindowDays: 90 }, suffix: "ca=managed:90" },
    // Indefinite ⇒ { mode: "autonomous" } ⇒ days default to 0 on the wire.
    { label: "autonomous", ca: { mode: "autonomous" }, suffix: "ca=autonomous:0" },
  ];

  for (const c of cases) {
    it(`emits the '${c.suffix}' token and matches the TS canonical bytes (${c.label})`, () => {
      const blob = makeBlob({ certAutonomy: c.ca });
      const jsBytes = jsCanonicalInstallBlob(blob);
      const text = new TextDecoder().decode(jsBytes);
      // The canonical string ENDS with the expected ca= token (no
      // bootUnlockMode here, so ca= is the final '|'-joined field).
      expect(text.endsWith(`|${c.suffix}`)).toBe(true);
      // Deterministic-Ed25519 byte-parity against @flagship/protocol.
      const tsSig = signInstallBlob(blob, irk);
      const jsSig = ed.sign(jsBytes, irk.privateKey);
      expect(Array.from(jsSig)).toEqual(Array.from(tsSig));
    });
  }

  it("appends ca= AFTER bootUnlockMode (order: …|<rck>|approve|ca=managed:7)", () => {
    const withApprove = makeBlob({
      bootUnlockMode: "approve",
      certAutonomy: { mode: "managed", offlineWindowDays: 7 },
    });
    const text = new TextDecoder().decode(jsCanonicalInstallBlob(withApprove));
    // bootUnlockMode precedes the ca= token; ca= is last.
    expect(text.endsWith("|approve|ca=managed:7")).toBe(true);
    // And it is byte-identical to the TS canonical form.
    const tsSig = signInstallBlob(withApprove, irk);
    const jsSig = ed.sign(jsCanonicalInstallBlob(withApprove), irk.privateKey);
    expect(Array.from(jsSig)).toEqual(Array.from(tsSig));
  });

  it("certAutonomy absent ⇒ legacy bytes (no ca= token appended)", () => {
    const text = new TextDecoder().decode(jsCanonicalInstallBlob(makeBlob({})));
    expect(text).not.toContain("ca=");
  });

  it("ordering matches: managed:7 token is exactly the rck-hex field + '|ca=managed:7'", () => {
    const base = makeBlob({});
    const baseText = new TextDecoder().decode(jsCanonicalInstallBlob(base));
    const withCa = new TextDecoder().decode(
      jsCanonicalInstallBlob(makeBlob({ certAutonomy: { mode: "managed", offlineWindowDays: 7 } })),
    );
    // The ca= form is exactly the legacy bytes + the appended token.
    expect(withCa).toBe(baseText + "|ca=managed:7");
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
    certAutonomy?: { mode: "managed" | "autonomous"; offlineWindowDays?: number };
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
    if (opts.certAutonomy !== undefined) blob.certAutonomy = opts.certAutonomy;
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

  it("appends de= LAST, after bootUnlockMode AND certAutonomy", () => {
    const blob = makeBlob({
      bootUnlockMode: "approve",
      certAutonomy: { mode: "managed", offlineWindowDays: 7 },
      diskEncryption: "none",
    });
    const text = new TextDecoder().decode(jsCanonicalInstallBlob(blob));
    expect(text.endsWith("|approve|ca=managed:7|de=none")).toBe(true);
    // Byte-identical to the TS canonical form with all three appends.
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

  it("buildDraft.canonicalInstallBlob appends de= after certAutonomy", () => {
    const caIdx = LIB_SRC.indexOf("b.certAutonomy !== undefined");
    const deIdx = LIB_SRC.indexOf("b.diskEncryption !== undefined");
    expect(caIdx).toBeGreaterThan(-1);
    expect(deIdx).toBeGreaterThan(caIdx);
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

describe("create-server view — cert-autonomy picker (per-user-cert)", () => {
  it("renders the who-renews question prompt", () => {
    expect(INDEX_HTML).toContain("Who renews this server's certificate?");
  });

  it("offers a binary managed/autonomous choice, defaulting to managed", () => {
    const sel = INDEX_HTML.slice(
      INDEX_HTML.indexOf('id="cs-cert-autonomy"'),
      INDEX_HTML.indexOf('id="cs-cert-autonomy"') + 400,
    );
    expect(sel).toMatch(/<option value="managed" selected>/);
    expect(sel).toMatch(/<option value="autonomous">/);
    // The old per-server days picker is gone.
    expect(sel).not.toMatch(/value="indefinite"/);
    expect(sel).not.toMatch(/value="90"/);
    // Exactly one option is preselected, and it's managed.
    const selected = sel.match(/selected/g) || [];
    expect(selected.length).toBe(1);
  });

  it("reads the picker and threads certAutonomy into the signed blob", () => {
    // The reader maps autonomous→self-mint, managed→account-wide window.
    expect(VIEW_SRC).toContain("cs-cert-autonomy");
    expect(VIEW_SRC).toMatch(/export function readCertAutonomy\(/);
    expect(VIEW_SRC).toMatch(/mode: "autonomous"/);
    expect(VIEW_SRC).toMatch(/mode: "managed", offlineWindowDays: getCertValidityDays\(\)/);
    // The blob carries it (mirror of the bootUnlockMode threading).
    expect(VIEW_SRC).toMatch(/blob\.certAutonomy = inputs\.certAutonomy/);
    // The downloaded recipe carries whatever the blob carried.
    expect(VIEW_SRC).toMatch(/onWireBlob\.certAutonomy = blob\.certAutonomy/);
  });

  it("buildDraft.canonicalInstallBlob appends ca= after bootUnlockMode", () => {
    // The lib mirrors the TS append order: bootUnlockMode, then ca=.
    const bootIdx = LIB_SRC.indexOf("b.bootUnlockMode !== undefined");
    const caIdx = LIB_SRC.indexOf("b.certAutonomy !== undefined");
    expect(bootIdx).toBeGreaterThan(-1);
    expect(caIdx).toBeGreaterThan(bootIdx);
    expect(LIB_SRC).toContain("`ca=${b.certAutonomy.mode}:${b.certAutonomy.offlineWindowDays ?? 0}`");
  });

  it("exposes the account-wide validity options + default as module exports", async () => {
    const { CERT_VALIDITY_OPTIONS, DEFAULT_CERT_VALIDITY_DAYS } = await import(
      "../public/webapp/lib/certValidity.js"
    );
    expect(CERT_VALIDITY_OPTIONS).toEqual([7, 30, 90]);
    expect(DEFAULT_CERT_VALIDITY_DAYS).toBe(30);
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
