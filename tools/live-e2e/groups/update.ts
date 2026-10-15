// Update this server (docs: AGENTS.md "Update this server"): the admin-root
// signed update order to an ALREADY-ENDORSED release, deposited on .com with
// IRK mailbox auth, consumed by the box (≤5 min poll), applied through the
// endorsement gate, and reported back as lastUpdate. Gym boxes run main HEAD,
// which no release endorses, so the target is the newest endorsed release the
// box lists (an "older" one): the release signature is what the box checks,
// not the direction.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { signDeviceEndpointClaim, signUpdateOrder, type UpdateOrder } from "@flagship/protocol";
import { pair, type Account } from "../lib/fleet.js";
import { CONTROL, assert, http, postJson, short, sleep } from "../lib/harness.js";
import type { Group } from "./types.js";

export function mailboxAuth(acct: Account): { auth: Record<string, unknown>; authSignature: string } {
  const issuedAt = Date.now();
  const nonce = new Uint8Array(randomBytes(32));
  const claim = { username: acct.username, endpointLabel: "webapp", phoneIrkPub: acct.keys.irk.publicKey, issuedAt, expiresAt: issuedAt + 120_000, nonce };
  return {
    auth: { ...claim, phoneIrkPub: bytesToHex(claim.phoneIrkPub), nonce: bytesToHex(nonce) },
    authSignature: bytesToHex(signDeviceEndpointClaim(claim, acct.keys.irk)),
  };
}

export const update: Group = {
  name: "update",
  title: "update this server to an endorsed release (signed order → box applies → lastUpdate)",
  needs: ["B1"],
  phase: 9,
  async run({ B, rec, box }) {
    const acct = B!;
    const b = box("B1");
    const session = await pair(acct, b);
    const s = { "x-flagship-session": session };
    let current = "";
    let target = "";
    const found = await rec.check("the box lists endorsed releases and its own commit", async () => {
      const r = await http(`https://${b.fqdn}/api/screens/updates?refresh=1`, { headers: s }, 120_000);
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      current = String(r.json?.currentCommit ?? "");
      const rel = (r.json?.releases ?? []) as Array<{ commit: string; relation: string; endorsedAt?: string }>;
      const pick = r.json?.latest?.commit ? rel.find((x) => x.commit === r.json.latest.commit) : undefined;
      const choice = pick ?? rel.filter((x) => x.relation !== "current").sort((x, y) => String(y.endorsedAt).localeCompare(String(x.endorsedAt)))[0];
      assert(/^[0-9a-f]{40}$/.test(current) && choice?.commit, `current=${current} releases=${short(rel, 200)}`);
      target = choice.commit;
      return `${current.slice(0, 8)} → ${target.slice(0, 8)} (${choice.relation})`;
    });
    if (!found) return;
    const order: UpdateOrder = { serverDomain: b.fqdn, targetCommit: target, fromCommit: current, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
    const deposit = (signer = acct.keys.adminRoot) =>
      postJson(`https://${CONTROL}/api/server/${encodeURIComponent(b.fqdn)}/update`, {
        ...mailboxAuth(acct),
        deposit: { serverDomain: b.fqdn, requestNonceHex: randomBytes(32).toString("hex") },
        order,
        signature: bytesToHex(signUpdateOrder(order, signer)),
      });
    await rec.check("an update order signed by the owner IRK is refused", async () => {
      const r = await deposit(acct.keys.irk);
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });
    const deposited = await rec.check(".com accepts the admin-root-signed update order", async () => {
      const r = await deposit();
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      return `expires ${r.json?.expiresAt}`;
    });
    if (!deposited) return;
    await rec.check("the box applies it and reports lastUpdate=applied at the target (≤25 min)", async () => {
      const deadline = Date.now() + 25 * 60_000;
      let last = "";
      let tok = session;
      while (Date.now() < deadline) {
        await sleep(30_000);
        let r = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": tok } }).catch(() => null);
        if (r?.status === 401) {
          b.session = undefined;
          tok = await pair(acct, b).catch(() => tok);
          r = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": tok } }).catch(() => null);
        }
        const lu = r?.json?.lastUpdate;
        last = `${r?.status ?? 0} commit=${String(r?.json?.currentCommit ?? "").slice(0, 8)} lastUpdate=${short(lu, 160)}`;
        if (lu?.outcome === "applied" && String(r?.json?.currentCommit ?? "").startsWith(target.slice(0, 12))) return last;
        if (lu?.outcome === "refused" || lu?.outcome === "rolled-back") throw new Error(last);
      }
      throw new Error(`not applied in 25 min (${last})`);
    });
  },
};
