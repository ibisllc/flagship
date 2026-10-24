// Gym boxes have no phone to hand them the account's cloud gossip key, and
// without it a box runs no leadership gossip (its /api/leads stays
// gossipActive:false with no leads) and no box-to-box access sync. The gym
// deposits it, as the owner's phone does after a box registers; each box
// restarts once it has the key.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { buildCgkDelivery, cgkDeliveryToCarrierHex, deriveCGK, signDeviceEndpointClaim } from "@flagship/protocol";
import { pods, type Account, type Box } from "./fleet.js";
import { CONTROL, assert, postJson, short, sleep, tryHttp } from "./harness.js";

export async function depositCgk(A: Account, boxes: Box[]): Promise<void> {
  const list = await pods(A.username);
  const cgk = deriveCGK(A.keys.umk);
  for (const b of boxes) {
    const stkHex = String(list.find((p) => p.serverDomain === b.fqdn)?.identityPubKey ?? "").toLowerCase();
    assert(/^[0-9a-f]{64}$/.test(stkHex), `no STK for ${b.serverName}`);
    const now = Date.now();
    const { delivery, signature } = buildCgkDelivery({
      serverDomain: b.fqdn,
      cgk,
      boxIdentityPub: Buffer.from(stkHex, "hex"),
      irk: A.keys.irk,
      issuedAt: now,
    });
    const nonce = randomBytes(32);
    const auth = { username: A.username, endpointLabel: "device", phoneIrkPub: A.keys.irk.publicKey, issuedAt: now, expiresAt: now + 120_000, nonce };
    const r = await postJson(`https://${CONTROL}/api/server/${encodeURIComponent(b.fqdn)}/cgk-deposit`, {
      auth: { ...auth, phoneIrkPub: bytesToHex(auth.phoneIrkPub), nonce: bytesToHex(nonce) },
      authSignature: bytesToHex(signDeviceEndpointClaim(auth, A.keys.irk)),
      deposit: {
        serverDomain: b.fqdn,
        requestNonceHex: randomBytes(32).toString("hex"),
        stkPub: stkHex,
        sealed: cgkDeliveryToCarrierHex(delivery, signature),
        issuedAt: now,
      },
    });
    assert(r.status === 200, `cgk deposit ${b.serverName} ${r.status}: ${short(r.text)}`);
  }
}

/** True once every box answers /api/leads with gossipActive:true (they restart after the deposit). */
export async function waitGossiping(boxes: Box[], ms = 8 * 60_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    let all = true;
    for (const b of boxes) {
      const r = await tryHttp(`https://${b.fqdn}/api/leads`, {}, 15_000).catch(() => null);
      if (r?.json?.gossipActive !== true) all = false;
    }
    if (all) return true;
    await sleep(15_000);
  }
  return false;
}
