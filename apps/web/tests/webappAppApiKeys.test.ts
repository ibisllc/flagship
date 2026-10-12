// App API keys on the webapp (docs/app-apis.md §3): the canonical bytes and
// signature against the shared vectors, the box calls (create, list, revoke),
// the refusals, and the "API keys" section on the app's page.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveIRK } from "@flagship/protocol";
import { buildServer } from "../src/server.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError } from "../public/webapp/lib/api.js";

const VECTORS = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/app-api-key/vectors.json"), "utf8"),
);

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}
const loadKeys = () => load("lib/appApiKeys.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const owner = { requireOwnerProfile: () => {} };
const err = (status: number, error: string) => new ScreensError(error, status, { error });

type Case = {
  serverDomain: string;
  serviceId: string;
  keyId: string;
  scope: string;
  expiresAt: number;
  issuedAt: number;
  canonical: string;
  signature: string;
};
const grantOf = (c: Case) => ({
  serverDomain: c.serverDomain,
  serviceId: c.serviceId,
  keyId: c.keyId,
  scope: c.scope,
  expiresAt: c.expiresAt,
  issuedAt: c.issuedAt,
});
/** getRandomValues that yields the case's keyId. */
const randomFor = (keyId: string) => (b: Uint8Array) => b.set(fromHex(keyId));

describe("API keys — the shared vectors", () => {
  it("builds the canonical bytes and signs with the IRK of the UMK seed", async () => {
    const { canonicalAppApiKeyBytes, signApiKeyGrant } = await loadKeys();
    const { signWithIrk } = await load("keystore.js");
    const seed = fromHex(VECTORS.umkSeedHex);
    expect(hex(deriveIRK({ seed }).publicKey)).toBe(VECTORS.pub);
    for (const c of VECTORS.cases as Case[]) {
      const grant = grantOf(c);
      expect(utf8(canonicalAppApiKeyBytes(grant))).toBe(c.canonical);
      expect(hex(await signWithIrk(seed, canonicalAppApiKeyBytes(grant)))).toBe(c.signature);
      expect(await signApiKeyGrant({ grant, label: "Kitchen", umk: seed, signWithIrk })).toEqual({
        grant,
        signature: c.signature,
        label: "Kitchen",
      });
    }
  });

  it("signs with the sensitive-order key (admin root when held)", async () => {
    const { SENSITIVE_TAGS, canonicalTag } = await load("lib/adminRoot.js");
    const { canonicalAppApiKeyBytes, TAG_APP_API_KEY } = await loadKeys();
    expect(TAG_APP_API_KEY).toBe("flagship/app-api-key/v1");
    expect(SENSITIVE_TAGS.has(TAG_APP_API_KEY)).toBe(true);
    expect(canonicalTag(canonicalAppApiKeyBytes(grantOf(VECTORS.cases[0])))).toBe(TAG_APP_API_KEY);
  });

  it("refuses a malformed grant before signing", async () => {
    const { canonicalAppApiKeyBytes } = await loadKeys();
    const g = grantOf(VECTORS.cases[0]);
    expect(() => canonicalAppApiKeyBytes({ ...g, keyId: "0123456789ABCDEF" })).toThrow(/keyId/);
    expect(() => canonicalAppApiKeyBytes({ ...g, keyId: "0123" })).toThrow(/keyId/);
    expect(() => canonicalAppApiKeyBytes({ ...g, scope: "admin" })).toThrow(/scope/);
    expect(() => canonicalAppApiKeyBytes({ ...g, expiresAt: -1 })).toThrow(/expiresAt/);
    expect(() => canonicalAppApiKeyBytes({ ...g, serverDomain: "" })).toThrow(/serverDomain/);
  });
});

describe("API keys — choices", () => {
  it("keyId is 16 random lowercase hex", async () => {
    const { newApiKeyId } = await loadKeys();
    for (let i = 0; i < 20; i++) expect(newApiKeyId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newApiKeyId(randomFor("0123456789abcdef"))).toBe("0123456789abcdef");
  });

  it("preselects Read and offers no expiry", async () => {
    const keys = await loadKeys();
    expect(keys.DEFAULT_API_KEY_SCOPE).toBe("read");
    expect(keys).not.toHaveProperty("API_KEY_EXPIRIES");
    expect(keys).not.toHaveProperty("expiresAtFor");
  });

  it("calls a key expired only when a box holds a past non-zero expiresAt", async () => {
    const { isApiKeyExpired } = await loadKeys();
    expect(isApiKeyExpired({ expiresAt: 0 }, 5)).toBe(false);
    expect(isApiKeyExpired({ expiresAt: 10 }, 5)).toBe(false);
    expect(isApiKeyExpired({ expiresAt: 5 }, 5)).toBe(true);
  });

  it("scope labels and the label check", async () => {
    const { scopeLabel, checkApiKeyLabel } = await loadKeys();
    expect(scopeLabel("read")).toBe("Read");
    expect(scopeLabel("write")).toBe("Read & write");
    expect(checkApiKeyLabel("  Kitchen  ")).toEqual({ label: "Kitchen" });
    expect(checkApiKeyLabel("   ").error).toBeTruthy();
    expect(checkApiKeyLabel("x".repeat(65)).error).toBeTruthy();
  });
});

describe("API keys — the box calls", () => {
  const c = VECTORS.cases[1] as Case;
  const now = () => c.issuedAt;

  it("Create picks the keyId, signs expiresAt 0, posts what the box verifies, and returns the key once", async () => {
    const { createApiKey } = await loadKeys();
    const { signWithIrk } = await load("keystore.js");
    const fetchJson = vi.fn(async () => ({ ok: true, key: `fsk_${c.keyId}_s3cret` }));
    const out = await createApiKey(
      {
        serverDomain: c.serverDomain,
        serviceId: c.serviceId,
        label: " Kitchen display ",
        scope: c.scope,
        umk: fromHex(VECTORS.umkSeedHex),
        signWithIrk,
        fetchJson,
      },
      { ...owner, now, getRandomValues: randomFor(c.keyId) },
    );
    expect(out).toEqual({
      key: `fsk_${c.keyId}_s3cret`,
      keyId: c.keyId,
      scope: c.scope,
      issuedAt: c.issuedAt,
      label: "Kitchen display",
    });
    const [path, init] = fetchJson.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(path).toBe("/api/screens/services/harry-weather/api-keys");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.label).toBe("Kitchen display");
    expect(body.grant).toEqual({ ...grantOf(c), expiresAt: 0 });
    expect(body.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("posts the vectors' exact signature (the expiresAt 0 case)", async () => {
    const { createApiKey } = await loadKeys();
    const { signWithIrk } = await load("keystore.js");
    const v = VECTORS.cases[0] as Case;
    const fetchJson = vi.fn(async () => ({ ok: true, key: `fsk_${v.keyId}_x` }));
    await createApiKey(
      { serverDomain: v.serverDomain, serviceId: v.serviceId, label: "k", scope: v.scope, umk: fromHex(VECTORS.umkSeedHex), signWithIrk, fetchJson },
      { ...owner, now: () => v.issuedAt, getRandomValues: randomFor(v.keyId) },
    );
    const body = JSON.parse((fetchJson.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toEqual({ grant: grantOf(v), signature: v.signature, label: "k" });
  });

  it("retries once with a new keyId on 409, then gives up", async () => {
    const { createApiKey } = await loadKeys();
    const ids: string[] = [];
    let calls = 0;
    const fetchJson = vi.fn(async (_p: string, init: { body: string }) => {
      ids.push(JSON.parse(init.body).grant.keyId);
      if (calls++ === 0) throw err(409, "keyId exists");
      return { ok: true, key: "fsk_x_y" };
    });
    const args = { serverDomain: "s", serviceId: "x", label: "k", scope: "read", umk: new Uint8Array(32), signWithIrk: async () => new Uint8Array(64), fetchJson };
    expect((await createApiKey(args, owner)).key).toBe("fsk_x_y");
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    const always409 = vi.fn(async () => { throw err(409, "keyId exists"); });
    await expect(createApiKey({ ...args, fetchJson: always409 }, owner)).rejects.toMatchObject({ status: 409 });
    expect(always409).toHaveBeenCalledTimes(2);
  });

  it("won't sign on a companion, without a label, or without a key back", async () => {
    const { createApiKey } = await loadKeys();
    const sign = vi.fn(async () => new Uint8Array(64));
    const args = { serverDomain: "s", serviceId: "x", label: "k", scope: "read", umk: new Uint8Array(32), signWithIrk: sign, fetchJson: vi.fn(async () => ({ ok: true })) };
    await expect(
      createApiKey(args, { requireOwnerProfile: () => { throw new Error("A remote browser can't sign"); } }),
    ).rejects.toThrow(/can't sign/);
    await expect(createApiKey({ ...args, label: "  " }, owner)).rejects.toThrow(/name/);
    expect(sign).not.toHaveBeenCalled();
    await expect(createApiKey(args, owner)).rejects.toThrow(/didn't return/);
  });

  it("lists defensively, newest first, and returns null when the box 404s (older box)", async () => {
    const { fetchApiKeys } = await loadKeys();
    const keys = await fetchApiKeys("harry-weather", async (path: string) => {
      expect(path).toBe("/api/screens/services/harry-weather/api-keys");
      return {
        keys: [
          { keyId: "aaaaaaaaaaaaaaaa", label: "Old", scope: "read", createdAt: 1, lastUsedAt: null, expiresAt: 0 },
          { keyId: "bbbbbbbbbbbbbbbb", label: "New", scope: "write", createdAt: 5, lastUsedAt: 6, expiresAt: 9 },
          { label: "no id" },
          null,
        ],
      };
    });
    expect(keys).toEqual([
      { keyId: "bbbbbbbbbbbbbbbb", label: "New", scope: "write", createdAt: 5, lastUsedAt: 6, expiresAt: 9 },
      { keyId: "aaaaaaaaaaaaaaaa", label: "Old", scope: "read", createdAt: 1, lastUsedAt: 0, expiresAt: 0 },
    ]);
    expect(await fetchApiKeys("x", async () => { throw err(404, "not found"); })).toBeNull();
    await expect(fetchApiKeys("x", async () => { throw err(500, "boom"); })).rejects.toMatchObject({ status: 500 });
  });

  it("Revoke sends DELETE with no signature; a key already gone counts as revoked", async () => {
    const { revokeApiKey } = await loadKeys();
    const fetchJson = vi.fn(async () => null);
    await revokeApiKey({ serviceId: "harry-weather", keyId: "0123456789abcdef", fetchJson }, owner);
    expect(fetchJson).toHaveBeenCalledWith("/api/screens/services/harry-weather/api-keys/0123456789abcdef", { method: "DELETE" });
    await revokeApiKey({ serviceId: "x", keyId: "k", fetchJson: async () => { throw err(404, "no such key"); } }, owner);
    await expect(
      revokeApiKey({ serviceId: "x", keyId: "k", fetchJson: async () => { throw err(403, "read-only companion"); } }, owner),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      revokeApiKey({ serviceId: "x", keyId: "k", fetchJson }, { requireOwnerProfile: () => { throw new Error("remote"); } }),
    ).rejects.toThrow(/remote/);
  });

  it("says the box's refusals plainly", async () => {
    const { apiKeyErrorMessage } = await loadKeys();
    expect(apiKeyErrorMessage(err(403, "stale issuedAt"))).toMatch(/clock/);
    expect(apiKeyErrorMessage(err(403, "grant for a different server"))).toMatch(/different server/);
    expect(apiKeyErrorMessage(err(403, "invalid signature"))).toMatch(/signature/);
    expect(apiKeyErrorMessage(err(404, "no such service"))).toMatch(/isn't installed/);
    expect(apiKeyErrorMessage(err(409, "keyId exists"))).toMatch(/Try again/);
    expect(apiKeyErrorMessage(err(400, "label too long"))).toMatch(/label too long/);
  });
});

describe("API keys — the app's page", () => {
  const keys = [
    { keyId: "bbbbbbbbbbbbbbbb", label: "Kitchen <display>", scope: "write", createdAt: 1_000, lastUsedAt: 0, expiresAt: 0 },
    { keyId: "aaaaaaaaaaaaaaaa", label: "Old", scope: "read", createdAt: 500, lastUsedAt: 900, expiresAt: 2_000 },
  ];
  const NOW = 10_000_000;

  it("lists each key with its scope, dates and Revoke; Create key opens the form", async () => {
    const { renderApiKeysSection } = await load("views/service-detail.js");
    const html: string = renderApiKeysSection({ keys, companion: false, now: NOW });
    expect(html).toContain("API keys");
    expect(html).toContain("Kitchen &lt;display&gt;");
    expect(html).toContain("Read &amp; write");
    expect(html).toContain(">Read<");
    expect(html).toContain("Never used");
    expect(html).toContain("Last used");
    expect(html).not.toContain("Never expires");
    expect(html).not.toContain("Expires");
    // Only a box-held past expiresAt shows; a 0 shows nothing.
    expect(html.match(/Expired /g)).toHaveLength(1);
    expect(html).toContain('data-api-key-revoke="bbbbbbbbbbbbbbbb"');
    expect(html).toContain('id="sd-api-key-new"');
    const form: string = renderApiKeysSection({ keys: [], companion: false, form: true, now: NOW });
    expect(form).toContain("No API keys yet.");
    expect(form).toContain('id="sd-api-key-label"');
    expect(form).toContain('<option value="read" selected>Read</option>');
    expect(form).toContain('<option value="write">Read &amp; write</option>');
    expect(form).not.toContain("sd-api-key-expiry");
    for (const label of ["Never", "30 days", "1 year"]) expect(form).not.toContain(`>${label}</option>`);
  });

  it("shows a new key once, with Copy, the warning and the usage line", async () => {
    const { renderApiKeysSection } = await load("views/service-detail.js");
    const html: string = renderApiKeysSection({ keys, companion: false, revealed: { key: "fsk_0123456789abcdef_s3cret", label: "Kitchen" }, now: NOW });
    expect(html).toContain("fsk_0123456789abcdef_s3cret");
    expect(html).toContain("Copy it now. Flagship can't show it again.");
    expect(html).toContain("Authorization: Bearer &lt;key&gt;");
    expect(html).toContain('id="sd-api-key-copy"');
    expect(html).not.toContain('id="sd-api-key-new"');
  });

  it("is read-only on a companion and hidden for an older box", async () => {
    const { renderApiKeysSection } = await load("views/service-detail.js");
    const html: string = renderApiKeysSection({ keys, companion: true, now: NOW });
    expect(html).toContain("Kitchen &lt;display&gt;");
    expect(html).not.toContain("data-api-key-revoke");
    expect(html).not.toContain("sd-api-key-new");
    expect(html).toContain("Create and revoke keys from your owner app.");
    expect(renderApiKeysSection({ keys: null, companion: false })).toBe("");
  });

  it("the page loads the section, signs with sensitiveSigner and confirms Revoke; the shell precaches the lib", async () => {
    const detail = await asset("/webapp/views/service-detail.js");
    expect(detail).toContain('<div id="sd-api-keys"></div>');
    expect(detail).toContain("void loadApiKeysSection(s);");
    expect(detail).toContain("createApiKey({");
    expect(detail).toContain("signWithIrk: sensitiveSigner(),");
    expect(detail).toContain("inlineConfirm({");
    expect(detail).toContain("revokeApiKey({");
    const sw = await asset("/webapp/service-worker.js");
    expect(sw).toContain('"/lib/appApiKeys.js"');
    expect(sw).toContain('SHELL_VERSION = "v56"');
  });
});
