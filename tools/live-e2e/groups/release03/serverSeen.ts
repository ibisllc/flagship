// Studio's automatic confirmation (first contact, 0.3): Studio posts the key a hosted VM showed and its MAC
// to `/api/order/<serial>/server-seen`; .com keeps a few beside the order's status, where the phone reads
// them. .com cannot check the MAC, only its shape; the phone does.
import { randomBytes } from "node:crypto";
import { CONTROL, SkipError, assert, http, postJson, short } from "../../lib/harness.js";
import type { Group } from "../types.js";

export const serverSeen: Group = {
  name: "server-seen",
  title: "Studio's report of a hosted VM's key is kept beside the order status (a few at most, shape-checked)",
  needs: ["A2"],
  phase: 1,
  async run({ rec, box }) {
    const serial = box("A2").serial;
    const stk = randomBytes(32).toString("hex");
    const mac = randomBytes(32).toString("hex");
    await rec.check("a report is accepted and comes back in the order status", async () => {
      if (!serial) throw new SkipError("the box has no auth-code serial (not gym-provisioned)");
      const r = await postJson(`https://${CONTROL}/api/order/${serial}/server-seen`, { stkPubHex: stk, macHex: mac });
      assert(r.status === 200, `post ${r.status}: ${short(r.text)}`);
      const st = await http(`https://${CONTROL}/api/order/${serial}/status`);
      const seen = (st.json?.serverSeen ?? []) as Array<{ stkPubHex: string; macHex: string }>;
      assert(seen.some((e) => e.stkPubHex === stk && e.macHex === mac), `status serverSeen ${short(seen)}`);
      return `${seen.length} kept`;
    });
    await rec.check("at most four are kept, the newest last", async () => {
      if (!serial) throw new SkipError("no serial");
      let last = "";
      for (let i = 0; i < 6; i++) {
        last = randomBytes(32).toString("hex");
        await postJson(`https://${CONTROL}/api/order/${serial}/server-seen`, { stkPubHex: stk, macHex: last });
      }
      const seen = ((await http(`https://${CONTROL}/api/order/${serial}/status`)).json?.serverSeen ?? []) as Array<{ macHex: string }>;
      assert(seen.length === 4 && seen.at(-1)?.macHex === last, `kept ${seen.length}, last ${seen.at(-1)?.macHex}`);
      return "4, newest last";
    });
    await rec.check("a malformed report and an unknown order are refused", async () => {
      const bad = await postJson(`https://${CONTROL}/api/order/${serial ?? "FS-NOPE-0000"}/server-seen`, { stkPubHex: "AB".repeat(32), macHex: mac });
      assert(bad.status === 400, `malformed got ${bad.status}`);
      const none = await postJson(`https://${CONTROL}/api/order/FS-GYM-${randomBytes(4).toString("hex")}/server-seen`, { stkPubHex: stk, macHex: mac });
      assert(none.status === 404, `unknown order got ${none.status}`);
      return "400 and 404";
    });
  },
};
