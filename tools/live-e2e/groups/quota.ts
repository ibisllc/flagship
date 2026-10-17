// Per-app disk limits (docs/app-runtimes.md §5.3) on a real box under gVisor:
// a phone backup policy with a small reserve gives each app a budget; an app
// that fills its files folder gets ENOSPC, one that fills its database has
// INSERT refused (reads and TRUNCATE still work); both show on server-detail,
// app-detail and as Activity entries; freeing space brings writes back. The
// policy goes back to "none" at the end so later groups aren't limited.
import { signBackupPolicy, type BackupPolicyOrder } from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { buildAndDeploy, finishAndWaitLive, mcpOpen } from "../lib/mcpBuild.js";
import type { Group } from "./types.js";

const MiB = 1024 * 1024;
const APP = "quotaapp";

const files: Record<string, string> = {
  "flagship.app.json": JSON.stringify({
    schema_version: 1,
    name: APP,
    version: "0.1.0",
    description: "gym quota probe",
    runtime: { base: "python-3.13", port: 8080, start: ["python", "app.py"] },
    data: { stores: { postgres: true, files: true } },
    network: { subdomain: APP },
    access: {
      enabled: true,
      public_routes: ["/*"],
      default_role: "member",
      role_descriptions: { member: "Uses the app.", manager: "Same as member.", master: "Same as member." },
    },
    migration: { verification: "standard" },
  }, null, 2),
  "requirements.txt": "psycopg[binary]==3.2.10\n",
  "migrations/001_blobs.sql": "CREATE TABLE IF NOT EXISTS blobs (id serial PRIMARY KEY, b bytea NOT NULL);\n",
  "app.py": `import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import psycopg

FILES = os.environ.get("FLAGSHIP_FILES_DIR", "/data")
PG = os.environ.get("FLAGSHIP_PG_URL", "")

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
        mb = int(q.get("mb", ["1"])[0])
        try:
            if u.path == "/":
                return self.send(200, {"app": "quota"})
            if u.path == "/fill-files":
                done = 0
                try:
                    for i in range(mb):
                        with open(os.path.join(FILES, "fill-%d" % i), "wb") as f:
                            f.write(os.urandom(1024 * 1024))
                            f.flush()
                            os.fsync(f.fileno())
                        done += 1
                    return self.send(200, {"wroteMb": done, "error": None})
                except OSError as e:
                    return self.send(200, {"wroteMb": done, "error": e.strerror, "errno": e.errno})
            if u.path == "/free-files":
                n = 0
                for name in os.listdir(FILES):
                    if name.startswith("fill-"):
                        os.remove(os.path.join(FILES, name))
                        n += 1
                return self.send(200, {"removed": n})
            if u.path == "/fill-db":
                done = 0
                try:
                    with psycopg.connect(PG, autocommit=True) as c:
                        for i in range(mb):
                            c.execute("INSERT INTO blobs (b) VALUES (%s)", (os.urandom(1024 * 1024),))
                            done += 1
                    return self.send(200, {"insertedMb": done, "error": None})
                except Exception as e:
                    return self.send(200, {"insertedMb": done, "error": str(e)[:300]})
            if u.path == "/db-write":
                try:
                    with psycopg.connect(PG, autocommit=True) as c:
                        c.execute("INSERT INTO blobs (b) VALUES ('\\\\x00')")
                    return self.send(200, {"ok": True})
                except Exception as e:
                    return self.send(200, {"ok": False, "error": str(e)[:300]})
            if u.path == "/db-read":
                with psycopg.connect(PG, autocommit=True) as c:
                    n = c.execute("SELECT count(*) FROM blobs").fetchone()[0]
                return self.send(200, {"rows": n})
            if u.path == "/free-db":
                with psycopg.connect(PG, autocommit=True) as c:
                    c.execute("TRUNCATE blobs")
                return self.send(200, {"truncated": True})
            return self.send(404, {"error": "not found"})
        except Exception as e:
            return self.send(500, {"error": str(e)[:300]})

ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), H).serve_forever()
`,
};

export const quota: Group = {
  name: "quota",
  title: "per-app disk limits: a full files folder is ENOSPC, a full database refuses INSERT, both come back when freed",
  needs: ["A1"],
  phase: 5,
  parallel: false,
  async run({ A, rec, box }) {
    const b = box("A1");
    const session = await pair(A, b);
    const H = { "x-flagship-session": session };
    const serviceId = `${A.username}--${APP}`;
    const base = `https://${APP}.${b.fqdn}`;
    const get = (p: string, timeoutMs = 300_000) => http(`${base}${p}`, {}, timeoutMs);
    const appDetail = async () => (await http(`https://${b.fqdn}/api/screens/app-detail/${encodeURIComponent(serviceId)}`, { headers: H })).json;
    const policy = async (p: BackupPolicyOrder["policy"], phoneReserveBytes: number) => {
      const order: BackupPolicyOrder = { serverDomain: b.fqdn, policy: p, phoneReserveBytes, issuedAt: Date.now() };
      const signatureHex = Buffer.from(signBackupPolicy(order, A.keys.adminRoot)).toString("hex");
      return postJson(`https://${b.fqdn}/api/screens/backup-policy`, { order, signatureHex }, H, 120_000);
    };
    const until = async <T>(what: string, minutes: number, f: () => Promise<T | null>): Promise<T> => {
      const deadline = Date.now() + minutes * 60_000;
      for (;;) {
        const v = await f().catch(() => null);
        if (v !== null && v !== undefined) return v;
        if (Date.now() > deadline) throw new Error(`${what}: not within ${minutes} min`);
        await sleep(10_000);
      }
    };

    if (!(await rec.check(`${APP}: MCP build → live`, async () => {
      const c = await mcpOpen(b, session, `gym-${APP}`);
      await buildAndDeploy(c, files);
      await finishAndWaitLive(c, b, serviceId);
      let r = await tryHttp(`${base}/`);
      for (let i = 0; i < 24 && r.status !== 200; i++) {
        await sleep(5000);
        r = await tryHttp(`${base}/`);
      }
      assert(r.status === 200 && r.json?.app === "quota", `/ ${r.status}: ${short(r.text)}`);
      return "live";
    }))) return;

    await rec.check("with no limit, server-detail shows the disk and the app's use, and the folder is its own image", async () => {
      const d = await until("storage on server-detail", 4, async () => {
        const r = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: H });
        const s = r.json?.storage;
        return s?.apps?.some((a: { serviceId: string; files?: unknown }) => a.serviceId === serviceId && a.files) ? s : null;
      });
      assert(d.disk?.totalBytes > 0 && d.brake === "off", `storage: ${short(d)}`);
      const me = d.apps.find((a: { serviceId: string }) => a.serviceId === serviceId);
      assert(me.files.enforced === true && me.files.limitBytes === null, `files: ${short(me.files)}`);
      return `disk ${Math.round(d.disk.usedBytes / 2 ** 30)}/${Math.round(d.disk.totalBytes / 2 ** 30)} GB, capped=${d.capped}`;
    });

    let set = false;
    try {
      await rec.check("a phone policy with a small reserve is taken, and the app gets a budget for each store", async () => {
        const g = await http(`https://${b.fqdn}/api/screens/backup-policy`, { headers: H });
        const used = Number(g.json?.cap?.usedBytes ?? 0);
        const r = await policy("phone", used + 600 * MiB);
        assert(r.status === 200, `policy ${r.status}: ${short(r.text)}`);
        set = true;
        const st = await until("budgets on app-detail", 6, async () => {
          const s = (await appDetail())?.storage;
          return s?.files?.limitBytes > 0 && s?.postgres?.limitBytes > 0 ? s : null;
        });
        return `files ${Math.round(st.files.limitBytes / MiB)} MB, database ${Math.round(st.postgres.limitBytes / MiB)} MB`;
      });

      let filesLimit = 0;
      await rec.check("filling the files folder past its budget ends in ENOSPC inside the app", async () => {
        filesLimit = Number((await appDetail())?.storage?.files?.limitBytes ?? 0);
        const r = await get(`/fill-files?mb=${Math.ceil(filesLimit / MiB) + 64}`);
        assert(r.json?.errno === 28 || /No space left/.test(String(r.json?.error)), `fill: ${short(r.text)}`);
        assert(r.json.wroteMb * MiB <= filesLimit + 2 * MiB, `files ${short((await appDetail())?.storage?.files, 400)} wrote ${r.json.wroteMb} MB past a ${Math.round(filesLimit / MiB)} MB limit`);
        return `${r.json.wroteMb} MB then ENOSPC (limit ${Math.round(filesLimit / MiB)} MB)`;
      });
      await rec.check("app-detail says the folder is full, and Activity has app.storage.full for it", async () => {
        await until("files full", 4, async () => ((await appDetail())?.storage?.files?.full ? true : null));
        return await until("Activity entry", 4, async () => {
          const r = await http(`https://${b.fqdn}/api/screens/activity?limit=200`, { headers: H });
          const e = (r.json?.entries ?? []).find((x: { kind?: string; target?: string; detail?: string }) => x.kind === "app.storage.full" && x.target === serviceId && /files folder/.test(String(x.detail)));
          return e ? short(e.detail, 120) : null;
        });
      });
      await rec.check("freeing the files brings writes back", async () => {
        await get("/free-files");
        const r = await get("/fill-files?mb=4");
        assert(r.json?.wroteMb === 4 && !r.json.error, `after free: ${short(r.text)} storage ${short((await appDetail())?.storage?.files, 400)}`);
        await get("/free-files");
        return "4 MB written after freeing";
      });

      await rec.check("filling the database past its budget gets INSERT refused within a tick; reads still work", async () => {
        const pgLimit = Number((await appDetail())?.storage?.postgres?.limitBytes ?? 0);
        const r = await get(`/fill-db?mb=${Math.ceil(pgLimit / MiB) + 8}`);
        assert(r.status === 200, `fill-db ${r.status}: ${short(r.text)}`);
        const refused = await until("INSERT refused", 5, async () => {
          const w = await get("/db-write");
          return w.json?.ok === false && /permission denied/.test(String(w.json.error)) ? String(w.json.error) : null;
        });
        const rd = await get("/db-read");
        assert(rd.status === 200 && rd.json?.rows > 0, `read: ${short(rd.text)}`);
        const s = (await appDetail())?.storage?.postgres;
        assert(s?.writesBlocked === true && s?.stopped === false, `postgres: ${short(s)}`);
        return short(refused, 100);
      });
      await rec.check("Activity has app.storage.full for the database", async () => {
        return await until("Activity entry", 4, async () => {
          const r = await http(`https://${b.fqdn}/api/screens/activity?limit=200`, { headers: H });
          const e = (r.json?.entries ?? []).find((x: { kind?: string; target?: string; detail?: string }) => x.kind === "app.storage.full" && x.target === serviceId && /database/.test(String(x.detail)));
          return e ? short(e.detail, 120) : null;
        });
      });
      await rec.check("TRUNCATE (allowed while blocked) frees it, and INSERT comes back within a tick", async () => {
        const t = await get("/free-db");
        assert(t.json?.truncated === true, `truncate: ${short(t.text)}`);
        await until("INSERT allowed again", 5, async () => ((await get("/db-write")).json?.ok === true ? true : null));
        const s = (await appDetail())?.storage?.postgres;
        assert(s?.writesBlocked === false, `postgres: ${short(s)}`);
        return "writes back";
      });
    } finally {
      if (set) {
        await rec.check("the policy goes back to none, and the app's limits lift", async () => {
          const r = await policy("none", 0);
          assert(r.status === 200, `policy ${r.status}: ${short(r.text)}`);
          await until("limits lifted", 4, async () => {
            const s = (await appDetail())?.storage;
            return s?.files?.limitBytes === null && s?.postgres?.limitBytes === null ? true : null;
          });
          return "none";
        });
      }
    }
  },
};
