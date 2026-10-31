// The upgrade path for boxes that are already out there: a CLASSIC box (Docker, TS keyd/privd) running an app is
// moved to arch-v2 (Podman, Rust keyd/broker/core) by the owner's signed order, the apps come back, and the
// owner can go back. Run it in the classic pass (GYM_BOX_STACK=classic): the box it uses must start classic.
// docs/architecture-v2/app-endpoints.md section 6, engine-and-rust-path.md section 7.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { ed, signInstallService, type ArchV2SwitchOrder, type InstallServiceRequest, signArchV2SwitchOrder } from "@flagship/protocol";
import { pair } from "../../lib/fleet.js";
import { assert, http, postJson, short, sleep, tryHttp } from "../../lib/harness.js";
import { whoamiManifest } from "../core.js";
import type { Group } from "../types.js";

export const stackSwitch: Group = {
  name: "stack-switch",
  title: "an existing classic box moves to arch-v2 on the owner's signed order, keeps its app, and can go back",
  needs: ["A1"],
  phase: 11,
  async run({ A, rec, box }) {
    // Not applicable to an arch-v2 pass (its boxes never start classic): the classic pass runs it.
    if ((process.env.GYM_BOX_STACK || "arch-v2") !== "classic") return;
    const b = box("A1");
    const fqdn = b.fqdn;
    const user = A.username;
    const { irk, adminRoot } = A.keys;
    let session = await pair(A, b);
    const headers = () => ({ "x-flagship-session": session });
    const call = async (path: string, init: Parameters<typeof http>[1] = {}, ms = 60_000) => {
      let r = await tryHttp(`https://${fqdn}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...headers() } }, ms);
      if (r.status === 401) {
        b.session = undefined;
        session = await pair(A, b);
        r = await tryHttp(`https://${fqdn}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...headers() } }, ms);
      }
      return r;
    };
    const order = (target: "arch-v2" | "classic"): { order: ArchV2SwitchOrder; signature: string } => {
      const o: ArchV2SwitchOrder = { serverDomain: fqdn, target, nonce: randomBytes(16).toString("hex"), issuedAt: Date.now() };
      return { order: o, signature: bytesToHex(signArchV2SwitchOrder(o, (m) => ed.sign(m, adminRoot.privateKey))) };
    };

    const slug = "swapp";
    const serviceId = `${user}--${slug}`;
    const served = async (what: string, minutes: number) => {
      const url = `https://${slug}.${fqdn}/`;
      const deadline = Date.now() + minutes * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const c = await tryHttp(url, {}, 12_000);
        if (c.status === 200) return `${what}: 200`;
        last = `${c.status} ${short(c.text, 100)}`;
        await sleep(10_000);
      }
      throw new Error(`${what}: not 200 in ${minutes} min (${last})`);
    };

    const stack = async (): Promise<{ stack?: string; engine?: string; switch?: { state?: string; reason?: string } | null }> => {
      const r = await call("/api/stack");
      return r.status === 200 ? (r.json ?? {}) : {};
    };

    const started = await rec.check("the box starts on the classic stack and runs an app", async () => {
      const s = await stack();
      assert(s.stack === "classic" && s.engine === "docker", `expected classic/docker, got ${short(s)} (run this group with GYM_BOX_STACK=classic)`);
      const req: InstallServiceRequest = { serverId: fqdn, creator: user, slug, manifestJson: whoamiManifest(slug), addOwnerToMembership: true, issuedAt: Date.now() };
      const r = await postJson(`https://${fqdn}/api/services`, { request: req, signature: bytesToHex(signInstallService(req, irk)) }, {}, 120_000);
      assert(r.status === 200, `install ${r.status}: ${short(r.text, 240)}`);
      return await served("served on Docker", 5);
    });
    if (!started) return;

    await rec.check("the plan for arch-v2 has no blockers, and a dry run changes nothing", async () => {
      const o = order("arch-v2");
      const r = await call("/api/stack/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...o, dryRun: true }) });
      assert(r.status === 200 && r.json?.dryRun === true, `${r.status}: ${short(r.text, 300)}`);
      const blockers = (r.json?.plan?.blockers ?? []) as Array<{ code: string; error: string }>;
      assert(blockers.length === 0, `blockers: ${blockers.map((x) => `${x.code}: ${x.error}`).join("; ")}`);
      assert((await stack()).stack === "classic", "a dry run switched the box");
      return "no blockers";
    });

    await rec.check("an order signed by the owner IRK (not the admin root) is refused", async () => {
      const o = order("arch-v2");
      const bad = bytesToHex(signArchV2SwitchOrder(o.order, (m) => ed.sign(m, irk.privateKey)));
      const r = await call("/api/stack/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: o.order, signature: bad }) });
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });

    const switched = await rec.check("the admin-signed order is accepted and the box ends up on arch-v2 (Podman) within 25 min", async () => {
      const r = await call("/api/stack/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order("arch-v2")) });
      assert(r.status === 202, `${r.status}: ${short(r.text, 300)}`);
      const deadline = Date.now() + 25 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        await sleep(20_000);
        const s = await stack().catch(() => ({}) as Awaited<ReturnType<typeof stack>>);
        last = short(s, 200);
        if (s.switch?.state === "reverted") throw new Error(`the switch was reverted: ${s.switch.reason ?? "no reason"}`);
        if (s.stack === "arch-v2" && s.engine === "podman" && (s.switch?.state === "trial" || s.switch?.state === "done")) return `arch-v2/podman (${s.switch.state})`;
      }
      throw new Error(`not switched in 25 min (${last})`);
    });
    if (!switched) return;

    await rec.check("the app that ran before runs again on Podman, through the endpoint resolver", async () => served("served on Podman", 15));

    // The trial keeps the switch by itself once the box is healthy and every app is back (archV2Switch.ts
    // settle, up to 20 min); until then another order is refused as in-progress, by design.
    const settled = await rec.check("the switch's trial settles to done, and the box still answers its owner", async () => {
      const r = await call("/api/screens/server-detail");
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      const deadline = Date.now() + 25 * 60_000;
      let s = await stack();
      while (s.switch?.state === "trial" && Date.now() < deadline) {
        await sleep(20_000);
        s = await stack().catch(() => s);
      }
      assert(s.switch?.state === "done", `switch ${short(s.switch, 200)}`);
      return short(s, 200);
    });
    if (!settled) return;

    const back = await rec.check("the owner can go back: a signed order to classic returns the box to Docker with its app", async () => {
      const r = await call("/api/stack/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order("classic")) });
      assert(r.status === 202, `${r.status}: ${short(r.text, 300)}`);
      const deadline = Date.now() + 25 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        await sleep(20_000);
        const s = await stack().catch(() => ({}) as Awaited<ReturnType<typeof stack>>);
        last = short(s, 200);
        if (s.stack === "classic" && s.engine === "docker") return "classic/docker";
      }
      throw new Error(`not back in 25 min (${last})`);
    });
    if (!back) return;
    await rec.check("the app runs on Docker again after going back", async () => served("served on Docker again", 15));
    void serviceId;
  },
};
