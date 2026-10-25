// P04 WASI apps on a real box (docs/wasi-apps.md): the SDK fixture app (Rust, wasm32-wasip1) is
// uploaded, installed by a signed order naming its digest, and served through the relay and the
// app proxy like any app: identity headers reach it, its data lives in its files folder and
// survives an update, an infinite loop and a memory bomb are stopped per request, a module that
// imports a host call its manifest doesn't declare is refused, the same module for two apps runs
// as two workers, and uninstall removes it.
import { pair } from "../../lib/fleet.js";
import { assert, http, short, tryHttp } from "../../lib/harness.js";
import type { Group } from "../types.js";
import { journal, uninstall, until } from "./util.js";
import { api, appRuntime, baseManifest, signedInstall, uploadModule, wasiFixture } from "./runtimeShared.js";

function wasiManifest(slug: string, digest: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseManifest(slug),
    runtime: { kind: "wasi", module: "app.wasm", world: "http-proxy", port: 8080, digest },
    data: { stores: { files: true } },
    resources: { memoryMiB: 32 },
    ...extra,
  };
}

export const wasiApps: Group = {
  name: "wasi-apps",
  title: "a WebAssembly app is installed, served, limited, updated and removed like any app",
  needs: ["A1"],
  phase: 3,
  async run({ A, rec, box }) {
    const b = box("A1");
    const session = await pair(A, b);
    const slug = "wasinotes";
    const sid = `${A.username}--${slug}`;
    const base = `https://${slug}.${b.fqdn}`;
    const fixture = wasiFixture("sdk-wasi-fixture");
    const hostcalls = wasiFixture("sdk-wasi-hostcalls");

    const ready = await rec.check("the box can run WebAssembly apps", async () => {
      const r = await http(`https://${b.fqdn}/api/wasi/status`, { headers: { "x-flagship-session": session } });
      assert(r.status === 200 && r.json?.available === true, `wasi status ${r.status}: ${short(r.text)}`);
      return (r.json.worlds as string[]).join(",");
    });
    if (!ready) return;

    const installed = await rec.check("the owner uploads the module and installs it by digest", async () => {
      const d = await uploadModule(b, session, fixture.bytes);
      assert(d === fixture.digest, `stored as ${d}`);
      const r = await signedInstall(A, b, slug, wasiManifest(slug, d));
      assert(r.status === 200, `install ${r.status}: ${short(r.text, 300)}`);
      await until("the app serving", 3 * 60_000, async () => ((await tryHttp(`${base}/healthz`, api(), 12_000)).status === 200 ? true : undefined));
      return d.slice(0, 19);
    });
    if (!installed) return;

    await rec.check("it serves HTTP through the relay and the app proxy", async () => {
      const r = await http(`${base}/`, api());
      assert(r.status === 200 && r.text.startsWith("flagship wasi fixture"), `${r.status}: ${short(r.text)}`);
      return short(r.text, 60);
    });
    await rec.check("the proxy's identity headers reach it; a client can't forge them", async () => {
      const r = await http(`${base}/whoami`, api({ "x-flagship-visitor": "member", "x-flagship-role": "master" }));
      assert(r.status === 200, `${r.status}`);
      assert(r.json?.visitor === "anonymous" && r.json?.role === null, `app saw ${short(r.text)}`);
      return short(r.text);
    });
    await rec.check("its data is kept in its files folder", async () => {
      const p = await http(`${base}/notes`, { method: "POST", headers: { "sec-fetch-mode": "cors", "content-type": "text/plain" }, body: "gym note" });
      assert(p.status === 303, `post ${p.status}: ${short(p.text)}`);
      const r = await http(`${base}/notes`, api());
      assert(r.text.includes("gym note"), short(r.text));
      return "saved";
    });
    await rec.check("an infinite loop is stopped and answered 503; the app keeps serving", async () => {
      const r = await http(`${base}/spin`, api(), 90_000);
      assert(r.status === 503 && /ran out of (fuel|wall-time)/.test(r.text), `${r.status}: ${short(r.text)}`);
      assert((await http(`${base}/healthz`, api())).status === 200, "not serving after");
      return short(r.text);
    });
    await rec.check("a memory bomb is stopped at the memory limit", async () => {
      const r = await http(`${base}/grow`, api(), 90_000);
      assert(r.status === 503 && /ran out of memory/.test(r.text), `${r.status}: ${short(r.text)}`);
      return short(r.text);
    });
    await rec.check("the box says it runs in the WASI worker", async () => {
      const rt = await appRuntime(b, session, sid);
      assert(rt.kind === "wasi" && rt.running === "wasi" && rt.moduleDigest === fixture.digest, short(rt));
      return `${rt.kind} ${rt.world}`;
    });
    await rec.check("an update keeps its data (same digest, new version)", async () => {
      const r = await signedInstall(A, b, slug, { ...wasiManifest(slug, fixture.digest), version: "1.1.0" }, true);
      assert(r.status === 200, `update ${r.status}: ${short(r.text, 300)}`);
      const notes = await until("serving after the update", 120_000, async () => {
        const n = await tryHttp(`${base}/notes`, api(), 12_000);
        return n.status === 200 ? n : undefined;
      });
      assert(notes.text.includes("gym note"), short(notes.text));
      return "kept";
    });

    await rec.check("a module importing a host call its manifest doesn't declare is refused", async () => {
      await uploadModule(b, session, hostcalls.bytes);
      const r = await signedInstall(A, b, "wasibad", wasiManifest("wasibad", hostcalls.digest, { data: {} }));
      assert(r.status === 400 && /does not declare|didn't start/.test(r.text), `${r.status}: ${short(r.text, 300)}`);
      return short(r.json?.error ?? r.text, 120);
    });
    await rec.check("the same module for a second app runs as its own worker", async () => {
      const r = await signedInstall(A, b, "wasitwin", wasiManifest("wasitwin", fixture.digest, { data: {} }));
      assert(r.status === 200, `install ${r.status}: ${short(r.text, 300)}`);
      const t = await until("twin serving", 120_000, async () => {
        const x = await tryHttp(`https://wasitwin.${b.fqdn}/notes`, api(), 12_000);
        return x.status === 200 ? x : undefined;
      });
      assert(!t.text.includes("gym note"), "the twin sees the first app's data");
      return "separate data";
    });
    await rec.check("the daemon journal records the worker's start", async () => {
      const lines = await journal(A, b);
      const hit = lines.find((l) => l.includes("[wasi]") && l.includes(sid));
      assert(hit, "no [wasi] line for the app");
      return short(hit, 120);
    });
    await rec.check("uninstall removes it", async () => {
      await uninstall(A, b, slug);
      await uninstall(A, b, "wasitwin");
      await until("gone", 90_000, async () => ((await tryHttp(`${base}/healthz`, api(), 12_000)).status !== 200 ? true : undefined));
      return "gone";
    });
  },
};
