// P05 on a real box (docs/app-groups.md, docs/app-runtimes.md "Database profiles"): an app made of
// several processes starts its members in the declared order; an update with a member that can't
// start rolls every member back, and the app keeps serving; and two apps with their own databases
// (the dedicated profile new boxes give) are isolated: one fills its database until it fails, the
// other keeps writing. The hostile databases are driven through the WASI capability SDK's db_query,
// so no shell on the box is needed.
import { pair } from "../../lib/fleet.js";
import { assert, http, short, tryHttp } from "../../lib/harness.js";
import type { Group } from "../types.js";
import { journal, uninstall, until } from "./util.js";
import { api, appRuntime, baseManifest, signedInstall, uploadModule, wasiFixture } from "./runtimeShared.js";

function groupManifest(slug: string, workerImage: string, version = "1.0.0"): Record<string, unknown> {
  return {
    ...baseManifest(slug),
    version,
    runtime: { image: "docker.io/traefik/whoami:v1.10", port: 80 },
    components: [
      { name: "api", image: "docker.io/traefik/whoami:v1.10", start: ["--port", "7000"], port: 7000 },
      { name: "worker", image: workerImage, start: ["sleep", "86400"], startAfter: ["api"] },
    ],
  };
}

function dbApp(slug: string, digest: string): Record<string, unknown> {
  return {
    ...baseManifest(slug),
    runtime: { kind: "wasi", module: "app.wasm", world: "http-proxy", port: 8080, digest },
    data: { stores: { postgres: true } },
    network: { subdomain: slug, egress: ["example.com"] },
    resources: { diskMiB: 96 },
  };
}

const sql = (s: string) => `/db?sql=${encodeURIComponent(s)}`;

export const appGroupsDb: Group = {
  name: "app-groups-db",
  title: "app groups start in order and roll back whole; a hostile dedicated database can't hurt its sibling",
  needs: ["A1"],
  phase: 3,
  async run({ A, rec, box }) {
    const b = box("A1");
    const session = await pair(A, b);
    const slug = "grpshop";
    const sid = `${A.username}--${slug}`;
    const base = `https://${slug}.${b.fqdn}`;
    // A run on a kept box starts clean: leftovers of an earlier run would answer "already installed".
    for (const s of [slug, "dbhog", "dbsib"]) await uninstall(A, b, s);

    const up = await rec.check("a three-process app installs and serves", async () => {
      const r = await signedInstall(A, b, slug, groupManifest(slug, "docker.io/library/busybox:1.37"));
      assert(r.status === 200, `install ${r.status}: ${short(r.text, 300)}`);
      await until("the app serving", 4 * 60_000, async () => ((await tryHttp(`${base}/`, api(), 12_000)).status === 200 ? true : undefined));
      return "200";
    });
    if (up) {
      await rec.check("its members started in the declared order and all run", async () => {
        const rt = await appRuntime(b, session, sid);
        const members = (rt.members ?? []) as Array<{ name: string; order: number; state: string }>;
        assert(rt.kind === "group" && members.map((m) => m.name).join(",") === "api,worker,main", short(rt));
        assert(members.every((m) => m.state === "running"), short(members));
        const lines = await journal(A, b);
        const starts = lines.filter((l) => l.includes(`[app-group] ${sid}: started`));
        assert(starts.length >= 3, `journal: ${short(starts)}`);
        return members.map((m) => `${m.order}:${m.name}`).join(" ");
      });
      await rec.check("an update whose member can't start rolls every member back; the app keeps serving", async () => {
        const r = await signedInstall(A, b, slug, groupManifest(slug, "docker.io/library/busybox:does-not-exist-gym", "2.0.0"), true);
        assert(r.status === 400, `update should fail, got ${r.status}: ${short(r.text)}`);
        const rt = await appRuntime(b, session, sid);
        const members = (rt.members ?? []) as Array<{ name: string; state: string }>;
        assert(members.length === 3 && members.every((m) => m.state === "running"), short(members));
        assert((await http(`${base}/`, api())).status === 200, "not serving after the rollback");
        const lines = await journal(A, b);
        assert(lines.some((l) => l.includes(sid) && l.includes("every process of the previous version is back")), "no rollback line in the journal");
        return short(r.json?.error ?? r.text, 120);
      });
      await rec.check("uninstall stops every member", async () => {
        await uninstall(A, b, slug);
        await until("gone", 90_000, async () => ((await tryHttp(`${base}/`, api(), 12_000)).status !== 200 ? true : undefined));
        return "gone";
      });
    }

    // Dedicated databases, through the WASI capability SDK.
    const wasi = await http(`https://${b.fqdn}/api/wasi/status`, { headers: { "x-flagship-session": session } });
    if (wasi.json?.available !== true) {
      rec.skip("a hostile dedicated database can't exhaust its sibling's", "the box can't run WebAssembly apps (see wasi-apps)");
      return;
    }
    const hc = wasiFixture("sdk-wasi-hostcalls");
    await uploadModule(b, session, hc.bytes);
    const hog = "dbhog";
    const sib = "dbsib";
    const both = await rec.check("two apps each get their own database instance", async () => {
      for (const s of [hog, sib]) {
        const r = await signedInstall(A, b, s, dbApp(s, hc.digest));
        assert(r.status === 200, `${s} install ${r.status}: ${short(r.text, 300)}`);
      }
      for (const s of [hog, sib]) {
        const rt = await appRuntime(b, session, `${A.username}--${s}`);
        assert(rt.database?.profile === "dedicated", `${s}: ${short(rt.database)}`);
      }
      return "dedicated";
    });
    if (!both) return;
    const q = (s: string, text: string) => http(`https://${s}.${b.fqdn}${sql(text)}`, api(), 60_000);
    await rec.check("the hostile app fills its own database until it fails", async () => {
      await q(hog, "CREATE TABLE IF NOT EXISTS t (x text)");
      let last = { status: 200, text: "" };
      for (let i = 0; i < 40 && last.status === 200; i++) {
        last = await q(hog, "INSERT INTO t SELECT md5(g::text) || repeat('x', 2000) FROM generate_series(1, 15000) g");
      }
      assert(last.status !== 200 && /space|extend|could not write|terminat|closed|recovery/i.test(last.text), `${last.status}: ${short(last.text)}`);
      return short(last.text, 120);
    });
    await rec.check("its sibling still writes and reads", async () => {
      await q(sib, "CREATE TABLE IF NOT EXISTS s (x text)");
      const w = await q(sib, "INSERT INTO s SELECT repeat('y', 500) FROM generate_series(1, 2000)");
      assert(w.status === 200, `${w.status}: ${short(w.text)}`);
      const r = await q(sib, "SELECT count(*) AS n FROM s");
      assert(r.status === 200 && /"n":"?2000/.test(r.text), short(r.text));
      return "2000 rows";
    });
    await uninstall(A, b, hog);
    await uninstall(A, b, sib);
  },
};
