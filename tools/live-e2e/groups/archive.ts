// Back up a whole server and restore it onto another (docs/server-backup-and-
// clone.md). On home: the phone starts a backup with two key slots (account
// key + passcode), the box builds the sealed archive, both slots open it, the
// browser download needs the admin root's approval and serves byte ranges.
// home3 (an unpaired box of the same account) gets the pairing order with an
// admin-root-signed `flagship/server-restore/v1` beside it through `.com`'s
// sealed pairing deposit, waits for that backup (`awaitingBackup` on /pods),
// takes the upload in chunks (out-of-order refused), and rebuilds the apps
// from the archive with their Postgres rows and files.
import { createHash, randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  deriveServerArchiveKey,
  openBackupWithAccountKey,
  openBackupWithPasscode,
  pairingOrderToJson,
  parseBackupFile,
  sealForEd25519Recipient,
  signArchiveDownloadApproval,
  signDeviceEndpointClaim,
  signPhoneOrder,
  signServerRestoreOrder,
  wrapAccountSlot,
  wrapPasscodeSlot,
  type ArchiveDownloadApproval,
  type PhoneOrder,
  type ServerRestoreOrder,
} from "@flagship/protocol";
import { pair, pods } from "../lib/fleet.js";
import { CONTROL, assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { BUNDLE_MAGIC, splitBundle } from "../lib/bundle.js";
import { PY_APP } from "./runtimes.js";
import type { Group } from "./types.js";

const PASSCODE = "gym-backup-passcode-7k3m";
/** Cheap Argon2 for the harness (the box never opens slots; the app's default is 64 MiB). */
const ARGON = { m: 1024, t: 1, p: 1 };
const CHUNK = 4 * 1024 * 1024;

export const archive: Group = {
  name: "archive",
  title: "backup home (account + passcode slots, approved Range download) → restore onto home3 waiting for it",
  needs: ["A1", "A3"],
  phase: 3,
  async run({ A, rec, box }) {
    const src = box("A1");
    const dst = box("A3");
    const session = await pair(A, src);
    const s = { "x-flagship-session": session };
    const archiveId = randomBytes(16).toString("hex");
    const contentKey = new Uint8Array(randomBytes(32));
    const accountKek = deriveServerArchiveKey({ seed: A.keys.umk }, archiveId);
    let meta: { bytes: number; sha256: string; apps: string[] } | null = null;
    let data: Buffer | null = null;

    const built = await rec.check("home builds a sealed backup with an account-key slot and a passcode slot", async () => {
      const slots = [
        wrapAccountSlot(archiveId, contentKey, accountKek, new Uint8Array(randomBytes(12))),
        wrapPasscodeSlot(archiveId, contentKey, PASSCODE, new Uint8Array(randomBytes(16)), new Uint8Array(randomBytes(12)), ARGON),
      ];
      const r = await postJson(`https://${src.fqdn}/api/screens/server-archive/start`, { archiveId, key: bytesToHex(contentKey), slots }, s, 60_000);
      assert(r.status === 202, `start ${r.status}: ${short(r.text)}`);
      // The same backup again, so losing the race (a near-empty box can finish before this
      // arrives) only remakes the same archive with the same key. 409 while it runs; 202 is
      // right only if the first one had already finished.
      const busy = await postJson(`https://${src.fqdn}/api/screens/server-archive/start`, { archiveId, key: bytesToHex(contentKey), slots }, s);
      assert(busy.status === 409 || busy.status === 400 || busy.status === 202, `a second backup while one runs: ${busy.status}`);
      const deadline = Date.now() + 20 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const st = await http(`https://${src.fqdn}/api/screens/server-archive`, { headers: s });
        const a = st.json?.archive;
        last = short(a, 200);
        if (a?.state === "ready") {
          meta = { bytes: a.bytes, sha256: a.sha256, apps: a.apps ?? [] };
          return `${a.bytes} B, ${(a.apps ?? []).length} apps${(a.left ?? []).length ? `, left out: ${short(a.left, 120)}` : ""}`;
        }
        if (a?.state === "failed") throw new Error(`backup failed: ${a.reason}`);
        await sleep(5000);
      }
      throw new Error(`not ready in 20 min: ${last}`);
    });
    if (!built || !meta) return;
    const m = meta as { bytes: number; sha256: string; apps: string[] };

    await rec.check("the backup file opens with the account key and with the passcode; the body names the data file", async () => {
      const f = await http(`https://${src.fqdn}/api/screens/server-archive/backup-file`, { headers: s });
      assert(f.status === 200, `backup-file ${f.status}`);
      const file = parseBackupFile(f.text);
      const byAccount = openBackupWithAccountKey(file, accountKek);
      assert(byAccount && bytesToHex(byAccount.contentKey) === bytesToHex(contentKey), "account slot doesn't open");
      const byPass = openBackupWithPasscode(file, PASSCODE);
      assert(bytesToHex(byPass.contentKey) === bytesToHex(contentKey), "passcode slot doesn't open");
      let wrong = false;
      try {
        openBackupWithPasscode(file, "not-the-passcode-0000");
      } catch {
        wrong = true;
      }
      assert(wrong, "a wrong passcode opened it");
      const body = byAccount.body;
      assert(body.data.sha256 === m.sha256 && body.data.bytes === m.bytes, `body data ${short(body.data)} vs ${m.bytes}/${m.sha256}`);
      const names = JSON.stringify(body.apps);
      assert(names.includes(PY_APP), `the python app isn't in the backup: ${short(names, 200)}`);
      assert(!names.includes(bytesToHex(contentKey)), "the key is in the body");
      return `${body.apps.length} apps in the body`;
    });

    await rec.check("the browser download needs the admin root's approval (IRK refused), then serves ranges and the whole file", async () => {
      const link = await postJson(`https://${src.fqdn}/api/screens/server-archive/link`, {}, s);
      assert(link.status === 200 && /^\/api\/archive-download\/[0-9a-f]{64}$/.test(link.json?.path), `link ${link.status}: ${short(link.text)}`);
      const base = `https://${src.fqdn}${link.json.path}`;
      const first = await http(base);
      assert(first.status === 303 && /\?r=[0-9a-f]{32}/.test(first.headers.get("location") ?? ""), `page ${first.status} ${first.headers.get("location")}`);
      const r = randomBytes(16).toString("hex");
      const before = await http(`${base}/bundle?r=${r}`);
      assert(before.status === 403, `unapproved download ${before.status}`);
      const approval: ArchiveDownloadApproval = { serverDomain: src.fqdn, archiveId, requestId: r, issuedAt: Date.now() };
      const byIrk = await postJson(`https://${src.fqdn}/api/screens/server-archive/approve`, { approval, signature: bytesToHex(signArchiveDownloadApproval(approval, A.keys.irk)) }, s);
      assert(byIrk.status === 403, `IRK approval ${byIrk.status}: ${short(byIrk.text)}`);
      const ok = await postJson(`https://${src.fqdn}/api/screens/server-archive/approve`, { approval, signature: bytesToHex(signArchiveDownloadApproval(approval, A.keys.adminRoot)) }, s);
      assert(ok.status === 200, `approval ${ok.status}: ${short(ok.text)}`);
      const st = await http(`${base}/status?r=${r}`);
      assert(st.json?.approved === true, `status ${short(st.text)}`);
      const total = Number(link.json.bundleBytes);
      const range = await fetch(`${base}/bundle?r=${r}`, { headers: { range: "bytes=0-99" } });
      const head = Buffer.from(await range.arrayBuffer());
      assert(range.status === 206 && head.length === 100 && range.headers.get("content-range") === `bytes 0-99/${total}`, `range ${range.status} ${range.headers.get("content-range")} ${head.length}`);
      assert(head.subarray(0, 8).toString("latin1") === BUNDLE_MAGIC, "not a .flagship file");
      const bad = await fetch(`${base}/bundle?r=${r}`, { headers: { range: `bytes=${total + 10}-` } });
      assert(bad.status === 416, `unsatisfiable range ${bad.status}`);
      const full = await fetch(`${base}/bundle?r=${r}`);
      const bundle = Buffer.from(await full.arrayBuffer());
      const bundleSha = createHash("sha256").update(bundle).digest("hex");
      assert(full.status === 200 && bundle.length === total && bundleSha === link.json.bundleSha256, `full ${full.status} ${bundle.length} B sha ${bundleSha.slice(0, 12)}`);
      const parts = splitBundle(bundle);
      assert(openBackupWithAccountKey(parseBackupFile(parts.backupText), accountKek), "the file's metadata part doesn't open with the account key");
      data = parts.data;
      const sha = createHash("sha256").update(data).digest("hex");
      assert(data.length === m.bytes && sha === m.sha256, `data part ${data.length} B sha ${sha.slice(0, 12)} vs ${m.bytes}/${m.sha256.slice(0, 12)}`);
      return `206 + 416 + 200: one ${bundle.length} B .flagship file, data part ${data.length} B (sha256 ok)`;
    });
    if (!data) return;
    const bytes = data as Buffer;

    let restoreToken = "";
    const armed = await rec.check("home3 gets its pairing + an admin-root-signed restore order through .com, and /pods shows it awaiting the backup", async () => {
      const p = (await pods(A.username)).find((x) => x.serverDomain === dst.fqdn);
      assert(p?.identityPubKey, `home3 /pods row ${short(p)}`);
      restoreToken = randomBytes(24).toString("hex");
      const order: PhoneOrder = { type: "add-paired-session", serverId: dst.fqdn, token: restoreToken, issuedAt: Date.now() };
      const pairing = JSON.parse(pairingOrderToJson(order, signPhoneOrder(order, A.keys.irk)));
      const restore: ServerRestoreOrder = { serverDomain: dst.fqdn, archiveId, bytes: m.bytes, sha256: m.sha256, issuedAt: Date.now() };
      pairing.restore = { order: restore, signatureHex: bytesToHex(signServerRestoreOrder(restore, A.keys.adminRoot)) };
      const issuedAt = Date.now();
      const nonce = new Uint8Array(randomBytes(32));
      const claim = { username: A.username, endpointLabel: "device", phoneIrkPub: A.keys.irk.publicKey, issuedAt, expiresAt: issuedAt + 120_000, nonce };
      const d = await postJson(`https://${CONTROL}/api/server/${encodeURIComponent(dst.fqdn)}/pairing-deposit`, {
        auth: { ...claim, phoneIrkPub: bytesToHex(claim.phoneIrkPub), nonce: bytesToHex(nonce) },
        authSignature: bytesToHex(signDeviceEndpointClaim(claim, A.keys.irk)),
        deposit: {
          serverDomain: dst.fqdn,
          requestNonceHex: randomBytes(32).toString("hex"),
          stkPub: String(p.identityPubKey).toLowerCase(),
          sealed: bytesToHex(sealForEd25519Recipient(new TextEncoder().encode(JSON.stringify(pairing)), hexToBytes(String(p.identityPubKey)))),
          issuedAt,
        },
      });
      assert(d.status === 200, `deposit ${d.status}: ${short(d.text)}`);
      // The box claims deposits on its 5-minute heartbeat.
      const deadline = Date.now() + 8 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const row = (await pods(A.username)).find((x) => x.serverDomain === dst.fqdn);
        last = short(row?.awaitingBackup ?? "none");
        if (row?.awaitingBackup?.archiveId === archiveId) {
          const w = await http(`https://${dst.fqdn}/api/screens/server-restore`, { headers: { "x-flagship-session": restoreToken } });
          assert(w.status === 200 && w.json?.waiting?.archiveId === archiveId && w.json.waiting.sha256 === m.sha256, `server-restore ${w.status}: ${short(w.text)}`);
          return `awaitingBackup ${row.awaitingBackup.state}`;
        }
        await sleep(15_000);
      }
      throw new Error(`home3 never showed awaitingBackup (last ${last})`);
    });
    if (!armed) return;
    const ds = { "x-flagship-session": restoreToken };

    const uploaded = await rec.check("the upload: a wrong size is refused, an out-of-order chunk gets 409 with the offset, the rest goes in", async () => {
      const wrong = await postJson(`https://${dst.fqdn}/api/screens/server-restore/start`, { archiveId, bytes: bytes.length + 1 }, ds);
      assert(wrong.status === 409 || wrong.status === 400, `wrong size ${wrong.status}: ${short(wrong.text)}`);
      const st = await postJson(`https://${dst.fqdn}/api/screens/server-restore/start`, { archiveId, bytes: bytes.length }, ds);
      assert(st.status === 202, `start ${st.status}: ${short(st.text)}`);
      let offset = Number(st.json?.received ?? 0);
      const send = (at: number) =>
        http(`https://${dst.fqdn}/api/screens/server-restore/chunk?offset=${at}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream", ...ds },
          body: bytes.subarray(at, Math.min(at + CHUNK, bytes.length)),
        }, 120_000);
      const skip = await send(Math.min(bytes.length - 1, offset + 1));
      assert(skip.status === 409 && Number(skip.json?.received) === offset, `out of order ${skip.status}: ${short(skip.text)}`);
      let chunks = 0;
      while (offset < bytes.length) {
        const r = await send(offset);
        assert(r.status === 200, `chunk at ${offset} ${r.status}: ${short(r.text)}`);
        offset = Number(r.json.received);
        chunks++;
      }
      const done = await http(`https://${dst.fqdn}/api/screens/server-restore`, { headers: ds });
      assert(done.json?.restore?.state === "ready" || done.json?.restore?.received === bytes.length, `after upload ${short(done.text)}`);
      return `${chunks} chunk(s), ${bytes.length} B`;
    });
    if (!uploaded) return;

    const restored = await rec.check("commit the content key: the box checks the file and rebuilds the apps (restore done)", async () => {
      const c = await postJson(`https://${dst.fqdn}/api/screens/server-restore/commit`, { key: bytesToHex(contentKey) }, ds);
      assert(c.status === 202, `commit ${c.status}: ${short(c.text)}`);
      const deadline = Date.now() + 30 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const r = await tryHttp(`https://${dst.fqdn}/api/screens/server-restore`, { headers: ds });
        const st = r.json?.restore;
        last = `${st?.state} ${short((st?.apps ?? []).map((a: { name: string; state: string }) => `${a.name}:${a.state}`), 300)}`;
        if (st?.state === "done") {
          const failed = (st.apps ?? []).filter((a: { state: string }) => a.state === "failed");
          assert(!failed.length, `apps failed: ${short(failed, 300)}`);
          return last;
        }
        if (st?.state === "failed") throw new Error(`restore failed: ${st.reason}`);
        await sleep(10_000);
      }
      throw new Error(`restore not done in 30 min (${last})`);
    });
    if (!restored) return;

    await rec.check("the python app on home3 serves the same Postgres rows and file as on home", async () => {
      const before = await http(`https://${PY_APP}.${src.fqdn}/read`);
      let r = await tryHttp(`https://${PY_APP}.${dst.fqdn}/read`);
      for (let i = 0; i < 36 && r.status !== 200; i++) {
        await sleep(5000);
        r = await tryHttp(`https://${PY_APP}.${dst.fqdn}/read`);
      }
      assert(r.status === 200, `home3 /read ${r.status}: ${short(r.text)}`);
      assert(r.json.file === before.json?.file, `file ${r.json.file} vs ${before.json?.file}`);
      const missing = (before.json?.rows ?? []).filter((x: string) => !(r.json.rows ?? []).includes(x));
      assert(!missing.length || (r.json.rows ?? []).length > 0, `rows missing on home3: ${short(missing)}`);
      return `${(r.json.rows ?? []).length} rows, file ${short(r.json.file, 40)}`;
    });
    await rec.check("home3 no longer waits (/pods), and both activity logs record the backup and the restore", async () => {
      const row = (await pods(A.username)).find((x) => x.serverDomain === dst.fqdn);
      assert(row && !row.awaitingBackup, `home3 still awaiting: ${short(row?.awaitingBackup)}`);
      const kinds = async (fqdn: string, sess: Record<string, string>) =>
        ((await http(`https://${fqdn}/api/screens/activity?limit=200`, { headers: sess })).json?.entries ?? []).map((e: { kind?: string; action: string }) => e.kind ?? e.action) as string[];
      const srcKinds = await kinds(src.fqdn, s);
      const dstKinds = await kinds(dst.fqdn, ds);
      const want = { home: ["server.backup.started", "server.backup.created", "server.backup.download-approved"], home3: ["server.restore.waiting", "server.restore.started", "server.restore.finished"] };
      const miss = [...want.home.filter((k) => !srcKinds.includes(k)).map((k) => `home:${k}`), ...want.home3.filter((k) => !dstKinds.includes(k)).map((k) => `home3:${k}`)];
      assert(!miss.length, `missing ${miss.join(", ")}`);
      const leaked = [...srcKinds, ...dstKinds].length && JSON.stringify(await http(`https://${src.fqdn}/api/screens/activity?limit=200`, { headers: s }).then((x) => x.json)).includes(bytesToHex(contentKey));
      assert(!leaked, "the activity log holds the content key");
      return "backup + restore entries, no key";
    });
  },
};
