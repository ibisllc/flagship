// Import a backup onto a box that is waiting for it (docs/server-backup-and-
// clone.md "Restore a backup"): the pairing order with an admin-root-signed
// restore order beside it goes to the box through `.com`'s sealed pairing
// deposit, the box waits (awaitingBackup on /pods), takes the data part in
// chunks and opens it with the content key.
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  pairingOrderToJson,
  sealForEd25519Recipient,
  signDeviceEndpointClaim,
  signPhoneOrder,
  signServerRestoreOrder,
  type PhoneOrder,
  type ServerRestoreOrder,
} from "@flagship/protocol";
import { pods, type Account, type Box } from "./fleet.js";
import { CONTROL, assert, http, postJson, short, sleep, tryHttp } from "./harness.js";

export const RESTORE_CHUNK = 4 * 1024 * 1024;

/** Sends `dst` its pairing + restore order; waits until it waits for that backup. Returns the owner session it pairs. */
export async function armRestore(acct: Account, dst: Box, meta: { archiveId: string; bytes: number; sha256: string }, minutes = 8): Promise<string> {
  const p = (await pods(acct.username)).find((x) => x.serverDomain === dst.fqdn);
  assert(p?.identityPubKey, `${dst.serverName} /pods row ${short(p)}`);
  const token = randomBytes(24).toString("hex");
  const order: PhoneOrder = { type: "add-paired-session", serverId: dst.fqdn, token, issuedAt: Date.now() };
  const pairing = JSON.parse(pairingOrderToJson(order, signPhoneOrder(order, acct.keys.irk)));
  const restore: ServerRestoreOrder = { serverDomain: dst.fqdn, ...meta, issuedAt: Date.now() };
  pairing.restore = { order: restore, signatureHex: bytesToHex(signServerRestoreOrder(restore, acct.keys.adminRoot)) };
  const issuedAt = Date.now();
  const nonce = new Uint8Array(randomBytes(32));
  const claim = { username: acct.username, endpointLabel: "device", phoneIrkPub: acct.keys.irk.publicKey, issuedAt, expiresAt: issuedAt + 120_000, nonce };
  const d = await postJson(`https://${CONTROL}/api/server/${encodeURIComponent(dst.fqdn)}/pairing-deposit`, {
    auth: { ...claim, phoneIrkPub: bytesToHex(claim.phoneIrkPub), nonce: bytesToHex(nonce) },
    authSignature: bytesToHex(signDeviceEndpointClaim(claim, acct.keys.irk)),
    deposit: {
      serverDomain: dst.fqdn,
      requestNonceHex: randomBytes(32).toString("hex"),
      stkPub: String(p.identityPubKey).toLowerCase(),
      sealed: bytesToHex(sealForEd25519Recipient(new TextEncoder().encode(JSON.stringify(pairing)), hexToBytes(String(p.identityPubKey)))),
      issuedAt,
    },
  });
  assert(d.status === 200, `pairing deposit ${d.status}: ${short(d.text)}`);
  // The box claims deposits on its 5-minute heartbeat.
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const row = (await pods(acct.username)).find((x) => x.serverDomain === dst.fqdn);
    last = short(row?.awaitingBackup ?? "none");
    if (row?.awaitingBackup?.archiveId === meta.archiveId) return token;
    await sleep(15_000);
  }
  throw new Error(`${dst.serverName} never showed awaitingBackup (last ${last})`);
}

/** Uploads the data part in chunks, commits the content key, waits for the restore to finish. */
export async function uploadAndRestore(dst: Box, session: string, archiveId: string, data: Buffer, contentKey: Uint8Array, minutes = 30): Promise<string> {
  const s = { "x-flagship-session": session };
  const st = await postJson(`https://${dst.fqdn}/api/screens/server-restore/start`, { archiveId, bytes: data.length }, s);
  assert(st.status === 202, `start ${st.status}: ${short(st.text)}`);
  let offset = Number(st.json?.received ?? 0);
  while (offset < data.length) {
    const r = await http(`https://${dst.fqdn}/api/screens/server-restore/chunk?offset=${offset}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...s },
      body: data.subarray(offset, Math.min(offset + RESTORE_CHUNK, data.length)),
    }, 120_000);
    assert(r.status === 200, `chunk at ${offset} ${r.status}: ${short(r.text)}`);
    offset = Number(r.json.received);
  }
  const c = await postJson(`https://${dst.fqdn}/api/screens/server-restore/commit`, { key: bytesToHex(contentKey) }, s);
  assert(c.status === 202, `commit ${c.status}: ${short(c.text)}`);
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await tryHttp(`https://${dst.fqdn}/api/screens/server-restore`, { headers: s });
    const job = r.json?.restore;
    last = `${job?.state} ${short((job?.apps ?? []).map((a: { name: string; state: string }) => `${a.name}:${a.state}`), 300)}`;
    if (job?.state === "done") {
      const failed = (job.apps ?? []).filter((a: { state: string }) => a.state === "failed");
      assert(!failed.length, `apps failed: ${short(failed, 300)}`);
      return last;
    }
    if (job?.state === "failed") throw new Error(`restore failed: ${job.reason}`);
    await sleep(10_000);
  }
  throw new Error(`restore not done in ${minutes} min (${last})`);
}
