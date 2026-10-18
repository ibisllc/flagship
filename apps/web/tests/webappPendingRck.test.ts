// A retry of the same pending order must register the same routing key, and a
// failed cancel must say why in plain words. Mirrors Android
// CreateServerRckReuseTest and the CancelPendingOrder reasons.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../public/webapp/lib/toast.js", () => ({ toast }));

import {
  PENDING_RCK_TTL_MS,
  clearPendingRck,
  reuseOrRecordRck,
} from "../public/webapp/lib/pendingRck.js";
import { mintInstallBlobBundle } from "../public/webapp/views/create-server.js";
import { deleteDeadServer } from "../public/webapp/views/home.js";
import { getSession } from "../public/webapp/lib/state.js";

const src = (p: string) => readFileSync(resolve(__dirname, "..", "public", "webapp", p), "utf8");

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const DOMAIN = "home.harry.flagship.services";

describe("pendingRck store", () => {
  it("reuses the pending key for the same name and records the first one", () => {
    const storage = memoryStorage() as unknown as Storage;
    expect(reuseOrRecordRck(DOMAIN, A, { storage })).toBe(A);
    expect(reuseOrRecordRck(DOMAIN, B, { storage })).toBe(A);
  });

  it("keeps a separate key per name, case-insensitively", () => {
    const storage = memoryStorage() as unknown as Storage;
    reuseOrRecordRck(DOMAIN, A, { storage });
    expect(reuseOrRecordRck("home2.harry.flagship.services", B, { storage })).toBe(B);
    expect(reuseOrRecordRck(DOMAIN.toUpperCase(), B, { storage })).toBe(A);
  });

  it("forgets the key after cancel or activation", () => {
    const storage = memoryStorage() as unknown as Storage;
    reuseOrRecordRck(DOMAIN, A, { storage });
    clearPendingRck(DOMAIN, { storage });
    expect(reuseOrRecordRck(DOMAIN, B, { storage })).toBe(B);
  });

  it("a key older than 24 hours is replaced", () => {
    const storage = memoryStorage() as unknown as Storage;
    let t = 1_000_000;
    reuseOrRecordRck(DOMAIN, A, { storage, now: () => t });
    t += PENDING_RCK_TTL_MS;
    expect(reuseOrRecordRck(DOMAIN, B, { storage, now: () => t })).toBe(A);
    t += 1;
    expect(reuseOrRecordRck(DOMAIN, B, { storage, now: () => t })).toBe(B);
  });

  it("an entry that isn't a public key is ignored", () => {
    const storage = memoryStorage();
    storage.setItem(`flagship.pendingRck.${DOMAIN}`, `not-a-key|${Date.now()}`);
    expect(reuseOrRecordRck(DOMAIN, A, { storage: storage as unknown as Storage })).toBe(A);
  });

  it("unusable storage falls back to the fresh key", () => {
    const broken = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    } as unknown as Storage;
    expect(reuseOrRecordRck(DOMAIN, A, { storage: broken })).toBe(A);
    expect(() => clearPendingRck(DOMAIN, { storage: broken })).not.toThrow();
  });
});

describe("minting twice for one pending name", () => {
  const fetchSpy = vi.fn();
  const storage = memoryStorage();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("localStorage", storage);
    for (const k of storage.keys()) storage.removeItem(k);
  });
  afterEach(() => vi.unstubAllGlobals());

  const session = () => ({
    umk: new Uint8Array(32).fill(1),
    irk: { publicKey: new Uint8Array(32).fill(2) },
    adminRootSeed: null,
  });
  const INPUTS = { serverName: "home", recipeTtlMs: 3_600_000, bootUnlockMode: "auto", diskEncryption: "luks" };

  async function mintAndGetRck(): Promise<string> {
    const sent: string[] = [];
    fetchSpy.mockImplementation(async (url: string, init?: { body: string }) => {
      if (String(url).endsWith("/api/routing/register-rck")) {
        sent.push(JSON.parse(init!.body).request.rckPubKey);
        return { ok: false, status: 500, text: async () => "stop here", json: async () => ({}) };
      }
      return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
    });
    await mintInstallBlobBundle(session(), "harry", INPUTS, { skipClaim: true, isDemo: true }).catch(() => {});
    expect(sent).toHaveLength(1);
    return sent[0]!;
  }

  it("registers the same routing key both times", async () => {
    const first = await mintAndGetRck();
    const second = await mintAndGetRck();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("a cancelled order mints a fresh key", async () => {
    const first = await mintAndGetRck();
    clearPendingRck("home.harry.flagship.services");
    expect(await mintAndGetRck()).not.toBe(first);
  });

  it("a different name mints its own key", async () => {
    const first = await mintAndGetRck();
    const sent: string[] = [];
    fetchSpy.mockImplementation(async (url: string, init?: { body: string }) => {
      if (String(url).endsWith("/api/routing/register-rck")) {
        sent.push(JSON.parse(init!.body).request.rckPubKey);
        return { ok: false, status: 500, text: async () => "stop", json: async () => ({}) };
      }
      return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
    });
    await mintInstallBlobBundle(session(), "harry", { ...INPUTS, serverName: "home2" }, { skipClaim: true, isDemo: true }).catch(() => {});
    expect(sent[0]).not.toBe(first);
  });
});

describe("a cancel that fails says why and can be tried again", () => {
  const fetchSpy = vi.fn();
  const storage = memoryStorage();
  beforeEach(() => {
    toast.mockReset();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("confirm", () => true);
    Object.assign(getSession(), {
      username: "harry",
      umk: new Uint8Array(32).fill(1),
      irk: { publicKey: new Uint8Array(32).fill(2) },
      adminRootSeed: null,
    });
    reuseOrRecordRck(DOMAIN, A);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(getSession(), { username: null, umk: null, irk: null });
  });

  const button = () => ({ disabled: false, textContent: "Cancel order" }) as unknown as HTMLButtonElement;

  it("shows the reason as a sentence, keeps the key, and re-enables the button", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: "invalid signature" }),
      json: async () => ({ error: "invalid signature" }),
    });
    const btn = button();
    const done = await deleteDeadServer(DOMAIN, btn, { label: "Cancel order" });
    expect(done).toBe(false);
    const shown = String(toast.mock.calls.at(-1)![0]);
    expect(shown).toMatch(/^Couldn't cancel the order — the name is still reserved\./);
    expect(shown).toContain("Your account key didn't match");
    expect(shown).not.toMatch(/release failed|HTTP|\{/);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Cancel order");
    expect(reuseOrRecordRck(DOMAIN, B)).toBe(A);
  });

  it("a dropped connection reads as a dropped connection, not its raw text", async () => {
    fetchSpy.mockRejectedValue(new Error("connection closed"));
    await deleteDeadServer(DOMAIN, button(), { label: "Cancel order" });
    const shown = String(toast.mock.calls.at(-1)![0]);
    expect(shown).toContain("The connection dropped");
    expect(shown).not.toContain("connection closed");
  });

  it("an edge error page reads as a temporary problem", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "error code: 1102",
      json: async () => { throw new Error("not json"); },
    });
    await deleteDeadServer(DOMAIN, button(), { label: "Cancel order" });
    const shown = String(toast.mock.calls.at(-1)![0]);
    expect(shown).toContain("briefly unavailable");
    expect(shown).not.toMatch(/1102|503/);
  });

  it("success frees the name and forgets the key", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/api/server/release")) {
        return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
      }
      return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
    });
    const done = await deleteDeadServer(DOMAIN, button(), { label: "Cancel order" });
    expect(done).toBe(true);
    expect(reuseOrRecordRck(DOMAIN, B)).toBe(B);
  });
});

describe("the draft list's Cancel server", () => {
  it("no longer prints the raw error, and forgets the key on success", () => {
    const s = src("views/create-server.js");
    expect(s).not.toMatch(/Cancel failed: \$\{e\.message/);
    expect(s).toContain("boxErrorText(e)");
    expect(s.match(/clearPendingRck\(serverDomain\)/g)?.length).toBe(2);
  });

  it("a registered server and the pending view's forget both clear the key", () => {
    expect(src("views/home.js")).toContain("clearPendingRck(String(s.serverId))");
    expect(src("views/pending-server.js")).toMatch(/function forgetPendingOrder\(fqdn\) \{\n  clearPendingRck\(fqdn\);/);
  });
});
