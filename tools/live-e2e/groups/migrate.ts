// Migrate a server (docs/server-backup-and-clone.md "Migrate"), on the real
// account R: `home` moves onto `home2`, which holds the same sealing key a
// phone derives for `home`. home backs itself up to its peer (home2), the
// owner starts the migration (admin-root signed), home2 attaches and restores
// on its own, the owner confirms and freezes, home flushes its last delta,
// home2 takes over the name, restarts as `home` and asks the phone (the
// harness) for a new entitlement, and home wipes itself after the hand-off.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  signRootEntitlement,
  signServerDecommission,
  signServerMigrationControl,
  signServerMigrationOrder,
  type RootEntitlement,
  type ServerDecommission,
  type ServerMigrationControl,
  type ServerMigrationOrder,
} from "@flagship/protocol";
import { pair, pods, type Account, type Box } from "../lib/fleet.js";
import { CONTROL, assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { installWhoami, waitServing } from "./gating.js";
import { mailboxAuth } from "./update.js";
import type { Group } from "./types.js";

const SLUG = "moved";

async function migration(fqdn: string): Promise<any> {
  return (await tryHttp(`https://${CONTROL}/api/server/${encodeURIComponent(fqdn)}/migration`)).json ?? {};
}

async function waitPhase(fqdn: string, want: RegExp, minutes: number, log: (s: string) => void): Promise<any> {
  const deadline = Date.now() + minutes * 60_000;
  let last: any = {};
  let said = "";
  while (Date.now() < deadline) {
    last = await migration(fqdn);
    if (last.phase !== said) {
      said = String(last.phase);
      log(`migration phase: ${said}`);
    }
    if (want.test(String(last.phase))) return last;
    if (last.phase === "aborted") throw new Error("the migration was aborted");
    await sleep(15_000);
  }
  throw new Error(`phase ${last.phase} after ${minutes} min (wanted ${want})`);
}

/** The phone's answer to the box's entitlement request: an admin-root-signed RootEntitlement for (name, STK). */
async function answerEntitlement(acct: Account, fqdn: string, stkHex: string, minutes: number): Promise<string> {
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    const list = await postJson(`https://${CONTROL}/api/secret-requests`, mailboxAuth(acct));
    const req = (list.json?.requests ?? []).find((r: { serverDomain: string; purpose: string }) => r.serverDomain === fqdn && r.purpose === "entitlement");
    if (req) {
      assert(String(req.stkPub).toLowerCase() === stkHex, `the request's STK ${req.stkPub} is not the new box's ${stkHex}`);
      const ent: RootEntitlement = { username: acct.username, podPubKey: Buffer.from(stkHex, "hex"), podCanonical: fqdn.toLowerCase(), issuedAt: Date.now() };
      const carrier = {
        rootEntitlement: { username: ent.username, podPubKey: stkHex, podCanonical: ent.podCanonical, issuedAt: ent.issuedAt },
        rootEntitlementSig: bytesToHex(signRootEntitlement(ent, acct.keys.adminRoot)),
        serviceEntitlement: null,
        serviceEntitlementSig: null,
      };
      const r = await postJson(`https://${CONTROL}/api/secret-response`, {
        ...mailboxAuth(acct),
        response: { serverDomain: fqdn, requestNonceHex: req.requestNonceHex, purpose: "entitlement", sealed: Buffer.from(JSON.stringify(carrier)).toString("hex"), issuedAt: Date.now() },
      });
      assert(r.status === 200, `secret-response ${r.status}: ${short(r.text)}`);
      return `answered request ${String(req.requestNonceHex).slice(0, 8)}…`;
    }
    await sleep(5000);
  }
  throw new Error(`no entitlement request from ${fqdn} in ${minutes} min`);
}

export const migrate: Group = {
  name: "migrate",
  title: "migrate the real account's home onto home2: peer backup, admin-signed order, attach + restore, freeze, take-over, new entitlement, old box wipes",
  needs: ["R1", "R2"],
  phase: 2,
  async run({ R, rec, box }) {
    const acct = R!;
    const x: Box = box("R1");
    const y: Box = box("R2");
    const xs = { "x-flagship-session": await pair(acct, x) };
    const ys = { "x-flagship-session": await pair(acct, y) };
    const stkOf = async (fqdn: string) => String((await http(`https://${CONTROL}/api/server/by-domain/${encodeURIComponent(fqdn)}`)).json?.identityPubKey ?? "").toLowerCase();
    const oldStk = await stkOf(x.fqdn);
    const newStk = await stkOf(y.fqdn);

    const backedUp = await rec.check("home runs an app and backs itself up to its peer (manifest on .com)", async () => {
      assert(/^[0-9a-f]{64}$/.test(oldStk) && /^[0-9a-f]{64}$/.test(newStk) && oldStk !== newStk, `STKs ${oldStk} / ${newStk}`);
      await installWhoami(acct, x, SLUG, { enabled: true, public_routes: ["/*"] });
      await waitServing(`https://${SLUG}.${x.fqdn}/`);
      for (const [b, s] of [[x, xs], [y, ys]] as const) {
        const t = await postJson(`https://${b.fqdn}/api/screens/peer-backup/toggle`, { participate: true }, s);
        assert(t.status === 200, `${b.serverName} peer-backup toggle ${t.status}: ${short(t.text)}`);
      }
      const deadline = Date.now() + 8 * 60_000;
      while (Date.now() < deadline) {
        const m = await tryHttp(`https://${CONTROL}/api/server/${encodeURIComponent(x.fqdn)}/backup-manifest`);
        if (m.status === 200) return `manifest on .com (${m.text.length} B)`;
        await sleep(15_000);
      }
      throw new Error("no backup manifest for home in 8 min");
    });
    if (!backedUp) return;

    const order = (signer = acct.keys.adminRoot) => {
      const o: ServerMigrationOrder = { serverDomain: x.fqdn, oldStkPubHex: oldStk, diskDisposition: "wipe-after-handoff", nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
      return postJson(`https://${CONTROL}/api/server/${encodeURIComponent(x.fqdn)}/migration`, { ...mailboxAuth(acct), order: o, signature: bytesToHex(signServerMigrationOrder(o, signer)) });
    };
    const started = await rec.check("the owner starts the migration (admin-root signed; the IRK is refused)", async () => {
      const byIrk = await order(acct.keys.irk);
      assert(byIrk.status === 403, `IRK-signed order ${byIrk.status}: ${short(byIrk.text)}`);
      const r = await order();
      assert(r.status === 200 && r.json?.phase === "initiated", `${r.status}: ${short(r.text)}`);
      return "initiated";
    });
    if (!started) return;

    const seeded = await rec.check("home2 attaches and restores home's backup on its own (pre-seeded)", async () => {
      const m = await waitPhase(x.fqdn, /^pre-seeded$/, 15, (s) => rec.log(s));
      assert(m.newServerDomain === y.fqdn && String(m.newStkPubHex).toLowerCase() === newStk, `attached by ${m.newServerDomain}`);
      return `attached ${short(m.attachedAt)} pre-seeded ${short(m.preSeededAt)}`;
    });
    if (!seeded) return;

    const control = (action: "confirm-ready" | "abort") => {
      const c: ServerMigrationControl = { serverDomain: x.fqdn, action, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
      return postJson(`https://${CONTROL}/api/server/${encodeURIComponent(x.fqdn)}/migration/${action}`, { ...mailboxAuth(acct), control: c, signature: bytesToHex(signServerMigrationControl(c, acct.keys.adminRoot)) });
    };
    const frozen = await rec.check("the owner confirms and freezes home (final backup, wipe after hand-off)", async () => {
      const ok = await control("confirm-ready");
      assert(ok.status === 200, `confirm-ready ${ok.status}: ${short(ok.text)}`);
      const d: ServerDecommission = { podCanonical: x.fqdn, retiredStkPubHex: oldStk, finalBackup: true, diskDisposition: "wipe-after-handoff", backupEpoch: Date.now(), nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
      const f = await postJson(`https://${CONTROL}/api/server/${encodeURIComponent(x.fqdn)}/migration/freeze`, { ...mailboxAuth(acct), order: d, signature: bytesToHex(signServerDecommission(d, acct.keys.adminRoot)) });
      assert(f.status === 200, `freeze ${f.status}: ${short(f.text)}`);
      return "freezing";
    });
    if (!frozen) return;

    const tookOver = await rec.check("home flushes its last delta and home2 takes over the name (.com now names home2's key)", async () => {
      const m = await waitPhase(x.fqdn, /^taken-over$/, 15, (s) => rec.log(s));
      assert(m.finalDeltaAt, `no final delta: ${short(m)}`);
      const stk = await stkOf(x.fqdn);
      assert(stk === newStk, `by-domain names ${stk}`);
      return `final delta ${m.finalDeltaAt}, taken over ${m.takenOverAt}`;
    });
    if (!tookOver) return;

    await rec.check("home2 restarts as home and asks the phone for an entitlement; answered, it serves home's name with a new cert", async () => {
      const answered = await answerEntitlement(acct, x.fqdn, newStk, 8);
      const deadline = Date.now() + 10 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const p = (await pods(acct.username)).find((q) => q.serverDomain === x.fqdn);
        const r = await tryHttp(`https://${x.fqdn}/`, {}, 15_000);
        last = `pods=${p?.state ?? "-"} http=${r.status}`;
        if (r.status === 200 && p?.state === "online" && String(p.identityPubKey).toLowerCase() === newStk) return `${answered}; ${last}`;
        await sleep(15_000);
      }
      throw new Error(`home's name isn't served by home2 (${last})`);
    });
    await rec.check("home's app came along: it serves on home's name from home2", async () => {
      const r = await waitServing(`https://${SLUG}.${x.fqdn}/`, 300);
      return `${r.status}`;
    });
    await rec.check("the new home's activity log records the take-over", async () => {
      const s = { "x-flagship-session": await pair(acct, { ...x, session: undefined }) };
      const a = await http(`https://${x.fqdn}/api/screens/activity?limit=100`, { headers: s });
      assert((a.json?.entries ?? []).some((e: { kind?: string }) => e.kind === "server.migration.taken-over"), `activity ${short(a.text, 300)}`);
      return "server.migration.taken-over";
    });
    await rec.check("the old box wipes itself after the hand-off and closes the migration (done)", async () => {
      const deadline = Date.now() + 15 * 60_000;
      let m: any = {};
      while (Date.now() < deadline) {
        m = await migration(x.fqdn);
        if (m.done && m.oldClosedOutAt) return `closed out ${m.oldClosedOutAt}`;
        await sleep(20_000);
      }
      throw new Error(`not closed out: ${short(m, 300)}`);
    });
  },
};
