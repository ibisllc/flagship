// A malicious sibling web app against the phone's endpoint (Appendix H scenario 11; Appendix I §7 and the last item of
// §8). A simulated admin phone (lib/phoneSim.ts: the apps' endpoint routes, decided by the shared
// `phoneEndpointCheck` the iOS and Android endpoints mirror) holds the bare `<account>.<apex>` through the REAL gym
// relay, terminating TLS itself. The harness then sends, byte for byte through the relay, what a browser would send on
// behalf of a page served by a sibling app (`https://<app>.<account>.<apex>` or `https://<app>.<box>`: same-site, not
// same-origin, so the browser attaches the phone's cookie to it): CSRF with and without a token, planted cookies,
// cross-origin reads and preflights, WebSocket upgrades, a mismatched Host. Sensitive operations must stay refused,
// the owner's own flow must keep working, and no answer may ever carry a CORS header.
//
// What it cannot prove: the iOS and Android endpoints' own code (unit tests and the shared vectors do), or a real
// browser's cookie jar (the requests are the ones a browser would make; a browser additionally refuses to let a
// sibling set a `__Host-` cookie at all). Runs in its own phase: it holds account A's bare name, which phone-route
// also uses. Leaves behind: nothing (the phone's grant is revoked).
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { bytesToHex } from "@noble/hashes/utils";
import { ed, PHONE_CSRF_HEADER, PHONE_SESSION_COOKIE, signRevokeDeviceCapabilityGrant } from "@flagship/protocol";
import { mintDeviceGrant } from "../../lib/fleet.js";
import { CONTROL, SERVICES, SkipError, assert, http, postJson, short } from "../../lib/harness.js";
import { SimPhone, phoneRequest, selfSignedPhoneCert, type PhoneHttpAnswer } from "../../lib/phoneSim.js";
import type { Group } from "../types.js";

/** Every `access-control-*` header an answer carries (there must be none). */
export function corsHeaders(a: PhoneHttpAnswer): string[] {
  return Object.keys(a.headers).filter((h) => h.startsWith("access-control-"));
}

/** The session cookie's attributes from a Set-Cookie line, or null when it is not the phone's session cookie. */
export function sessionCookieOf(setCookie: string | undefined): { token: string; attrs: Set<string>; domain: boolean } | null {
  if (!setCookie) return null;
  const parts = setCookie.split(";").map((p) => p.trim());
  const first = parts[0] ?? "";
  if (!first.startsWith(`${PHONE_SESSION_COOKIE}=`)) return null;
  const attrs = new Set(parts.slice(1).map((p) => p.toLowerCase()));
  return { token: first.slice(PHONE_SESSION_COOKIE.length + 1), attrs, domain: parts.slice(1).some((p) => /^domain=/i.test(p)) };
}

export const phoneEndpoint: Group = {
  name: "phone-endpoint",
  title: "a sibling app's page cannot use the phone endpoint: CSRF, planted cookies, cross-origin reads and preflights, WebSocket upgrades and Host confusion are refused through the real relay; the owner's session still works; no CORS ever",
  needs: ["A1"],
  phase: 4.2,
  async run({ A, rec, box }) {
    const acct = A;
    const bare = `${acct.username}.${SERVICES}`;
    const self = `https://${bare}`;
    const siblings = [`https://evil.${acct.username}.${SERVICES}`, `https://evil.${box("A1").fqdn}`];
    const ep = await http(`https://${CONTROL}/api/services/endpoints`);
    const hub = typeof ep.json?.tunnelHub === "string" ? (ep.json.tunnelHub as string) : "";
    const url = hub.replace(/\/tunnel$/, "/phone-tunnel");
    const seed = new Uint8Array(randomBytes(32));
    const cert = selfSignedPhoneCert(bare);
    let phone: SimPhone;
    try {
      phone = await SimPhone.connect(url, { account: acct.username, seed, label: "P", tls: cert });
    } catch (e) {
      await rec.check("the gym relay offers /phone-tunnel", async () => {
        throw new SkipError(`no phone tunnel at ${url || "(no tunnelHub)"}: ${String(e)} (the relay needs the serving authority on)`);
      });
      return;
    }
    const relayIp = (await lookup(box("A1").fqdn, { family: 4 })).address;
    const answers: PhoneHttpAnswer[] = [];
    const req = async (method: string, path: string, headers: Record<string, string>, body?: string): Promise<PhoneHttpAnswer> => {
      for (let i = 0; i < 4; i++) {
        const a = await phoneRequest({ ip: relayIp, sni: bare, ca: [cert.cert], method, path, headers: { host: bare, ...headers }, ...(body !== undefined ? { body } : {}) });
        if (a) {
          answers.push(a);
          return a;
        }
      }
      throw new Error(`no answer from the phone for ${method} ${path}`);
    };
    const refused = (what: string, a: PhoneHttpAnswer, code: string) => {
      assert(a.status === 403, `${what}: ${a.status} ${short(a.body)} (expected 403 ${code})`);
      assert(a.body.includes(`"code":"${code}"`), `${what}: refused ${short(a.body)}, expected ${code}`);
      return `${what}: ${code}`;
    };
    let grantId = "";
    let token = "";
    let csrf = "";
    const cookie = () => `${PHONE_SESSION_COOKIE}=${token}`;

    try {
      const ready = await rec.check("setup: an admin-granted simulated phone holds the bare name through the relay", async () => {
        const kp = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
        const g = await mintDeviceGrant(acct, randomBytes(16).toString("hex"), kp, ["admin"], acct.keys.adminRoot);
        assert(g.status === 200 && typeof g.json?.grantId === "string", `grant ${g.status}: ${short(g.text)}`);
        grantId = g.json.grantId as string;
        const c = await phone.acquire();
        assert(c.type === "granted", `claim: ${JSON.stringify(c)}`);
        const w = await req("GET", "/.well-known/flagship-phone", {});
        assert(w.status === 200 && w.body.includes(`"phone":"P"`), `well-known ${w.status} ${short(w.body)}`);
        return `generation ${String(c.generation)}`;
      });
      if (!ready) return;

      await rec.check("the owner's flow works: the one-time code from the exact origin opens a session with a host-only __Host- cookie (Secure, HttpOnly, SameSite=Strict, Path=/, no Domain) and a CSRF token; a ping with both is allowed", async () => {
        const code = phone.endpoint.newCode();
        const s = await req("POST", "/api/phone/session", { origin: self, "content-type": "application/json" }, JSON.stringify({ code }));
        assert(s.status === 200, `session ${s.status} ${short(s.body)}`);
        const c = sessionCookieOf(s.headers["set-cookie"]);
        assert(c, `no ${PHONE_SESSION_COOKIE} in ${short(s.headers["set-cookie"])}`);
        for (const a of ["secure", "httponly", "samesite=strict", "path=/"]) assert(c.attrs.has(a), `the cookie lacks ${a}: ${s.headers["set-cookie"]}`);
        assert(!c.domain, `the cookie names a Domain: ${s.headers["set-cookie"]}`);
        token = c.token;
        csrf = String(JSON.parse(s.body).csrf ?? "");
        assert(/^[0-9a-f]{64}$/.test(csrf), `no CSRF token: ${short(s.body)}`);
        const ping = await req("POST", "/api/phone/ping", { origin: self, cookie: cookie(), [PHONE_CSRF_HEADER]: csrf });
        assert(ping.status === 200, `owner's ping ${ping.status} ${short(ping.body)}`);
        const reuse = await req("POST", "/api/phone/session", { origin: self }, JSON.stringify({ code }));
        return `${refused("the code used twice", reuse, "bad-code")}; ping 200`;
      });

      await rec.check("CSRF: a sibling page's POST (the browser attaches the phone's same-site cookie) is refused with or without the token; a null or missing Origin too; the exact origin still needs the token", async () => {
        const out: string[] = [];
        for (const sib of siblings) {
          out.push(refused(`${sib} no token`, await req("POST", "/api/phone/ping", { origin: sib, cookie: cookie() }), "cross-origin"));
          out.push(refused(`${sib} with token`, await req("POST", "/api/phone/ping", { origin: sib, cookie: cookie(), [PHONE_CSRF_HEADER]: csrf }), "cross-origin"));
          out.push(refused(`${sib} form post`, await req("POST", "/api/phone/ping", { origin: sib, cookie: cookie(), "content-type": "text/plain" }, "x=1"), "cross-origin"));
          const code = phone.endpoint.newCode();
          out.push(refused(`${sib} opening a session with a valid code`, await req("POST", "/api/phone/session", { origin: sib, "content-type": "application/json" }, JSON.stringify({ code })), "cross-origin"));
        }
        out.push(refused("Origin: null", await req("POST", "/api/phone/ping", { origin: "null", cookie: cookie(), [PHONE_CSRF_HEADER]: csrf }), "cross-origin"));
        out.push(refused("no Origin", await req("POST", "/api/phone/ping", { cookie: cookie(), [PHONE_CSRF_HEADER]: csrf }), "cross-origin"));
        out.push(refused("http:// origin", await req("POST", "/api/phone/ping", { origin: `http://${bare}`, cookie: cookie(), [PHONE_CSRF_HEADER]: csrf }), "cross-origin"));
        out.push(refused("exact origin, no token", await req("POST", "/api/phone/ping", { origin: self, cookie: cookie() }), "csrf"));
        out.push(refused("exact origin, wrong token", await req("POST", "/api/phone/ping", { origin: self, cookie: cookie(), [PHONE_CSRF_HEADER]: "0".repeat(64) }), "csrf"));
        return `${out.length} refused`;
      });

      await rec.check("cookie injection: cookies a sibling can plant (Domain-wide `flagship-phone`, a case-variant `__host-` name, an attacker-chosen value) never authenticate; a session opened over a planted cookie gets a fresh token and the planted one stays useless", async () => {
        const out = [
          refused("Domain-wide name", await req("POST", "/api/phone/ping", { origin: self, cookie: `flagship-phone=${token}`, [PHONE_CSRF_HEADER]: csrf }), "no-session"),
          refused("__host- (case variant)", await req("POST", "/api/phone/ping", { origin: self, cookie: `__host-flagship-phone=${token}`, [PHONE_CSRF_HEADER]: csrf }), "no-session"),
          refused("planted value", await req("POST", "/api/phone/ping", { origin: self, cookie: `${PHONE_SESSION_COOKIE}=${"ab".repeat(32)}`, [PHONE_CSRF_HEADER]: csrf }), "no-session"),
        ];
        const planted = "cd".repeat(32);
        const code = phone.endpoint.newCode();
        const s = await req("POST", "/api/phone/session", { origin: self, cookie: `${PHONE_SESSION_COOKIE}=${planted}`, "content-type": "application/json" }, JSON.stringify({ code }));
        const c = sessionCookieOf(s.headers["set-cookie"]);
        assert(s.status === 200 && c && c.token !== planted, `session over a planted cookie: ${s.status} ${short(s.headers["set-cookie"])}`);
        const newCsrf = String(JSON.parse(s.body).csrf ?? "");
        out.push(refused("the planted token with the new CSRF", await req("POST", "/api/phone/ping", { origin: self, cookie: `${PHONE_SESSION_COOKIE}=${planted}`, [PHONE_CSRF_HEADER]: newCsrf }), "no-session"));
        return out.join("; ");
      });

      await rec.check("cross-origin reads: a sibling's read gets no CORS grant and nothing secret; its preflight is refused", async () => {
        const out: string[] = [];
        for (const sib of siblings) {
          const w = await req("GET", "/.well-known/flagship-phone", { origin: sib, cookie: cookie() });
          assert(w.status === 200, `well-known ${w.status}`);
          assert(corsHeaders(w).length === 0, `CORS on a read: ${corsHeaders(w).join(", ")}`);
          assert(!w.body.includes(csrf) && !w.body.includes(token), "the read answer holds the session's secrets");
          const pre = await req("OPTIONS", "/api/phone/ping", { origin: sib, "access-control-request-method": "POST", "access-control-request-headers": PHONE_CSRF_HEADER });
          out.push(refused(`${sib} preflight`, pre, "cross-origin"));
        }
        return out.join("; ");
      });

      await rec.check("WebSocket: a sibling's upgrade (cookie attached) is refused; an exact-origin upgrade without the CSRF token too; nothing ever answers 101", async () => {
        const ws = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13" };
        const out: string[] = [];
        for (const sib of siblings) out.push(refused(`${sib} upgrade`, await req("GET", "/", { ...ws, origin: sib, cookie: cookie() }), "cross-origin"));
        out.push(refused("no-Origin upgrade", await req("GET", "/", { ...ws, cookie: cookie() }), "cross-origin"));
        out.push(refused("exact origin, no token", await req("GET", "/", { ...ws, origin: self, cookie: cookie() }), "csrf"));
        assert(answers.every((a) => a.status !== 101), "an upgrade was accepted");
        return out.join("; ");
      });

      await rec.check("Host confusion: the phone's name in SNI with a sibling's Host is refused for reads and writes", async () => {
        const out: string[] = [];
        for (const sib of siblings) {
          const host = new URL(sib).host;
          out.push(refused(`GET Host ${host}`, await req("GET", "/", { host }), "wrong-host"));
          out.push(refused(`POST Host ${host}`, await req("POST", "/api/phone/ping", { host, origin: sib, cookie: cookie(), [PHONE_CSRF_HEADER]: csrf }), "wrong-host"));
        }
        return out.join("; ");
      });

      await rec.check("no answer the phone gave in this group carried an Access-Control-* header", async () => {
        const bad = answers.filter((a) => corsHeaders(a).length > 0);
        assert(bad.length === 0, `${bad.length} answers with CORS: ${bad.map((a) => corsHeaders(a).join(",")).join(" | ")}`);
        return `${answers.length} answers, none with CORS`;
      });
    } finally {
      phone.terminate();
      if (grantId) {
        const r = { grantId, username: acct.username, reason: "decommissioned" as const, issuedAt: Date.now() };
        await postJson(`https://${CONTROL}/api/users/${acct.username}/device-grants/revoke`, { request: r, signature: bytesToHex(signRevokeDeviceCapabilityGrant(r, acct.keys.irk)) }).catch(() => undefined);
      }
    }
  },
};
