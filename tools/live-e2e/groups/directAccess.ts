// Direct access (docs/direct-access-and-domains.md §7-§8) on a gym box with a public IPv6 address: the owner's
// admin-root-signed direct-access order to the box, the box's signed address update reaching `.com`, the owner's
// name order for `<slug>--<user>.<direct apex>`, the box's own certificate for that name, the AAAA record `.com`
// publishes, an HTTPS request from outside over IPv6 answered by the box itself (not the relay), `.com`'s outside
// probe, and the withdrawal when the name and then direct access are turned off.
//
// The direct apex comes from `.com` (`GET /api/accounts/<u>/direct-access` → `apex`): production's is `fshp.app`,
// the gym's is its own name under the gym's zone, so the gym never writes into the production direct zone.
//
// The outside client is this machine when it has IPv6, else (or with GYM_DIRECT_OUTSIDE=vm) a small throwaway
// UpCloud VM with a public IPv6 address, destroyed at the end.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils";
import {
  canonicalIp,
  signDirectAccessOrder,
  signDirectNameOrder,
  type DirectAccessOrder,
  type DirectNameOrder,
} from "@flagship/protocol";
import { accountReadHeaders } from "../readToken.js";
import { addBox, pair, waitOnline, type Box } from "../lib/fleet.js";
import { CONTROL, assert, http, postJson, short, sleep } from "../lib/harness.js";
import { createDebianVm, destroyVm, serverAddresses, ssh, type Vm } from "../lib/upcloudVm.js";
import { installWhoami } from "./gating.js";
import type { Group } from "./types.js";

const SLUG = "dirhello";

interface Outside {
  where: string;
  /** Runs a shell command on the outside client. */
  sh(cmd: string, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
}

function localSh(cmd: string, timeoutMs = 60_000) {
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout: timeoutMs });
  return Promise.resolve({ code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
}

async function outsideClient(dir: string, log: (s: string) => void): Promise<Outside> {
  const forceVm = process.env.GYM_DIRECT_OUTSIDE === "vm";
  if (!forceVm) {
    const probe = await localSh("curl -6 -sS --max-time 10 -o /dev/null -w '%{http_code}' https://www.google.com/", 20_000);
    if (probe.code === 0 && probe.stdout.trim() === "200") return { where: "this machine (its own IPv6)", sh: localSh, close: async () => {} };
    log("this machine has no working IPv6; using a throwaway UpCloud VM as the outside client");
  }
  const vm: Vm = await createDebianVm({ dir: join(dir, "direct-outside-vm"), title: `gym-direct-outside-${Date.now().toString(36)}`, plan: "1xCPU-1GB", diskGb: 10, ipv6: true, log });
  const v6 = (await serverAddresses(vm.uuid)).publicV6[0] ?? "?";
  return { where: `UpCloud VM ${vm.uuid} (IPv6 ${v6})`, sh: (cmd, t) => ssh(vm, cmd, t), close: () => destroyVm(vm, log) };
}

/** The zone's authoritative name servers answer without any resolver cache (the zone's negative TTL is long). */
async function authoritative(name: string, type: "A" | "AAAA" | "CAA"): Promise<string[]> {
  const zone = name.split(".").slice(-2).join(".");
  const ns = (await localSh(`dig +short NS ${zone} | head -1`)).stdout.trim();
  assert(ns, `no NS for ${zone}`);
  const out = (await localSh(`dig +short +norecurse @${ns} ${type} ${name}`)).stdout.trim();
  return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export const directAccess: Group = {
  name: "direct-access",
  title: "direct access on an IPv6 box: signed order, address update, direct name, its own certificate, outside HTTPS over IPv6, withdrawal",
  needs: ["A1"],
  phase: 1,
  async run({ A, rec, dir, adopt }) {
    const u = A.username;
    const readHeaders = () => accountReadHeaders(CONTROL, u, A.keys.irk);
    const view = async (): Promise<any> => {
      const r = await http(`https://${CONTROL}/api/accounts/${u}/direct-access`, { headers: await readHeaders() });
      assert(r.status === 200, `direct-access view ${r.status}: ${short(r.text)}`);
      return r.json;
    };

    let box: Box | undefined;
    const made = await rec.check("a gym box with a public IPv6 address comes online", async () => {
      box = await addBox(A, "direct6", { provisionExtras: { ipv6: true } });
      adopt(A, box);
      if (!box.ipv6 && box.serverId) box.ipv6 = (await serverAddresses(box.serverId)).publicV6[0] ?? null;
      assert(box.ipv6, "UpCloud gave the box no public IPv6 address");
      const r = await waitOnline(box, 25, (m) => rec.log(m));
      return `${box.fqdn} ${box.ipv6} (${r})`;
    });
    if (!made || !box) return;
    const b = box;
    // UpCloud spells addresses with leading zeros (…:0fd5); orders, the box and DNS use RFC 5952 text.
    const v6 = canonicalIp(b.ipv6!) ?? b.ipv6!;
    const session = { "x-flagship-session": await pair(A, b) };

    const sees = await rec.check("the box sees the IPv6 address on its own interface (direct-access view endpoints)", async () => {
      let v: any = null;
      for (let i = 0; i < 18; i++) {
        const r = await http(`https://${b.fqdn}/api/screens/direct-access`, { headers: session });
        assert(r.status === 200, `view ${r.status}: ${short(r.text)}`);
        v = r.json;
        if ((v.endpoints ?? []).some((e: { address: string }) => e.address === v6)) return short(v.endpoints);
        await sleep(10_000);
      }
      throw new Error(`the box lists ${short(v?.endpoints)}, not ${v6}`);
    });
    if (!sees) return;

    const installed = await rec.check(`the app ${SLUG} runs on the box, open to visitors`, async () => {
      await installWhoami(A, b, SLUG, { enabled: true, public_routes: ["/*"] });
      return `${u}--${SLUG}`;
    });
    if (!installed) return;

    const accessOrder = (enabled: boolean): DirectAccessOrder => ({
      serverDomain: b.fqdn,
      enabled,
      addresses: enabled ? [v6] : [],
      prefixes: [],
      port: 443,
      issuedAt: Date.now(),
    });
    // The apps send the order to the box, then to `.com` (webapp views/direct-access.js).
    const sendAccess = async (o: DirectAccessOrder, key = A.keys.adminRoot) => {
      const signed = { order: o, signatureHex: bytesToHex(signDirectAccessOrder(o, key)) };
      const toBox = await postJson(`https://${b.fqdn}/api/screens/direct-access`, signed, session);
      const toCom = toBox.status === 200 ? await postJson(`https://${CONTROL}/api/accounts/${u}/direct-access`, signed) : null;
      return { toBox, toCom };
    };

    await rec.check("an order signed with the owner IRK is refused by the box (admin-pinned account)", async () => {
      const { toBox } = await sendAccess(accessOrder(true), A.keys.irk);
      assert(toBox.status === 403 || toBox.status === 401, `expected a refusal, got ${toBox.status}: ${short(toBox.text)}`);
      return `${toBox.status} ${toBox.json?.code ?? ""}`;
    });

    const on = await rec.check("the admin-root-signed direct-access order is taken by the box and by .com", async () => {
      const { toBox, toCom } = await sendAccess(accessOrder(true));
      assert(toBox.status === 200 && toBox.json?.directAccess?.on === true, `box ${toBox.status}: ${short(toBox.text)}`);
      assert(toCom && (toCom.status === 200 || (toCom.status === 409 && toCom.json?.code === "replayed")), `.com ${toCom?.status}: ${short(toCom?.text)}`);
      return `box ${toBox.status}, .com ${toCom.status}`;
    });
    if (!on) return;

    const reported = await rec.check("the box's signed address update reaches .com (boxAddresses lists the IPv6)", async () => {
      let s: any = null;
      for (let i = 0; i < 40; i++) {
        s = ((await view()).servers ?? []).find((x: any) => x.serverDomain === b.fqdn);
        if (s?.on && (s.boxAddresses ?? []).includes(v6)) return short(s);
        await sleep(15_000);
      }
      throw new Error(`.com holds ${short(s)}`);
    });
    if (!reported) return;

    const apex: string = String((await view()).apex ?? "");
    const name = `${SLUG}--${u}.${apex}`;
    const label = `${SLUG}--${u}`;
    rec.log(`direct apex ${apex}; name ${name}`);
    await rec.check("the gym's direct apex is not production's fshp.app", async () => {
      assert(apex && apex !== "fshp.app" && !apex.endsWith(".fshp.app"), `the gym .com names ${apex}: it would publish into production's zone`);
      return apex;
    });
    if (!apex || apex === "fshp.app" || apex.endsWith(".fshp.app")) return;

    const nameOrder = (enabled: boolean): DirectNameOrder => ({ name, serverDomain: b.fqdn, enabled, addresses: [], caa: "pin", issuedAt: Date.now() });
    const sendName = (o: DirectNameOrder) =>
      postJson(`https://${CONTROL}/api/accounts/${u}/direct-names`, { order: o, signatureHex: bytesToHex(signDirectNameOrder(o, A.keys.adminRoot, apex)) });

    const named = await rec.check("the owner's name order is taken by .com", async () => {
      const r = await sendName(nameOrder(true));
      assert(r.status === 200, `direct-names ${r.status}: ${short(r.text)}`);
      return r.json?.name ?? name;
    });
    if (!named) return;

    const nameRow = async () => ((await view()).names ?? []).find((n: any) => n.name === name);
    const published = await rec.check("the box gets its own certificate for the name and .com publishes exactly an AAAA to the box (+ CAA)", async () => {
      let n: any = null;
      for (let i = 0; i < 60; i++) {
        n = await nameRow();
        if (n?.certificate && n.state === "published") break;
        await sleep(15_000);
      }
      assert(n?.certificate, `no certificate after 15 min: ${short(n, 400)}`);
      assert(n.state === "published", `state ${n.state} reason ${n.reason} error ${n.error}`);
      const recs = (n.published ?? []) as Array<{ type: string; content: string }>;
      assert(recs.some((r) => r.type === "AAAA" && r.content === v6), `published ${short(recs)}`);
      assert(!recs.some((r) => r.type === "A"), `an A record was published: ${short(recs)}`);
      return `cert until ${new Date(n.certificate.notAfter).toISOString()}; ${recs.map((r) => `${r.type} ${r.content}`).join("; ")}`;
    });
    if (!published) return;

    await rec.check("the zone's own name servers answer AAAA = the box, no A, CAA pinned to the issuance account", async () => {
      const aaaa = await authoritative(name, "AAAA");
      const a = await authoritative(name, "A");
      const caa = await authoritative(name, "CAA");
      assert(aaaa.length === 1 && aaaa[0] === v6, `AAAA ${short(aaaa)}`);
      assert(a.length === 0, `A ${short(a)}`);
      assert(caa.some((c) => /issue "letsencrypt\.org; ?accounturi=/.test(c)) && caa.some((c) => /issuewild ";"/.test(c)), `CAA ${short(caa)}`);
      return `AAAA ${aaaa[0]}; ${caa.join(" | ")}`;
    });

    let outside: Outside | null = null;
    try {
      await rec.check("from outside, over IPv6, HTTPS to the direct name is answered by the box with its own certificate", async () => {
        outside = await outsideClient(dir, (m) => rec.log(m));
        // Resolve through the client's own resolver: a fresh name, so no negative answer can be cached for it.
        let got = { code: 1, stdout: "", stderr: "" };
        for (let i = 0; i < 12; i++) {
          got = await outside.sh(`curl -6 -sS --max-time 20 -o /tmp/direct-body -w '%{http_code} %{remote_ip} %{ssl_verify_result}' https://${name}/; echo; head -c 300 /tmp/direct-body`, 60_000);
          if (got.code === 0 && got.stdout.startsWith("200 ")) break;
          await sleep(10_000);
        }
        const [status, remoteIp, verify] = got.stdout.split("\n")[0]!.split(" ");
        assert(status === "200", `curl: ${short(got.stdout + got.stderr, 300)}`);
        assert(remoteIp === v6, `answered from ${remoteIp}, not the box's ${v6}`);
        assert(verify === "0", `certificate not verified (${verify})`);
        assert(/Hostname: /.test(got.stdout), `not the app's answer: ${short(got.stdout, 200)}`);
        const cert = await outside.sh(`echo | openssl s_client -connect [${v6}]:443 -servername ${name} 2>/dev/null | openssl x509 -noout -issuer -ext subjectAltName 2>/dev/null`, 40_000);
        const issuer = (/issuer=(.*)/.exec(cert.stdout) ?? [])[1]?.trim() ?? "";
        const sans = [...cert.stdout.matchAll(/DNS:([^,\s]+)/g)].map((m) => m[1]!);
        assert(sans.length === 1 && sans[0] === name, `SANs ${short(sans)}`);
        assert(issuer, `no issuer: ${short(cert.stdout + cert.stderr)}`);
        return `from ${outside.where}: 200 from ${remoteIp}, verified; issuer ${issuer}; SAN ${sans.join(",")}`;
      });

      await rec.check("the relay does not serve the direct name (the box refuses it on the tunnel)", async () => {
        const relay = (await localSh(`dig +short A ${b.fqdn} | tail -1`)).stdout.trim();
        assert(relay && relay !== v6, `no relay address for ${b.fqdn}`);
        const r = await localSh(`echo | openssl s_client -connect ${relay}:443 -servername ${name} 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null`, 40_000);
        assert(!r.stdout.includes(name), `the relay path presented a certificate for ${name}`);
        return `relay ${relay}: no certificate for the name`;
      });

      await rec.check(".com's outside probe reaches the name", async () => {
        const r = await http(`https://${CONTROL}/api/accounts/${u}/direct-names/${label}/probe`, { method: "POST", headers: await readHeaders() }, 60_000);
        assert(r.status === 200, `probe ${r.status}: ${short(r.text)}`);
        assert(r.json?.reachable === true && r.json?.https?.ok === true, `probe ${short(r.json, 300)}`);
        return `reachable, ${r.json.https.status ?? ""}`;
      });

      const nameOff = await rec.check("turning the name off withdraws its records (.com state and the zone's name servers)", async () => {
        const r = await sendName(nameOrder(false));
        assert(r.status === 200, `off ${r.status}: ${short(r.text)}`);
        let n: any = null;
        for (let i = 0; i < 24; i++) {
          n = await nameRow();
          if (n && n.state === "empty" && (n.published ?? []).length === 0) break;
          await sleep(10_000);
        }
        assert(n?.state === "empty", `state ${short(n, 300)}`);
        const left = [...(await authoritative(name, "AAAA")), ...(await authoritative(name, "CAA"))];
        assert(left.length === 0, `the zone still holds ${short(left)}`);
        return `state ${n.state} (${n.reason}); zone empty at the name`;
      });

      if (nameOff) {
        await rec.check("turning direct access off: the name (back on) gets no records, and the box stops listening on its IPv6", async () => {
          const back = await sendName(nameOrder(true));
          assert(back.status === 200, `name on ${back.status}: ${short(back.text)}`);
          const { toBox, toCom } = await sendAccess(accessOrder(false));
          assert(toBox.status === 200 && toBox.json?.directAccess?.on === false, `box ${toBox.status}: ${short(toBox.text)}`);
          assert(toCom?.status === 200, `.com ${toCom?.status}: ${short(toCom?.text)}`);
          let n: any = null;
          for (let i = 0; i < 24; i++) {
            n = await nameRow();
            if (n && n.state === "empty" && n.reason === "direct-access-off") break;
            await sleep(10_000);
          }
          assert(n?.state === "empty" && n.reason === "direct-access-off", `name ${short(n, 300)}`);
          assert((await authoritative(name, "AAAA")).length === 0, "an AAAA came back");
          const tcp = await outside!.sh(`curl -6 -sS -k --max-time 10 -o /dev/null -w '%{http_code}' --resolve ${name}:443:[${v6}] https://${name}/`, 30_000);
          assert(tcp.code !== 0, `the box still answered on its IPv6: ${short(tcp.stdout)}`);
          return `name ${n.state} (${n.reason}); box: ${short(tcp.stderr.trim(), 100)}`;
        });
      }
    } finally {
      const o = outside as Outside | null;
      if (o) await o.close().catch((e) => rec.log(`outside client close: ${String(e)}`));
    }

    await rec.check("cleanup: the name is off on .com (the box goes with the fleet teardown)", async () => {
      const r = await sendName(nameOrder(false));
      assert(r.status === 200 || (r.status === 409 && r.json?.code === "replayed"), `off ${r.status}: ${short(r.text)}`);
      return String(r.status);
    });
  },
};

