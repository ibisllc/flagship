// A box's outbound proxy on the gym (docs/outbound-proxy.md; "Failure handling", owner rule 2026-11-17). A small
// SOCKS5 server with a username and password runs on a throwaway UpCloud VM and logs every CONNECT. The real account
// R (made Pro with gym vouchers) points its box R1 at it; the box's traffic then really leaves through the VM. The
// proxy is killed: with `fallbackDirect` the box goes direct, stays reachable and is alerted (Activity, `/pods`).
// Then the same proxy without the fallback is killed again: the box goes offline and alerts through the lane; the
// owner's "turn it off" order, left at `.com` (never with a password), reaches the box and brings it back. A Free
// account's box refuses a proxy (pro-required).
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed, signBoxProxy, type BoxProxy, type Keypair } from "@flagship/protocol";
import { pair, pods } from "../lib/fleet.js";
import { CONTROL, assert, http, postJson, short, sleep } from "../lib/harness.js";
import { ensurePro, primaryDevice } from "../lib/payments.js";
import { createDebianVm, destroyVm, scp, ssh, type Vm } from "../lib/upcloudVm.js";
import type { Group } from "./types.js";

const SOCKS_PORT = 1080;

/** RFC 1928 + RFC 1929 (username/password), CONNECT only; one line per connection in /root/socks.log. */
const SOCKS_PY = String.raw`
import asyncio, socket, struct, sys, time
USER, PASS = sys.argv[1], sys.argv[2]
LOG = open('/root/socks.log', 'a', buffering=1)
def log(s): LOG.write(f"{int(time.time())} {s}\n")
async def pipe(r, w):
    try:
        while True:
            d = await r.read(65536)
            if not d: break
            w.write(d); await w.drain()
    except Exception: pass
    finally:
        try: w.close()
        except Exception: pass
async def handle(r, w):
    peer = (w.get_extra_info('peername') or ['?'])[0]
    try:
        ver, n = await r.readexactly(2)
        methods = await r.readexactly(n)
        if 2 not in methods:
            w.write(b'\x05\xff'); await w.drain(); w.close(); log(f"{peer} NO-AUTH-METHOD"); return
        w.write(b'\x05\x02'); await w.drain()
        _, ul = await r.readexactly(2); u = await r.readexactly(ul)
        pl = (await r.readexactly(1))[0]; p = await r.readexactly(pl)
        if u.decode() != USER or p.decode() != PASS:
            w.write(b'\x01\x01'); await w.drain(); w.close(); log(f"{peer} AUTH-REFUSED"); return
        w.write(b'\x01\x00'); await w.drain()
        _, cmd, _, atyp = await r.readexactly(4)
        if atyp == 1: host = socket.inet_ntoa(await r.readexactly(4))
        elif atyp == 3: l = (await r.readexactly(1))[0]; host = (await r.readexactly(l)).decode()
        elif atyp == 4: host = socket.inet_ntop(socket.AF_INET6, await r.readexactly(16))
        else: w.close(); return
        port = struct.unpack('>H', await r.readexactly(2))[0]
        if cmd != 1:
            w.write(b'\x05\x07\x00\x01' + b'\x00' * 6); await w.drain(); w.close(); return
        try:
            ur, uw = await asyncio.wait_for(asyncio.open_connection(host, port), 15)
        except Exception:
            w.write(b'\x05\x05\x00\x01' + b'\x00' * 6); await w.drain(); w.close(); log(f"{peer} FAIL {host}:{port}"); return
        log(f"{peer} CONNECT {host}:{port}")
        w.write(b'\x05\x00\x00\x01' + b'\x00' * 6); await w.drain()
        await asyncio.gather(pipe(r, uw), pipe(ur, w))
    except Exception:
        try: w.close()
        except Exception: pass
async def main():
    s = await asyncio.start_server(handle, '0.0.0.0', ${SOCKS_PORT})
    async with s: await s.serve_forever()
asyncio.run(main())
`;

export const outboundProxy: Group = {
  name: "outbound-proxy",
  title: "outbound proxy: a Pro box's traffic through a SOCKS5 VM; proxy down → alert + direct fallback; proxy down without fallback → the fix-it order through the .com lane; a Free account refused",
  needs: ["A1", "R1"],
  phase: 3,
  async run({ A, R, rec, box, dir }) {
    const acct = R!;
    const b = box("R1");
    const domain = b.fqdn.toLowerCase();
    const sR = { "x-flagship-session": await pair(acct, b) };
    const user = `gym${randomBytes(3).toString("hex")}`;
    const pass = randomBytes(16).toString("hex");
    const order = (signer: Keypair, p: Omit<BoxProxy, "serverDomain" | "issuedAt" | "nonce">, serverDomain = domain) => {
      const proxy: BoxProxy = { serverDomain, ...p, issuedAt: Date.now(), nonce: randomBytes(32).toString("hex") };
      return { proxy, signature: signBoxProxy(proxy, signer) };
    };
    const summary = async () => http(`https://${b.fqdn}/api/screens/outbound-proxy`, { headers: sR }, 20_000).catch(() => ({ status: 0, json: null, text: "" }) as never);
    const waitFor = async (what: string, ms: number, f: () => Promise<string | null>) => {
      const deadline = Date.now() + ms;
      let last = "";
      while (Date.now() < deadline) {
        const got = await f().catch((e: Error) => {
          last = e.message;
          return null;
        });
        if (got) return got;
        await sleep(8000);
      }
      throw new Error(`${what}: not within ${ms / 1000} s (${short(last)})`);
    };
    const alertOf = async () => (await pods(acct.username)).find((p) => p.serverDomain === domain)?.proxyAlert ?? null;

    await rec.check("a Free account's box refuses a proxy: 403 pro-required", async () => {
      const a1 = box("A1");
      const sA = { "x-flagship-session": await pair(A, a1) };
      const r = await postJson(
        `https://${a1.fqdn}/api/screens/outbound-proxy`,
        order(A.keys.adminRoot, { kind: "socks5", host: "192.0.2.1", port: 1080, auth: false, fallbackDirect: true }, a1.fqdn.toLowerCase()),
        sA,
        60_000,
      );
      assert(r.status === 403 && r.json?.code === "pro-required", `${r.status}: ${short(r.text)}`);
      const g = await http(`https://${a1.fqdn}/api/screens/outbound-proxy`, { headers: sA });
      assert(g.status === 200 && g.json?.available === false && g.json?.proxy === null, `summary ${short(g.text)}`);
      return "403 pro-required; the summary says available: false";
    });

    let vm: Vm | null = null;
    try {
      const up = await rec.check("a SOCKS5 proxy (username + password) on a throwaway VM", async () => {
        const pro = await ensurePro(primaryDevice(acct));
        vm = await createDebianVm({ dir: join(dir, "socks-vm"), title: `gym-socks-${randomBytes(3).toString("hex")}`, plan: "1xCPU-1GB", diskGb: 10, log: (s) => rec.log(s) });
        const tmp = mkdtempSync(join(tmpdir(), "gym-socks-"));
        writeFileSync(join(tmp, "socks.py"), SOCKS_PY);
        writeFileSync(
          join(tmp, "gymsocks.service"),
          `[Unit]\nDescription=gym socks5\n[Service]\nExecStart=/usr/bin/python3 /root/socks.py ${user} ${pass}\nRestart=no\n[Install]\nWantedBy=multi-user.target\n`,
        );
        assert((await scp(vm, join(tmp, "socks.py"), "/root/socks.py")).code === 0, "scp socks.py");
        assert((await scp(vm, join(tmp, "gymsocks.service"), "/etc/systemd/system/gymsocks.service")).code === 0, "scp unit");
        const s = await ssh(vm, "systemctl daemon-reload && systemctl start gymsocks && sleep 1 && systemctl is-active gymsocks");
        assert(s.code === 0 && /active/.test(s.stdout), `start: ${short(s.stdout + s.stderr)}`);
        return `${vm.ip}:${SOCKS_PORT}; R is Pro until +${((pro - Date.now()) / 86_400_000).toFixed(1)} d`;
      });
      if (!up || !vm) return;
      const v: Vm = vm;
      const socksLog = async () => (await ssh(v, "cat /root/socks.log 2>/dev/null || true")).stdout.trim().split("\n").filter(Boolean);
      const socksSvc = async (verb: "start" | "stop") => {
        const r = await ssh(v, `systemctl ${verb} gymsocks; systemctl is-active gymsocks || true`);
        return r.stdout.trim();
      };

      const set = await rec.check("R's box takes the proxy (Pro, a wrong password refused first) and its traffic really leaves through the VM", async () => {
        const wrong = await postJson(`https://${b.fqdn}/api/screens/outbound-proxy`, {
          ...order(acct.keys.adminRoot, { kind: "socks5", host: v.ip, port: SOCKS_PORT, auth: true, fallbackDirect: true }),
          credentials: { username: user, password: "not-the-password" },
        }, sR, 90_000);
        assert(wrong.status === 422, `a wrong password: ${wrong.status} ${short(wrong.text)}`);
        const r = await postJson(`https://${b.fqdn}/api/screens/outbound-proxy`, {
          ...order(acct.keys.adminRoot, { kind: "socks5", host: v.ip, port: SOCKS_PORT, auth: true, fallbackDirect: true }),
          credentials: { username: user, password: pass },
        }, sR, 90_000);
        assert(r.status === 200 && r.json?.ok === true, `${r.status}: ${short(r.text)}`);
        const via = await waitFor("the box's connections through the proxy", 4 * 60_000, async () => {
          const lines = (await socksLog()).filter((l) => / CONNECT /.test(l));
          const s = await summary();
          return lines.length >= 1 && s.status === 200 && s.json?.status?.state === "ok" ? lines.map((l) => l.split(" ").slice(1).join(" ")).join("; ") : null;
        });
        const s = (await summary()).json;
        assert(s.proxy?.kind === "socks5" && s.proxy.host === v.ip && s.proxy.auth === true && s.hasCredentials === true, `summary ${short(s)}`);
        assert(!JSON.stringify(s).includes(pass), "the summary shows the password");
        const refused = (await socksLog()).filter((l) => /AUTH-REFUSED/.test(l)).length;
        return `wrong password 422 (${refused} refused at the proxy); through the proxy: ${short(via, 220)}`;
      });
      if (!set) return;

      await rec.check("the proxy dies with fallbackDirect: the box goes direct, stays reachable, and is alerted (state fallback on /pods)", async () => {
        assert((await socksSvc("stop")) !== "active", "the proxy did not stop");
        const st = await waitFor("fallback", 5 * 60_000, async () => {
          const s = await summary();
          return s.status === 200 && s.json?.status?.state === "fallback" ? `${s.json.status.state} (${s.json.status.code ?? "-"}: ${short(s.json.status.lastError, 60)})` : null;
        });
        const alert = await waitFor("proxyAlert on /pods", 3 * 60_000, async () => {
          const a = await alertOf();
          return a?.state === "fallback" ? `${a.state}/${a.code}` : null;
        });
        return `box: ${st}; /pods: ${alert}`;
      });

      await rec.check("the proxy back, the box set to the same proxy without the fallback (the stored password reused): working, alert cleared", async () => {
        assert((await socksSvc("start")) === "active", "the proxy did not start");
        const n0 = (await socksLog()).length;
        const r = await postJson(`https://${b.fqdn}/api/screens/outbound-proxy`, order(acct.keys.adminRoot, { kind: "socks5", host: v.ip, port: SOCKS_PORT, auth: true, fallbackDirect: false }), sR, 90_000);
        assert(r.status === 200, `${r.status}: ${short(r.text)}`);
        const back = await waitFor("ok through the proxy, no alert", 5 * 60_000, async () => {
          const s = await summary();
          const a = await alertOf();
          const n = (await socksLog()).filter((l) => / CONNECT /.test(l)).length;
          return s.status === 200 && s.json?.status?.state === "ok" && s.json?.proxy?.fallbackDirect === false && !a && (await socksLog()).length > n0 && n > 0 ? "ok" : null;
        });
        return `${back}; ${(await socksLog()).length - n0} new proxy log line(s)`;
      });

      await rec.check("the proxy dies without the fallback: the box goes offline and alerts through the lane (state failing on /pods)", async () => {
        assert((await socksSvc("stop")) !== "active", "the proxy did not stop");
        const alert = await waitFor("proxyAlert failing", 6 * 60_000, async () => {
          const a = await alertOf();
          return a?.state === "failing" ? `${a.state}/${a.code}` : null;
        });
        const s = await summary();
        return `/pods: ${alert}; the box over its relay: ${s.status || "unreachable"}`;
      });

      await rec.check("the fix-it order through `.com`'s lane: a password or a stranger's signature refused; the owner's \"turn off\" reaches the offline box and brings it back", async () => {
        const withCreds = await postJson(`https://${CONTROL}/api/server/${domain}/proxy-order`, {
          ...order(acct.keys.adminRoot, { kind: "socks5", host: v.ip, port: SOCKS_PORT, auth: true, fallbackDirect: true }),
          credentials: { username: user, password: pass },
        });
        assert(withCreds.status === 400 && withCreds.json?.code === "lane-no-credentials", `with a password: ${withCreds.status} ${short(withCreds.text)}`);
        const strangerSeed = new Uint8Array(randomBytes(32));
        const stranger: Keypair = { privateKey: strangerSeed, publicKey: ed.getPublicKey(strangerSeed) };
        const bad = await postJson(`https://${CONTROL}/api/server/${domain}/proxy-order`, order(stranger, { kind: "none", host: "", port: 0, auth: false, fallbackDirect: false }));
        assert(bad.status === 403, `a stranger's order: ${bad.status} ${short(bad.text)}`);
        const t0 = Date.now();
        const ok = await postJson(`https://${CONTROL}/api/server/${domain}/proxy-order`, order(acct.keys.adminRoot, { kind: "none", host: "", port: 0, auth: false, fallbackDirect: false }));
        assert(ok.status === 200, `the owner's order: ${ok.status} ${short(ok.text)}`);
        const back = await waitFor("the box back without a proxy", 8 * 60_000, async () => {
          const s = await summary();
          return s.status === 200 && s.json?.proxy === null && s.json?.status?.state === "direct" ? "direct" : null;
        });
        const cleared = await waitFor("the alert cleared", 3 * 60_000, async () => ((await alertOf()) ? null : "cleared"));
        return `box ${back} ${((Date.now() - t0) / 1000).toFixed(0)} s after the order; /pods alert ${cleared}`;
      });

      await rec.check("Activity on the box records the fallback, the failure, the lane's change and the recovery", async () => {
        const r = await http(`https://${b.fqdn}/api/screens/activity?limit=500`, { headers: sR });
        const kinds = ((r.json?.entries ?? []) as Array<{ kind?: string }>).map((e) => e.kind ?? "").filter((k) => k.startsWith("server.proxy."));
        for (const k of ["server.proxy.fallback", "server.proxy.failing", "server.proxy.changed"]) assert(kinds.includes(k), `no ${k} in ${[...new Set(kinds)].join(", ")}`);
        return [...new Set(kinds)].join(", ");
      });
    } finally {
      if (vm) await destroyVm(vm, (s) => rec.log(s)).catch(() => {});
    }
  },
};
