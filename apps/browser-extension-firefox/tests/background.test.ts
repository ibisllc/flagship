import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ed, signDaemonStatusReport } from "@flagship/protocol";

const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const DOMAIN = "home.alice.flagship.services";
const CERT = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const colon = (hex: string) => hex.toUpperCase().match(/.{2}/g)!.join(":");
const stk = ed.utils.randomPrivateKey();
const stkPubHex = bytesToHex(ed.getPublicKey(stk));

type Details = { requestId: string; url: string; tabId: number; type: string };
let onHeaders: (d: Details) => Promise<{ cancel?: boolean }>;
let local: Record<string, unknown>;
let session: Record<string, unknown>;
let leafFor: (requestId: string) => string;
const tabsUpdate = vi.fn(async () => ({}));
const fetchMock = vi.fn();

function box(evidence: { certSha256: string; issuedAt: number } | null) {
  return {
    serverDomain: DOMAIN, username: "alice", stkPubHex, token: "11".repeat(32), tokenExpiresAt: Date.now() + 86_400_000,
    pairedAt: Date.now(), session: "active", evidence: evidence ? { ...evidence, certValidUntil: null } : null,
  };
}

function signedReport(cert: string) {
  const report = {
    serverDomain: DOMAIN, certSha256: cert, certValidUntil: null, certIssuer: null, appsServed: [] as string[],
    nonce: "00", issuedAt: Date.now(),
  };
  return { report, signatureHex: bytesToHex(signDaemonStatusReport(report, (m: Uint8Array) => ed.sign(m, stk))) };
}

beforeAll(async () => {
  const area = (get: () => Record<string, unknown>) => ({
    get: async (k: string) => (k in get() ? { [k]: get()[k] } : {}),
    set: async (o: Record<string, unknown>) => { Object.assign(get(), o); },
    remove: async (k: string) => { delete get()[k]; },
  });
  (globalThis as Record<string, unknown>).browser = {
    webRequest: {
      onHeadersReceived: { addListener: (fn: typeof onHeaders) => { onHeaders = fn; } },
      getSecurityInfo: async (requestId: string) => ({ state: "secure", certificates: [{ fingerprint: { sha256: colon(leafFor(requestId)) } }] }),
    },
    storage: { local: area(() => local), session: area(() => session) },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    i18n: { getMessage: (k: string) => k },
    tabs: { update: tabsUpdate, onRemoved: { addListener: () => {} } },
    runtime: { id: "ext", getURL: (p: string) => `moz-extension://ext/${p}`, onMessage: { addListener: () => {} } },
  };
  vi.stubGlobal("fetch", fetchMock);
  await import("../src/background.js");
});

beforeEach(() => {
  local = {};
  session = {};
  tabsUpdate.mockClear();
  fetchMock.mockReset();
});

const page = (url = `https://notes.${DOMAIN}/`): Details => ({ requestId: "r1", url, tabId: 3, type: "main_frame" });

describe("the pin check in Firefox", () => {
  it("lets the signed certificate through and remembers the verdict for the popup", async () => {
    local.boxes = { [DOMAIN]: box({ certSha256: CERT, issuedAt: Date.now() }) };
    leafFor = () => CERT;
    expect(await onHeaders(page())).toEqual({});
    expect(session["tab:3"]).toMatchObject({ verdict: "match", serverDomain: DOMAIN });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels another certificate and opens the warning page, after asking the box once", async () => {
    local.boxes = { [DOMAIN]: box({ certSha256: CERT, issuedAt: Date.now() }) };
    leafFor = () => OTHER;
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    expect(await onHeaders(page())).toEqual({ cancel: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(String(target)).toMatch(new RegExp(`^https://${DOMAIN.replace(/\./g, "\\.")}/api/companion/cert-pin\\?n=[0-9a-f]{16}$`));
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", headers: { "x-flagship-session": "11".repeat(32) } });
    expect(tabsUpdate).toHaveBeenCalledTimes(1);
    const warning = new URL((tabsUpdate.mock.calls[0] as unknown as [number, { url: string }])[1].url);
    expect(warning.pathname).toBe("/src/pages/blocked.html");
    expect(warning.searchParams.get("expected")).toBe(CERT);
    expect(warning.searchParams.get("served")).toBe(OTHER);
  });

  it("takes a renewed certificate the box signed over that same connection", async () => {
    local.boxes = { [DOMAIN]: box({ certSha256: CERT, issuedAt: Date.now() - 1000 }) };
    leafFor = () => OTHER;
    fetchMock.mockImplementation(async (target: string) => {
      await onHeaders({ requestId: "own", url: target, tabId: -1, type: "xmlhttprequest" });
      return new Response(JSON.stringify(signedReport(OTHER)), { status: 200 });
    });
    expect(await onHeaders(page())).toEqual({});
    expect((local.boxes as Record<string, ReturnType<typeof box>>)[DOMAIN].evidence?.certSha256).toBe(OTHER);
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it("blocks when the box's word names one certificate and the page another, before any pin", async () => {
    local.boxes = { [DOMAIN]: box(null) };
    leafFor = () => OTHER;
    fetchMock.mockImplementation(async (target: string) => {
      await onHeaders({ requestId: "own", url: target, tabId: -1, type: "xmlhttprequest" });
      return new Response(JSON.stringify(signedReport(CERT)), { status: 200 });
    });
    expect(await onHeaders(page())).toEqual({ cancel: true });
  });

  it("leaves a box it has nothing for to Firefox when the box can't be reached", async () => {
    local.boxes = { [DOMAIN]: box(null) };
    leafFor = () => OTHER;
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await onHeaders(page())).toEqual({});
    expect(session["tab:3"]).toMatchObject({ verdict: "no-evidence" });
  });

  it("never touches names outside Flagship", async () => {
    leafFor = () => OTHER;
    expect(await onHeaders(page("https://example.com/"))).toEqual({});
  });
});
