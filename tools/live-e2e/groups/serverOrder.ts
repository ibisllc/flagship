// Server order + leader acknowledgement (docs/server-order.md) across account
// A's two boxes: the admin-root-signed order lands on .com and on each box,
// /pods carries it, and every box acknowledges it (orderIssuedAt) — then the
// order is reversed and acknowledged again.
import { randomBytes } from "node:crypto";
import { signServerOrder, type ServerOrder } from "@flagship/protocol";
import { pair, pods } from "../lib/fleet.js";
import { CONTROL, assert, http, postJson, short, sleep } from "../lib/harness.js";
import type { Group } from "./types.js";

export const serverOrder: Group = {
  name: "server-order",
  title: "server order on .com + both boxes, leader acknowledgement, reorder",
  needs: ["A1", "A2"],
  phase: 2,
  async run({ A, rec, box }) {
    const b1 = box("A1");
    const b2 = box("A2");
    const stkOf = async (fqdn: string): Promise<string> => {
      const p = (await pods(A.username)).find((x) => x.serverDomain === fqdn);
      const stk = String(p?.identityPubKey ?? "").toLowerCase();
      assert(/^[0-9a-f]{64}$/.test(stk), `no identityPubKey for ${fqdn} in /pods: ${short(p)}`);
      return stk;
    };
    let stk1 = "";
    let stk2 = "";
    const ok = await rec.check("both boxes are in /pods with their STKs", async () => {
      stk1 = await stkOf(b1.fqdn);
      stk2 = await stkOf(b2.fqdn);
      return `${stk1.slice(0, 8)}… ${stk2.slice(0, 8)}…`;
    });
    if (!ok) return;
    const s1 = await pair(A, b1);
    const s2 = await pair(A, b2);
    const mkOrder = (stks: string[]): ServerOrder => ({ user: A.username, stks, issuedAt: Date.now(), nonce: randomBytes(32).toString("hex") });

    await rec.check(".com refuses a server order signed by the owner IRK (admin-pinned)", async () => {
      const order = mkOrder([stk1, stk2]);
      const r = await postJson(`https://${CONTROL}/api/accounts/${A.username}/server-order`, { order, signature: signServerOrder(order, A.keys.irk) });
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });

    const apply = async (stks: string[], label: string): Promise<void> => {
      const order = mkOrder(stks);
      const signature = signServerOrder(order, A.keys.adminRoot);
      await rec.check(`${label}: .com stores the admin-root-signed order`, async () => {
        const r = await postJson(`https://${CONTROL}/api/accounts/${A.username}/server-order`, { order, signature });
        assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
        return "stored";
      });
      await rec.check(`${label}: each box adopts it (POST /api/screens/server-order)`, async () => {
        for (const [b, s] of [[b1, s1], [b2, s2]] as const) {
          const r = await postJson(`https://${b.fqdn}/api/screens/server-order`, { order, signature }, { "x-flagship-session": s });
          assert(r.status === 200 && r.json?.heldIssuedAt === order.issuedAt, `${b.serverName}: ${r.status} ${short(r.text)}`);
        }
        return "both hold it";
      });
      await rec.check(`${label}: /pods carries the order and both boxes acknowledge it (orderIssuedAt)`, async () => {
        const deadline = Date.now() + 6 * 60_000;
        let last = "";
        while (Date.now() < deadline) {
          const r = await http(`https://${CONTROL}/api/users/${A.username}/pods`);
          const held = r.json?.serverOrder?.order ?? r.json?.serverOrder;
          const list = (r.json?.pods ?? []) as Array<{ serverDomain: string; orderIssuedAt?: number }>;
          const acks = [b1, b2].map((b) => list.find((p) => p.serverDomain === b.fqdn)?.orderIssuedAt ?? 0);
          last = `serverOrder.issuedAt=${held?.issuedAt} acks=${acks.join(",")}`;
          if (held?.issuedAt === order.issuedAt && (held?.stks ?? []).join() === stks.join() && acks.every((a) => a >= order.issuedAt)) {
            return `leader ${stks[0] === stk1 ? "home" : "home2"} acknowledged`;
          }
          await sleep(15_000);
        }
        throw new Error(`not acknowledged in 6 min (${last})`);
      });
    };
    await apply([stk1, stk2], "order home, home2");
    await apply([stk2, stk1], "reorder home2, home");
  },
};
