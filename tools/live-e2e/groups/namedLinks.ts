// Custom voi.ci names (docs/named-links.md) on account A's two live boxes.
// .com side: the link state of a new app, an admin-root-signed set, the name
// rules and reserved words, the per-service change limit. Box side: the
// canonical address <app>.<user>.<services apex> is served by the first live
// server in the order that runs the app, and passes to the other one when that
// server stops running the app (the election reads .com's server list as well as gossip).
// voi.ci itself is a fixed host, so redirects are covered by the control-plane
// tests, not here. Not yet run live.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { signServerOrder, signUninstallService, signVoiciNameOrder, type ServerOrder, type UninstallServiceRequest, type VoiciNameOrder } from "@flagship/protocol";
import { pair, pods } from "../lib/fleet.js";
import { CONTROL, SERVICES, assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { installWhoami } from "./gating.js";
import type { Group } from "./types.js";

export const namedLinks: Group = {
  name: "named-links",
  title: "custom voi.ci names: set, rules, change limit; the canonical address follows the running server",
  needs: ["A1", "A2"],
  phase: 7,
  async run({ A, rec, box }) {
    const b1 = box("A1");
    const b2 = box("A2");
    const slug = "linkdemo";
    const serviceId = `${A.username}--${slug}`;
    const base = `https://${CONTROL}/api/users/${A.username}`;
    const links = async () => (await http(`${base}/apps/${serviceId}/links`)).json ?? {};
    const setName = async (name: string) => {
      const order: VoiciNameOrder = { user: A.username, serviceId, name, op: name ? "set" : "clear", issuedAt: Date.now(), nonce: randomBytes(32).toString("hex") };
      return postJson(`${base}/apps/${serviceId}/voici-name`, { order, signature: bytesToHex(signVoiciNameOrder(order, A.keys.adminRoot)) });
    };

    const installed = await rec.check("the app runs on both servers", async () => {
      await installWhoami(A, b1, slug, { enabled: true, public_routes: ["/*"] });
      await installWhoami(A, b2, slug, { enabled: true, public_routes: ["/*"] });
      return slug;
    });
    if (!installed) return;

    await rec.check("a new app has a random code and a link with all its changes left", async () => {
      let l: any = {};
      for (let i = 0; i < 24 && !l.shortCode; i++) {
        l = await links();
        if (!l.shortCode) await sleep(5_000);
      }
      assert(/^[a-z0-9]{6}$/.test(String(l.shortCode)), `shortCode ${short(l)}`);
      assert(l.link?.name === null && l.link?.changesLeft === 3, `link ${short(l.link)}`);
      return `${l.shortCode}, ${l.link.held}/${l.link.limit} names`;
    });

    await rec.check("an order signed with the owner IRK is refused (admin-pinned account)", async () => {
      const order: VoiciNameOrder = { user: A.username, serviceId, name: "gymlinkirk", op: "set", issuedAt: Date.now(), nonce: randomBytes(32).toString("hex") };
      const r = await postJson(`${base}/apps/${serviceId}/voici-name`, { order, signature: bytesToHex(signVoiciNameOrder(order, A.keys.irk)) });
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });

    const name = `gym-${randomBytes(3).toString("hex")}-link`;
    await rec.check("a reserved word and a too-short name are refused", async () => {
      const a = await setName("admin");
      const b = await setName("abc");
      assert(a.status >= 400 && b.status >= 400, `reserved ${a.status}, short ${b.status}`);
      return `${a.json?.code ?? a.status}, ${b.json?.code ?? b.status}`;
    });
    await rec.check("an admin-root-signed order sets the custom name; the random code stays", async () => {
      const before = (await links()).shortCode;
      const r = await setName(name);
      assert(r.status === 200, `set ${r.status}: ${short(r.text)}`);
      const l = await links();
      assert(l.link?.name === name && l.link?.changesLeft === 2 && l.shortCode === before, `link ${short(l)}`);
      return `${name}, 2 changes left`;
    });
    await rec.check("the name without its hyphens is the same name (current for this app)", async () => {
      const r = await http(`${base}/voici-name-check?name=${encodeURIComponent(name.replace(/-/g, ""))}&service=${serviceId}`);
      assert(r.json?.status === "current", `check ${short(r.text)}`);
      return String(r.json?.status);
    });
    await rec.check("a replace and a clear use the other two changes; the fourth is refused with a date", async () => {
      assert((await setName(`${name}-two`)).status === 200, "replace refused");
      assert((await setName("")).status === 200, "clear refused");
      const r = await setName(`${name}-three`);
      assert(r.status === 429 || r.status === 403 || r.status === 409, `fourth change got ${r.status}`);
      assert(r.json?.code === "change-limit" && Number(r.json?.nextChangeAt) > Date.now(), `body ${short(r.text)}`);
      return "change-limit";
    });

    // ---- the canonical address ----
    const stkOf = async (fqdn: string) => String((await pods(A.username)).find((p) => p.serverDomain === fqdn)?.identityPubKey ?? "").toLowerCase();
    const [s1, s2] = [await pair(A, b1), await pair(A, b2)];
    void s1;
    void s2;
    const canonical = `https://${slug}.${A.username}.${SERVICES}/`;
    const serves = async () => (await tryHttp(canonical, { headers: { accept: "text/html" } }, 15_000)).status === 200;
    const until = async (what: string, f: () => Promise<boolean>, ms: number) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await f().catch(() => false)) return;
        await sleep(5_000);
      }
      throw new Error(`${what}: not within ${Math.round(ms / 1000)} s`);
    };
    await rec.check("home leads in the server order and the canonical address serves", async () => {
      const [k1, k2] = [await stkOf(b1.fqdn), await stkOf(b2.fqdn)];
      const order: ServerOrder = { user: A.username, stks: [k1, k2], issuedAt: Date.now(), nonce: randomBytes(32).toString("hex") };
      const r = await postJson(`https://${CONTROL}/api/accounts/${A.username}/server-order`, { order, signature: signServerOrder(order, A.keys.adminRoot) });
      assert(r.status === 200, `order ${r.status}: ${short(r.text)}`);
      await until("canonical address", serves, 6 * 60_000);
      return "200";
    });
    await rec.check("when home stops running the app the canonical address still serves, from home2", async () => {
      const req: UninstallServiceRequest = { serverId: b1.fqdn, creator: A.username, slug, issuedAt: Date.now() };
      const r = await http(`https://${b1.fqdn}/api/services/${encodeURIComponent(serviceId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: req, signature: bytesToHex(signUninstallService(req, A.keys.adminRoot)) }),
      }, 120_000);
      assert(r.status === 200, `uninstall on home ${r.status}: ${short(r.text)}`);
      const gone = Date.now() + 6 * 60_000;
      let held = false;
      while (Date.now() < gone && !held) {
        const lead = await tryHttp(`https://${b2.fqdn}/api/leads`, {}, 15_000);
        held = lead.json?.leads?.[slug]?.leaderFqdn === b2.fqdn;
        if (!held) await sleep(5_000);
      }
      assert(held, "home2 never became the lead for the app");
      await until("the canonical address", serves, 6 * 60_000);
      return "200 from home2";
    });
  },
};
