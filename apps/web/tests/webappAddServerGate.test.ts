// Adding a server to the account (create, co-manage, take over, import a
// backup) is for the account's admin devices only, wherever the flow is
// opened from, and minting a recipe never mints an admin root: only opening
// the account does. Mirrors iOS AddServerGateTests and Android
// AddServerGateTest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const keystoreSpies = vi.hoisted(() => ({
  generateAdminRoot: vi.fn(async () => {
    throw new Error("stray admin root minted");
  }),
}));
vi.mock("../public/webapp/keystore.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, generateAdminRoot: keystoreSpies.generateAdminRoot };
});
const modal = vi.hoisted(() => ({ inlineAlert: vi.fn(async () => {}), inlinePrompt: vi.fn(async () => null) }));
vi.mock("../public/webapp/lib/modal.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, inlineAlert: modal.inlineAlert, inlinePrompt: modal.inlinePrompt };
});
const router = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("../public/webapp/lib/router.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, show: router.show };
});

import {
  ADD_SERVERS_ADMIN_ONLY,
  AddServerRefusedError,
  canAddServers,
  recipeAdminRootPin,
} from "../public/webapp/lib/addServerGate.js";
import { humanError } from "../public/webapp/lib/humanError.js";
import { getSession } from "../public/webapp/lib/state.js";
import { enterCreateServer, mintInstallBlobBundle } from "../public/webapp/views/create-server.js";
import { promptShareLink } from "../public/webapp/views/share-accept.js";
import { enterTransferClaim } from "../public/webapp/views/transfer-claim.js";
import { openImportBackup } from "../public/webapp/views/import-backup.js";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const src = (p: string) => readFileSync(resolve(WEBAPP, p), "utf8");

const INPUTS = { serverName: "home", recipeTtlMs: 3_600_000, bootUnlockMode: "auto", diskEncryption: "luks" };

function nonAdminSession() {
  return { umk: new Uint8Array(32).fill(1), irk: { publicKey: new Uint8Array(32).fill(2) }, adminRootSeed: null };
}

describe("the rule", () => {
  it("only an admin device, or a demo account's device, may add servers", () => {
    expect(canAddServers({ adminRootSeed: new Uint8Array(32) }, null)).toBe(true);
    expect(canAddServers({ adminRootSeed: null }, null)).toBe(false);
    expect(canAddServers({}, { demoServer: { fqdn: "home.demo.flagship.services" } })).toBe(true);
    expect(ADD_SERVERS_ADMIN_ONLY).toBe("Only an admin device of this account can add servers.");
  });

  it("a recipe pins the admin root the device holds, refuses without one, and a demo pins none", async () => {
    const seed = new Uint8Array(32).fill(7);
    await expect(recipeAdminRootPin({ adminRootSeed: seed }, { pubHexOf: async () => "ab" })).resolves.toBe("ab");
    await expect(recipeAdminRootPin({ adminRootSeed: null }, { isDemo: true, pubHexOf: async () => "ab" })).resolves.toBeNull();
    await expect(recipeAdminRootPin({ adminRootSeed: null }, { pubHexOf: async () => "ab" })).rejects.toBeInstanceOf(
      AddServerRefusedError,
    );
  });

  it("the refusal reads the same wherever it is shown", () => {
    expect(new AddServerRefusedError().message).toBe(ADD_SERVERS_ADMIN_ONLY);
    expect(humanError(new AddServerRefusedError())).toBe(ADD_SERVERS_ADMIN_ONLY);
  });
});

describe("minting a recipe", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    keystoreSpies.generateAdminRoot.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  // The stray-mint case: a non-admin device of an admin-pinned account used
  // to mint a brand-new admin root here and pin it into the new box.
  it("refuses a device without the admin root before any call, and mints no admin root", async () => {
    await expect(mintInstallBlobBundle(nonAdminSession(), "harry", INPUTS, { skipClaim: true })).rejects.toThrow(
      ADD_SERVERS_ADMIN_ONLY,
    );
    await expect(mintInstallBlobBundle(nonAdminSession(), "harry", INPUTS, { skipClaim: false })).rejects.toBeInstanceOf(
      AddServerRefusedError,
    );
    expect(keystoreSpies.generateAdminRoot).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pins the admin root an admin device already holds", async () => {
    const pub = "cd".repeat(32);
    let issued: { code?: { adminRootPubKey?: string } } | null = null;
    fetchSpy.mockImplementation(async (url: string, init: { body: string }) => {
      if (String(url).endsWith("/api/auth-code/issue")) issued = JSON.parse(init.body);
      return { ok: false, status: 500, text: async () => "stop here", json: async () => ({}) };
    });
    const session = { ...nonAdminSession(), adminRootSeed: new Uint8Array(32).fill(9) };
    await expect(
      mintInstallBlobBundle(session, "harry", INPUTS, { skipClaim: true, adminRootPubHexOf: async () => pub }),
    ).rejects.toThrow();
    expect(issued?.code?.adminRootPubKey).toBe(pub);
    expect(keystoreSpies.generateAdminRoot).not.toHaveBeenCalled();
  });

  it("only opening the account mints an admin root", () => {
    expect(src("views/create-server.js")).not.toContain("ensureAdminRoot");
    const users = ["lib/openAccount.js"];
    for (const f of ["views/create-server.js", "views/import-backup.js", "views/share-accept.js", "views/transfer-claim.js"]) {
      expect(src(f)).not.toMatch(/ensureAdminRoot|generateAdminRoot/);
    }
    expect(src(users[0])).toContain("ensureAdminRoot");
  });
});

describe("every way into a flow that adds a server", () => {
  beforeEach(() => {
    modal.inlineAlert.mockClear();
    modal.inlinePrompt.mockClear();
    router.show.mockClear();
    Object.assign(getSession(), nonAdminSession());
  });
  afterEach(() => Object.assign(getSession(), { umk: null, irk: null, adminRootSeed: null }));

  const refused = () => {
    expect(modal.inlineAlert).toHaveBeenCalledWith({ title: "Admin devices only", message: ADD_SERVERS_ADMIN_ONLY });
  };

  it("create a server (Home, Settings' row, ?view=create-server)", async () => {
    await enterCreateServer();
    refused();
    expect(router.show).not.toHaveBeenCalledWith("view-create-server");
  });

  it("co-manage from a pasted share link", async () => {
    await promptShareLink();
    refused();
    expect(modal.inlinePrompt).not.toHaveBeenCalled();
  });

  it("take over a box", async () => {
    await enterTransferClaim();
    refused();
  });

  it("import a backup (Home's menu or a waiting server's Send the backup)", async () => {
    await openImportBackup();
    refused();
  });

  it("an opened share link shows the refusal in place of the offer", () => {
    const js = src("views/share-accept.js");
    const enter = js.slice(js.indexOf("export async function enterShareAccept"));
    const guard = enter.indexOf("if (!canAddServers()) {");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(enter.indexOf("openShareLink("));
    expect(enter.slice(guard, guard + 120)).toContain("errorCard(ADD_SERVERS_ADMIN_ONLY)");
  });

  it("transfer and create-server deep links land on Home with the refusal", () => {
    const js = src("lib/deepLink.js");
    expect(js.match(/if \(!canAddServers\(\)\) return refuseAddServer\(\{ home: true \}\);/g)).toHaveLength(2);
    expect(js.indexOf("refuseAddServer({ home: true })")).toBeLessThan(js.indexOf("enterTransferClaim(offer)"));
  });
});

// `.com` enforces the rule too (owner rule 2026-10-16): the issue carries the
// admin root's approval of the AuthCode, which test-vectors/add-server pins.
describe("what `.com` checks", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const V = JSON.parse(
    readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/add-server/vectors.json"), "utf8"),
  ) as any;
  const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const codeOf = (f: Record<string, unknown>) => ({
    ...f,
    delegatedPubKey: fromHex(f.delegatedPubKey as string),
    userPubKey: fromHex(f.userPubKey as string),
  });

  it("builds the vectors' AuthCode and admin forms, and signs the pinned approval", async () => {
    const { authCodeCanonicalBytes, authCodeAdminCanonicalBytes } = await import(
      "../public/webapp/views/create-server.js"
    );
    const ks = await import("../public/webapp/keystore.js");
    const { ed } = await import("@flagship/protocol");
    const f = V.authCode.fields;
    const c = codeOf(f);
    expect(text(authCodeCanonicalBytes(c, f.adminRootPubKey))).toBe(V.authCode.canonical);
    const adminBytes = authCodeAdminCanonicalBytes(c, f.adminRootPubKey);
    expect(text(adminBytes)).toBe(V.authCode.adminCanonical);
    const seed = fromHex(V.keys.adminRootSeedHex);
    expect(await ks.adminRootPubHex(seed)).toBe(V.keys.adminRootPubHex);
    expect(Buffer.from(await ks.signWithAdminRoot(seed, adminBytes)).toString("hex")).toBe(V.authCode.adminSignatureHex);
    for (const r of V.reject) {
      expect(ed.verify(fromHex(r.signatureHex), adminBytes, fromHex(V.keys.adminRootPubHex)), r.why).toBe(false);
    }
    const w = V.wrongRoot.fields;
    expect(text(authCodeAdminCanonicalBytes(codeOf(w), w.adminRootPubKey))).toBe(V.wrongRoot.adminCanonical);
    for (const r of V.refuse) expect(() => authCodeAdminCanonicalBytes(codeOf(r.fields), undefined), r.why).toThrow();
  });

  it("the restore order and the RCK sign under the admin root", async () => {
    const { SENSITIVE_TAGS } = await import("../public/webapp/lib/adminRoot.js");
    expect(SENSITIVE_TAGS.has("flagship/server-restore/v1")).toBe(true);
    expect(SENSITIVE_TAGS.has("flagship/rck-register/v1")).toBe(true);
    const { serverRestoreCanonicalBytes } = await import("../public/webapp/lib/serverBackupFormat.js");
    expect(text(serverRestoreCanonicalBytes(V.restore.order))).toBe(V.restore.canonical);
  });

  describe("minting", () => {
    const fetchSpy = vi.fn();
    beforeEach(() => {
      fetchSpy.mockReset();
      vi.stubGlobal("fetch", fetchSpy);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("the issue carries the admin root's approval of the AuthCode it pins", async () => {
      const ks = await import("../public/webapp/keystore.js");
      const { ed } = await import("@flagship/protocol");
      const { authCodeAdminCanonicalBytes } = await import("../public/webapp/views/create-server.js");
      const seed = new Uint8Array(32).fill(9);
      const pub = await ks.adminRootPubHex(seed);
      let issued: { code: Record<string, unknown>; adminSignature?: string } | null = null;
      fetchSpy.mockImplementation(async (url: string, init: { body: string }) => {
        if (String(url).endsWith("/api/auth-code/issue")) issued = JSON.parse(init.body);
        return { ok: false, status: 500, text: async () => "stop here", json: async () => ({}) };
      });
      const session = { ...nonAdminSession(), adminRootSeed: seed };
      await expect(mintInstallBlobBundle(session, "harry", INPUTS, { skipClaim: true })).rejects.toThrow();
      const sent = issued as unknown as { code: Record<string, unknown>; adminSignature?: string };
      expect(sent.code.adminRootPubKey).toBe(pub);
      const bytes = authCodeAdminCanonicalBytes(codeOf(sent.code), pub);
      expect(ed.verify(fromHex(sent.adminSignature!), bytes, fromHex(pub))).toBe(true);
    });

    it("`.com`'s refusal reads as the apps' sentence", async () => {
      const refusal = JSON.stringify({ error: ADD_SERVERS_ADMIN_ONLY, code: "add-server-admin-only" });
      fetchSpy.mockImplementation(async () => ({
        ok: false,
        status: 403,
        text: async () => refusal,
        json: async () => JSON.parse(refusal),
      }));
      const session = { ...nonAdminSession(), adminRootSeed: new Uint8Array(32).fill(9) };
      const e = await mintInstallBlobBundle(session, "harry", INPUTS, { skipClaim: true }).catch((x) => x);
      expect(e).toBeInstanceOf(AddServerRefusedError);
      expect(humanError(e)).toBe(ADD_SERVERS_ADMIN_ONLY);
    });
  });

  it("a take-over refused by `.com` reads as the same sentence", async () => {
    const { submitTransferClaim } = await import("../public/webapp/lib/serverTransfer.js");
    const refusal = { error: ADD_SERVERS_ADMIN_ONLY, code: "add-server-admin-only" };
    const offer = {
      kind: "flagship-transfer-offer",
      serverDomain: "home.alice.flagship.services",
      transferNonce: "ab".repeat(32),
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      giverIrkPub: "cd".repeat(32),
      offerSignature: "00".repeat(64),
    };
    const e = await submitTransferClaim(
      {
        offer,
        acquirerUsername: "harry",
        umk: new Uint8Array(32),
        acquirerIrkPubHex: "ef".repeat(32),
        acquirerAdminRootPubHex: "12".repeat(32),
        signWithIrk: async () => new Uint8Array(64),
      },
      { fetch: async () => ({ ok: false, status: 403, json: async () => refusal }), origin: "https://x" },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AddServerRefusedError);
  });
});
