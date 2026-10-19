// What the Workers Free plan work changed (docs/runbooks/workers-cpu-budget.md),
// seen from outside: the read routes whose internals were batched and cached
// answer the same, per token flavour, with their cold and warm latencies; the
// held /stream shows a change within its new schedule; an app rename reaches the
// box's routing within the slower alias poll; the static files and the security
// headers are right; and the gym Worker's own log (wrangler tail, started by
// shared-run) shows no request that ran out of CPU. The heartbeat doorbell
// itself is timed where its consumers already run: the update and decommission
// checks (update, lifecycle) and the new-device sign-in (invites).
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  accountReadTokenPath,
  signAccountDirectoryRequest,
  signDeviceEndpointClaim,
  signInstallService,
  signServerOrder,
  signServiceRename,
  signUninstallService,
  type InstallServiceRequest,
  type Keypair,
  type ServerOrder,
  type ServiceRename,
  type UninstallServiceRequest,
} from "@flagship/protocol";
import { REAL_PRIMARY_DEVICE_ID, pods } from "../lib/fleet.js";
import { describeLatency, latencyStats, securityHeaderGaps, uncachedProbe } from "../lib/freePlan.js";
import { CONTROL, assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { currentTail } from "../lib/workerTail.js";
import { whoamiManifest } from "./core.js";
import type { Group } from "./types.js";

/** Heartbeat 5 min; the rename poll is allowed to be this much slower than before (1 min -> 5 min), plus the reconcile. */
const RENAME_BUDGET_MS = 7 * 60_000;
/** The held stream checks at 3, 8, 15 and 25 s; a change must show by the last check plus a little. */
const STREAM_BUDGET_MS = 27_000;

export const freePlan: Group = {
  name: "free-plan",
  title: "Workers Free plan: read routes per token flavour with cold/warm latency, held /stream change delay, rename routing lag, static files + security headers",
  needs: ["A1", "R1"],
  phase: 1,
  async run({ A, R, rec, box }) {
    const real = R!;
    const user = real.username;
    const b = box("A1");
    const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
      const t0 = Date.now();
      const v = await f();
      return [v, Date.now() - t0];
    };

    // ── token flavours ────────────────────────────────────────────────────
    const mintIrk = async (nonce = new Uint8Array(randomBytes(32))) => {
      const issuedAt = Date.now();
      const claim = { username: user, endpointLabel: ACCOUNT_READ_TOKEN_LABEL, phoneIrkPub: real.keys.irk.publicKey, issuedAt, expiresAt: issuedAt + 5 * 60_000, nonce };
      const body = { auth: { ...claim, phoneIrkPub: bytesToHex(claim.phoneIrkPub), nonce: bytesToHex(claim.nonce) }, authSignature: bytesToHex(signDeviceEndpointClaim(claim, real.keys.irk)) };
      return { body, post: () => postJson(`https://${CONTROL}${accountReadTokenPath(user)}`, body) };
    };
    const deviceHeaders = (method: string, path: string, deviceId = REAL_PRIMARY_DEVICE_ID, device: Keypair = real.keys.primaryDevice): Record<string, string> => {
      const requestId = randomBytes(16).toString("hex");
      const issuedAt = Date.now();
      const sig = signAccountDirectoryRequest({ accountId: user, deviceId, signerPubHex: bytesToHex(device.publicKey), method, path, requestId, issuedAt }, device);
      return {
        "content-type": "application/json",
        "x-flagship-device-id": deviceId,
        "x-flagship-device-pub": bytesToHex(device.publicKey),
        "x-flagship-request-id": requestId,
        "x-flagship-issued-at": String(issuedAt),
        "x-flagship-signature": sig,
      };
    };
    const tokens: Record<string, string> = {};
    await rec.check("read tokens: the IRK and the admin device each mint one; a replayed IRK claim is refused", async () => {
      const m = await mintIrk();
      const first = await m.post();
      assert(first.status === 200 && first.json?.token, `IRK mint ${first.status}: ${short(first.text)}`);
      tokens.irk = first.json.token;
      const replay = await m.post();
      assert(replay.status >= 400 && replay.status < 500, `a replayed claim got ${replay.status}`);
      const path = accountReadTokenPath(user);
      const d = await http(`https://${CONTROL}${path}`, { method: "POST", headers: deviceHeaders("POST", path), body: "{}" });
      assert(d.status === 200 && d.json?.token, `device mint ${d.status}: ${short(d.text)}`);
      tokens.device = d.json.token;
      return `IRK + device minted; replay ${replay.status}`;
    });

    const serviceId = `${A.username}--fpprobe`;
    const reads: Array<[string, string]> = [
      ["/pods", `/api/users/${user}/pods`],
      ["/stream (first connect)", `/api/users/${user}/stream`],
      ["/audit", `/api/users/${user}/audit`],
      ["/apps/aliases", `/api/users/${user}/apps/aliases`],
      ["/device-grants", `/api/users/${user}/device-grants`],
      ["/apps/:id/links", `/api/users/${user}/apps/${encodeURIComponent(`${user}--fpprobe`)}/links`],
    ];
    for (const [label, path] of reads) {
      await rec.check(`${label}: 401 without a token, answered for the IRK and the device token (same status), cold then warm`, async () => {
        assert(Object.keys(tokens).length === 2, "no tokens minted");
        const url = `https://${CONTROL}${path}`;
        const bare = await http(url);
        assert(bare.status === 401, `without a token: ${bare.status} ${short(bare.text)}`);
        const forged = await http(url, { headers: { authorization: "Bearer art1.e30.AAAA" } });
        assert(forged.status === 401, `forged token: ${forged.status}`);
        const statuses = new Set<number>();
        const out: string[] = [];
        for (const flavour of ["irk", "device"] as const) {
          const samples: number[] = [];
          for (let i = 0; i < 4; i++) {
            const [r, ms] = await timed(() => http(url, { headers: { authorization: `Bearer ${tokens[flavour]}` } }));
            assert(r.status < 500, `${flavour} token: ${r.status} ${short(r.text)}`);
            statuses.add(r.status);
            samples.push(ms);
          }
          out.push(`${flavour}: ${describeLatency("", latencyStats(samples)).trim()}`);
        }
        assert(statuses.size === 1, `the two token flavours were answered differently: ${[...statuses].join(", ")}`);
        const status = [...statuses][0]!;
        assert(status === 200 || (label.includes(":id") && status === 404), `status ${status}`);
        return `${status}; ${out.join("; ")}`;
      });
    }

    await rec.check("directory + profile: a device-signed GET answers; unsigned and stranger-signed are refused; cold then warm", async () => {
      const out: string[] = [];
      for (const which of ["directory", "profile"] as const) {
        const path = `/api/accounts/${user}/${which}`;
        const bare = await http(`https://${CONTROL}${path}`);
        assert(bare.status >= 400 && bare.status < 500, `${which} unsigned: ${bare.status}`);
        const samples: number[] = [];
        for (let i = 0; i < 4; i++) {
          const [r, ms] = await timed(() => http(`https://${CONTROL}${path}`, { headers: deviceHeaders("GET", path) }));
          assert(r.status === 200 && r.json, `${which} signed: ${r.status} ${short(r.text)}`);
          samples.push(ms);
        }
        out.push(describeLatency(which, latencyStats(samples)));
      }
      return out.join("; ");
    });
    await rec.check("account-gone: an account that does not exist answers 4xx on directory and /pods, never 5xx", async () => {
      const ghost = `fpgone${randomBytes(3).toString("hex")}`;
      for (const p of [`/api/accounts/${ghost}/directory`, `/api/accounts/${ghost}/profile`, `/api/users/${ghost}/pods`]) {
        const r = await http(`https://${CONTROL}${p}`);
        assert(r.status >= 400 && r.status < 500, `${p}: ${r.status} ${short(r.text)}`);
      }
      return "4xx x3";
    });

    // ── the held /stream ──────────────────────────────────────────────────
    await rec.check("held /stream: a server-order change wakes a held request within its schedule (checks at 3, 8, 15, 25 s)", async () => {
      const stk = String((await pods(A.username)).find((p) => p.serverDomain === b.fqdn)?.identityPubKey ?? "").toLowerCase();
      assert(/^[0-9a-f]{64}$/.test(stk), "no STK for A1 in /pods");
      const first = await http(`https://${CONTROL}/api/users/${A.username}/stream`);
      assert(first.status === 200 && typeof first.json?.cursor === "string", `first connect ${first.status}: ${short(first.text)}`);
      const held = (async () => {
        const t0 = Date.now();
        const r = await http(`https://${CONTROL}/api/users/${A.username}/stream?cursor=${first.json.cursor}`, {}, 40_000);
        return { r, ms: Date.now() - t0 };
      })();
      await sleep(1000);
      const order: ServerOrder = { user: A.username, stks: [stk], issuedAt: Date.now(), nonce: randomBytes(32).toString("hex") };
      const t0 = Date.now();
      const post = await postJson(`https://${CONTROL}/api/accounts/${A.username}/server-order`, { order, signature: signServerOrder(order, A.keys.adminRoot) });
      assert(post.status === 200, `server-order ${post.status}: ${short(post.text)}`);
      const { r } = await held;
      const delay = Date.now() - t0;
      assert(r.status === 200 && r.json?.cursor && r.json.cursor !== first.json.cursor, `the held request returned the same cursor after ${delay} ms`);
      assert(delay <= STREAM_BUDGET_MS, `the change showed after ${delay} ms (budget ${STREAM_BUDGET_MS})`);
      return `change visible ${(delay / 1000).toFixed(1)} s after the write`;
    });

    // ── rename routing lag (the box polls the alias list less often now) ───
    const slug = "fpprobe";
    const fqdn = b.fqdn;
    let installed = false;
    await rec.check("install a probe app on A1 and see it serve", async () => {
      const req: InstallServiceRequest = { serverId: fqdn, creator: A.username, slug, manifestJson: whoamiManifest(slug), addOwnerToMembership: true, issuedAt: Date.now() };
      const r = await postJson(`https://${fqdn}/api/services`, { request: req, signature: bytesToHex(signInstallService(req, A.keys.irk)) }, {}, 120_000);
      assert(r.status === 200, `install ${r.status}: ${short(r.text, 240)}`);
      installed = true;
      for (let i = 0; i < 36; i++) {
        if ((await tryHttp(`https://${slug}.${fqdn}/`, {}, 12_000)).status === 200) return "serving";
        await sleep(5000);
      }
      throw new Error("the probe app did not serve in 180 s");
    });
    if (installed) {
      await rec.check(`rename the app: the box routes the new name within ${RENAME_BUDGET_MS / 60_000} min (measured)`, async () => {
        const newLabel = "fpprobe2";
        const rn: ServiceRename = { username: A.username, serviceId, newDisplayLabel: newLabel, issuedAt: Date.now() };
        const t0 = Date.now();
        const r = await postJson(`https://${CONTROL}/api/users/${A.username}/apps/${encodeURIComponent(serviceId)}/rename`, {
          request: rn,
          signature: bytesToHex(signServiceRename(rn, A.keys.irk)),
        });
        assert(r.status === 200, `rename ${r.status}: ${short(r.text)}`);
        let last = "";
        while (Date.now() - t0 < RENAME_BUDGET_MS) {
          const c = await tryHttp(`https://${newLabel}.${fqdn}/`, {}, 12_000);
          last = `${c.status} ${short(c.text, 60)}`;
          if (c.status === 200) return `the new name served ${((Date.now() - t0) / 1000).toFixed(0)} s after the rename`;
          await sleep(10_000);
        }
        throw new Error(`the renamed app was not routed within ${RENAME_BUDGET_MS / 1000} s (${last})`);
      });
      await rec.check("uninstall the probe app", async () => {
        const req: UninstallServiceRequest = { serverId: fqdn, creator: A.username, slug, issuedAt: Date.now() };
        const r = await http(`https://${fqdn}/api/services/${encodeURIComponent(serviceId)}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: req, signature: bytesToHex(signUninstallService(req, A.keys.adminRoot)) }),
        }, 90_000);
        assert(r.status === 200, `uninstall ${r.status}: ${short(r.text)}`);
        return "uninstalled";
      });
    }

    // ── static files and headers ──────────────────────────────────────────
    const statics = [`https://${CONTROL}/`, `https://webapp.${CONTROL}/app.js`, `https://webapp.${CONTROL}/service-worker.js`];
    await rec.check("static pages and files carry the security headers; /api still answers from the Worker", async () => {
      const out: string[] = [];
      for (const url of statics) {
        const r = await http(url);
        assert(r.status === 200, `${url}: ${r.status}`);
        const gaps = securityHeaderGaps(r.headers);
        assert(gaps.length === 0, `${url} is missing: ${gaps.join("; ")}`);
        out.push(new URL(url).pathname);
      }
      const api = await http(`https://${CONTROL}/api/health`);
      assert(api.status === 200 && api.json?.ok === true, `/api/health ${api.status}`);
      assert(securityHeaderGaps(api.headers).length === 0, `/api/health headers: ${securityHeaderGaps(api.headers).join("; ")}`);
      return `headers ok on ${out.join(", ")} and /api/health`;
    });
    await rec.check("static files are served without the Worker (the tail sees no invocation for them)", async () => {
      const tail = currentTail();
      if (!tail || !tail.summary().available) return "tail not running here: not checked (headers above still are)";
      if (tail.summary().events === 0) return "the tail has seen no request yet: not checked";
      const tag = randomBytes(4).toString("hex");
      const t0 = Date.now();
      for (const url of statics) await http(uncachedProbe(url, tag));
      await sleep(6000);
      const hits = tail.seen(`fp=${tag}`, t0 - 2000);
      const expect = process.env.GYM_EXPECT_STATIC_BYPASS === "1";
      if (expect) assert(hits.length === 0, `${hits.length} static request(s) reached the Worker: ${hits.map((h) => h.route).join(", ")}`);
      return hits.length === 0 ? "none of the static requests reached the Worker" : `${hits.length}/${statics.length} reached the Worker (GYM_EXPECT_STATIC_BYPASS not set: informational)`;
    });
  },
};
