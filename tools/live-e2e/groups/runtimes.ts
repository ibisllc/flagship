// App runtimes (docs/app-runtimes.md) built with no model, through the MCP
// build server: a python-3.13 app on Postgres 18 + the /data files folder, a
// node-24 app on /data, and a static app — each under gVisor — then a backup of
// the python app's data. The python app stays installed: later groups use its
// /probe route (access lists) and its data (app copy).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pair } from "../lib/fleet.js";
import { assert, http, postJson, short, tryHttp } from "../lib/harness.js";
import { buildAndDeploy, finishAndWaitLive, mcpOpen, tool } from "../lib/mcpBuild.js";
import type { Group } from "./types.js";

const roles = {
  default_role: "member",
  role_descriptions: { member: "Uses the app.", manager: "Same as member.", master: "Same as member." },
};

export const PY_APP = "pyapp";

export const pyAppFiles: Record<string, string> = {
  "flagship.app.json": JSON.stringify({
    schema_version: 1,
    name: PY_APP,
    version: "0.1.0",
    description: "gym python probe",
    runtime: { base: "python-3.13", port: 8080, start: ["python", "app.py"] },
    data: { stores: { postgres: true, files: true } },
    network: { subdomain: PY_APP },
    access: { enabled: true, public_routes: ["/*"], ...roles },
    migration: { verification: "standard" },
  }, null, 2),
  "requirements.txt": "psycopg[binary]==3.2.10\n",
  "migrations/001_notes.sql": "CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text NOT NULL);\n",
  "app.py": `import json, os, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import psycopg

FILES = os.environ.get("FLAGSHIP_FILES_DIR", "/data")
PG = os.environ.get("FLAGSHIP_PG_URL", "")

def db(sql, args=(), fetch=False):
    with psycopg.connect(PG) as c:
        with c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall() if fetch else None

class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/":
                return self.send(200, {"app": "py", "uid": os.getuid()})
            if u.path == "/write":
                text = q.get("text", ["gym"])[0]
                with open(os.path.join(FILES, "note.txt"), "w") as f:
                    f.write(text)
                db("INSERT INTO notes (body) VALUES (%s)", (text,))
                return self.send(200, {"wrote": text})
            if u.path == "/read":
                try:
                    with open(os.path.join(FILES, "note.txt")) as f:
                        file_text = f.read()
                except FileNotFoundError:
                    file_text = None
                rows = db("SELECT body FROM notes ORDER BY id", fetch=True)
                ver = db("SHOW server_version", fetch=True)[0][0]
                return self.send(200, {"file": file_text, "rows": [r[0] for r in rows], "pg": ver})
            if u.path == "/probe":
                host = q.get("host", ["example.com"])[0]
                try:
                    with urllib.request.urlopen("https://" + host + "/", timeout=8) as r:
                        return self.send(200, {"host": host, "reached": True, "status": r.status})
                except Exception as e:
                    return self.send(200, {"host": host, "reached": False, "error": str(e)[:200]})
            return self.send(404, {"error": "not found"})
        except Exception as e:
            return self.send(500, {"error": str(e)[:300]})

ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), H).serve_forever()
`,
};

const nodeFiles: Record<string, string> = {
  "flagship.app.json": JSON.stringify({
    schema_version: 1,
    name: "nodeapp",
    version: "0.1.0",
    description: "gym node probe",
    runtime: { base: "node-24", port: 8080 },
    data: { stores: { files: true } },
    network: { subdomain: "nodeapp" },
    access: { enabled: true, public_routes: ["/*"], ...roles },
    migration: { verification: "standard" },
  }, null, 2),
  "package.json": JSON.stringify({ name: "nodeapp", version: "0.1.0", private: true, scripts: { start: "node server.js" } }, null, 2),
  "package-lock.json": JSON.stringify({ name: "nodeapp", version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name: "nodeapp", version: "0.1.0" } } }, null, 2),
  "server.js": `const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FLAGSHIP_FILES_DIR || "/data";
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const out = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === "/write") { fs.writeFileSync(path.join(dir, "n.txt"), u.searchParams.get("text") || "gym"); return out({ wrote: true }); }
    if (u.pathname === "/read") return out({ file: fs.readFileSync(path.join(dir, "n.txt"), "utf8") });
    let rootWritable = true;
    try { fs.writeFileSync("/app/x", "x"); } catch { rootWritable = false; }
    return out({ app: "node", uid: process.getuid(), node: process.version, rootWritable });
  } catch (e) { res.statusCode = 500; out({ error: String(e) }); }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
`,
};

const staticFiles: Record<string, string> = {
  "flagship.app.json": JSON.stringify({
    schema_version: 1,
    name: "staticapp",
    version: "0.1.0",
    description: "gym static probe",
    runtime: { base: "static", port: 8080 },
    network: { subdomain: "staticapp" },
    access: { enabled: true, public_routes: ["/*"], ...roles },
    migration: { verification: "standard" },
  }, null, 2),
  "index.html": "<!doctype html><title>gym</title><p>static runtime ok</p>\n",
};

export const runtimes: Group = {
  name: "runtimes",
  title: "python/node/static runtimes under gVisor, Postgres 18 + /data, backup",
  needs: ["A1"],
  phase: 1,
  async run({ A, rec, box }) {
    const b = box("A1");
    const session = await pair(A, b);
    const user = A.username;

    await rec.check("the app sandbox (gVisor) is ready (server-detail.appSandbox)", async () => {
      const deadline = Date.now() + 10 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const r = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": session } });
        last = short(r.json?.appSandbox ?? r.text, 160);
        if (r.json?.appSandbox?.state === "ready") return `gVisor ${r.json.appSandbox.version ?? ""}`;
        await new Promise((res) => setTimeout(res, 15_000));
      }
      throw new Error(`appSandbox not ready in 10 min: ${last}`);
    });

    const build = async (
      name: string,
      files: Record<string, string>,
      probe: (base: string) => Promise<string>,
      onStaging?: (c: Awaited<ReturnType<typeof mcpOpen>>) => Promise<string>,
    ) => {
      await rec.check(`${name}: MCP build → test copy deploys → finish → live`, async () => {
        const c = await mcpOpen(b, session, `gym-${name}`);
        const d = await buildAndDeploy(c, files);
        const check = await tool(c, "check_app", { path: "/" });
        assert(/200/.test(check), `test copy check_app: ${short(check, 200)}`);
        if (onStaging) await rec.check(`${name}: the staging copy reaches no host at all (not even a package registry)`, () => onStaging(c));
        await finishAndWaitLive(c, b, `${user}--${name}`);
        return short(d, 100);
      }) && (await rec.check(`${name}: the live app answers`, () => probe(`https://${name}.${b.fqdn}`)));
    };

    await build(PY_APP, pyAppFiles, async (base) => {
      let r = await tryHttp(`${base}/`);
      for (let i = 0; i < 24 && r.status !== 200; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        r = await tryHttp(`${base}/`);
      }
      assert(r.status === 200 && r.json?.app === "py", `/ ${r.status}: ${short(r.text)}`);
      assert(r.json.uid !== 0, "runs as root");
      const w = await http(`${base}/write?text=gym-${user}`);
      assert(w.status === 200, `/write ${w.status}: ${short(w.text)}`);
      const rd = await http(`${base}/read`);
      assert(rd.json?.file === `gym-${user}` && rd.json?.rows?.includes(`gym-${user}`), `/read ${short(rd.text)}`);
      assert(String(rd.json?.pg).startsWith("18"), `postgres ${rd.json?.pg}`);
      return `uid=${r.json.uid} pg=${rd.json.pg} file+row written and read back`;
    }, async (c) => {
      const out: string[] = [];
      for (const host of ["example.com", "pypi.org"]) {
        const t = await tool(c, "check_app", { path: `/probe?host=${host}` });
        assert(/reached\W{0,6}false/.test(t) && !/reached\W{0,6}true/.test(t), `staging reached ${host}: ${short(t, 200)}`);
        out.push(`${host} blocked`);
      }
      return out.join(", ");
    });
    await build("nodeapp", nodeFiles, async (base) => {
      let r = await tryHttp(`${base}/`);
      for (let i = 0; i < 24 && r.status !== 200; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        r = await tryHttp(`${base}/`);
      }
      assert(r.status === 200 && r.json?.app === "node", `/ ${r.status}: ${short(r.text)}`);
      assert(r.json.uid !== 0 && r.json.rootWritable === false, `uid=${r.json.uid} rootWritable=${r.json.rootWritable}`);
      await http(`${base}/write?text=node-ok`);
      const rd = await http(`${base}/read`);
      assert(rd.json?.file === "node-ok", `/read ${short(rd.text)}`);
      return `${r.json.node} uid=${r.json.uid}, read-only root, /data writable`;
    });
    await build("staticapp", staticFiles, async (base) => {
      let r = await tryHttp(`${base}/`);
      for (let i = 0; i < 24 && r.status !== 200; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        r = await tryHttp(`${base}/`);
      }
      assert(r.status === 200 && /static runtime ok/.test(r.text), `/ ${r.status}: ${short(r.text)}`);
      return "served by the static runtime";
    });

    await rec.check("the owner's Database view lists the python app's notes table (read-only)", async () => {
      const r = await http(`https://${b.fqdn}/api/screens/services/${encodeURIComponent(`${user}--${PY_APP}`)}/db`, { headers: { "x-flagship-session": session } });
      assert(r.status === 200 && /notes/.test(r.text), `db ${r.status}: ${short(r.text)}`);
      return short(r.json, 120);
    });
    await rec.check("app backup with user data: a tar.gz holding the Postgres dump and the files", async () => {
      const s = await postJson(`https://${b.fqdn}/api/screens/app-backup/start`, { serviceId: `${user}--${PY_APP}`, includeUserData: true }, { "x-flagship-session": session }, 180_000);
      assert(s.status === 200 && s.json?.backupId, `start ${s.status}: ${short(s.text)}`);
      const res = await fetch(`https://${b.fqdn}${s.json.fetchPath ?? `/api/backups/${s.json.backupId}`}`, { headers: { "x-flagship-session": session } });
      assert(res.status === 200, `fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const dirp = mkdtempSync(join(tmpdir(), "gym-backup-"));
      writeFileSync(join(dirp, "b.tgz"), buf);
      const t = spawnSync("tar", ["-tzf", join(dirp, "b.tgz")], { encoding: "utf8" });
      const names = (t.stdout || "").split("\n").filter(Boolean);
      assert(names.some((n) => /pg|postgres|\.sql/i.test(n)) && names.some((n) => /files|data/i.test(n)), `entries: ${names.join(", ").slice(0, 300)}`);
      return `${buf.length} bytes: ${names.join(", ").slice(0, 200)}`;
    });
  },
};
