// Canary update receipts (architecture v2 V02, docs/runbooks/canary.md) on the gym: `.com` counts a
// well-formed receipt once (a resend is a duplicate), refuses one carrying anything extra, and shows it in the
// operator's view; a box's owner turns sharing on and off from an owner session, and a stranger's session
// cannot. When the `update` group moved a box in this run and the box was sharing, its receipt is in the
// counts. The synthetic release commit is fixed, so the counts it leaves in the gym D1 never look like a
// real release.
import { randomBytes } from "node:crypto";
import { pair } from "../../lib/fleet.js";
import { ADMIN, CONTROL, SkipError, assert, http, postJson, short } from "../../lib/harness.js";
import type { Group } from "../types.js";

const SYNTHETIC = "c0ffee0000000000000000000000000000000c0a";

export const canary: Group = {
  name: "canary",
  title: "update receipts are counted once, carry nothing extra, and only the owner turns them on",
  needs: ["A1", "B1"],
  phase: 2,
  async run({ A, B, rec, box }) {
    const receipt = { format: 1, release: SYNTHETIC, cohort: "1", healthGate: "fail", rolledBack: true, arch: "amd64", stack: "classic", nonce: randomBytes(16).toString("hex") };
    const report = async () => {
      if (!ADMIN) throw new SkipError("no GYM_ADMIN_SECRET in this run");
      const r = await http(`https://${CONTROL}/api/admin/canary?days=2&release=${SYNTHETIC}`, { headers: { "x-admin-secret": ADMIN } });
      assert(r.status === 200, `canary report ${r.status}: ${short(r.text)}`);
      return (r.json?.releases?.[0]?.totals ?? { passed: 0, rolledBack: 0, stuck: 0 }) as { rolledBack: number };
    };
    await rec.check(".com counts a receipt once and shows it to the operator", async () => {
      const before = (await report()).rolledBack;
      const first = await postJson(`https://${CONTROL}/api/update-receipts`, receipt);
      assert(first.status === 202, `first ${first.status}: ${short(first.text)}`);
      const again = await postJson(`https://${CONTROL}/api/update-receipts`, receipt);
      assert(again.status === 200 && again.json?.duplicate === true, `resend ${again.status}: ${short(again.text)}`);
      const after = (await report()).rolledBack;
      assert(after === before + 1, `rolled back ${before} -> ${after}`);
      return `rolled back ${before} -> ${after}`;
    });
    await rec.check(".com refuses a receipt that carries anything extra", async () => {
      for (const extra of [{ server: box("A1").fqdn }, { username: A.username }, { previousCommit: SYNTHETIC }]) {
        const r = await postJson(`https://${CONTROL}/api/update-receipts`, { ...receipt, nonce: randomBytes(16).toString("hex"), ...extra });
        assert(r.status === 400, `${Object.keys(extra)[0]}: ${r.status}`);
      }
      return "400 for server, username, previousCommit";
    });
    await rec.check("the owner turns sharing on and off; another account's session cannot", async () => {
      const b = box("A1");
      const s = { "x-flagship-session": await pair(A, b) };
      const url = `https://${b.fqdn}/api/update-reports`;
      const start = await http(url, { headers: s });
      if (start.status === 404) throw new SkipError("this box's release has no /api/update-reports");
      assert(start.status === 200 && typeof start.json?.share === "boolean", `get ${start.status}: ${short(start.text)}`);
      const was = start.json.share as boolean;
      try {
        const on = await postJson(url, { share: !was }, s);
        assert(on.status === 200, `set ${on.status}: ${short(on.text)}`);
        assert((await http(url, { headers: s })).json?.share === !was, "the choice did not stick");
        if (B) {
          const other = { "x-flagship-session": await pair(B, box("B1")) };
          const r = await postJson(url, { share: was }, other);
          assert(r.status === 401 || r.status === 403, `another account's session: ${r.status}`);
        }
        const anon = await postJson(url, { share: was });
        assert(anon.status === 401 || anon.status === 403, `no session: ${anon.status}`);
      } finally {
        await postJson(url, { share: was }, s);
      }
      return `share ${was} -> ${!was} -> ${was}`;
    });
  },
};
