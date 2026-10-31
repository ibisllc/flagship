// Update this server (docs: AGENTS.md "Update this server"): the admin-root
// signed update order to an ALREADY-ENDORSED release, deposited on .com with
// IRK mailbox auth, consumed by the box (≤5 min poll), applied through the
// endorsement gate, and reported back as lastUpdate. This box (B3) is installed from the
// gym's PREVIOUS signed artifact (shared-run.ts `updateFromCommit`) and moves itself to this
// run's release at its first boot, so by now nothing newer is listed. The group then publishes the
// gym's hidden update target (scripts/gym-update-target.sh: the gym tip, signed with the gym key,
// one sequence later) and orders the move to it; it takes it out of the index again at the end.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { signDeviceEndpointClaim, signUpdateOrder, type UpdateOrder } from "@flagship/protocol";
import { pair, type Account } from "../lib/fleet.js";
import { CONTROL, assert, http, postJson, short, sleep } from "../lib/harness.js";
import type { Group } from "./types.js";
import { journal } from "./release03/util.js";

export function mailboxAuth(acct: Account): { auth: Record<string, unknown>; authSignature: string } {
  const issuedAt = Date.now();
  const nonce = new Uint8Array(randomBytes(32));
  const claim = { username: acct.username, endpointLabel: "webapp", phoneIrkPub: acct.keys.irk.publicKey, issuedAt, expiresAt: issuedAt + 120_000, nonce };
  return {
    auth: { ...claim, phoneIrkPub: bytesToHex(claim.phoneIrkPub), nonce: bytesToHex(nonce) },
    authSignature: bytesToHex(signDeviceEndpointClaim(claim, acct.keys.irk)),
  };
}

const SCRIPT = fileURLToPath(new URL("../../../scripts/gym-update-target.sh", import.meta.url));
const updateTarget = (mode: "publish" | "unpublish"): string => {
  try {
    return execFileSync("bash", [SCRIPT, mode, "--worktree", process.env.GYM_WORKTREE || `${homedir()}/.cache/flagship/gym-worktree`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    }).trim();
  } catch (e) {
    const why = String((e as { stderr?: string }).stderr ?? "").trim().split("\n").at(-1);
    throw new Error(why || (e as Error).message);
  }
};

export const update: Group = {
  name: "update",
  title: "update this server to an endorsed release (signed order → box applies → lastUpdate)",
  needs: ["B3"],
  phase: 9,
  async run({ B, rec, box }) {
    const acct = B!;
    const b = box("B3");
    const session = await pair(acct, b);
    const s = { "x-flagship-session": session };
    let current = "";
    let target = "";
    const published = await rec.check("the gym's update target (a newer release signed with the gym key) is published to the index and catalog", async () => {
      const out = updateTarget("publish");
      await sleep(70_000); // the Worker serves the index and catalog with max-age 60
      return out.split("\n").at(-1) ?? out;
    });
    if (!published) return;
    try {
      await orderAndWatch();
    } finally {
      try {
        updateTarget("unpublish");
      } catch (e) {
        console.warn(`[update] the update target is still in releases.json (${(e as Error).message}); a box made later moves onto it at first boot`);
      }
    }

    async function orderAndWatch(): Promise<void> {
    const found = await rec.check("the box lists endorsed releases and its own commit", async () => {
      const r = await http(`https://${b.fqdn}/api/screens/updates?refresh=1`, { headers: s }, 120_000);
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      current = String(r.json?.currentCommit ?? "");
      const rel = (r.json?.releases ?? []) as Array<{ commit: string; relation: string; endorsedAt?: string }>;
      const pick = r.json?.latest?.commit ? rel.find((x) => x.commit === r.json.latest.commit) : undefined;
      const choice = pick ?? rel.filter((x) => x.relation !== "current").sort((x, y) => String(y.endorsedAt).localeCompare(String(x.endorsedAt)))[0];
      assert(/^[0-9a-f]{40}$/.test(current) && choice?.commit, `current=${current} releases=${short(rel, 200)}`);
      assert(choice.relation === "newer", `nothing newer than ${current.slice(0, 8)} is listed (picked ${choice.commit.slice(0, 8)}, ${choice.relation}): the catalog refuses a move back`);
      target = choice.commit;
      return `${current.slice(0, 8)} → ${target.slice(0, 8)} (${choice.relation})`;
    });
    if (!found) return;
    const order: UpdateOrder = { serverDomain: b.fqdn, targetCommit: target, fromCommit: current, nonce: randomBytes(32).toString("hex"), issuedAt: Date.now() };
    const deposit = (signer = acct.keys.adminRoot) =>
      postJson(`https://${CONTROL}/api/server/${encodeURIComponent(b.fqdn)}/update`, {
        ...mailboxAuth(acct),
        deposit: { serverDomain: b.fqdn, requestNonceHex: randomBytes(32).toString("hex") },
        order,
        signature: bytesToHex(signUpdateOrder(order, signer)),
      });
    await rec.check("an update order signed by the owner IRK is refused", async () => {
      const r = await deposit(acct.keys.irk);
      assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
      return "403";
    });
    const deposited = await rec.check(".com accepts the admin-root-signed update order", async () => {
      const r = await deposit();
      assert(r.status === 200, `${r.status}: ${short(r.text)}`);
      return `expires ${r.json?.expiresAt}`;
    });
    if (!deposited) return;
    const depositedAt = Date.now();
    let appliedAfterMs = 0;
    await rec.check("the box applies it and reports lastUpdate=applied at the target (≤25 min)", async () => {
      const deadline = Date.now() + 25 * 60_000;
      let last = "";
      let tok = session;
      while (Date.now() < deadline) {
        await sleep(30_000);
        let r = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": tok } }).catch(() => null);
        if (r?.status === 401) {
          b.session = undefined;
          tok = await pair(acct, b).catch(() => tok);
          r = await http(`https://${b.fqdn}/api/screens/server-detail`, { headers: { "x-flagship-session": tok } }).catch(() => null);
        }
        const lu = r?.json?.lastUpdate;
        last = `${r?.status ?? 0} commit=${String(r?.json?.currentCommit ?? "").slice(0, 8)} lastUpdate=${short(lu, 160)}`;
        if (lu?.outcome === "applied" && String(r?.json?.currentCommit ?? "").startsWith(target.slice(0, 12))) {
          appliedAfterMs = Date.now() - depositedAt;
          return `${last} (${(appliedAfterMs / 60_000).toFixed(1)} min after the order)`;
        }
        if (lu?.outcome === "refused" || lu?.outcome === "rolled-back") throw new Error(last);
      }
      throw new Error(`not applied in 25 min (${last})`);
    });
    // The heartbeat doorbell (docs/runbooks/workers-cpu-budget.md) may delay an order by at most one
    // heartbeat (5 min); the apply itself (fetch, build, restart) takes a few minutes more.
    await rec.check("the update order reached the box within the doorbell budget (heartbeat 5 min + apply: ≤ 12 min)", async () => {
      assert(appliedAfterMs > 0, "the box never applied it");
      assert(appliedAfterMs <= 12 * 60_000, `applied ${(appliedAfterMs / 60_000).toFixed(1)} min after the order`);
      return `${(appliedAfterMs / 60_000).toFixed(1)} min`;
    });
    // Evidence for the release journal: which program staged, switched and verified the release (the Rust
    // flagship-updater on an arch-v2 box, the shell installers as its fallback).
    await rec.check("the box's journal names what installed the release (info)", async () => {
      const lines = (await journal(acct, b, 4000)).filter((l) => /flagship-updater|update-guard|\[self-update\]|release op|installer/i.test(l));
      assert(lines.length > 0, "no update lines in the journal");
      return lines.slice(-12).map((l) => l.replace(/^\S+ \S+ /, "").slice(0, 160)).join(" ⏎ ");
    });
    }
  },
};
