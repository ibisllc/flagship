// App copy between account A's two boxes (docs/app-placement.md): the
// admin-root-signed app-copy/v1 grant goes to the target, the target pulls the
// python app (code, Postgres dump, files) from the source, and the copy serves
// the same data; then the copy is uninstalled with the signed uninstall.
import { bytesToHex } from "@noble/hashes/utils";
import { spawnSync } from "node:child_process";
import { hexToBytes } from "@noble/hashes/utils";
import { checkLanHint, signAppCopyGrant, signUninstallService, type AppCopyGrant, type LanHint, type UninstallServiceRequest } from "@flagship/protocol";
import { pair, pods } from "../lib/fleet.js";
import { assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { PY_APP } from "./runtimes.js";
import type { Group } from "./types.js";

export const appCopy: Group = {
  name: "app-copy",
  title: "copy the python app home → home2 (code + Postgres + files), then uninstall the copy",
  needs: ["A1", "A2"],
  phase: 3,
  async run({ A, rec, box }) {
    const src = box("A1");
    const dst = box("A2");
    const serviceId = `${A.username}--${PY_APP}`;
    const dstSession = await pair(A, dst);
    const s = { "x-flagship-session": dstSession };
    const before = await http(`https://${PY_APP}.${src.fqdn}/read`).catch(() => null);
    if (!(await rec.check("the source app holds data to copy", () => {
      assert(before?.status === 200 && before.json?.file, `source /read ${before?.status}: ${short(before?.text)}`);
      return short(before!.json, 100);
    }))) return;

    let lanOffered = false;
    await rec.check("LAN-direct: the source's lan-hint is signed by its server key and names only LAN endpoints (or there are none: 204)", async () => {
      const srcSession = await pair(A, src);
      const r = await http(`https://${src.fqdn}/api/screens/lan-hint`, { headers: { "x-flagship-session": srcSession } });
      if (r.status === 204) return "204: no LAN address on this host";
      assert(r.status === 200 && r.json?.hint && r.json?.signatureHex, `lan-hint ${r.status}: ${short(r.text)}`);
      const stk = String((await pods(A.username)).find((p) => p.serverDomain === src.fqdn)?.identityPubKey ?? "");
      assert(/^[0-9a-f]{64}$/i.test(stk), "no identityPubKey on /pods");
      const der = spawnSync("bash", ["-c", `echo | openssl s_client -connect ${src.fqdn}:443 -servername ${src.fqdn} 2>/dev/null | openssl x509 -outform DER 2>/dev/null | openssl dgst -sha256 -hex`], { encoding: "utf8", timeout: 25_000 });
      const certSha256 = (/([0-9a-f]{64})\s*$/.exec(der.stdout.trim()) || [])[1] ?? "";
      const hint = r.json.hint as LanHint;
      const v = checkLanHint(hint, hexToBytes(r.json.signatureHex), hexToBytes(stk), { serverDomain: src.fqdn, certSha256, now: Date.now() });
      assert(v.ok, `checkLanHint: ${short(v)} (cert ${certSha256.slice(0, 12)} vs ${String(hint.certSha256).slice(0, 12)})`);
      const forged = checkLanHint({ ...hint, endpoints: [{ address: "10.9.9.9", port: 443 }] }, hexToBytes(r.json.signatureHex), hexToBytes(stk), { serverDomain: src.fqdn, certSha256, now: Date.now() });
      assert(!forged.ok, "an altered hint verified");
      const bridges = hint.endpoints.filter((e) => e.address.startsWith("172."));
      assert(!bridges.length, `the hint offers a container bridge: ${bridges.map((e) => e.address).join(", ")}`);
      lanOffered = hint.endpoints.length > 0;
      return `${hint.endpoints.map((e) => `${e.address}:${e.port}`).join(", ")} — signature ok, altered hint refused`;
    });

    const grantFor = (): AppCopyGrant => ({ sourceServer: src.fqdn, targetServer: dst.fqdn, serviceId, issuedAt: Date.now() });
    await rec.check("a copy grant signed by the owner IRK is refused", async () => {
      const g = grantFor();
      const r = await postJson(`https://${dst.fqdn}/api/screens/services/copy`, { grant: g, signature: bytesToHex(signAppCopyGrant(g, A.keys.irk)) }, s);
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });
    let copyId = "";
    const started = await rec.check("the target accepts the admin-root-signed copy (202)", async () => {
      const g = grantFor();
      const r = await postJson(`https://${dst.fqdn}/api/screens/services/copy`, { grant: g, signature: bytesToHex(signAppCopyGrant(g, A.keys.adminRoot)) }, s);
      assert(r.status === 202 && r.json?.copyId, `${r.status}: ${short(r.text)}`);
      copyId = r.json.copyId;
      return copyId;
    });
    if (!started) return;
    const done = await rec.check("the copy finishes (copying → installing → done)", async () => {
      const deadline = Date.now() + 20 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const r = await http(`https://${dst.fqdn}/api/screens/services/copies`, { headers: s });
        const c = (r.json?.copies ?? []).find((x: { copyId: string }) => x.copyId === copyId);
        last = short(c, 200);
        if (c?.state === "done") {
          assert(c.route === "lan" || c.route === "relay", `route=${c.route}`);
          // Both boxes sit on the provider's private network: the copy should take it.
          assert(!lanOffered || c.route === "lan", `the source offered a LAN endpoint but the copy went via ${c.route}`);
          return `done via ${c.route}`;
        }
        if (c?.state === "failed") throw new Error(`copy failed: ${c.reason}`);
        await sleep(15_000);
      }
      throw new Error(`not done in 20 min: ${last}`);
    });
    if (!done) return;
    await rec.check("the copy on home2 serves the same Postgres rows and file", async () => {
      let r = await tryHttp(`https://${PY_APP}.${dst.fqdn}/read`);
      for (let i = 0; i < 24 && r.status !== 200; i++) {
        await sleep(5000);
        r = await tryHttp(`https://${PY_APP}.${dst.fqdn}/read`);
      }
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      assert(r.json.file === before!.json.file && JSON.stringify(r.json.rows) === JSON.stringify(before!.json.rows), `copy ${short(r.json)} vs source ${short(before!.json)}`);
      return short(r.json, 100);
    });
    await rec.check("uninstall the copy on home2 (owner-IRK signed) → gone", async () => {
      const req: UninstallServiceRequest = { serverId: dst.fqdn, creator: A.username, slug: PY_APP, issuedAt: Date.now() };
      const r = await http(`https://${dst.fqdn}/api/services/${encodeURIComponent(serviceId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: req, signature: bytesToHex(signUninstallService(req, A.keys.adminRoot)) }),
      }, 120_000);
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      const list = await http(`https://${dst.fqdn}/api/services`);
      assert(!list.text.includes(serviceId), "still listed");
      return "uninstalled";
    });
  },
};
