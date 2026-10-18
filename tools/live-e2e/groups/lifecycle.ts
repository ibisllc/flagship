// Revoke / un-revoke / delete a server (.com), on account A's home2 — last,
// because it takes the box out of the account. Delete is what the apps do:
// deposit the admin-root-signed `wipe-now` decommission order, then release
// the name; the box picks the order up on its 5-minute poll, wipes itself and
// powers off, and .com no longer lets its key act for the account.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  signReleaseServerName,
  signRevocation,
  signServerDecommission,
  signServerUnrevocation,
  type ReleaseServerName,
  type ServerDecommission,
  type ServerRevocation,
  type ServerUnrevocation,
} from "@flagship/protocol";
import { pods } from "../lib/fleet.js";
import { CONTROL, assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import type { Group } from "./types.js";
import { mailboxAuth } from "./update.js";

export const lifecycle: Group = {
  name: "lifecycle",
  title: "revoke → un-revoke (admin root) → delete (wipe-now order + release the name) on home2, and the box wipes itself",
  needs: ["A2"],
  phase: 9,
  async run({ A, rec, box }) {
    const b = box("A2");
    const user = A.username;
    const row = async () => (await pods(user)).find((p) => p.serverDomain === b.fqdn);

    const revoked = await rec.check("revoke home2 (owner-IRK signed) → /pods shows it revoked", async () => {
      const r0: ServerRevocation = { userId: user, revokedServerId: b.fqdn, reason: "lost", issuedAt: Date.now() } as ServerRevocation;
      const r = await postJson(`https://${CONTROL}/api/server-registry/revoke`, { request: r0, signature: bytesToHex(signRevocation(r0, A.keys.irk)) });
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      const p = await row();
      assert(p?.revokedAt, `/pods row: ${short(p)}`);
      return `reason=${p.revocationReason}`;
    });
    if (!revoked) return;
    await rec.check("un-revoke signed by the owner IRK is refused (admin root required)", async () => {
      const u: ServerUnrevocation = { username: user, serverDomain: b.fqdn, issuedAt: Date.now() };
      const r = await postJson(`https://${CONTROL}/api/server-registry/unrevoke`, { request: u, signature: bytesToHex(signServerUnrevocation(u, A.keys.irk)) });
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });
    await rec.check("un-revoke (admin-root signed) → /pods clears it; no DNS is written (the zone wildcard answers the box)", async () => {
      const u: ServerUnrevocation = { username: user, serverDomain: b.fqdn, issuedAt: Date.now() };
      const r = await postJson(`https://${CONTROL}/api/server-registry/unrevoke`, { request: u, signature: bytesToHex(signServerUnrevocation(u, A.keys.adminRoot)) });
      assert(r.status === 200 && r.json?.ok !== false, `${r.status}: ${short(r.text)}`);
      const p = await row();
      assert(p && !p.revokedAt, `/pods row: ${short(p)}`);
      assert(r.json?.legacyDnsRemoved === 0, `legacyDnsRemoved=${r.json?.legacyDnsRemoved} (an un-revoke writes no record and finds none to clear)`);
      return "legacyDnsRemoved=0";
    });

    let stk = "";
    const ordered = await rec.check("delete, step 1: the wipe-now decommission order (admin-root signed; the IRK is refused) is on file for home2's key", async () => {
      stk = String((await row())?.identityPubKey ?? "").toLowerCase();
      assert(/^[0-9a-f]{64}$/.test(stk), `no identityPubKey for home2`);
      const order: ServerDecommission = { podCanonical: b.fqdn, retiredStkPubHex: stk, finalBackup: false, diskDisposition: "wipe-now", backupEpoch: 0, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
      const send = (signer = A.keys.adminRoot) =>
        postJson(`https://${CONTROL}/api/server/${encodeURIComponent(b.fqdn)}/decommission`, { ...mailboxAuth(A), order, signature: bytesToHex(signServerDecommission(order, signer)) });
      const byIrk = await send(A.keys.irk);
      assert(byIrk.status === 403, `IRK-signed order ${byIrk.status}: ${short(byIrk.text)}`);
      const r = await send();
      assert(r.status === 200, `order ${r.status}: ${short(r.text)}`);
      const got = await http(`https://${CONTROL}/api/server/${encodeURIComponent(b.fqdn)}/decommission?stk=${stk}`);
      assert(got.status === 200 && JSON.parse(got.json?.orderJson ?? "{}").diskDisposition === "wipe-now", `order read back ${got.status}: ${short(got.text)}`);
      return "403 / 200, readable at the box's poll URL";
    });
    const released = await rec.check("delete, step 2: release the name (admin-root signed) → /pods no longer lists home2, by-domain says revoked", async () => {
      const rel: ReleaseServerName = { username: user, serverDomain: b.fqdn, issuedAt: Date.now() };
      const r = await postJson(`https://${CONTROL}/api/server/release`, { request: rel, signature: bytesToHex(signReleaseServerName(rel, A.keys.adminRoot)) });
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      for (let i = 0; i < 6; i++) {
        if (!(await row())) {
          const bd = await http(`https://${CONTROL}/api/server/by-domain/${encodeURIComponent(b.fqdn)}`);
          assert(bd.json?.revoked, `by-domain ${short(bd.text)}`);
          return "gone from /pods; by-domain revoked";
        }
        await sleep(5000);
      }
      throw new Error(`still listed: ${short(await row())}`);
    });
    if (!ordered || !released) return;
    const orderedAt = Date.now();
    let stoppedAfterMs = 0;
    await rec.check("home2 consumes the order, wipes itself and stops answering (≤ 12 min)", async () => {
      const deadline = Date.now() + 12 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const r = await tryHttp(`https://${b.fqdn}/`, {}, 15_000);
        last = `${r.status} ${short(r.text, 60)}`;
        if (r.status === 0 || r.status >= 500) {
          const again = await tryHttp(`https://${b.fqdn}/api/services`, {}, 15_000);
          if (again.status === 0 || again.status >= 500) {
            stoppedAfterMs = Date.now() - orderedAt;
            return `stopped answering ${(stoppedAfterMs / 60_000).toFixed(1)} min after the release (${last})`;
          }
        }
        await sleep(20_000);
      }
      throw new Error(`home2 still answers after 12 min (${last})`);
    });
    // The decommission lane rings on the next heartbeat (5 min) and the wipe takes a little more.
    await rec.check("the decommission order reached the box within the doorbell budget (heartbeat 5 min + wipe: ≤ 10 min)", async () => {
      assert(stoppedAfterMs > 0, "home2 never stopped answering");
      assert(stoppedAfterMs <= 10 * 60_000, `stopped ${(stoppedAfterMs / 60_000).toFixed(1)} min after the release`);
      return `${(stoppedAfterMs / 60_000).toFixed(1)} min`;
    });
  },
};
