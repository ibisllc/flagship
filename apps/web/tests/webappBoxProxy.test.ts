// A server's outbound proxy on the webapp (docs/outbound-proxy.md): the order
// against the shared vectors, signing with the sensitive-order key, the form
// checks, the recipe siblings, sending a change to the box, and the server
// page's section.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyBoxProxy } from "@flagship/protocol";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/box-proxy/vectors.json"), "utf8"),
);
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const UMK = fromHex(V.keys.umkSeedHex);
const DOMAIN = "home.plucky-avocet.flagship.services";

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

beforeEach(() => {
  (globalThis as { document?: unknown }).document = { getElementById: () => null, addEventListener: () => {}, removeEventListener: () => {} };
});
afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe("the box-proxy order", () => {
  it("reproduces every vector's canonical bytes and IRK signature", async () => {
    const { canonicalBoxProxy, signBoxProxy } = await load("lib/boxProxy.js");
    const { signWithIrk } = await load("keystore.js");
    for (const c of V.cases) {
      expect(utf8(canonicalBoxProxy(c.fields)), c.name).toBe(c.canonical);
      const sig = await signBoxProxy(c.fields, UMK, signWithIrk);
      expect(sig, c.name).toBe(c.signatureHex);
      expect(verifyBoxProxy(c.fields, sig, fromHex(V.keys.irkPubHex))).toBe(true);
      expect(verifyBoxProxy(c.fields, c.rejectSignatureHex, fromHex(V.keys.irkPubHex))).toBe(false);
    }
  });

  it("refuses every refuse case, normalizes hosts and checks credentials", async () => {
    const { canonicalBoxProxy, normalizeBoxProxyHost, boxProxyCredentialsError, boxProxyHostError } = await load("lib/boxProxy.js");
    for (const r of V.refuse) expect(() => canonicalBoxProxy(r.fields), r.why).toThrow();
    for (const n of V.normalize) expect(normalizeBoxProxyHost(n.input)).toBe(n.host);
    for (const h of V.hostErrors) expect(boxProxyHostError(h.host), h.host).toBe(h.error);
    for (const c of V.credentials.accept) expect(boxProxyCredentialsError(c)).toBeNull();
    for (const c of V.credentials.refuse) expect(boxProxyCredentialsError(c), c.why).not.toBeNull();
  });

  it("is a sensitive order: the admin root signs it when held", async () => {
    const { SENSITIVE_TAGS, canonicalTag } = await load("lib/adminRoot.js");
    const { canonicalBoxProxy } = await load("lib/boxProxy.js");
    expect(SENSITIVE_TAGS.has("flagship/box-proxy/v1")).toBe(true);
    expect(canonicalTag(canonicalBoxProxy(V.cases[0].fields))).toBe("flagship/box-proxy/v1");
  });
});

describe("the form", () => {
  it("accepts a proxy, normalizes it, and says what's wrong", async () => {
    const { readProxyForm } = await load("lib/boxProxy.js");
    expect(readProxyForm({ kind: "none" })).toEqual({ ok: true, value: { kind: "none" } });
    expect(readProxyForm({ kind: "socks5", host: " Proxy.Example.NET ", port: "1080", username: "", password: "", fallbackDirect: true })).toEqual({
      ok: true,
      value: { kind: "socks5", host: "proxy.example.net", port: 1080, fallbackDirect: true, credentials: null },
    });
    expect(readProxyForm({ kind: "http", host: "", port: "3128" })).toMatchObject({ ok: false, error: "Enter the proxy's address." });
    expect(readProxyForm({ kind: "http", host: "http://x", port: "3128" }).ok).toBe(false);
    expect(readProxyForm({ kind: "http", host: "10.0.0.2", port: "70000" })).toMatchObject({ ok: false, field: "port" });
    expect(readProxyForm({ kind: "http", host: "10.0.0.2", port: "3128", username: "a", password: "" })).toMatchObject({
      ok: false,
      error: "Enter both a username and a password, or neither.",
    });
    expect(readProxyForm({ kind: "http", host: "10.0.0.2", port: "3128", username: "a:b", password: "x" })).toMatchObject({
      ok: false,
      error: "The username can't contain a colon.",
    });
  });
});

describe("signing and sending", () => {
  it("puts the signed order and typed credentials on the recipe", async () => {
    const { recipeProxySiblings } = await load("lib/boxProxy.js");
    const { signWithIrk } = await load("keystore.js");
    const value = { kind: "socks5", host: "proxy.example.net", port: 1080, fallbackDirect: true, credentials: { username: "alice", password: "pw" } };
    const s = await recipeProxySiblings(
      { serverDomain: DOMAIN.toUpperCase(), value },
      { umk: UMK, sign: signWithIrk, now: () => V.cases[0].fields.issuedAt, nonceHex: V.cases[0].fields.nonce },
    );
    expect(s.outboundProxy).toEqual(V.cases[0].wire);
    expect(s.outboundProxyCredentials).toEqual({ username: "alice", password: "pw" });
    expect(await recipeProxySiblings({ serverDomain: DOMAIN, value: { kind: "none" } }, { umk: UMK, sign: signWithIrk })).toEqual({});
  });

  it("posts a change to the box, keeping stored credentials for the same proxy", async () => {
    const { sendBoxProxy, OUTBOUND_PROXY_PATH } = await load("lib/boxProxy.js");
    const { signWithIrk } = await load("keystore.js");
    const fetchJson = vi.fn(async () => ({ ok: true }));
    const current = {
      proxy: { kind: "http", host: "10.0.0.2", port: 3128, auth: true, fallbackDirect: false, issuedAt: 1 },
      hasCredentials: true,
      status: { state: "ok", since: 1 },
    };
    await sendBoxProxy(
      { serverDomain: DOMAIN, value: { kind: "http", host: "10.0.0.2", port: 3128, fallbackDirect: true, credentials: null }, current, fetchJson },
      { umk: UMK, sign: signWithIrk, now: () => 5 },
    );
    const [path, init] = fetchJson.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(OUTBOUND_PROXY_PATH);
    const body = JSON.parse(String(init.body));
    expect(body.proxy).toMatchObject({ serverDomain: DOMAIN, kind: "http", auth: true, fallbackDirect: true, issuedAt: 5 });
    expect(body.credentials).toBeUndefined();
    expect(verifyBoxProxy(body.proxy, body.signature, fromHex(V.keys.irkPubHex))).toBe(true);

    // Turning it off.
    await sendBoxProxy({ serverDomain: DOMAIN, value: { kind: "none" }, current, fetchJson }, { umk: UMK, sign: signWithIrk });
    const off = JSON.parse(String((fetchJson.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(off.proxy).toMatchObject({ kind: "none", host: "", port: 0, auth: false, fallbackDirect: false });
  });
});

describe("creating a server", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, "..", "public", "webapp", rel), "utf8");

  it("offers the proxy under Advanced and puts it on the recipe, never in a draft", () => {
    const html = read("index.html");
    const adv = html.slice(html.indexOf('id="cs-advanced-options"'), html.indexOf('id="cs-save-draft"'));
    expect(adv).toContain('<h3 class="mt-3">Outbound proxy</h3>');
    expect(adv).toContain("Send this server's internet traffic through a proxy, so Flagship and the sites it reaches see the proxy's address instead of yours.");
    expect(adv).toContain('id="cs-proxy-block"');
    const view = read("views/create-server.js");
    expect(view).toMatch(/export function readOutboundProxy\(/);
    expect(view).toContain("if (blobBundle.outboundProxy) recipe.outboundProxy = blobBundle.outboundProxy;");
    expect(view).toContain("recipe.outboundProxyCredentials = blobBundle.outboundProxyCredentials");
    // readInputs feeds saved drafts; the proxy (and its password) stays out of it.
    const readInputs = view.slice(view.indexOf("function readInputs()"), view.indexOf("export function readOutboundProxy"));
    expect(readInputs).not.toContain("outboundProxy");
  });

  it("renders the fields with the exact copy", async () => {
    const { proxyFieldsHtml } = await load("lib/boxProxy.js");
    const html = proxyFieldsHtml("cs-proxy");
    for (const s of [
      "None", "SOCKS5", "HTTP", "Proxy address", "proxy.example.net or 192.168.1.20", "Port",
      "Username (optional)", "Password (optional)",
      "The username and password are saved in the setup file. Only give the file to people you trust.",
      "If the proxy stops working, connect directly",
      "If this is off and the proxy stops working, the server goes offline until the proxy is back or you change it from the same network.",
    ]) expect(html).toContain(s);
    expect(html).toContain('id="cs-proxy-fields" class="hidden"');
    expect(proxyFieldsHtml("sd", { kind: "http", host: "10.0.0.2", port: 3128, hasCredentials: true })).toContain('placeholder="Unchanged"');
  });
});

describe("the server page", () => {
  it("shows the proxy and its status, and hides the section for older boxes", async () => {
    const { proxySummaryText, proxyStatusText } = await load("lib/boxProxy.js");
    const on = { proxy: { kind: "socks5", host: "2001:db8::7", port: 9050, auth: true }, hasCredentials: true, status: { state: "failing", lastError: "Can't reach the proxy." } };
    expect(proxySummaryText(on)).toBe("SOCKS5 · [2001:db8::7]:9050 · needs a password");
    expect(proxyStatusText(on)).toBe("Not working: Can't reach the proxy.");
    expect(proxyStatusText({ ...on, status: { state: "ok" } })).toBe("Working");
    expect(proxyStatusText({ ...on, status: { state: "fallback" } })).toBe("Using a direct connection: the proxy isn't answering");
    expect(proxySummaryText({ proxy: null, status: { state: "direct" } })).toBe("Off");
    expect(proxyStatusText({ proxy: null, status: { state: "direct" } })).toBe("");

    const { outboundProxyHtml } = await load("views/server-detail.js");
    expect(outboundProxyHtml({ serverFqdn: DOMAIN }, { canEdit: true })).toBe("");
    const html = outboundProxyHtml({ serverFqdn: DOMAIN, outboundProxy: on }, { canEdit: true });
    expect(html).toContain("Outbound proxy");
    expect(html).toContain('id="outbound-proxy-change"');
    expect(html).toContain('id="outbound-proxy-off"');
    const readOnly = outboundProxyHtml({ serverFqdn: DOMAIN, outboundProxy: on }, { canEdit: false });
    expect(readOnly).not.toContain("outbound-proxy-change");
  });

  it("on a Free account shows the Pro row and keeps only Turn off", async () => {
    const { outboundProxyHtml } = await load("views/server-detail.js");
    const off = { proxy: null, hasCredentials: false, status: { state: "direct" }, available: false };
    const freeOff = outboundProxyHtml({ serverFqdn: DOMAIN, outboundProxy: off }, { canEdit: true });
    expect(freeOff).toContain("An outbound proxy is part of Pro.");
    expect(freeOff).toContain('href="/pro"');
    expect(freeOff).not.toContain("outbound-proxy-change");
    expect(freeOff).not.toContain("outbound-proxy-off");
    const on = { ...off, proxy: { kind: "socks5", host: "proxy.example.net", port: 1080, auth: false }, status: { state: "ok" } };
    const freeOn = outboundProxyHtml({ serverFqdn: DOMAIN, outboundProxy: on }, { canEdit: true });
    expect(freeOn).not.toContain("outbound-proxy-change");
    expect(freeOn).toContain('id="outbound-proxy-off"');
    const pro = outboundProxyHtml({ serverFqdn: DOMAIN, outboundProxy: { ...off, available: true } }, { canEdit: true });
    expect(pro).not.toContain("part of Pro");
    expect(pro).toContain('id="outbound-proxy-change"');
  });
});

describe("the Pro gate when creating a server", () => {
  it("treats only a Free plan as closed, and swaps the fields for the Pro row", async () => {
    const { proxyAllowedForTier, proxyProHtml } = await load("lib/boxProxy.js");
    expect(proxyAllowedForTier("free")).toBe(false);
    expect(proxyAllowedForTier("hobby")).toBe(true);
    expect(proxyAllowedForTier("maker")).toBe(true);
    expect(proxyAllowedForTier(null)).toBe(true);
    expect(proxyProHtml()).toContain("An outbound proxy is part of Pro.");
    const view = readFileSync(resolve(__dirname, "..", "public", "webapp", "views/create-server.js"), "utf8");
    expect(view).toContain("if (!proxyAllowedForTier(accountTier)) {");
    expect(view).toContain("block.innerHTML = proxyProHtml();");
  });
});
