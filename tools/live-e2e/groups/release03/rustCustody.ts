// Which keyd served, asserted instead of inferred (release plan G8 / R8, docs/architecture-v2/
// rust-consolidation.md row 1): the box reports each Rust-path component's selector decision on
// `GET /api/stack` (`components`, from /run/flagship-rust/<c>.status). On an arch-v2 pass A1's keyd
// must be the release's pinned Rust binary; on a classic pass it must be the TypeScript keyd because
// the switch is off.
//
// The crash-and-fallback drill runs on this group's OWN box (`keyd` of account A, provisioned with a
// gym-only root SSH key, so A1 is never disturbed): the Rust keyd is SIGKILLed three times within its
// stable window, flagship-rust-select must switch the component to the TypeScript keyd
// (failed-to-start), the box must keep working on it (HTTPS, a paired session, a box-key signature
// made through keyd, a fresh signed heartbeat), and once the crash count is cleared the Rust keyd must
// serve again. The box is released at the end. Arch-v2 only (a classic box has no Rust keyd to crash).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes } from "@noble/hashes/utils";
import { rescueHelloFromBody, verifyRescueHello } from "@flagship/protocol";
import { addBox, pair, pods, waitOnline, type Box } from "../../lib/fleet.js";
import { ADMIN, CONTROL, assert, http, postJson, short, sleep, tryHttp } from "../../lib/harness.js";
import {
  describeStatus,
  failedRunsFromJournal,
  fellBack,
  gymStack,
  reportedAtMs,
  rustServedProblem,
  tsServedProblem,
  type ComponentStatus,
} from "../../lib/rustCustody.js";
import { run } from "../../lib/upcloudVm.js";
import type { Group } from "../types.js";
import { until } from "./util.js";

type Components = Record<"keyd" | "broker" | "core" | "access", ComponentStatus | null>;

async function components(b: Box, session: string): Promise<Components> {
  const r = await http(`https://${b.fqdn}/api/stack`, { headers: { "x-flagship-session": session } });
  assert(r.status === 200, `/api/stack ${r.status}: ${short(r.text)}`);
  const c = r.json?.components as Components | null | undefined;
  assert(c && typeof c === "object", `the box reports no components on /api/stack (a release before rustStack/componentStatus.ts?): ${short(r.text, 200)}`);
  return c;
}

const sshArgs = (key: string, ip: string) => [
  "-i", key, "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", `root@${ip}`,
];

export const rustCustody: Group = {
  name: "rust-custody",
  title: "which keyd served is asserted from the box's own report; a crashing Rust keyd falls back to the TypeScript keyd and comes back",
  needs: ["A1"],
  phase: 10.8,
  async run({ A, rec, box, dir, adopt }) {
    const stack = gymStack();
    const a1 = box("A1");
    const s1 = await pair(A, a1);

    await rec.check(`A1 (${stack}): keyd is ${stack === "arch-v2" ? "the release's pinned Rust binary" : "the TypeScript keyd (Rust switched off)"}, from /api/stack`, async () => {
      const c = await components(a1, s1);
      const problem = stack === "arch-v2" ? rustServedProblem(c.keyd) : tsServedProblem(c.keyd);
      assert(!problem, `keyd: ${problem}`);
      return `keyd ${describeStatus(c.keyd)}; broker ${describeStatus(c.broker)}; core ${describeStatus(c.core)}; access ${describeStatus(c.access)}`;
    });
    if (stack !== "arch-v2") {
      rec.skip("crash-and-fallback drill", "arch-v2 only: a classic box runs no Rust keyd");
      return;
    }

    // ── the drill, on its own box ──────────────────────────────────────────
    const key = join(dir, "rust-custody-ssh");
    if (!existsSync(key)) {
      const g = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "gym-rust-custody", "-f", key]);
      assert(g.code === 0, `ssh-keygen: ${g.stderr}`);
    }
    const pub = readFileSync(`${key}.pub`, "utf8").trim();
    let b: Box | null = null;
    try {
      const made = await rec.check("a box of its own for the drill (root SSH by a gym-only key) comes online", async () => {
        b = await addBox(A, "keyd", { provisionExtras: { debugSshPublicKey: pub } });
        adopt(A, b);
        assert(b.ipv4, "the gym provision returned no IPv4");
        return `${b.fqdn} ${b.ipv4}: ${await waitOnline(b, 20)}`;
      });
      if (!made || !b) return;
      const bx: Box = b;
      const sh = async (cmd: string, ms = 60_000) => {
        let r = await run("ssh", [...sshArgs(key, bx.ipv4!), cmd], ms);
        // ssh exits 255 before running anything when the connection itself failed: only then is it safe to ask again.
        for (let i = 0; i < 3 && r.code === 255 && /banner exchange|Connection (timed out|refused|reset|closed)/.test(r.stderr); i++) {
          await new Promise((res) => setTimeout(res, 10_000));
          r = await run("ssh", [...sshArgs(key, bx.ipv4!), cmd], ms);
        }
        if (r.code !== 0) throw new Error(`ssh '${short(cmd, 80)}' exit ${r.code}: ${short(r.stderr || r.stdout, 200)}`);
        return r.stdout.trim();
      };
      let session = await pair(A, bx);
      const status = async (): Promise<ComponentStatus | null> => {
        try {
          return (await components(bx, session)).keyd;
        } catch (e) {
          // The daemon may restart while keyd moves; pair again and retry once.
          bx.session = undefined;
          session = await pair(A, bx).catch(() => session);
          return (await components(bx, session).catch(() => {
            throw e;
          })).keyd;
        }
      };

      const before = await rec.check("the drill box's keyd is the pinned Rust binary, and the box's own status file says the same", async () => {
        const s = await until("keyd running on Rust", 5 * 60_000, async () => ((await status())?.reason === "running" ? (await status())! : undefined), 10_000);
        const problem = rustServedProblem(s);
        assert(!problem, problem!);
        const onDisk = JSON.parse(await sh("cat /run/flagship-rust/keyd.status")) as ComponentStatus;
        assert(onDisk.choice === s.choice && onDisk.sha256 === s.sha256, `/api/stack ${describeStatus(s)} vs the file ${describeStatus(onDisk)}`);
        return describeStatus(s);
      });
      if (!before) return;

      const fell = await rec.check("three SIGKILLs of the Rust keyd within its stable window switch keyd to the TypeScript fallback (failed-to-start)", async () => {
        for (let i = 1; i <= 3; i++) {
          // Kill only once the socket is back, so each run counts as a failed run of the same binary.
          await sh("for _ in $(seq 1 120); do [ -S /run/flagship-keyd/keyd.sock ] && systemctl is-active -q flagship-keyd && break; sleep 0.5; done");
          await sh("systemctl kill --signal=SIGKILL --kill-whom=main flagship-keyd");
          await sleep(4_000);
        }
        const s = await until("keyd on the TypeScript fallback", 3 * 60_000, async () => {
          const x = await status().catch(() => null);
          return fellBack(x) ? x! : undefined;
        }, 5_000);
        const journal = (await sh("journalctl -u flagship-keyd -b --no-pager -o cat | tail -n 200")).split("\n");
        const runs = failedRunsFromJournal(journal);
        assert(runs >= 3, `the selector counted ${runs} failed runs`);
        return `${describeStatus(s)}; the selector counted ${runs} failed runs`;
      });
      if (!fell) return;

      const fallbackAt = Date.now();
      await rec.check("on the TypeScript keyd the box keeps working: HTTPS 200, a new paired session, a box-key signature through keyd, a fresh signed heartbeat", async () => {
        await sh("for _ in $(seq 1 120); do [ -S /run/flagship-keyd/keyd.sock ] && break; sleep 0.5; done; [ -S /run/flagship-keyd/keyd.sock ]");
        const front = await tryHttp(`https://${bx.fqdn}/`, {}, 20_000);
        assert(front.status === 200, `HTTPS ${front.status}`);
        bx.session = undefined;
        session = await pair(A, bx);
        const row = (await pods(A.username)).find((p) => p.serverDomain === bx.fqdn);
        const stk = String(row?.identityPubKey ?? "");
        assert(/^[0-9a-f]{64}$/i.test(stk), `no identity key on /pods: ${short(row)}`);
        const clientNonce = randomBytes(16).toString("hex");
        const h = await postJson(`https://${bx.fqdn}/api/rescue/hello`, { clientNonce });
        assert(h.status === 200, `rescue hello ${h.status}: ${short(h.text)}`);
        const hello = rescueHelloFromBody(h.json.hello, bx.fqdn);
        assert(hello && hello.clientNonce === clientNonce && verifyRescueHello(hello, hexToBytes(h.json.signatureHex), hexToBytes(stk)), "the hello is not signed by the box's own key");
        const heartbeat = await until("a heartbeat after the fallback", 8 * 60_000, async () => {
          const r = (await pods(A.username)).find((p) => p.serverDomain === bx.fqdn);
          const at = reportedAtMs(r?.lastReported);
          return at > fallbackAt ? at : undefined;
        }, 20_000);
        return `HTTPS 200, session paired, STK-signed hello verified, heartbeat ${Math.round((heartbeat - fallbackAt) / 1000)} s after the fallback`;
      });

      await rec.check("cleared crash count + keyd restart: the Rust keyd serves again", async () => {
        await sh("rm -f /var/lib/flagship-rust/keyd.crashes && systemctl restart flagship-keyd");
        const s = await until("keyd back on Rust", 3 * 60_000, async () => {
          const x = await status().catch(() => null);
          return x && !rustServedProblem(x) ? x : undefined;
        }, 5_000);
        const front = await tryHttp(`https://${bx.fqdn}/`, {}, 20_000);
        assert(front.status === 200, `HTTPS ${front.status} after the return`);
        return describeStatus(s);
      });
    } finally {
      const bb = b as Box | null;
      if (bb?.serverId) {
        const r = await tryHttp(`https://${CONTROL}/api/gym/teardown`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-admin-secret": ADMIN },
          body: JSON.stringify({ serverIds: [bb.serverId], serverDomains: [bb.fqdn] }),
        }, 300_000);
        bb.online = false;
        rec.log(`released ${bb.fqdn}: ${r.status}`);
      }
    }
  },
};
