// A malicious sibling web app against the phone's endpoint (Appendix H scenario 11; Appendix I §7 and the last item of
// §8), as the 0.3 apps serve it: the one-time-code browser session (`/api/phone/session`, `/api/phone/ping`, the
// `__Host-` cookie) is retired, and the only operations a website reaches are voi.ci's `GET /api/phone/live` and
// `POST /api/phone/deliver` (docs/voici-and-messages.md §8.2), from the listed voi.ci origins only (the gym:
// `https://gym.voi.ci`). A simulated admin phone (lib/phoneSim.ts: decided by the shared `phoneWebCheck`, then
// `phoneEndpointCheck`, which the iOS and Android endpoints mirror) holds the bare `<account>.<apex>` through the REAL
// gym relay, terminating TLS itself. The harness then sends, byte for byte through the relay, what a browser would send
// on behalf of a page served by a sibling app (`https://<app>.<account>.<apex>` or `https://<app>.<box>`: same-site,
// so the browser attaches any cookie it holds) and by the phone's own name: cross-origin reads, preflights and
// deliveries, form posts, the retired session routes, planted cookies, WebSocket upgrades, a mismatched Host. Every
// one must be refused with no CORS header; CORS may only ever name the listed origin, on live, deliver and its
// preflight; no answer sets a cookie. The voi.ci content of live/deliver (signed envelopes, acks) is the voici group's.
//
// What it cannot prove: the iOS and Android endpoints' own code (unit tests and the shared vectors do), or a real
// browser's cookie jar. Runs in its own phase: it holds account A's bare name, which phone-route also uses. Leaves
// behind: nothing (the phone's grant is revoked).
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { bytesToHex } from "@noble/hashes/utils";
import { ed, PHONE_DELIVER_PATH, PHONE_ENVELOPE_CONTENT_TYPE, PHONE_LIVE_PATH, PHONE_SESSION_COOKIE, PHONE_WEB_ORIGINS_GYM, signRevokeDeviceCapabilityGrant } from "@flagship/protocol";
import { mintDeviceGrant } from "../../lib/fleet.js";
import { accountReadHeaders } from "../../readToken.js";
import { CONTROL, SERVICES, SkipError, assert, http, postJson, short } from "../../lib/harness.js";
import { SimPhone, phoneRequest, selfSignedPhoneCert, type PhoneHttpAnswer } from "../../lib/phoneSim.js";
import type { Group } from "../types.js";

/** The origins the gym's phone endpoint lets reach live/deliver (GYM_PHONE_WEB_ORIGIN overrides, e.g. another gym apex). */
export const GYM_PHONE_ORIGINS: readonly string[] = process.env.GYM_PHONE_WEB_ORIGIN ? [process.env.GYM_PHONE_WEB_ORIGIN] : PHONE_WEB_ORIGINS_GYM;

/** Every `access-control-*` header an answer carries. */
export function corsHeaders(a: PhoneHttpAnswer): string[] {
  return Object.keys(a.headers).filter((h) => h.startsWith("access-control-"));
}

/**
 * Why an answer's CORS is wrong, or null when it is right: CORS only on live, deliver or the deliver preflight, only
 * for a request whose Origin is listed, naming exactly that origin (never `*`), and never Allow-Credentials.
 */
export function corsProblem(a: PhoneHttpAnswer, req: { method: string; path: string; origin: string | null }, listed: readonly string[]): string | null {
  const h = corsHeaders(a);
  if (h.length === 0) return null;
  const path = req.path.split("?")[0]!;
  const op = path === PHONE_LIVE_PATH || path === PHONE_DELIVER_PATH;
  if (!op) return `CORS on ${req.method} ${path}`;
  if (req.origin === null || !listed.includes(req.origin)) return `CORS for an unlisted origin ${req.origin ?? "(none)"}`;
  const allow = a.headers["access-control-allow-origin"];
  if (allow !== req.origin) return `Allow-Origin ${allow ?? "(missing)"} for ${req.origin}`;
  if (a.headers["access-control-allow-credentials"] !== undefined) return "Allow-Credentials sent";
  return null;
}

/** The refusal code in an endpoint answer's JSON body, or null. */
export function refusalCode(a: PhoneHttpAnswer): string | null {
  try {
    const c = (JSON.parse(a.body) as { code?: unknown }).code;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

export const phoneEndpoint: Group = {
  name: "phone-endpoint",
  title: "a sibling app's page cannot use the phone endpoint (0.3: voi.ci live/deliver only): cross-origin reads, preflights, deliveries and form posts, the retired session routes, planted cookies, WebSocket upgrades and Host confusion are refused through the real relay; CORS only ever for the listed voi.ci origin; no cookie",
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
      phone = await SimPhone.connect(url, { account: acct.username, seed, label: "P", tls: cert, origins: GYM_PHONE_ORIGINS, com: { control: CONTROL, readHeaders: async () => (acct.demo ? {} : accountReadHeaders(CONTROL, acct.username, acct.keys.irk)) } });
    } catch (e) {
      await rec.check("the gym relay offers /phone-tunnel", async () => {
        throw new SkipError(`no phone tunnel at ${url || "(no tunnelHub)"}: ${String(e)} (the relay needs the serving authority on)`);
      });
      return;
    }
    const relayIp = (await lookup(box("A1").fqdn, { family: 4 })).address;
    const answers: Array<{ a: PhoneHttpAnswer; req: { method: string; path: string; origin: string | null } }> = [];
    const req = async (method: string, path: string, headers: Record<string, string>, body?: string): Promise<PhoneHttpAnswer> => {
      for (let i = 0; i < 4; i++) {
        const a = await phoneRequest({ ip: relayIp, sni: bare, ca: [cert.cert], method, path, headers: { host: bare, ...headers }, ...(body !== undefined ? { body } : {}) });
        if (a) {
          answers.push({ a, req: { method, path, origin: headers.origin ?? null } });
          return a;
        }
      }
      throw new Error(`no answer from the phone for ${method} ${path}`);
    };
    const refused = (what: string, a: PhoneHttpAnswer, status: number, code: string) => {
      assert(a.status === status && refusalCode(a) === code, `${what}: ${a.status} ${short(a.body)} (expected ${status} ${code})`);
      assert(corsHeaders(a).length === 0, `${what}: a refusal carried CORS (${corsHeaders(a).join(", ")})`);
      return `${what}: ${status} ${code}`;
    };
    const listed = GYM_PHONE_ORIGINS[0]!;
    const envelope = JSON.stringify({ kind: "voici-message", v: 1 });
    const planted = `${PHONE_SESSION_COOKIE}=${"ab".repeat(32)}; flagship-phone=${"cd".repeat(32)}`;
    let grantId = "";

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

      await rec.check("the native reads the apps use still work: GET / and the well-known answer 200 with no Origin, no CORS and no cookie", async () => {
        const root = await req("GET", "/", {});
        const w = await req("GET", "/.well-known/flagship-phone", {});
        for (const [n, a] of [["GET /", root], ["well-known", w]] as const) {
          assert(a.status === 200, `${n}: ${a.status} ${short(a.body)}`);
          assert(corsHeaders(a).length === 0 && a.headers["set-cookie"] === undefined, `${n}: CORS or a cookie: ${short(a.headers)}`);
        }
        return "200, 200";
      });

      await rec.check("the retired one-time-code session is gone: /api/phone/session and /api/phone/ping are refused from the phone's own origin, a sibling and with no Origin, and no answer sets a cookie", async () => {
        const out: string[] = [];
        const code = JSON.stringify({ code: "123456" });
        out.push(refused("session, own origin", await req("POST", "/api/phone/session", { origin: self, "content-type": "application/json" }, code), 403, "origin"));
        out.push(refused("ping, own origin", await req("POST", "/api/phone/ping", { origin: self, cookie: planted }), 403, "origin"));
        for (const sib of siblings) out.push(refused(`session, ${sib}`, await req("POST", "/api/phone/session", { origin: sib, "content-type": "application/json" }, code), 403, "origin"));
        out.push(refused("session, no Origin", await req("POST", "/api/phone/session", { "content-type": "application/json" }, code), 403, "cross-origin"));
        out.push(refused("ping, no Origin, planted cookie", await req("POST", "/api/phone/ping", { cookie: planted }), 403, "cross-origin"));
        return out.join("; ");
      });

      await rec.check("a sibling app's page (cookie attached) cannot read live, preflight or post a delivery, or post a form; nor can the phone's own name as an origin, Origin: null or http://", async () => {
        const out: string[] = [];
        const bad = [...siblings, self, "null", `http://${bare}`];
        for (const o of bad) {
          out.push(refused(`${o} live`, await req("GET", PHONE_LIVE_PATH, { origin: o, cookie: planted }), 403, "origin"));
          out.push(refused(`${o} preflight`, await req("OPTIONS", PHONE_DELIVER_PATH, { origin: o, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }), 403, "origin"));
          out.push(refused(`${o} deliver`, await req("POST", PHONE_DELIVER_PATH, { origin: o, cookie: planted, "content-type": PHONE_ENVELOPE_CONTENT_TYPE }, envelope), 403, "origin"));
          out.push(refused(`${o} form post`, await req("POST", PHONE_DELIVER_PATH, { origin: o, cookie: planted, "content-type": "application/x-www-form-urlencoded" }, "x=1"), 403, "origin"));
        }
        return `${out.length} refused`;
      });

      await rec.check(`the listed origin (${listed}) gets only what voi.ci needs: live and the deliver preflight with CORS for exactly that origin; a preflight asking for more, a simple-request content type, GET deliver and any other path are refused`, async () => {
        const live = await req("GET", PHONE_LIVE_PATH, { origin: listed });
        assert((live.status === 200 || live.status === 404) && live.headers["access-control-allow-origin"] === listed, `live ${live.status} ${short(live.headers)}`);
        const pre = await req("OPTIONS", PHONE_DELIVER_PATH, { origin: listed, "access-control-request-method": "POST", "access-control-request-headers": "content-type" });
        assert(pre.status === 204 && pre.headers["access-control-allow-origin"] === listed && pre.headers["access-control-allow-credentials"] === undefined, `preflight ${pre.status} ${short(pre.headers)}`);
        const out = [
          refused("preflight + authorization", await req("OPTIONS", PHONE_DELIVER_PATH, { origin: listed, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" }), 403, "preflight"),
          refused("preflight for live", await req("OPTIONS", PHONE_LIVE_PATH, { origin: listed, "access-control-request-method": "GET" }), 403, "preflight"),
          refused("text/plain deliver", await req("POST", PHONE_DELIVER_PATH, { origin: listed, "content-type": "text/plain" }, envelope), 415, "content-type"),
          refused("GET deliver", await req("GET", PHONE_DELIVER_PATH, { origin: listed }), 405, "method"),
          refused("well-known from the listed origin", await req("GET", "/.well-known/flagship-phone", { origin: listed }), 403, "origin"),
          refused("the retired ping from the listed origin", await req("POST", "/api/phone/ping", { origin: listed }), 403, "origin"),
        ];
        return `live ${live.status} + preflight 204 with CORS for ${listed}; ${out.join("; ")}`;
      });

      await rec.check("WebSocket: no upgrade from a sibling, the listed origin, the phone's own origin or with no Origin; nothing ever answers 101", async () => {
        const ws = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13" };
        const out: string[] = [];
        for (const o of [...siblings, listed, self]) out.push(refused(`${o} upgrade`, await req("GET", "/", { ...ws, origin: o, cookie: planted }), 403, "origin"));
        out.push(refused("no-Origin upgrade", await req("GET", "/", { ...ws, cookie: planted }), 403, "cross-origin"));
        assert(answers.every((x) => x.a.status !== 101), "an upgrade was accepted");
        return out.join("; ");
      });

      await rec.check("Host confusion: the phone's name in SNI with a sibling's Host is refused (421) for reads, live and deliveries", async () => {
        const out: string[] = [];
        for (const sib of siblings) {
          const host = new URL(sib).host;
          out.push(refused(`GET / Host ${host}`, await req("GET", "/", { host }), 421, "wrong-host"));
          out.push(refused(`live Host ${host}`, await req("GET", PHONE_LIVE_PATH, { host, origin: listed }), 421, "wrong-host"));
          out.push(refused(`deliver Host ${host}`, await req("POST", PHONE_DELIVER_PATH, { host, origin: listed, "content-type": PHONE_ENVELOPE_CONTENT_TYPE }, envelope), 421, "wrong-host"));
        }
        return out.join("; ");
      });

      await rec.check("across every answer in this group: CORS only on live/deliver for the listed origin and naming exactly it, never credentials; no Set-Cookie at all", async () => {
        const bad = answers.map((x) => corsProblem(x.a, x.req, GYM_PHONE_ORIGINS)).filter((p): p is string => p !== null);
        assert(bad.length === 0, `${bad.length} bad CORS answers: ${bad.slice(0, 5).join(" | ")}`);
        const cookies = answers.filter((x) => x.a.headers["set-cookie"] !== undefined);
        assert(cookies.length === 0, `${cookies.length} answers set a cookie`);
        return `${answers.length} answers checked`;
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
