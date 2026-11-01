// The simulators the H6 acceptance groups (relay-authority, relay-instances, phone-endpoint) lean on: if one of these
// lies, a live check passes for the wrong reason.
import { describe, expect, it } from "vitest";
import { parseClientHelloSni } from "@flagship/tunnel-protocol";
import { PHONE_CSRF_HEADER, PHONE_SESSION_COOKIE } from "@flagship/protocol";
import { clientHello, readSimAnswer, relayInstances, simAnswer } from "../lib/boxSim.js";
import { cookieValue, parseHttpAnswer, parseHttpRequest, PhoneEndpointSim, type HttpRequestHead } from "../lib/phoneSim.js";
import { corsHeaders, sessionCookieOf } from "../groups/release03/phoneEndpoint.js";

const HOST = "alice.gym.flagship.services";
const SELF = `https://${HOST}`;
const SIB = "https://evil.alice.gym.flagship.services";

function head(method: string, path: string, headers: Record<string, string>, body = ""): HttpRequestHead {
  return { method, path, headers: { host: HOST, ...headers }, body };
}

function call(ep: PhoneEndpointSim, r: HttpRequestHead) {
  return parseHttpAnswer(ep.respond(r, HOST))!;
}

function open(ep: PhoneEndpointSim): { token: string; csrf: string } {
  const code = ep.newCode();
  const a = call(ep, head("POST", "/api/phone/session", { origin: SELF }, JSON.stringify({ code })));
  expect(a.status).toBe(200);
  const c = sessionCookieOf(a.headers["set-cookie"])!;
  return { token: c.token, csrf: JSON.parse(a.body).csrf as string };
}

describe("simulated box helpers", () => {
  it("builds a ClientHello the relay's SNI parser reads back", () => {
    for (const sni of ["home.alice.gym.flagship.services", "simapp.sim1a2b3c.alice.gym.flagship.services"]) {
      const r = parseClientHelloSni(clientHello(sni));
      expect(r).toEqual({ kind: "ok", sni });
    }
  });

  it("tells a simulated box's answer from a real box's TLS", () => {
    expect(readSimAnswer(Buffer.from(simAnswer("S", "x.y.z")))).toEqual({ label: "S", sni: "x.y.z" });
    expect(readSimAnswer(Buffer.from([0x16, 3, 3, 0, 10]))).toBeNull();
    expect(readSimAnswer(Buffer.alloc(0))).toBeNull();
  });

  it("reads GYM_RELAY_INSTANCES as Fly machine ids and refuses anything else", () => {
    expect(relayInstances(undefined)).toEqual([]);
    expect(relayInstances("")).toEqual([]);
    expect(relayInstances("148e21ea7d6189, 3d8d9e1a2b4c58 148e21ea7d6189")).toEqual(["148e21ea7d6189", "3d8d9e1a2b4c58"]);
    expect(() => relayInstances("2")).toThrow(/machine id/);
    expect(() => relayInstances("abc;rm -rf")).toThrow();
  });
});

describe("simulated phone endpoint (the apps' policy)", () => {
  const ep = () => new PhoneEndpointSim({ account: "alice", label: "P", phoneRoutePub: "ab".repeat(32) });

  it("parses a whole request only once its body has arrived", () => {
    const raw = `POST /api/phone/session HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 5\r\n\r\nab`;
    expect(parseHttpRequest(Buffer.from(raw))).toBeNull();
    expect(parseHttpRequest(Buffer.from(`${raw}cde`))?.body).toBe("abcde");
    expect(parseHttpRequest(Buffer.from(`GET / HTTP/1.1\r\nHost: x\r\n\r\n`))?.headers.host).toBe("x");
  });

  it("matches the session cookie by its exact, case-sensitive name", () => {
    expect(cookieValue(`flagship-phone=a; __host-flagship-phone=b`, PHONE_SESSION_COOKIE)).toBeNull();
    expect(cookieValue(`x=1; ${PHONE_SESSION_COOKIE}=t`, PHONE_SESSION_COOKIE)).toBe("t");
  });

  it("opens a session for the code from the exact origin with a host-only __Host- cookie, and only once", () => {
    const e = ep();
    const code = e.newCode();
    const a = call(e, head("POST", "/api/phone/session", { origin: SELF }, JSON.stringify({ code })));
    const c = sessionCookieOf(a.headers["set-cookie"])!;
    expect(c.domain).toBe(false);
    for (const x of ["secure", "httponly", "samesite=strict", "path=/"]) expect(c.attrs.has(x)).toBe(true);
    expect(call(e, head("POST", "/api/phone/session", { origin: SELF }, JSON.stringify({ code }))).body).toContain("bad-code");
  });

  it("refuses a sibling's POST, preflight and upgrade even with the cookie and token; the owner's ping passes", () => {
    const e = ep();
    const { token, csrf } = open(e);
    const cookie = `${PHONE_SESSION_COOKIE}=${token}`;
    expect(call(e, head("POST", "/api/phone/ping", { origin: SELF, cookie, [PHONE_CSRF_HEADER]: csrf })).status).toBe(200);
    const variants: Array<Record<string, string>> = [
      { origin: SIB, cookie, [PHONE_CSRF_HEADER]: csrf },
      { origin: "null", cookie, [PHONE_CSRF_HEADER]: csrf },
      { cookie, [PHONE_CSRF_HEADER]: csrf },
    ];
    for (const h of variants) {
      expect(call(e, head("POST", "/api/phone/ping", h)).body).toContain("cross-origin");
    }
    expect(call(e, head("OPTIONS", "/api/phone/ping", { origin: SIB, "access-control-request-method": "POST" })).status).toBe(403);
    expect(call(e, head("GET", "/", { origin: SIB, cookie, upgrade: "websocket" })).body).toContain("cross-origin");
    expect(call(e, head("GET", "/", { origin: SELF, cookie, upgrade: "websocket" })).body).toContain("csrf");
    expect(call(e, head("POST", "/api/phone/ping", { origin: SELF, cookie })).body).toContain("csrf");
  });

  it("never authenticates a planted cookie, and a session opened over one gets a fresh token", () => {
    const e = ep();
    const { token, csrf } = open(e);
    for (const cookie of [`flagship-phone=${token}`, `__host-flagship-phone=${token}`, `${PHONE_SESSION_COOKIE}=${"ab".repeat(32)}`]) {
      expect(call(e, head("POST", "/api/phone/ping", { origin: SELF, cookie, [PHONE_CSRF_HEADER]: csrf })).body).toContain("no-session");
    }
    const code = e.newCode();
    const planted = "cd".repeat(32);
    const a = call(e, head("POST", "/api/phone/session", { origin: SELF, cookie: `${PHONE_SESSION_COOKIE}=${planted}` }, JSON.stringify({ code })));
    expect(sessionCookieOf(a.headers["set-cookie"])!.token).not.toBe(planted);
  });

  it("refuses a sibling Host and sends no CORS header on any answer", () => {
    const e = ep();
    const a = call(e, { method: "GET", path: "/", headers: { host: "evil.alice.gym.flagship.services" }, body: "" });
    expect(a.body).toContain("wrong-host");
    const w = call(e, head("GET", "/.well-known/flagship-phone", { origin: SIB }));
    expect(w.status).toBe(200);
    expect(JSON.parse(w.body)).toMatchObject({ account: "alice", hostname: HOST, phone: "P" });
    for (const x of [a, w]) expect(corsHeaders(x)).toEqual([]);
    expect(corsHeaders({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "" })).toEqual(["access-control-allow-origin"]);
  });
});
