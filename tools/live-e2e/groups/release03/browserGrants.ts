// Browser grants beyond the manifest (SEC-BROWSER-002, 0.3): a probe app with `browser.domains` asks its
// box for more (a session on another site); the box holds the ask until the owner answers. The owner's
// answer is a signed `flagship/browser-grant/v1`: unsigned, wider than asked, or signed by another key is
// refused; Allow once on the session ask is granted for once and listed among the owner's grants; a
// signed `flagship/browser-grant-revoke/v1` withdraws it at once; a Deny makes the same ask wait.
//
// The app browser is OFF on every box (APP_BROWSER.enabled in packages/server-daemon/src/index.ts, the
// owner's decision). The group runs only against a box whose build turns it on and runs the chromium
// service (the gym branch may set APP_BROWSER.enabled for gym boxes); elsewhere the owner routes are not
// served and the group says so and stops.
import { bytesToHex } from "@noble/hashes/utils";
import { canonicalBrowserGrantAnswer, canonicalBrowserGrantRevoke, ed, type BrowserGrantAnswer } from "@flagship/protocol";
import { pair, type Account, type Box } from "../../lib/fleet.js";
import { assert, http, postJson, short, tryHttp } from "../../lib/harness.js";
import { buildAndDeploy, finishAndWaitLive, mcpOpen } from "../../lib/mcpBuild.js";
import type { Group } from "../types.js";
import { allowEgress, uninstall, until } from "./util.js";

const SLUG = "browserprobe";

/** A Python app that drives the box's browser API with its app token. */
function probeFiles(boxFqdn: string): Record<string, string> {
  return {
    "flagship.app.json": JSON.stringify({
      schema_version: 1,
      name: SLUG,
      version: "0.1.0",
      description: "gym browser probe",
      runtime: { base: "python-3.13", port: 8080, start: ["python", "app.py"], env: { GYM_BOX: boxFqdn } },
      data: {},
      network: { subdomain: SLUG, egress: [{ host: boxFqdn, why: "the box's app browser API" }] },
      browser: { domains: ["example.com"] },
      access: { enabled: true, public_routes: ["/*"], default_role: "member", role_descriptions: { member: "Uses it.", manager: "Same.", master: "Same." } },
      migration: { verification: "standard" },
    }, null, 2),
    "app.py": `import json, os, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BOX = "https://" + os.environ["GYM_BOX"]
TOKEN = os.environ.get("FLAGSHIP_APP_TOKEN", "")

def call(method, path, body=None):
    req = urllib.request.Request(BOX + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"authorization": "Bearer " + TOKEN, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:300]}
    except Exception as e:
        return 0, {"error": str(e)[:300]}

class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/":
            return self.send(200, {"app": "browser"})
        if u.path == "/ask":
            s, j = call("POST", "/api/browser/grant-requests", {"capabilities": q["caps"].split(","), "origins": q["origins"].split(","), "duration": q["duration"], "explanation": "gym probe"})
            return self.send(200, {"status": s, "body": j})
        if u.path == "/status":
            s, j = call("GET", "/api/browser/grant-requests/" + q["id"])
            return self.send(200, {"status": s, "body": j})
        if u.path == "/open":
            s, j = call("POST", "/api/browser/tabs", {"url": q["url"]})
            return self.send(200, {"status": s, "body": j})
        return self.send(404, {"error": "no route"})

    def log_message(self, *a):
        pass

ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), H).serve_forever()
`,
  };
}

type Ask = { requestId: string; serviceId: string; capabilities: string[]; origins: string[]; localNetwork: BrowserGrantAnswer["localNetwork"]; duration: BrowserGrantAnswer["duration"] };

function signedAnswer(acct: Account, b: Box, a: Ask, duration: BrowserGrantAnswer["duration"], key = acct.keys.adminRoot.privateKey) {
  const issuedAt = Date.now();
  const order: BrowserGrantAnswer = { serverDomain: b.fqdn, requestId: a.requestId, serviceId: a.serviceId, decision: "allow", duration, capabilities: a.capabilities, origins: a.origins, localNetwork: a.localNetwork, issuedAt };
  return { requestId: a.requestId, decision: "allow", issuedAt, duration, signature: bytesToHex(ed.sign(canonicalBrowserGrantAnswer(order), key)) };
}

function signedRevoke(acct: Account, b: Box, serviceId: string, grantId: string) {
  const issuedAt = Date.now();
  return { serviceId, grantId, issuedAt, signature: bytesToHex(ed.sign(canonicalBrowserGrantRevoke({ serverDomain: b.fqdn, serviceId, grantId, issuedAt }), acct.keys.adminRoot.privateKey)) };
}

export const browserGrants: Group = {
  name: "browser-grants",
  title: "an app asks for browser access beyond its manifest: the owner allows less than asked (signed), lists and withdraws it",
  needs: ["A1"],
  phase: 8,
  parallel: false,
  async run({ A, rec, box }) {
    const b = box("A1");
    const session = await pair(A, b);
    const s = { "x-flagship-session": session };
    const owner = (path: string) => `https://${b.fqdn}/api/browser/owner/${path}`;

    const on = await tryHttp(owner("grants"), { headers: s });
    if (on.status !== 200) {
      rec.skip("ask, answer, list, withdraw", `the app browser is off on ${b.serverName} (owner routes answer ${on.status}); a gym build with APP_BROWSER.enabled and the chromium service runs this group`);
      return;
    }
    const serviceId = `${A.username}--${SLUG}`;
    const app = `https://${SLUG}.${b.fqdn}`;
    const up = await rec.check("a browser probe app with browser.domains runs", async () => {
      const c = await mcpOpen(b, session, `gym-${SLUG}`);
      await buildAndDeploy(c, probeFiles(b.fqdn));
      await finishAndWaitLive(c, b, serviceId);
      await allowEgress(A, b, session, serviceId, b.fqdn);
      await until("the probe answering", 3 * 60_000, async () => ((await tryHttp(`${app}/`)).json?.app === "browser" ? true : undefined));
      return app;
    });
    if (!up) return;

    let ask: Ask | null = null;
    await rec.check("the app's ask for a session on another site waits for the owner, shown from its fields", async () => {
      const r = await http(`${app}/ask?caps=navigate,read-dom&origins=example.org&duration=session`);
      assert(r.json?.status === 202 && r.json?.body?.status === "pending", `ask: ${short(r.json)}`);
      const id = String(r.json.body.requestId);
      const list = await http(owner("grant-requests"), { headers: s });
      ask = ((list.json?.requests ?? []) as Ask[]).find((x) => x.requestId === id) ?? null;
      assert(ask && ask.serviceId === serviceId && ask.duration === "session" && ask.origins.join() === "example.org", `listed: ${short(list.json)}`);
      return id;
    });
    if (!ask) return;
    const a: Ask = ask;

    await rec.check("an unsigned, a wider and another key's answer are refused", async () => {
      const unsigned = await postJson(owner("grant-requests/answer"), { requestId: a.requestId, decision: "allow", issuedAt: Date.now(), duration: "session" }, s);
      assert(unsigned.status === 400, `unsigned ${unsigned.status}`);
      const wider = await postJson(owner("grant-requests/answer"), signedAnswer(A, b, a, "service"), s);
      assert(wider.status === 400, `wider ${wider.status}: ${short(wider.text)}`);
      const stranger = await postJson(owner("grant-requests/answer"), signedAnswer(A, b, a, "session", new Uint8Array(32).fill(7)), s);
      assert(stranger.status === 403, `another key ${stranger.status}`);
      return "400, 400, 403";
    });

    let grantId = "";
    await rec.check("Allow once on the session ask grants once, and the owner's list shows it", async () => {
      const r = await postJson(owner("grant-requests/answer"), signedAnswer(A, b, a, "once"), s);
      assert(r.status === 200 && r.json?.grantId, `allow ${r.status}: ${short(r.text)}`);
      grantId = String(r.json.grantId);
      const st = await http(`${app}/status?id=${a.requestId}`);
      assert(st.json?.body?.status === "allowed", `app sees ${short(st.json)}`);
      const list = await http(`${owner("grants")}?serviceId=${encodeURIComponent(serviceId)}`, { headers: s });
      const g = ((list.json?.grants ?? []) as Array<{ grantId: string; duration: string }>).find((x) => x.grantId === grantId);
      assert(g?.duration === "once", `grants: ${short(list.json)}`);
      return `${grantId} (once)`;
    });

    await rec.check("a signed withdraw drops the grant at once; an unsigned one is refused", async () => {
      assert(grantId, "no grant to withdraw");
      const unsigned = await postJson(owner("grants/revoke"), { serviceId, grantId, issuedAt: Date.now() }, s);
      assert(unsigned.status === 400, `unsigned ${unsigned.status}`);
      const r = await postJson(owner("grants/revoke"), signedRevoke(A, b, serviceId, grantId), s);
      assert(r.status === 200, `revoke ${r.status}: ${short(r.text)}`);
      const list = await http(`${owner("grants")}?serviceId=${encodeURIComponent(serviceId)}`, { headers: s });
      assert(!((list.json?.grants ?? []) as Array<{ grantId: string }>).some((x) => x.grantId === grantId), `still listed: ${short(list.json)}`);
      const again = await postJson(owner("grants/revoke"), signedRevoke(A, b, serviceId, grantId), s);
      assert(again.status === 404, `second revoke ${again.status}`);
      const open = await http(`${app}/open?url=${encodeURIComponent("https://example.org/")}`);
      assert(open.json?.status === 403, `a withdrawn site opened: ${short(open.json)}`);
      return "withdrawn; the site is refused";
    });

    await rec.check("a Deny makes the same ask wait before it can be asked again", async () => {
      const r = await http(`${app}/ask?caps=navigate&origins=example.net&duration=once`);
      const id = String(r.json?.body?.requestId ?? "");
      assert(id, `ask: ${short(r.json)}`);
      const d = await postJson(owner("grant-requests/answer"), { requestId: id, decision: "deny", issuedAt: Date.now() }, s);
      assert(d.status === 200, `deny ${d.status}`);
      const again = await http(`${app}/ask?caps=navigate&origins=example.net&duration=once`);
      assert(again.json?.status === 429, `asked again: ${short(again.json)}`);
      return "429 with a cooldown";
    });
    await uninstall(A, b, SLUG);
  },
};
