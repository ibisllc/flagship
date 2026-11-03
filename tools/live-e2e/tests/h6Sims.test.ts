// The simulators the H6 acceptance groups (relay-authority, relay-instances, phone-endpoint) lean on: if one of these
// lies, a live check passes for the wrong reason.
import { describe, expect, it } from "vitest";
import { parseClientHelloSni } from "@flagship/tunnel-protocol";
import { PHONE_ENVELOPE_CONTENT_TYPE, PHONE_SESSION_COOKIE } from "@flagship/protocol";
import { clientHello, readSimAnswer, relayInstances, simAnswer } from "../lib/boxSim.js";
import { cookieValue, parseHttpAnswer, parseHttpRequest, PhoneEndpointSim, type HttpRequestHead } from "../lib/phoneSim.js";
import { corsHeaders, corsProblem, refusalCode } from "../groups/release03/phoneEndpoint.js";

const HOST = "alice.gym.flagship.services";
const SELF = `https://${HOST}`;
const SIB = "https://evil.alice.gym.flagship.services";
const LISTED = "https://gym.voi.ci";

function head(method: string, path: string, headers: Record<string, string>, body = ""): HttpRequestHead {
  return { method, path, headers: { host: HOST, ...headers }, body };
}

function call(ep: PhoneEndpointSim, r: HttpRequestHead) {
  return parseHttpAnswer(ep.respond(r, HOST) as string)!;
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

describe("simulated phone endpoint (the 0.3 apps' policy: voi.ci live/deliver only)", () => {
  const ep = () => new PhoneEndpointSim({ account: "alice", label: "P", phoneRoutePub: "ab".repeat(32), origins: [LISTED] });

  it("parses a whole request only once its body has arrived", () => {
    const raw = `POST /api/phone/deliver HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 5\r\n\r\nab`;
    expect(parseHttpRequest(Buffer.from(raw))).toBeNull();
    expect(parseHttpRequest(Buffer.from(`${raw}cde`))?.body).toBe("abcde");
    expect(parseHttpRequest(Buffer.from(`GET / HTTP/1.1\r\nHost: x\r\n\r\n`))?.headers.host).toBe("x");
  });

  it("matches a cookie by its exact, case-sensitive name", () => {
    expect(cookieValue(`flagship-phone=a; __host-flagship-phone=b`, PHONE_SESSION_COOKIE)).toBeNull();
    expect(cookieValue(`x=1; ${PHONE_SESSION_COOKIE}=t`, PHONE_SESSION_COOKIE)).toBe("t");
  });

  it("answers the native reads with no Origin, and sets no cookie", () => {
    const e = ep();
    const w = call(e, head("GET", "/.well-known/flagship-phone", {}));
    expect(w.status).toBe(200);
    expect(JSON.parse(w.body)).toMatchObject({ account: "alice", hostname: HOST, phone: "P" });
    expect(call(e, head("GET", "/", {})).status).toBe(200);
    expect(w.headers["set-cookie"]).toBeUndefined();
    expect(corsHeaders(w)).toEqual([]);
  });

  it("refuses the retired session routes from every origin and with none", () => {
    const e = ep();
    const body = JSON.stringify({ code: "123456" });
    for (const origin of [SELF, SIB, LISTED]) {
      const a = call(e, head("POST", "/api/phone/session", { origin, "content-type": "application/json" }, body));
      expect([a.status, refusalCode(a)]).toEqual([403, "origin"]);
      expect(a.headers["set-cookie"]).toBeUndefined();
    }
    const none = call(e, head("POST", "/api/phone/ping", { cookie: `${PHONE_SESSION_COOKIE}=${"ab".repeat(32)}` }));
    expect([none.status, refusalCode(none)]).toEqual([403, "cross-origin"]);
  });

  it("refuses a sibling, the phone's own origin and Origin: null on live, preflight and deliver, without CORS", () => {
    const e = ep();
    for (const origin of [SIB, SELF, "null"]) {
      const answers = [
        call(e, head("GET", "/api/phone/live", { origin })),
        call(e, head("OPTIONS", "/api/phone/deliver", { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" })),
        call(e, head("POST", "/api/phone/deliver", { origin, "content-type": PHONE_ENVELOPE_CONTENT_TYPE }, "{}")),
      ];
      for (const a of answers) {
        expect([a.status, refusalCode(a)]).toEqual([403, "origin"]);
        expect(corsHeaders(a)).toEqual([]);
      }
    }
  });

  it("gives the listed origin live (404 without a page) and the preflight, with CORS for exactly it; refuses more", () => {
    const e = ep();
    const live = call(e, head("GET", "/api/phone/live", { origin: LISTED }));
    expect(live.status).toBe(404);
    expect(live.headers["access-control-allow-origin"]).toBe(LISTED);
    const pre = call(e, head("OPTIONS", "/api/phone/deliver", { origin: LISTED, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }));
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(LISTED);
    expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(refusalCode(call(e, head("OPTIONS", "/api/phone/deliver", { origin: LISTED, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" })))).toBe("preflight");
    expect(call(e, head("POST", "/api/phone/deliver", { origin: LISTED, "content-type": "text/plain" }, "{}")).status).toBe(415);
    expect(call(e, head("GET", "/api/phone/deliver", { origin: LISTED })).status).toBe(405);
    expect(refusalCode(call(e, head("GET", "/.well-known/flagship-phone", { origin: LISTED })))).toBe("origin");
  });

  it("refuses upgrades and a sibling Host", () => {
    const e = ep();
    const ws = { upgrade: "websocket", connection: "Upgrade" };
    expect(refusalCode(call(e, head("GET", "/", { ...ws, origin: SIB })))).toBe("origin");
    expect(refusalCode(call(e, head("GET", "/", { ...ws, origin: LISTED })))).toBe("origin");
    expect(refusalCode(call(e, head("GET", "/", ws)))).toBe("cross-origin");
    const a = call(e, { method: "GET", path: "/", headers: { host: "evil.alice.gym.flagship.services" }, body: "" });
    expect([a.status, refusalCode(a)]).toEqual([421, "wrong-host"]);
  });

  it("corsProblem accepts only CORS for the listed origin on the two operations", () => {
    const ok = { status: 200, headers: { "access-control-allow-origin": LISTED }, body: "" };
    expect(corsProblem(ok, { method: "GET", path: "/api/phone/live", origin: LISTED }, [LISTED])).toBeNull();
    expect(corsProblem({ status: 200, headers: {}, body: "" }, { method: "GET", path: "/", origin: SIB }, [LISTED])).toBeNull();
    expect(corsProblem(ok, { method: "GET", path: "/.well-known/flagship-phone", origin: LISTED }, [LISTED])).toMatch(/CORS on/);
    expect(corsProblem(ok, { method: "GET", path: "/api/phone/live", origin: SIB }, [LISTED])).toMatch(/unlisted/);
    expect(corsProblem({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "" }, { method: "GET", path: "/api/phone/live", origin: LISTED }, [LISTED])).toMatch(/Allow-Origin/);
    expect(corsProblem({ status: 200, headers: { "access-control-allow-origin": LISTED, "access-control-allow-credentials": "true" }, body: "" }, { method: "GET", path: "/api/phone/live?x=1", origin: LISTED }, [LISTED])).toMatch(/Credentials/);
  });
});
