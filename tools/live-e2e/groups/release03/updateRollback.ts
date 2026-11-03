// G1 (RELEASE-0.3-JOURNAL.md): a release that fails its health gate is rolled back, by the Rust updater.
//
// Runs after the `update` group, on the same box (B3), which by then sits on the gym's update target. The
// rollback drill release (scripts/gym-update-target.sh --flavor broken, built by gym-refresh.sh when
// GYM_ROLLBACK_TARGET=1) is a child of that target, one sequence above it, signed with the gym key, whose
// daemon exits at start. The group publishes it, orders the box onto it with the admin root, and expects:
//   - the box installs it (so the signed-artifact path accepts it: the fault is in the code, not the trust);
//   - the new daemon never turns healthy; the update guard (ExecStartPre) hands over to the pin-checked
//     /usr/local/sbin/flagship-updater, which counts the starts and switches back to the update target;
//   - lastUpdate says rolled-back, the box runs the previous release again and serves;
//   - the guard lines in the journal are the Rust updater's, not the bash fallback's (lib/updateGuard.ts).
// It takes the drill out of releases.json at the end (the catalog keeps it, as for the update target).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { signUpdateOrder, type UpdateOrder } from "@flagship/protocol";
import { pair } from "../../lib/fleet.js";
import { CONTROL, SkipError, assert, http, postJson, short, sleep, tryHttp } from "../../lib/harness.js";
import { classifyGuardJournal, rustRolledBack } from "../../lib/updateGuard.js";
import type { Group } from "../types.js";
import { mailboxAuth } from "../update.js";
import { journal } from "./util.js";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/gym-update-target.sh", import.meta.url));
const drillTarget = (mode: "publish" | "unpublish"): string => {
  try {
    return execFileSync("bash", [SCRIPT, mode, "--flavor", "broken", "--worktree", process.env.GYM_WORKTREE || `${homedir()}/.cache/flagship/gym-worktree`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    }).trim();
  } catch (e) {
    const why = String((e as { stderr?: string }).stderr ?? "").trim().split("\n").at(-1);
    throw new Error(why || (e as Error).message);
  }
};

export const updateRollback: Group = {
  name: "update-rollback",
  title: "a release that never turns healthy is rolled back by the Rust updater (guard hand-over), and the box serves again",
  needs: ["B3"],
  phase: 9.2,
  async run({ B, rec, box, groupOk }) {
    const acct = B!;
    const b = box("B3");
    if (!groupOk("update")) {
      rec.skip("the box is on the update target (the update group passed)", "the update group did not pass in this run, so the box is not on the release the drill was built on");
      return;
    }
    let session = await pair(acct, b);
    const detail = async () => {
      let r = await tryHttp(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": session } }, 20_000);
      if (r.status === 401) {
        b.session = undefined;
        session = await pair(acct, b).catch(() => session);
        r = await tryHttp(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": session } }, 20_000);
      }
      return r;
    };

    let before = "";
    let drill = "";
    const published = await rec.check("the rollback drill release (built on this run's update target; its daemon exits at start) is published", async () => {
      const d = await detail();
      before = String(d.json?.currentCommit ?? "");
      assert(/^[0-9a-f]{40}$/.test(before), `server-detail ${d.status}: ${short(d.text)}`);
      let out: string;
      try {
        out = drillTarget("publish");
      } catch (e) {
        // Not built (GYM_ROLLBACK_TARGET unset at the refresh) or built on another tip: nothing proven.
        throw new SkipError(`no usable rollback target: ${(e as Error).message} (refresh the gym with GYM_ROLLBACK_TARGET=1)`);
      }
      await sleep(70_000); // the Worker serves the index and catalog with max-age 60
      return out.split("\n").at(-1) ?? out;
    });
    if (!published) return;
    try {
      const listed = await rec.check("the box lists the drill release as newer than the one it runs", async () => {
        const r = await http(`https://${b.fqdn}/api/screens/updates?refresh=1`, { headers: { "x-flagship-session": session } }, 120_000);
        assert(r.status === 200, `${r.status}: ${short(r.text)}`);
        const rel = (r.json?.releases ?? []) as Array<{ commit: string; relation: string; label?: string }>;
        const newer = rel.filter((x) => x.relation === "newer");
        assert(newer.length > 0, `nothing newer than ${before.slice(0, 8)}: ${short(rel, 240)}`);
        // The drill is one sequence above the update target, so it is the newest.
        drill = (r.json?.latest?.commit as string | undefined) ?? newer[0]!.commit;
        assert(drill !== before, "the newest release is the one the box runs");
        return `${before.slice(0, 8)} → ${drill.slice(0, 8)}`;
      });
      if (!listed) return;

      const order: UpdateOrder = { serverDomain: b.fqdn, targetCommit: drill, fromCommit: before, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
      const ordered = await rec.check(".com accepts the admin-root-signed order to the drill release", async () => {
        const r = await postJson(`https://${CONTROL}/api/server/${encodeURIComponent(b.fqdn)}/update`, {
          ...mailboxAuth(acct),
          deposit: { serverDomain: b.fqdn, requestNonceHex: randomBytes(32).toString("hex") },
          order,
          signature: bytesToHex(signUpdateOrder(order, acct.keys.adminRoot)),
        });
        assert(r.status === 200, `${r.status}: ${short(r.text)}`);
        return `expires ${r.json?.expiresAt}`;
      });
      if (!ordered) return;

      let sawDown = false;
      let rolledAfterMs = 0;
      const t0 = Date.now();
      const rolled = await rec.check("the box takes it, never turns healthy, and reports lastUpdate=rolled-back on its previous release (≤ 35 min)", async () => {
        const deadline = Date.now() + 35 * 60_000;
        let last = "";
        while (Date.now() < deadline) {
          await sleep(20_000);
          const d = await detail().catch(() => null);
          if (!d || d.status >= 500 || d.status === 0) {
            sawDown = true;
            last = `down (${d?.status ?? "no answer"})`;
            continue;
          }
          const lu = d.json?.lastUpdate;
          const now = String(d.json?.currentCommit ?? "");
          last = `${d.status} commit=${now.slice(0, 8)} lastUpdate=${short(lu, 200)}`;
          if (lu?.outcome === "rolled-back" && String(lu?.targetCommit ?? drill) === drill) {
            assert(now === before, `rolled back, but runs ${now.slice(0, 8)}, not ${before.slice(0, 8)}`);
            rolledAfterMs = Date.now() - t0;
            return `${last} (${(rolledAfterMs / 60_000).toFixed(1)} min after the order${sawDown ? ", down in between" : ""})`;
          }
          if (lu?.outcome === "applied" && now === drill) throw new Error(`the drill release was COMMITTED as healthy: ${last}`);
          if (lu?.outcome === "refused" && String(lu?.targetCommit ?? "") === drill) throw new Error(`the box refused the drill instead of installing it (the fault must be in the code, not the trust): ${last}`);
        }
        throw new Error(`no roll-back in 35 min (${last})`);
      });
      if (!rolled) return;

      await rec.check("the box went down while the drill release ran (it was really installed and started)", async () => {
        assert(sawDown, "the box answered the whole time: the drill release may never have been switched to");
        return "down, then back on the previous release";
      });

      await rec.check("the box serves again on the previous release (front page + a paired session)", async () => {
        const f = await tryHttp(`https://${b.fqdn}/api/front-page`, {}, 15_000);
        assert(f.status === 200, `front page ${f.status}`);
        b.session = undefined;
        session = await pair(acct, b);
        const d = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": session } });
        assert(d.status === 200 && d.json?.currentCommit === before, `server-detail ${d.status} ${String(d.json?.currentCommit ?? "").slice(0, 8)}`);
        return `on ${before.slice(0, 8)}`;
      });

      await rec.check("the guard handed over: the Rust flagship-updater counted the starts and rolled back (not the bash fallback)", async () => {
        const lines = await journal(acct, b, 8000);
        const ev = classifyGuardJournal(lines);
        const v = rustRolledBack(ev, before);
        if (!v.ok) throw new Error(`${v.why}; guard lines: ${short(ev.lines.slice(-8).join(" ⏎ "), 600)}`);
        return `${ev.rustStarts} counted starts, rolled back to ${before.slice(0, 8)} by ${v.by}`;
      });
    } finally {
      try {
        drillTarget("unpublish");
      } catch (e) {
        console.warn(`[update-rollback] the drill release is still in releases.json (${(e as Error).message}); a box made later moves onto it at first boot and crash-loops until rolled back`);
      }
    }
  },
};
