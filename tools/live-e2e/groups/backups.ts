// Backups saved on the server (docs/server-backup-and-clone.md "Scheduled
// backups", "The one file", "Backup policy"), the backup agent's spec, on
// account B: home sets a phone backup policy, takes a batch of backup keys
// from an admin device, makes a backup now, serves it as ONE .flagship file
// (4 MiB pieces and an approved browser link with Range), which imports onto
// home2 waiting for it; a schedule makes one by itself and retention drops
// the older; and the policy's limit refuses new apps until it is lifted.
import { createHash, randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  deriveServerArchiveKey,
  openBackupWithAccountKey,
  parseBackupFile,
  signArchiveDownloadApproval,
  signBackupPolicy,
  type ArchiveDownloadApproval,
  type BackupPolicyOrder,
  type Keypair,
} from "@flagship/protocol";
import { splitBundle } from "../lib/bundle.js";
import { pair, type Account, type Box } from "../lib/fleet.js";
import { assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { buildAndDeploy, finishAndWaitLive, mcpOpen } from "../lib/mcpBuild.js";
import { armRestore, uploadAndRestore } from "../lib/restore.js";
import { installWhoami } from "./gating.js";
import { depositKeys } from "./migrate.js";
import { pyAppFiles } from "./runtimes.js";
import type { Group } from "./types.js";

const APP = "bkapp";
const GiB = 1024 ** 3;

function appFiles(): Record<string, string> {
  const manifest = JSON.parse(pyAppFiles["flagship.app.json"]!);
  manifest.name = APP;
  manifest.network.subdomain = APP;
  return { ...pyAppFiles, "flagship.app.json": JSON.stringify(manifest, null, 2) };
}

function setPolicy(acct: Account, b: Box, s: Record<string, string>, policy: BackupPolicyOrder["policy"], reserve: number, signer: Keypair = acct.keys.adminRoot) {
  const order: BackupPolicyOrder = { serverDomain: b.fqdn, policy, phoneReserveBytes: policy === "phone" ? reserve : 0, issuedAt: Date.now() };
  return postJson(`https://${b.fqdn}/api/screens/backup-policy`, { order, signatureHex: bytesToHex(signBackupPolicy(order, signer)) }, s);
}

export const backups: Group = {
  name: "backups",
  title: "backups saved on the server: phone policy + limit, admin-device keys, back up now, one .flagship file (pieces + approved link), import onto home2, schedule + retention",
  needs: ["B1", "B2"],
  phase: 6,
  async run({ B, rec, box }) {
    const acct = B!;
    const a: Box = box("B1");
    const b2: Box = box("B2");
    const s = { "x-flagship-session": await pair(acct, a) };
    const list = async () => (await http(`https://${a.fqdn}/api/screens/server-archive/backups`, { headers: s })).json ?? {};
    const appUrl = `https://${APP}.${a.fqdn}`;
    const marker = `bk-${randomBytes(3).toString("hex")}`;

    const policySet = await rec.check("the policy starts unset; an admin device sets phone-side backups with a 10 GB reserve (the IRK is refused)", async () => {
      const g = await http(`https://${a.fqdn}/api/screens/backup-policy`, { headers: s });
      assert(g.status === 200 && g.json?.policy?.policy === "unset", `policy ${g.status}: ${short(g.text)}`);
      const byIrk = await setPolicy(acct, a, s, "phone", 10 * GiB, acct.keys.irk);
      assert(byIrk.status === 403, `IRK-signed policy ${byIrk.status}: ${short(byIrk.text)}`);
      const r = await setPolicy(acct, a, s, "phone", 10 * GiB);
      assert(r.status === 200 && r.json?.policy?.policy === "phone" && r.json?.cap?.limitBytes === 10 * GiB, `policy ${r.status}: ${short(r.text)}`);
      return `limit ${r.json.cap.limitBytes} B, used ${r.json.cap.usedBytes}`;
    });
    if (!policySet) return;

    const keyed = await rec.check("an admin device gives the server 5 backup keys; an app with Postgres and files holds a row and a file", async () => {
      const k = await depositKeys(acct, a, s, 5);
      assert(k.status === 200 && k.json?.keysLeft === 5, `keys ${k.status}: ${short(k.text)}`);
      const c = await mcpOpen(a, s["x-flagship-session"], "gym-backups");
      await buildAndDeploy(c, appFiles());
      await finishAndWaitLive(c, a, `${acct.username}--${APP}`);
      for (let i = 0; i < 24; i++) {
        const w = await tryHttp(`${appUrl}/write?text=${marker}`);
        if (w.status === 200) return `keysLeft 5; wrote ${marker}`;
        await sleep(5000);
      }
      throw new Error(`${appUrl} never took the write`);
    });
    if (!keyed) return;

    let saved: { archiveId: string; bytes: number; sha256: string; bundleBytes: number; bundleSha256: string } | null = null;
    const made = await rec.check("Back up now: the backup is listed with lastRun ok, and one key is used (keysLeft 4)", async () => {
      const run = await postJson(`https://${a.fqdn}/api/screens/server-archive/backups/run`, {}, s);
      assert(run.status === 202 && run.json?.archiveId, `run ${run.status}: ${short(run.text)}`);
      for (let i = 0; i < 90; i++) {
        const l = await list();
        const e = (l.backups ?? []).find((x: { archiveId: string }) => x.archiveId === run.json.archiveId);
        if (e && l.lastRun?.ok === true && !l.running) {
          assert(l.keysLeft === 4, `keysLeft ${l.keysLeft}`);
          assert(e.trigger === "now" && (e.apps ?? []).some((x: unknown) => JSON.stringify(x).includes(APP)), `entry ${short(e)}`);
          saved = e;
          return `${e.archiveId.slice(0, 8)}… ${e.bytes} B data, ${e.bundleBytes} B file`;
        }
        if (l.lastRun?.ok === false) throw new Error(`backup failed: ${l.lastRun.reason}`);
        await sleep(10_000);
      }
      throw new Error("the backup never finished");
    });
    if (!made || !saved) return;
    const sv = saved as { archiveId: string; bytes: number; sha256: string; bundleBytes: number; bundleSha256: string };

    let data: Buffer | null = null;
    let contentKey: Uint8Array | null = null;
    const downloaded = await rec.check("the one .flagship file downloads in 4 MiB pieces: FLGSHBK1, its SHA-256, and the metadata part opens with the account key", async () => {
      const pieces: Buffer[] = [];
      let offset = 0;
      let headerSha = "";
      while (true) {
        const r = await fetch(`https://${a.fqdn}/api/screens/server-archive/backups/${sv.archiveId}/bundle?offset=${offset}`, { headers: s });
        assert(r.status === 200, `bundle at ${offset}: ${r.status}`);
        headerSha = r.headers.get("x-flagship-bundle-sha256") ?? "";
        const buf = Buffer.from(await r.arrayBuffer());
        assert(buf.length <= 4 * 1024 * 1024, `piece of ${buf.length} B`);
        pieces.push(buf);
        offset += buf.length;
        if (buf.length === 0 || offset >= Number(r.headers.get("x-flagship-bundle-bytes"))) break;
      }
      const file = Buffer.concat(pieces);
      const sha = createHash("sha256").update(file).digest("hex");
      assert(sha === headerSha && sha === sv.bundleSha256 && file.length === sv.bundleBytes, `sha ${sha.slice(0, 12)} header ${headerSha.slice(0, 12)} len ${file.length}`);
      const parts = splitBundle(file);
      const opened = openBackupWithAccountKey(parseBackupFile(parts.backupText), deriveServerArchiveKey({ seed: acct.keys.umk }, sv.archiveId));
      assert(opened, "the metadata part doesn't open with the account key");
      assert(createHash("sha256").update(parts.data).digest("hex") === sv.sha256 && parts.data.length === sv.bytes, "the data part isn't the one the backup names");
      data = parts.data;
      contentKey = opened.contentKey;
      return `${pieces.length} piece(s), ${file.length} B, data from offset ${parts.dataOffset}`;
    });

    await rec.check("the browser link: an approved request reads bytes 100-199 of the file (206)", async () => {
      const link = await postJson(`https://${a.fqdn}/api/screens/server-archive/backups/${sv.archiveId}/link`, {}, s);
      assert(link.status === 200 && link.json?.path, `link ${link.status}: ${short(link.text)}`);
      const r = randomBytes(16).toString("hex");
      const approval: ArchiveDownloadApproval = { serverDomain: a.fqdn, archiveId: sv.archiveId, requestId: r, issuedAt: Date.now() };
      const ok = await postJson(`https://${a.fqdn}/api/screens/server-archive/approve`, { approval, signature: bytesToHex(signArchiveDownloadApproval(approval, acct.keys.adminRoot)) }, s);
      assert(ok.status === 200, `approve ${ok.status}: ${short(ok.text)}`);
      const res = await fetch(`https://${a.fqdn}${link.json.path}/bundle?r=${r}`, { headers: { range: "bytes=100-199" } });
      const got = Buffer.from(await res.arrayBuffer());
      assert(res.status === 206 && got.length === 100, `range ${res.status} ${got.length}`);
      const piece = Buffer.from(await (await fetch(`https://${a.fqdn}/api/screens/server-archive/backups/${sv.archiveId}/bundle?offset=0`, { headers: s })).arrayBuffer()).subarray(100, 200);
      assert(got.equals(piece), "the link's bytes differ from the file's");
      return "206, same bytes";
    });

    if (downloaded && data && contentKey) {
      const d = data as Buffer;
      const key = contentKey as Uint8Array;
      await rec.check("home2, waiting for this backup, imports the data part and runs the app with its row and file", async () => {
        const session = await armRestore(acct, b2, { archiveId: sv.archiveId, bytes: sv.bytes, sha256: sv.sha256 });
        const done = await uploadAndRestore(b2, session, sv.archiveId, d, key);
        let r = await tryHttp(`https://${APP}.${b2.fqdn}/read`);
        for (let i = 0; i < 36 && r.status !== 200; i++) {
          await sleep(5000);
          r = await tryHttp(`https://${APP}.${b2.fqdn}/read`);
        }
        assert(r.status === 200 && (r.json?.rows ?? []).includes(marker) && r.json?.file === marker, `home2 /read ${r.status}: ${short(r.text)}`);
        return short(done, 160);
      });
    }

    await rec.check("a daily schedule 10 minutes ahead makes a backup by itself, and keep-1-daily drops the older one", async () => {
      const at = new Date(Date.now() + 10 * 60_000);
      const minuteOfDayUtc = at.getUTCHours() * 60 + at.getUTCMinutes();
      const put = await http(`https://${a.fqdn}/api/screens/server-archive/backups/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...s },
        body: JSON.stringify({ frequency: "daily", minuteOfDayUtc, weekdayUtc: 0, keepDaily: 1, keepWeekly: 0 }),
      });
      assert(put.status === 200 && put.json?.schedule?.minuteOfDayUtc === minuteOfDayUtc, `schedule ${put.status}: ${short(put.text)}`);
      const deadline = Date.now() + 22 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const l = await list();
        const sched = (l.backups ?? []).filter((x: { trigger: string }) => x.trigger === "schedule");
        last = `${(l.backups ?? []).map((x: { trigger: string }) => x.trigger).join(",")} next=${l.nextRunAt} last=${short(l.lastRun)}`;
        if (sched.length && !l.running) {
          const older = (l.backups ?? []).find((x: { archiveId: string }) => x.archiveId === sv.archiveId);
          assert(!older, `retention kept the older backup: ${last}`);
          assert(l.keysLeft === 3, `keysLeft ${l.keysLeft}`);
          return `scheduled backup ${sched[0].archiveId.slice(0, 8)}…; the older one is gone`;
        }
        await sleep(30_000);
      }
      throw new Error(`no scheduled backup in 22 min (${last})`);
    });

    await rec.check("the limit: a reserve below what the server holds is refused (409 with the sentence); at it, a new app is refused; with no policy it installs", async () => {
      const used = Number((await http(`https://${a.fqdn}/api/screens/backup-policy`, { headers: s })).json?.cap?.usedBytes);
      assert(used > 0, `usedBytes ${used}`);
      const below = await setPolicy(acct, a, s, "phone", Math.max(1, used - 1024 * 1024));
      assert(below.status === 409 && below.json?.code === "over-backup-limit" && /Reserve at least/.test(below.json?.error ?? ""), `below ${below.status}: ${short(below.text)}`);
      let over = false;
      for (let i = 0; i < 3 && !over; i++) {
        const now = Number((await http(`https://${a.fqdn}/api/screens/backup-policy`, { headers: s })).json?.cap?.usedBytes);
        const at = await setPolicy(acct, a, s, "phone", now);
        over = at.status === 200 && at.json?.cap?.overLimit === true;
      }
      assert(over, "couldn't set the reserve at what the server holds");
      let refused = "";
      try {
        await installWhoami(acct, a, "bkextra", { enabled: true, public_routes: ["/*"] });
      } catch (e) {
        refused = String(e);
      }
      assert(/over its backup limit/.test(refused), `install at the limit: ${short(refused || "installed", 200)}`);
      const none = await setPolicy(acct, a, s, "none", 0);
      assert(none.status === 200 && none.json?.cap?.limitBytes === null, `none ${none.status}: ${short(none.text)}`);
      await installWhoami(acct, a, "bkextra", { enabled: true, public_routes: ["/*"] });
      return `refused at ${used} B: ${short(refused, 90)}; installs with no policy`;
    });
    // Later groups on this box must not run under a limit or a schedule.
    const g = await http(`https://${a.fqdn}/api/screens/backup-policy`, { headers: s }).catch(() => null);
    if (g?.json?.policy?.policy === "phone") await setPolicy(acct, a, s, "none", 0).catch(() => null);
    await http(`https://${a.fqdn}/api/screens/server-archive/backups/schedule`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...s },
      body: JSON.stringify({ frequency: "off", minuteOfDayUtc: 180, weekdayUtc: 0, keepDaily: 7, keepWeekly: 4 }),
    }).catch(() => null);
  },
};
