// Revoke / un-revoke / delete a server (.com), on account A's home2 — last,
// because it takes the box out of the account.
import { bytesToHex } from "@noble/hashes/utils";
import {
  signReleaseServerName,
  signRevocation,
  signServerUnrevocation,
  type ReleaseServerName,
  type ServerRevocation,
  type ServerUnrevocation,
} from "@flagship/protocol";
import { pods } from "../lib/fleet.js";
import { CONTROL, assert, postJson, short, sleep } from "../lib/harness.js";
import type { Group } from "./types.js";

export const lifecycle: Group = {
  name: "lifecycle",
  title: "revoke → un-revoke (admin root) → delete (release the name) on home2",
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
    await rec.check("un-revoke (admin-root signed) → /pods clears it and DNS is republished", async () => {
      const u: ServerUnrevocation = { username: user, serverDomain: b.fqdn, issuedAt: Date.now() };
      const r = await postJson(`https://${CONTROL}/api/server-registry/unrevoke`, { request: u, signature: bytesToHex(signServerUnrevocation(u, A.keys.adminRoot)) });
      assert(r.status === 200 && r.json?.ok !== false, `${r.status}: ${short(r.text)}`);
      const p = await row();
      assert(p && !p.revokedAt, `/pods row: ${short(p)}`);
      return `dnsRepublished=${r.json?.dnsRepublished}`;
    });
    await rec.check("delete: release the name (admin-root signed) → /pods no longer lists home2", async () => {
      const rel: ReleaseServerName = { username: user, serverDomain: b.fqdn, issuedAt: Date.now() };
      const r = await postJson(`https://${CONTROL}/api/server/release`, { request: rel, signature: bytesToHex(signReleaseServerName(rel, A.keys.adminRoot)) });
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      for (let i = 0; i < 6; i++) {
        if (!(await row())) return "gone from /pods";
        await sleep(5000);
      }
      throw new Error(`still listed: ${short(await row())}`);
    });
  },
};
