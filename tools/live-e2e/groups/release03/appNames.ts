// App names get a certificate on every server (0.3): once a box holds the admin's server-wildcard
// grant (the demo and gym bootstrap mint it at install), its apps certificate also names
// `*.<user>.<apex>` (plan H9: the control name has a certificate of its own), so the app's canonical `<app>.<user>` address serves over valid TLS from whichever
// of the account's boxes the relay routes it to. Needs gossip, so the account's gossip key is deposited
// first (lib/cgk.ts, as on feat/UX).
import { depositCgk, waitGossiping } from "../../lib/cgk.js";
import { expectedIssuer } from "../../lib/acmeCa.js";
import { SERVICES, assert, certInfo, tryHttp } from "../../lib/harness.js";
import { installWhoami } from "../gating.js";
import type { Group } from "../types.js";
import { uninstall, until } from "./util.js";

export const appNames: Group = {
  name: "app-names",
  title: "each box's apps certificate names *.<user>; <app>.<user> serves over valid TLS from the box that holds it",
  needs: ["A1", "A2"],
  phase: 8,
  parallel: false,
  async run({ A, rec, box }) {
    const b1 = box("A1");
    const b2 = box("A2");
    const account = `*.${A.username}.${SERVICES}`;

    // Plan H9: the box's own name has a control certificate of exactly that name; the account wildcard lives on the
    // apps certificate, checked below on the app's canonical address (the relay routes only names a box serves).
    for (const b of [b1, b2]) {
      await rec.check(`${b.serverName}'s control certificate names exactly ${b.fqdn}`, () => {
        const c = certInfo(b.fqdn);
        assert(c.sans.length === 1 && c.sans[0] === b.fqdn, `sans=${c.sans.join(",")}`);
        assert(expectedIssuer().test(c.issuer), `issuer=${c.issuer} (expected ${expectedIssuer()})`);
        return c.sans.join(", ");
      });
    }

    const gossiping = await rec.check("both servers gossip (the account's gossip key deposited)", async () => {
      if (!(await waitGossiping([b1, b2], 30_000))) {
        await depositCgk(A, [b1, b2]);
        assert(await waitGossiping([b1, b2]), "a box never reported gossipActive after the deposit");
      }
      return "gossipActive on both";
    });
    if (!gossiping) return;

    const slug = "appname";
    const canonical = `${slug}.${A.username}.${SERVICES}`;
    const installed = await rec.check("the app runs on home only", async () => {
      await installWhoami(A, b1, slug, { enabled: true, public_routes: ["/*"] });
      return slug;
    });
    if (!installed) return;
    await rec.check(`https://${canonical}/ answers over valid TLS (a plain fetch verifies the certificate)`, async () => {
      const r = await until("the canonical address", 8 * 60_000, async () => {
        const x = await tryHttp(`https://${canonical}/`, {}, 15_000);
        return x.status === 200 ? x : undefined;
      }, 15_000);
      return `${r.status}, ${r.text.length} B`;
    });
    await rec.check(`the certificate served for ${canonical} is home's apps certificate, naming ${account}`, () => {
      const c = certInfo(canonical);
      assert(c.sans.includes(account) && c.sans.includes(`*.${b1.fqdn}`) && !c.sans.includes(b1.fqdn), `sans=${c.sans.join(",")}`);
      return c.sans.join(", ");
    });
    await uninstall(A, b1, slug);
  },
};
