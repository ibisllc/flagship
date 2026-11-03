// The Rust controller and the Rust proxy taking over apps on an arch-v2 box (plan G3/G4;
// docs/architecture-v2/broker-runtime-core.md §11). Owner 2026-11-02: on arch-v2 the Rust owners are
// the DEFAULT. A fresh box starts on shadow/ts with `chosenBy: "default"` and moves each one to Rust on
// its own once it qualifies (core's agreeing passes, the pinned ingress and a known app network). A
// probe app (python: SSE, WebSocket echo, uploads, a crash switch) is deployed; the box must take both
// Rust owners with no order sent, keeping the app's container across that restart (the admin's signed
// order is then a no-op, or turns on what a box from before this default still runs on TS). The app must be adopted (same container) across the daemon restart, a
// new app must install and serve under core, SSE must stream event by event, a WebSocket must echo
// and a large upload must arrive intact through the Rust proxy (the daemon's decision counter shows
// the ingress asked), forged identity headers must not reach the app, a dead app process must be
// brought back by core, and a second daemon restart must adopt again. The access authority (G5) must
// run in `rust` by default (decisions and writes through flagship-access, none unavailable). The order
// then turns both off, and that owner's rollback must hold (no automatic move back to Rust).
// Arch-v2 pass only (GYM_BOX_STACK=arch-v2, the default). Leaves behind: both apps removed, the box on
// shadow/ts by the owner's order.
import { createHash, randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { ed, signRustOwnershipOrder, type RustOwnershipOrder } from "@flagship/protocol";
import { pair } from "../../lib/fleet.js";
import { SkipError, assert, short, sleep, tryHttp } from "../../lib/harness.js";
import { buildAndDeploy, finishAndWaitLive, mcpOpen } from "../../lib/mcpBuild.js";
import { installWhoami, waitServing } from "../gating.js";
import type { Group } from "../types.js";
import { uninstall } from "./util.js";

const SLUG = "rcore";
const WHO = "rcorewho";
const UPLOAD_BYTES = 32 * 1024 * 1024;

const probeFiles: Record<string, string> = {
  "flagship.app.json": JSON.stringify(
    {
      schema_version: 1,
      name: SLUG,
      version: "0.1.0",
      description: "gym rust core probe",
      runtime: { base: "python-3.13", port: 8080, start: ["python", "app.py"] },
      data: {},
      network: { subdomain: SLUG },
      access: { enabled: true, public_routes: ["/*"], default_role: "member", role_descriptions: { member: "uses it", manager: "runs it", master: "owns it" } },
      migration: { verification: "standard" },
    },
    null,
    2,
  ),
  "app.py": `import base64, hashlib, json, os, socket, struct, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
BOOT = os.urandom(8).hex()

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/":
            return self.send_json(200, {"app": "rcore", "host": socket.gethostname(), "pid": os.getpid(), "boot": BOOT})
        if p == "/headers":
            return self.send_json(200, {"headers": {k.lower(): v for k, v in self.headers.items()}})
        if p == "/sse":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            for i in range(1, 4):
                self.wfile.write(("data: %d\\n\\n" % i).encode())
                self.wfile.flush()
                time.sleep(1.5)
            self.close_connection = True
            return
        if p == "/ws":
            return self.websocket()
        if p == "/crash":
            self.send_json(200, {"bye": True})
            threading.Timer(0.3, lambda: os._exit(7)).start()
            return
        return self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/upload":
            return self.send_json(404, {"error": "not found"})
        n = int(self.headers.get("content-length", "0"))
        h = hashlib.sha256()
        left = n
        while left > 0:
            b = self.rfile.read(min(left, 65536))
            if not b:
                break
            h.update(b)
            left -= len(b)
        return self.send_json(200, {"bytes": n - left, "sha256": h.hexdigest()})

    def websocket(self):
        key = self.headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        self.send_response(101)
        self.send_header("upgrade", "websocket")
        self.send_header("connection", "Upgrade")
        self.send_header("sec-websocket-accept", accept)
        self.end_headers()
        self.wfile.flush()
        r, w = self.rfile, self.wfile
        while True:
            hdr = r.read(2)
            if len(hdr) < 2:
                return
            op = hdr[0] & 0x0F
            ln = hdr[1] & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", r.read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", r.read(8))[0]
            mask = r.read(4) if hdr[1] & 0x80 else b"\\0\\0\\0\\0"
            data = bytearray(r.read(ln))
            for i in range(len(data)):
                data[i] ^= mask[i % 4]
            if op == 8:
                w.write(b"\\x88\\x00")
                w.flush()
                return
            if op == 9:
                op = 10
            if op in (1, 2, 10):
                out = bytes([0x80 | op])
                if len(data) < 126:
                    out += bytes([len(data)])
                elif len(data) < 65536:
                    out += bytes([126]) + struct.pack(">H", len(data))
                else:
                    out += bytes([127]) + struct.pack(">Q", len(data))
                w.write(out + bytes(data))
                w.flush()

    def log_message(self, *a):
        pass

ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), H).serve_forever()
`,
};

interface OwnershipView {
  reconciler?: string;
  proxy?: string;
  chosenBy?: "default" | "owner";
  coreChoice?: string | null;
  core?: { ok?: boolean; mode?: string; agreePasses?: number; lastShadow?: string | null } | null;
  ingressPinned?: boolean;
  blockers?: { reconciler?: Array<{ code: string; error: string }>; proxy?: Array<{ code: string; error: string }> };
  running?: {
    reconciler?: string;
    core?: { live?: boolean; workloads?: Array<{ installation: string; state: string; reason?: string | null }> } | null;
    proxyDecisions?: { proxy: number; daemon: number };
    ingress?: { choice?: string; reason?: string } | null;
    access?: {
      mode?: string | null;
      decisions?: { asked: number; disagreed: number; unavailable: number } | null;
      writes?: { calls: number; disagreed: number; unavailable: number } | null;
    } | null;
  } | null;
}

export const rustCore: Group = {
  name: "rust-core",
  title: "the Rust controller and proxy take over apps on an arch-v2 box: adopt across restarts, install, restart a dead app, SSE, WebSocket and large uploads through the Rust proxy, then hand back",
  needs: ["A1"],
  phase: 10.7,
  parallel: false,
  async run({ A, rec, box }) {
    if ((process.env.GYM_BOX_STACK || "arch-v2") !== "arch-v2") return;
    const b = box("A1");
    const fqdn = b.fqdn;
    const user = A.username;
    const appId = `${user}--${SLUG}`;
    const whoId = `${user}--${WHO}`;
    const appUrl = `https://${SLUG}.${fqdn}`;
    let session = await pair(A, b);
    const call = async (path: string, init: Parameters<typeof tryHttp>[1] = {}, ms = 60_000) => {
      let r = await tryHttp(`https://${fqdn}${path}`, { ...init, headers: { ...(init.headers ?? {}), "x-flagship-session": session } }, ms);
      if (r.status === 401) {
        b.session = undefined;
        session = await pair(A, b);
        r = await tryHttp(`https://${fqdn}${path}`, { ...init, headers: { ...(init.headers ?? {}), "x-flagship-session": session } }, ms);
      }
      return r;
    };
    const view = async (): Promise<OwnershipView> => {
      const r = await call("/api/stack/rust-ownership", {}, 20_000);
      return r.status === 200 ? (r.json as OwnershipView) : {};
    };
    const order = (reconciler: "shadow" | "rust", proxy: "ts" | "rust") => {
      const o: RustOwnershipOrder = { serverDomain: fqdn, reconciler, proxy, nonce: randomBytes(16).toString("hex"), issuedAt: Date.now() };
      return { order: o, signature: bytesToHex(signRustOwnershipOrder(o, (m) => ed.sign(m, A.keys.adminRoot.privateKey))) };
    };
    /** Sends the order, then waits for the restarted daemon to run under it. */
    const setOwnership = async (reconciler: "shadow" | "rust", proxy: "ts" | "rust"): Promise<string> => {
      const r = await call("/api/stack/rust-ownership", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order(reconciler, proxy)) });
      assert(r.status === 202 || r.status === 200, `order ${r.status}: ${short(r.text, 300)}`);
      const deadline = Date.now() + 8 * 60_000;
      let last = "";
      await sleep(5_000);
      while (Date.now() < deadline) {
        const v = await view().catch(() => ({}) as OwnershipView);
        last = short({ r: v.running?.reconciler, live: v.running?.core?.live, ingress: v.running?.ingress }, 200);
        const reconcilerOk = v.running?.reconciler === reconciler && (reconciler === "shadow" || v.running?.core?.live === true);
        const proxyOk = v.proxy === proxy && (proxy === "ts" || v.running?.ingress?.choice === "rust");
        if (reconcilerOk && proxyOk) return `reconciler ${reconciler}, proxy ${proxy}`;
        await sleep(10_000);
      }
      throw new Error(`the box did not come back under reconciler ${reconciler} / proxy ${proxy} in 8 min (last: ${last})`);
    };
    const probe = async (): Promise<{ host: string }> => {
      const r = await tryHttp(`${appUrl}/`, {}, 20_000);
      assert(r.status === 200 && r.json?.app === "rcore", `probe ${r.status}: ${short(r.text)}`);
      return { host: String(r.json.host) };
    };
    /** After a daemon restart core adopts on its next pass: probe until it serves (gym 22, 25: one probe at once got 503). */
    const probeAfterRestart = async (): Promise<{ host: string }> => {
      let last = "";
      for (let i = 0; i < 24; i++) {
        try {
          return await probe();
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
          await sleep(5_000);
        }
      }
      throw new Error(`the app was not served within 2 min of the restart (last: ${last})`);
    };
    const proxied = async () => (await view()).running?.proxyDecisions?.proxy ?? -1;

    const onArchV2 = await rec.check("setup: the box is on arch-v2, core serves, and nobody has chosen its owners (the arch-v2 default)", async () => {
      const v = await view();
      if (!v.reconciler) throw new SkipError("GET /api/stack/rust-ownership is not served (a box older than this release)");
      assert(v.chosenBy === "default", `the owners were set by an order, not the default: ${short(v, 200)}`);
      assert(v.coreChoice === "rust", `core runs ${v.coreChoice ?? "nothing"} (the Rust units are not on)`);
      assert(v.ingressPinned === true, "this release carries no pinned flagship-ingress");
      return `core ${v.core?.mode ?? "?"}, ${v.core?.agreePasses ?? 0} agreeing passes`;
    });
    if (!onArchV2) return;

    let host0 = "";
    const ready = await rec.check("setup: the probe app (SSE, WebSocket, uploads) is deployed on the TS path and core's shadow comparison agrees", async () => {
      for (const s of [SLUG, WHO]) await uninstall(A, b, s).catch(() => {});
      const c = await mcpOpen(b, session, "gym-rust-core");
      await buildAndDeploy(c, probeFiles);
      await finishAndWaitLive(c, b, appId);
      await waitServing(`${appUrl}/`);
      host0 = (await probe()).host;
      const deadline = Date.now() + 6 * 60_000;
      let v = await view();
      while ((v.blockers?.reconciler?.length ?? 1) > 0 && Date.now() < deadline) {
        await sleep(15_000);
        v = await view();
      }
      assert((v.blockers?.reconciler?.length ?? 1) === 0, `the cut-over rule still blocks: ${short(v.blockers, 300)}`);
      return `container ${host0}; ${v.core?.agreePasses} agreeing passes`;
    });
    if (!ready) return;

    try {
      await rec.check("the arch-v2 default: with no order sent, the box takes both Rust owners once they qualify and keeps the app's container", async () => {
        const deadline = Date.now() + 8 * 60_000;
        let v = await view().catch(() => ({}) as OwnershipView);
        while (!(v.running?.reconciler === "rust" && v.running?.core?.live === true && v.proxy === "rust" && v.running?.ingress?.choice === "rust") && Date.now() < deadline) {
          await sleep(15_000);
          v = await view().catch(() => ({}) as OwnershipView);
        }
        assert(v.running?.reconciler === "rust" && v.proxy === "rust", `still ${short({ r: v.running?.reconciler, p: v.proxy, blockers: v.blockers }, 300)} after 8 min`);
        assert(v.chosenBy === "default", `chosenBy ${v.chosenBy}`);
        const p = await probeAfterRestart();
        assert(p.host === host0, `the app was restarted by the automatic move (container ${host0} → ${p.host})`);
        return `reconciler rust, proxy rust by default; container ${p.host} kept`;
      });

      await rec.check("the access authority is Rust by default: decisions and writes go through flagship-access, none unavailable", async () => {
        await probe();
        const a = (await view()).running?.access;
        assert(a?.mode === "rust", `access authority ${a?.mode ?? "not reported"} (FLAGSHIP_ACCESS_AUTHORITY default on arch-v2 is rust)`);
        assert((a.decisions?.asked ?? 0) > 0, `no decision was asked: ${short(a, 200)}`);
        assert((a.decisions?.unavailable ?? 1) === 0 && (a.writes?.unavailable ?? 0) === 0, `the Rust side was unavailable: ${short(a, 200)}`);
        return `decisions ${a.decisions?.asked}, writes ${a.writes?.calls ?? 0}`;
      });

      const on = await rec.check("the admin's signed order for both is accepted under the default and core still runs the app (same container)", async () => {
        const how = await setOwnership("rust", "rust");
        // The daemon has just restarted under the new owners: core adopts on its next pass (gym 22: one probe at once got 503).
        let p: { host: string } | null = null;
        let last = "";
        for (let i = 0; i < 24 && !p; i++) {
          try {
            p = await probe();
          } catch (e) {
            last = e instanceof Error ? e.message : String(e);
            await sleep(5_000);
          }
        }
        assert(p, `the app was not served under the Rust owners within 2 min (last: ${last})`);
        assert(p.host === host0, `the app was restarted (container ${host0} → ${p.host})`);
        return `${how}; container ${p.host} kept`;
      });
      if (!on) return;

      await rec.check("a new app installs and is served under the Rust reconciler", async () => {
        await installWhoami(A, b, WHO, { enabled: true });
        await waitServing(`https://${WHO}.${fqdn}/`);
        const w = (await view()).running?.core?.workloads?.find((x) => x.installation === whoId);
        assert(w?.state === "running", `core says ${short(w)}`);
        return `${whoId}: running under core`;
      });

      await rec.check("SSE streams event by event through the Rust proxy", async () => {
        const before = await proxied();
        const t0 = Date.now();
        const res = await fetch(`${appUrl}/sse`, { headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(30_000) });
        assert(res.status === 200 && res.body, `sse ${res.status}`);
        const reader = res.body.getReader();
        const td = new TextDecoder();
        let text = "";
        let firstAt = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += td.decode(value, { stream: true });
          if (!firstAt && text.includes("data: 1")) firstAt = Date.now() - t0;
        }
        const total = Date.now() - t0;
        assert(/data: 1[\s\S]*data: 2[\s\S]*data: 3/.test(text), `events: ${short(text)}`);
        assert(firstAt > 0 && total - firstAt >= 2_000, `the first event came at ${firstAt} ms of ${total} ms: the stream was buffered`);
        const after = await proxied();
        assert(after > before, `the ingress did not ask the daemon (decisions ${before} → ${after})`);
        return `first event at ${firstAt} ms, stream ended at ${total} ms; decisions ${before} → ${after}`;
      });

      await rec.check("a WebSocket echoes both ways through the Rust proxy", async () => {
        const before = await proxied();
        const ws = new WebSocket(`wss://${SLUG}.${fqdn}/ws`);
        const got: string[] = [];
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`no echo in 30 s (got ${got.length})`)), 30_000);
          ws.onerror = () => {
            clearTimeout(t);
            reject(new Error("the WebSocket failed"));
          };
          ws.onopen = () => {
            for (const m of ["one", "two", "x".repeat(70_000)]) ws.send(m);
          };
          ws.onmessage = (e) => {
            got.push(String(e.data));
            if (got.length === 3) {
              clearTimeout(t);
              resolve();
            }
          };
        });
        ws.close();
        assert(got[0] === "one" && got[1] === "two" && got[2]!.length === 70_000, `echoes: ${short(got.map((g) => g.length))}`);
        const after = await proxied();
        assert(after > before, `the ingress did not ask the daemon (decisions ${before} → ${after})`);
        return `3 echoes (the last 70,000 bytes); decisions ${before} → ${after}`;
      });

      await rec.check(`a ${UPLOAD_BYTES / 1024 / 1024} MiB upload streams intact through the Rust proxy`, async () => {
        const before = await proxied();
        const data = randomBytes(UPLOAD_BYTES);
        const want = createHash("sha256").update(data).digest("hex");
        const t0 = Date.now();
        const r = await fetch(`${appUrl}/upload`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: data, signal: AbortSignal.timeout(10 * 60_000) });
        const j = (await r.json().catch(() => null)) as { bytes?: number; sha256?: string } | null;
        assert(r.status === 200 && j?.bytes === UPLOAD_BYTES && j.sha256 === want, `upload ${r.status}: ${short(j)}`);
        const after = await proxied();
        assert(after > before, `the ingress did not ask the daemon (decisions ${before} → ${after})`);
        return `${UPLOAD_BYTES} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s, SHA-256 matches`;
      });

      await rec.check("forged identity headers (any spelling) never reach the app through the Rust proxy", async () => {
        const r = await tryHttp(`${appUrl}/headers`, { headers: { "X-Flagship-User": "forged", "X-Flagship-Role": "master", x_flagship_visitor: "member" } }, 20_000);
        assert(r.status === 200, `headers ${r.status}`);
        const h = (r.json?.headers ?? {}) as Record<string, string>;
        assert(h["x-flagship-visitor"] === "anonymous", `visitor ${h["x-flagship-visitor"]}`);
        assert(h["x-flagship-user"] === undefined && h["x-flagship-role"] === undefined, `forged identity reached the app: ${short(h)}`);
        assert(!Object.keys(h).some((k) => k.replace(/_/g, "-").startsWith("x-flagship-") && JSON.stringify(h[k]).includes("forged")), "a forged spelling reached the app");
        assert(typeof h["x-flagship-signature"] === "string", "no identity signature");
        return `the app saw ${Object.keys(h).filter((k) => k.startsWith("x-flagship-")).join(", ")}`;
      });

      // Gym 25: the engine's own restart policy (on-failure) usually brings the process back in the same container
      // before core's pass; either is the app coming back, which the start id shows.
      await rec.check("an app whose process dies comes back (the engine restarts it, or core makes a new container)", async () => {
        const first = await tryHttp(`${appUrl}/`, {}, 15_000);
        const before = { host: String(first.json?.host ?? ""), boot: String(first.json?.boot ?? "") };
        assert(before.boot, `the probe app reports no start id: ${short(first.text)}`);
        await tryHttp(`${appUrl}/crash`, {}, 15_000);
        const deadline = Date.now() + 4 * 60_000;
        let last = "";
        while (Date.now() < deadline) {
          await sleep(10_000);
          const r = await tryHttp(`${appUrl}/`, {}, 15_000);
          last = `${r.status} ${short(r.text, 80)}`;
          if (r.status === 200 && r.json?.boot && r.json.boot !== before.boot) {
            return r.json.host === before.host ? `restarted in container ${before.host}` : `container ${before.host} → ${r.json.host}`;
          }
        }
        throw new Error(`not back in 4 min (last: ${last})`);
      });

      await rec.check("another daemon restart (the proxy back on TS) adopts the app again under core", async () => {
        const before = (await probe()).host;
        const how = await setOwnership("rust", "ts");
        const after = (await probeAfterRestart()).host;
        assert(after === before, `the app was restarted (container ${before} → ${after})`);
        return `${how}; container ${after} kept`;
      });
    } finally {
      await rec.check("cleanup: the owner's rollback to TS/shadow holds (no automatic move back); the apps still serve; both removed", async () => {
        const how = await setOwnership("shadow", "ts");
        await waitServing(`${appUrl}/`);
        // The automatic default runs every minute: an owner's order must end it for good.
        await sleep(90_000);
        const v = await view();
        assert(v.chosenBy === "owner" && v.reconciler === "shadow" && v.proxy === "ts", `the rollback did not hold: ${short(v, 200)}`);
        for (const s of [SLUG, WHO]) await uninstall(A, b, s).catch(() => {});
        return `${how}; held`;
      });
    }
  },
};
