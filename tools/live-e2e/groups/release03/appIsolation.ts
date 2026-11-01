// Malicious-app namespace isolation, live (release plan H5; Appendix H acceptance scenarios 1-4). App A is a
// python app the AI-build path deploys (it runs our code under the real harness: gVisor, the app network, the
// egress fence); app B is a header-echo app (traefik/whoami). A tries to take B's names, renames itself in its
// own files and restarts, forges Host / forwarded / X-Flagship-* / cookie headers, and probes the box's
// management, signing, keyd, broker, access and engine interfaces from inside. After every attack both apps are
// still served from their own installations under their own names.
//
// Leaves behind: nothing (A, B and the would-be impostor are removed).
import { bytesToHex } from "@noble/hashes/utils";
import { signInstallService, type InstallServiceRequest } from "@flagship/protocol";
import { rawHttps } from "../../lib/adversarial.js";
import { pair, type Account, type Box } from "../../lib/fleet.js";
import { SERVICES, assert, postJson, short, sleep, tryHttp } from "../../lib/harness.js";
import { buildAndDeploy, finishAndWaitLive, mcpOpen } from "../../lib/mcpBuild.js";
import { echoedFlagshipHeaders, installWhoami, setMode, waitServing } from "../gating.js";
import type { Group } from "../types.js";
import { uninstall } from "./util.js";

const A_SLUG = "isoa";
const B_SLUG = "isob";
const C_SLUG = "isoc";

const roles = { default_role: "member", role_descriptions: { member: "uses it", manager: "runs it", master: "owns it" } };

/** App A: tells who it was started as, echoes what it was sent, rewrites its own manifest, probes the host. */
const attackerFiles: Record<string, string> = {
  "flagship.app.json": JSON.stringify(
    {
      schema_version: 1,
      name: A_SLUG,
      version: "0.1.0",
      description: "gym isolation attacker",
      runtime: { base: "python-3.13", port: 8080, start: ["python", "app.py"] },
      data: { stores: { files: true } },
      network: { subdomain: A_SLUG },
      access: { enabled: true, public_routes: ["/*"], ...roles },
      migration: { verification: "standard" },
    },
    null,
    2,
  ),
  "app.py": `import json, os, socket, threading, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

def me():
    return {k: os.environ.get(k) for k in ("FLAGSHIP_APP_ID", "FLAGSHIP_CREATOR", "FLAGSHIP_SLUG")}

def gateway():
    try:
        with open("/proc/net/route") as f:
            for line in f.readlines()[1:]:
                p = line.split()
                if p[1] == "00000000":
                    return socket.inet_ntoa(bytes.fromhex(p[2])[::-1])
    except Exception:
        pass
    return None

SOCKETS = ["/run/flagship-keyd/keyd.sock", "/run/flagship-broker/privd.sock", "/run/flagship-broker/broker.sock",
           "/run/flagship-access/access.sock", "/run/flagship-privd/privd.sock", "/run/flagship-core/core.sock",
           "/run/flagship-ingress/upstream.sock", "/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock",
           "/run/containerd/containerd.sock"]
FILES = ["/var/flagship/config.json", "/etc/flagship/config.json", "/var/flagship/data/flagship-access/service-access.json",
         "/var/flagship/service-sessions.json", "/var/lib/flagship-keyd", "/var/lib/flagship/arch-v2.json",
         "/var/flagship/acme", "/var/flagship/tunnel", "/opt/flagship/installer/rust/PINS.json", "/root/.ssh"]

def probe(fqdn):
    out = {}
    for p in SOCKETS:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(2); s.connect(p); s.close()
            out["unix:" + p] = "REACHED"
        except Exception as e:
            out["unix:" + p] = type(e).__name__
    for p in FILES:
        try:
            if os.path.isdir(p):
                os.listdir(p); out["file:" + p] = "REACHED"
            else:
                open(p, "rb").read(1); out["file:" + p] = "REACHED"
        except Exception as e:
            out["file:" + p] = type(e).__name__
    gw = gateway()
    targets = [("169.254.169.254", 80), ("127.0.0.1", 9090), ("127.0.0.1", 2375)]
    if gw:
        # The gateway's :80/:443 are the egress proxy by design (registries are reached through it), so a bare
        # connect there proves nothing; the URL probes below check the box's own API is out of reach.
        targets += [(gw, 9090), (gw, 2375), (gw, 22), (gw, 8443), (gw, 10250)]
    for h, port in targets:
        try:
            c = socket.create_connection((h, port), timeout=3); c.close()
            out["tcp:%s:%d" % (h, port)] = "REACHED"
        except Exception as e:
            out["tcp:%s:%d" % (h, port)] = type(e).__name__
    for url in ["https://%s/api/screens/server-detail" % fqdn, "https://%s/api/front-page" % fqdn]:
        try:
            with urllib.request.urlopen(url, timeout=8) as r:
                out["https:" + url] = "REACHED %d" % r.status
        except Exception as e:
            out["https:" + url] = type(e).__name__
    return out

def rename(to):
    doc = {"schema_version": 1, "name": to, "network": {"subdomain": to}, "slug": to, "app_id": to}
    wrote = {}
    for p in ["flagship.app.json", "/app/flagship.app.json", "/data/flagship.json", "/data/flagship.app.json"]:
        try:
            with open(p, "w") as f:
                json.dump(doc, f)
            wrote[p] = True
        except Exception as e:
            wrote[p] = type(e).__name__
    threading.Timer(0.5, lambda: os._exit(3)).start()
    return wrote

class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_any(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/":
            return self.send(200, {"app": "isoa", "me": me()})
        if u.path == "/echo":
            return self.send(200, {"me": me(), "headers": {k.lower(): v for k, v in self.headers.items()}})
        if u.path == "/rename":
            return self.send(200, {"wrote": rename(q.get("to", ["x"])[0])})
        if u.path == "/isoprobe":
            return self.send(200, probe(q.get("fqdn", ["localhost"])[0]))
        return self.send(404, {"error": "not found"})

    do_GET = handle_any
    do_POST = handle_any

ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), H).serve_forever()
`,
};

/** A whoami install whose manifest names another app's subdomain and name. */
async function installImpostor(acct: Account, box: Box, slug: string, claims: string): Promise<{ status: number; text: string }> {
  const manifestJson = JSON.stringify({
    schema_version: 1,
    name: claims,
    version: "0.1.0",
    description: "gym impostor",
    runtime: { image: "traefik/whoami", port: 80 },
    data: {},
    network: { subdomain: claims },
    access: { enabled: true },
    migration: { verification: "standard" },
  });
  const req: InstallServiceRequest = { serverId: box.fqdn, creator: acct.username, slug, manifestJson, addOwnerToMembership: true, issuedAt: Date.now() };
  const r = await postJson(`https://${box.fqdn}/api/services`, { request: req, signature: bytesToHex(signInstallService(req, acct.keys.irk)) }, {}, 120_000);
  return { status: r.status, text: r.text };
}

export const appIsolation: Group = {
  name: "app-isolation",
  title: "malicious-app isolation (H5): an app cannot take another app's names, rename itself, forge its way into another app's traffic or authority, or reach the box's keys and control sockets",
  needs: ["A1"],
  phase: 9.5,
  parallel: false,
  async run({ A, rec, box }) {
    const acct = A;
    const b = box("A1");
    const fqdn = b.fqdn;
    const user = acct.username;
    const aId = `${user}--${A_SLUG}`;
    const bId = `${user}--${B_SLUG}`;
    const aHost = `${A_SLUG}.${fqdn}`;
    const bHost = `${B_SLUG}.${fqdn}`;
    const shortB = `${B_SLUG}.${user}.${SERVICES}`;
    const session = await pair(acct, b);

    /** Legitimate traffic: A answers as A, B as B. */
    const bothServed = async (): Promise<string> => {
      const a = await tryHttp(`https://${aHost}/`, {}, 30_000);
      assert(a.status === 200 && a.json?.me?.FLAGSHIP_APP_ID === aId, `A: ${a.status} ${short(a.text)}`);
      const w = await tryHttp(`https://${bHost}/`, { headers: { accept: "text/html" } }, 30_000);
      assert(w.status === 200, `B: ${w.status} ${short(w.text)}`);
      const h = echoedFlagshipHeaders(w.text);
      assert(h["x-flagship-app-id"] === bId, `B answered as ${h["x-flagship-app-id"]}`);
      return "A as A, B as B";
    };

    const ready = await rec.check("setup: B (header echo) installed, A (python, our code) built and deployed through the real harness", async () => {
      for (const s of [A_SLUG, B_SLUG, C_SLUG]) await uninstall(acct, b, s).catch(() => {});
      await installWhoami(acct, b, B_SLUG, { enabled: true });
      await waitServing(`https://${bHost}/`);
      const c = await mcpOpen(b, session, "gym-isolation");
      await buildAndDeploy(c, attackerFiles);
      await finishAndWaitLive(c, b, aId);
      for (let i = 0; i < 36; i++) {
        const r = await tryHttp(`https://${aHost}/`, {}, 15_000);
        if (r.status === 200) break;
        await sleep(5_000);
      }
      return bothServed();
    });
    if (!ready) return;

    try {
      await rec.check("H5-1 a second install under B's name is refused, and an app whose manifest names B's subdomain does not get B's names", async () => {
        const again = await installImpostor(acct, b, B_SLUG, B_SLUG);
        assert(again.status !== 200, `reinstalling under B's slug was accepted: ${short(again.text)}`);
        const c = await installImpostor(acct, b, C_SLUG, B_SLUG);
        const w = await tryHttp(`https://${bHost}/`, { headers: { accept: "text/html" } }, 30_000);
        assert(echoedFlagshipHeaders(w.text)["x-flagship-app-id"] === bId, `B's name now answers as ${short(echoedFlagshipHeaders(w.text)["x-flagship-app-id"])}`);
        const sb = await tryHttp(`https://${shortB}/`, { headers: { accept: "text/html" } }, 30_000);
        const sbId = echoedFlagshipHeaders(sb.text)["x-flagship-app-id"];
        assert(sb.status !== 200 || sbId === bId, `B's account-wide name answers as ${sbId}`);
        if (c.status === 200) {
          await waitServing(`https://${C_SLUG}.${fqdn}/`).catch(() => undefined);
          const cw = await tryHttp(`https://${C_SLUG}.${fqdn}/`, { headers: { accept: "text/html" } }, 30_000);
          const cid = echoedFlagshipHeaders(cw.text)["x-flagship-app-id"];
          assert(cw.status !== 200 || cid === `${user}--${C_SLUG}`, `the impostor answered as ${cid}`);
        }
        return `reinstall ${again.status}; impostor install ${c.status}; ${await bothServed()}`;
      });

      await rec.check("H5-2 A rewrites its own manifest to name B and restarts: its identity and routes do not change", async () => {
        const r = await tryHttp(`https://${aHost}/rename?to=${B_SLUG}`, {}, 20_000);
        const wrote = short(r.json?.wrote ?? r.text, 200);
        let back = false;
        for (let i = 0; i < 36 && !back; i++) {
          await sleep(5_000);
          const a = await tryHttp(`https://${aHost}/`, {}, 10_000);
          if (a.status === 200) {
            assert(a.json?.me?.FLAGSHIP_APP_ID === aId, `after restart A runs as ${short(a.json?.me)}`);
            back = true;
          }
          const w = await tryHttp(`https://${bHost}/`, { headers: { accept: "text/html" } }, 15_000);
          assert(w.status !== 200 || echoedFlagshipHeaders(w.text)["x-flagship-app-id"] === bId, `B's name answered as ${echoedFlagshipHeaders(w.text)["x-flagship-app-id"]}`);
          assert(w.text.indexOf('"app": "isoa"') === -1 && w.text.indexOf('"app":"isoa"') === -1, "B's name reached A");
        }
        const services = await tryHttp(`https://${fqdn}/api/services`);
        const rows = (Array.isArray(services.json) ? services.json : (services.json?.apps ?? services.json?.services ?? [])) as Array<Record<string, unknown>>;
        const asB = rows.filter((x) => x.serviceId === bId || x.id === bId);
        assert(asB.every((x) => x.slug === undefined || x.slug === B_SLUG), `the box lists another app under B's id: ${short(asB)}`);
        assert(back, "A did not come back after its restart (no restart policy?): its routes stayed its own, but the restart half is unproven");
        return `writes ${wrote}; after its restart A is still ${aId}; ${await bothServed()}`;
      });

      await rec.check("H5-3 forged Host, forwarded and X-Flagship-* headers and a made-up session cookie get neither B's traffic nor any authority", async () => {
        const forged = {
          "X-Forwarded-Host": bHost,
          Forwarded: `host=${bHost};proto=https`,
          "X-Forwarded-For": "10.0.0.1",
          "X-Flagship-App-Id": bId,
          "X-Flagship-User": "owner",
          "X-Flagship-Role": "master",
          "X-Flagship-Visitor": "member",
          X_Flagship_Role: "master",
          Cookie: "Flagship-App-Session=" + "ab".repeat(32),
        };
        // SNI picks A, Host names B: A answers, and is told its own routed name.
        const x = await rawHttps({ sni: aHost, host: bHost, path: "/echo", headers: forged });
        const xj = JSON.parse(x.text.slice(x.text.indexOf("{"))) as { me: Record<string, string>; headers: Record<string, string> };
        assert(xj.me.FLAGSHIP_APP_ID === aId, `SNI A + Host B reached ${xj.me.FLAGSHIP_APP_ID}`);
        assert(xj.headers.host === aHost, `A was told Host ${xj.headers.host}`);
        assert(xj.headers["x-flagship-app-id"] === aId && xj.headers["x-flagship-visitor"] === "anonymous" && !xj.headers["x-flagship-user"], `A saw ${short(xj.headers)}`);
        assert(!xj.headers["x-forwarded-for"] && !xj.headers.forwarded && xj.headers["x-forwarded-host"] === aHost, `forwarding headers reached A: ${short(xj.headers)}`);
        // SNI picks B, Host names A: B answers with B's identity, the forged ones gone.
        const y = await rawHttps({ sni: bHost, host: aHost, path: "/", headers: forged });
        const yh = echoedFlagshipHeaders(y.text);
        assert(yh["x-flagship-app-id"] === bId && yh["x-flagship-visitor"] === "anonymous" && !yh["x-flagship-user"] && !yh["x-flagship-role"], `B saw ${short(yh)}`);
        // Members-only B: a Host naming open A, forged identity and a made-up cookie do not open it.
        await setMode(acct, b, bId, "restricted");
        try {
          const z = await rawHttps({ sni: bHost, host: aHost, path: "/", headers: forged });
          assert(z.status === 403 || z.status === 401, `members-only B with forged headers: ${z.status}`);
          assert(!/X-Flagship-App-Id/i.test(z.text), "the forged request reached B's container");
        } finally {
          await setMode(acct, b, bId, "open");
        }
        return `${await bothServed()}; A saw its own name; B saw no forged identity; members-only B refused (403)`;
      });

      await rec.check("H5-4 from inside, A reaches no management, signing, keyd, broker, access or engine socket, no box secret file, no host port and not the box's control API", async () => {
        const r = await tryHttp(`https://${aHost}/isoprobe?fqdn=${encodeURIComponent(fqdn)}`, {}, 120_000);
        assert(r.status === 200 && r.json, `probe ${r.status}: ${short(r.text)}`);
        const reached = Object.entries(r.json as Record<string, string>).filter(([, v]) => String(v).startsWith("REACHED"));
        assert(reached.length === 0, `A reached: ${reached.map(([k, v]) => `${k}=${v}`).join(", ")}`);
        return `${Object.keys(r.json).length} probes refused; ${await bothServed()}`;
      });
    } finally {
      for (const s of [A_SLUG, B_SLUG, C_SLUG]) await uninstall(acct, b, s).catch(() => {});
    }
  },
};
