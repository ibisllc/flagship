/**
 * App-facing browser API. Apps call these endpoints from inside their
 * containers using `Authorization: Bearer <FLAGSHIP_APP_TOKEN>`.
 *
 * The handler resolves the bearer to an appId, then enforces:
 *
 *   - DomainGate.check on every navigate / openTab URL.
 *   - TabRegistry.appIdForTab matches the calling appId on every
 *     per-tab operation. Cross-tenant tab id returns 404 (NOT 403)
 *     to avoid leaking that the tab exists for a different app.
 *
 * Cookies / localStorage / raw CDP are NOT exposed. The high-level
 * API is the only surface — see plan: "App API granularity = high-
 * level Puppeteer-style only" decision.
 */

import type { AppAuthTokens } from "../appAuthToken.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { BrowserManager } from "./browserManager.js";
import type { DomainGate } from "./domainGate.js";
import type { PhonePipe, InputKind } from "./phonePipe.js";
import type { TabRegistry } from "./tabRegistry.js";

const J = { "content-type": "application/json" } as const;
const PNG = { "content-type": "image/png" } as const;

export interface BrowserApiDeps {
  browser: BrowserManager;
  tabRegistry: TabRegistry;
  domainGate: DomainGate;
  phonePipe: PhonePipe;
  appAuthTokens: AppAuthTokens;
}

export function buildBrowserApiHandlers(deps: BrowserApiDeps) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (!req.path.startsWith("/api/browser/")) return null;

    const appId = await resolveAppId(req, deps.appAuthTokens);
    if (!appId) return jerr(401, "missing or invalid app token");

    // Check the app actually has a browser grant (manifest declared
    // browser.domains and the daemon installed the grant). If not, the
    // app is not entitled to use the browser surface at all.
    if (!deps.domainGate.hasGrant(appId)) {
      return jerr(403, "app does not declare browser.domains in its manifest");
    }

    // The runtime doesn't strip query strings, so do it here for routing.
    const qIdx = req.path.indexOf("?");
    const path = qIdx >= 0 ? req.path.slice(0, qIdx) : req.path;
    const method = req.method;

    // POST /api/browser/tabs  { url }
    if (path === "/api/browser/tabs" && method === "POST") {
      return openTab(req, appId, deps);
    }
    // GET /api/browser/tabs (list this app's tabs)
    if (path === "/api/browser/tabs" && method === "GET") {
      return listTabs(appId, deps);
    }

    // GET /api/browser/screenshot/:ref — phone or app retrieving an
    // alert's screenshot bytes.
    {
      const m = /^\/api\/browser\/screenshot\/([a-zA-Z0-9._-]+)$/.exec(path);
      if (m && method === "GET") {
        return getScreenshot(m[1]!, appId, deps);
      }
    }

    // /api/browser/tabs/:id[/<verb>]
    const tabPathMatch = /^\/api\/browser\/tabs\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (tabPathMatch) {
      const tabId = tabPathMatch[1]!;
      const verb = tabPathMatch[2];
      const ownership = deps.tabRegistry.appIdForTab(tabId);
      if (ownership !== appId) {
        // 404 — not 403 — so cross-tenant probing can't enumerate.
        return jerr(404, "tab not found");
      }

      if (!verb && method === "DELETE") return closeTab(tabId, deps);
      if (!verb && method === "GET") return tabInfo(tabId, deps);
      if (verb === "navigate" && method === "POST") return navigate(req, tabId, appId, deps);
      if (verb === "fill" && method === "POST") return fill(req, tabId, deps);
      if (verb === "click" && method === "POST") return click(req, tabId, deps);
      if (verb === "dom" && method === "GET") return readDom(req, tabId, deps);
      if (verb === "screenshot" && method === "GET") return screenshot(tabId, deps);
      if (verb === "request-input" && method === "POST") return requestInput(req, tabId, deps);
      return jerr(405, "method not allowed for this resource");
    }
    return jerr(404, "no such browser route");
  };
}

// ──────────────────────────────────────────────────────────────────────
// Route handlers
// ──────────────────────────────────────────────────────────────────────

async function openTab(
  req: HttpRequest,
  appId: string,
  deps: BrowserApiDeps,
): Promise<HttpResponse> {
  const body = parseJson(req.body);
  const url = (body as { url?: string } | null)?.url;
  if (typeof url !== "string") return jerr(400, "url is required");
  if (deps.domainGate.check(appId, url) !== "allow") {
    return jerr(403, "domain not in app's browser.domains allowlist");
  }
  let tabId: string;
  try {
    const r = await deps.browser.openTab(url);
    tabId = r.tabId;
  } catch (e) {
    return jerr(502, `openTab failed: ${(e as Error).message}`);
  }
  deps.tabRegistry.assignTab(tabId, appId);
  // Equip the tab so the focus-watcher binding fires for password / OTP
  // fields. Failures here are non-fatal — the tab still works for nav,
  // we just won't surface input alerts.
  await deps.phonePipe.equipTab(tabId).catch(() => {});
  return { status: 200, headers: J, body: JSON.stringify({ tabId }) };
}

function listTabs(appId: string, deps: BrowserApiDeps): HttpResponse {
  const tabs = deps.tabRegistry.tabsForApp(appId);
  return { status: 200, headers: J, body: JSON.stringify({ tabs }) };
}

function tabInfo(tabId: string, deps: BrowserApiDeps): HttpResponse {
  return {
    status: 200,
    headers: J,
    body: JSON.stringify({ tabId, owner: deps.tabRegistry.appIdForTab(tabId) }),
  };
}

async function navigate(
  req: HttpRequest,
  tabId: string,
  appId: string,
  deps: BrowserApiDeps,
): Promise<HttpResponse> {
  const body = parseJson(req.body);
  const url = (body as { url?: string } | null)?.url;
  if (typeof url !== "string") return jerr(400, "url is required");
  if (deps.domainGate.check(appId, url) !== "allow") {
    return jerr(403, "domain not in app's browser.domains allowlist");
  }
  try {
    await deps.browser.navigate(tabId, url);
  } catch (e) {
    return jerr(502, `navigate failed: ${(e as Error).message}`);
  }
  return { status: 200, headers: J, body: JSON.stringify({ ok: true }) };
}

async function fill(req: HttpRequest, tabId: string, deps: BrowserApiDeps): Promise<HttpResponse> {
  const body = parseJson(req.body) as { selector?: string; value?: string } | null;
  if (!body || typeof body.selector !== "string" || typeof body.value !== "string") {
    return jerr(400, "selector and value are required");
  }
  try {
    await deps.browser.fill(tabId, body.selector, body.value);
  } catch (e) {
    return jerr(502, `fill failed: ${(e as Error).message}`);
  }
  return { status: 200, headers: J, body: JSON.stringify({ ok: true }) };
}

async function click(req: HttpRequest, tabId: string, deps: BrowserApiDeps): Promise<HttpResponse> {
  const body = parseJson(req.body) as { selector?: string } | null;
  if (!body || typeof body.selector !== "string") return jerr(400, "selector is required");
  try {
    await deps.browser.click(tabId, body.selector);
  } catch (e) {
    return jerr(502, `click failed: ${(e as Error).message}`);
  }
  return { status: 200, headers: J, body: JSON.stringify({ ok: true }) };
}

async function readDom(
  req: HttpRequest,
  tabId: string,
  deps: BrowserApiDeps,
): Promise<HttpResponse> {
  // selector arrives in the query string of req.path.
  const sel = extractQuery(req.path, "selector");
  if (!sel) return jerr(400, "selector query param is required");
  try {
    const html = await deps.browser.readDOM(tabId, sel);
    return {
      status: 200,
      headers: J,
      body: JSON.stringify({ outerHTML: html }),
    };
  } catch (e) {
    return jerr(502, `readDOM failed: ${(e as Error).message}`);
  }
}

async function screenshot(tabId: string, deps: BrowserApiDeps): Promise<HttpResponse> {
  try {
    const png = await deps.browser.screenshot(tabId);
    return { status: 200, headers: PNG, body: png };
  } catch (e) {
    return jerr(502, `screenshot failed: ${(e as Error).message}`);
  }
}

async function closeTab(tabId: string, deps: BrowserApiDeps): Promise<HttpResponse> {
  try {
    await deps.browser.closeTab(tabId);
  } catch {
    // best-effort
  }
  deps.tabRegistry.forgetTab(tabId);
  return { status: 200, headers: J, body: JSON.stringify({ ok: true }) };
}

async function requestInput(
  req: HttpRequest,
  tabId: string,
  deps: BrowserApiDeps,
): Promise<HttpResponse> {
  const body = parseJson(req.body) as { inputKind?: string; host?: string } | null;
  if (!body) return jerr(400, "body required");
  const kind = body.inputKind;
  if (kind !== "password" && kind !== "otp" && kind !== "text") {
    return jerr(400, "inputKind must be password|otp|text");
  }
  try {
    const r = await deps.phonePipe.requestInput({
      tabId,
      inputKind: kind as InputKind,
      host: body.host,
    });
    return { status: 200, headers: J, body: JSON.stringify(r) };
  } catch (e) {
    return jerr(500, (e as Error).message);
  }
}

async function getScreenshot(
  ref: string,
  appId: string,
  deps: BrowserApiDeps,
): Promise<HttpResponse> {
  // Phone-paired-session gating is future work; for now we gate on the
  // calling app being one with browser entitlement (any app with a grant
  // can attempt a fetch — but the ref space is opaque random hex, so an
  // app that didn't issue the request can't guess refs in practice).
  void appId;
  const png = deps.phonePipe.getScreenshot(ref);
  if (!png) return jerr(404, "screenshot ref not found or expired");
  return { status: 200, headers: PNG, body: png };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

async function resolveAppId(
  req: HttpRequest,
  tokens: AppAuthTokens,
): Promise<string | null> {
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  return await tokens.resolve(auth.slice("Bearer ".length).trim());
}

function parseJson(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

function jerr(status: number, message: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error: message }) };
}

/** Extract a query value from a path like "/api/browser/tabs/x/dom?selector=..." */
function extractQuery(input: string, key: string): string | null {
  const i = input.indexOf("?");
  if (i < 0) return null;
  const search = new URLSearchParams(input.slice(i + 1));
  return search.get(key);
}
