// App access lists (egress): a live app's call to a host nobody approved is
// blocked and becomes an access request (screens events + access-requests),
// the owner approves it with an admin-root-signed list, and the call goes
// through; denying it again closes it. Uses the runtimes group's python app.
import { bytesToHex } from "@noble/hashes/utils";
import { accessListSha256, normalizeAccessList, signAppAccessGrant, withRule, type AppAccessGrant } from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { assert, http, postJson, short, sleep } from "../lib/harness.js";
import { PY_APP } from "./runtimes.js";
import type { Group } from "./types.js";

const HOST = "example.com";

export const accessLists: Group = {
  name: "access-lists",
  title: "egress: blocked call → access request (event) → signed approve → call works → deny",
  needs: ["A1"],
  phase: 2,
  async run({ A, rec, box }) {
    const b = box("A1");
    const session = await pair(A, b);
    const serviceId = `${A.username}--${PY_APP}`;
    const app = `https://${PY_APP}.${b.fqdn}`;
    const s = { "x-flagship-session": session };
    const probe = async () => (await http(`${app}/probe?host=${HOST}`, {}, 30_000)).json;

    const up = await rec.check(`the python app is live (from the runtimes group)`, async () => {
      const r = await http(`${app}/`);
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      return "up";
    });
    if (!up) return;

    const events: string[] = [];
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`wss://${b.fqdn}/api/screens/events?sessionToken=${session}`);
      ws.onmessage = (m) => events.push(String(m.data));
      await new Promise((res) => setTimeout(res, 3000));
    } catch {
      ws = null;
    }

    await rec.check(`a call to ${HOST} nobody approved is blocked`, async () => {
      const p = await probe();
      assert(p?.reached === false, `reached: ${short(p)}`);
      return short(p?.error, 80);
    });
    await rec.check("it shows up as an access request (GET /api/screens/access-requests)", async () => {
      for (let i = 0; i < 12; i++) {
        const r = await http(`https://${b.fqdn}/api/screens/access-requests`, { headers: s });
        const hit = (r.json?.requests ?? []).find((x: { serviceId: string; host?: string }) => x.serviceId === serviceId && x.host === HOST);
        if (hit) return `attempts=${hit.attempts}`;
        await sleep(5000);
      }
      throw new Error("no access request");
    });
    await rec.check("an access-request event reached the screens WebSocket", () => {
      ws?.close();
      assert(events.some((e) => /access-request/.test(e) && e.includes(serviceId)), `events: ${short(events.join(" | "), 200)}`);
      return `${events.length} event(s)`;
    });

    const access = await http(`https://${b.fqdn}/api/screens/services/${encodeURIComponent(serviceId)}/access`, { headers: s });
    const current = normalizeAccessList(String(access.json?.list ?? access.json?.access?.list ?? ""));
    const send = (list: string, signer = A.keys.adminRoot) => {
      const grant: AppAccessGrant = { serverDomain: b.fqdn, serviceId, listSha256: accessListSha256(list), issuedAt: Date.now() };
      return postJson(`https://${b.fqdn}/api/screens/services/${encodeURIComponent(serviceId)}/access`, { list, grant, signature: bytesToHex(signAppAccessGrant(grant, signer)) }, s);
    };
    const allowList = withRule(current, "allow", HOST);
    await rec.check("an access list signed by the owner IRK is refused", async () => {
      const r = await send(allowList, A.keys.irk);
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });
    await rec.check(`approve ${HOST} (admin-root signed list) → the call goes through`, async () => {
      const r = await send(allowList);
      assert(r.status === 200, `approve ${r.status}: ${short(r.text)}`);
      for (let i = 0; i < 12; i++) {
        const p = await probe();
        if (p?.reached) return `status ${p.status}`;
        await sleep(5000);
      }
      throw new Error(`still blocked after approval: ${short(await probe())}`);
    });
    await rec.check(`deny ${HOST} again → blocked again`, async () => {
      await sleep(1100);
      const r = await send(withRule(allowList, "deny", HOST));
      assert(r.status === 200, `deny ${r.status}: ${short(r.text)}`);
      for (let i = 0; i < 12; i++) {
        const p = await probe();
        if (p?.reached === false) return "blocked";
        await sleep(5000);
      }
      throw new Error("still reachable after deny");
    });
  },
};
