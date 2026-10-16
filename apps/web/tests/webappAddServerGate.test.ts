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
