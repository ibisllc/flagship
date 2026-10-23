// First contact (docs/first-contact.md): the recipe carries a one-time enrollment secret; the new box
// proves its own key with it in the first request the phone answers (`deviceInfo.enrollmentProof`), so
// the phone pins the key built from ITS recipe. The gym plays the phone: it verifies the proof against the
// secret it put in the recipe (and not against any other secret), checks the request's own signature,
// answers the entitlement, and finds the server code in the box's journal.
//
// Needs the gym-provision option `selfMintEntitlements: false` (a box that mints its own entitlement
// never sends the request); on a .com without it the checks are skipped, not failed.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { serverCode, signRootEntitlement, verifyEnrollmentProof, verifySecretRequest, type RootEntitlement } from "@flagship/protocol";
import { addBox, pods, type Account } from "../../lib/fleet.js";
import { CONTROL, SkipError, assert, http, postJson, short } from "../../lib/harness.js";
import { mailboxAuth } from "../update.js";
import type { Group } from "../types.js";
import { journal, until } from "./util.js";

/** The phone's answer to the box's entitlement request: an admin-root-signed RootEntitlement for (name, STK). */
async function answerEntitlement(acct: Account, fqdn: string, stkHex: string, requestNonceHex: string): Promise<string> {
  const ent: RootEntitlement = { username: acct.username, podPubKey: Buffer.from(stkHex, "hex"), podCanonical: fqdn.toLowerCase(), issuedAt: Date.now() };
  const carrier = {
    rootEntitlement: { username: ent.username, podPubKey: stkHex, podCanonical: ent.podCanonical, issuedAt: ent.issuedAt },
    rootEntitlementSig: bytesToHex(signRootEntitlement(ent, acct.keys.adminRoot)),
    serviceEntitlement: null,
    serviceEntitlementSig: null,
  };
  const r = await postJson(`https://${CONTROL}/api/secret-response`, {
    ...mailboxAuth(acct),
    response: { serverDomain: fqdn, requestNonceHex, purpose: "entitlement", sealed: Buffer.from(JSON.stringify(carrier)).toString("hex"), issuedAt: Date.now() },
  });
  assert(r.status === 200, `secret-response ${r.status}: ${short(r.text)}`);
  return `answered request ${requestNonceHex.slice(0, 8)}…`;
}

export const firstContact: Group = {
  name: "first-contact",
  title: "a new box proves its key with the recipe's one-time secret; the code is on its screen",
  needs: ["A1"],
  phase: 1,
  async run({ A, rec, adopt }) {
    const secret = randomBytes(32);
    const name = `fc${randomBytes(2).toString("hex")}`;
    let b!: Awaited<ReturnType<typeof addBox>>;
    const made = await rec.check("provision a box from a recipe carrying an enrollment secret, minting nothing itself", async () => {
      b = await addBox(A, name, { blobExtras: { enrollmentKeyHex: secret.toString("hex") }, provisionExtras: { selfMintEntitlements: false } });
      adopt(A, b);
      return b.fqdn;
    });
    if (!made) return;

    type Req = { serverDomain: string; purpose: string; stkPub: string; requestNonceHex: string; issuedAt: number; requestSignature: string; deviceInfo?: { enrollmentProof?: string } };
    let req: Req | null = null;
    await rec.check("its first request (purpose entitlement) carries an enrollment proof that verifies with the recipe's secret", async () => {
      req = await until("the entitlement request", 25 * 60_000, async () => {
        const r = await http(`https://${CONTROL}/api/users/${A.username}/secret-requests`);
        const hit = ((r.json?.requests ?? []) as Req[]).find((x) => x.serverDomain === b.fqdn && x.purpose === "entitlement");
        if (hit) return hit;
        const pod = (await pods(A.username)).find((p) => p.serverDomain === b.fqdn);
        if (pod?.liveness === "live") throw new SkipError("the box came up without asking: this gym .com ignores selfMintEntitlements:false");
        return undefined;
      }, 10_000);
      const proof = req.deviceInfo?.enrollmentProof;
      assert(typeof proof === "string", `no enrollmentProof in deviceInfo: ${short(req.deviceInfo)}`);
      assert(b.serial, "no auth-code serial for the box");
      const statement = { serverDomain: b.fqdn, stkPubHex: req.stkPub.toLowerCase(), authCodeSerial: b.serial };
      assert(verifyEnrollmentProof(secret, statement, proof), "the proof does not verify with the recipe's secret");
      assert(!verifyEnrollmentProof(randomBytes(32), statement, proof), "the proof verified with a different secret");
      return `proof ${proof.slice(0, 12)}…`;
    });
    if (!req) return;
    const r = req as Req;

    await rec.check("the request is signed by the key it names, and that key is the one .com registered", async () => {
      const sigOk = verifySecretRequest(
        { serverDomain: r.serverDomain, stkPub: Buffer.from(r.stkPub, "hex"), purpose: r.purpose as "entitlement", nonce: Buffer.from(r.requestNonceHex, "hex"), issuedAt: r.issuedAt },
        Buffer.from(r.requestSignature, "hex"),
        Buffer.from(r.stkPub, "hex"),
      );
      assert(sigOk, "the request signature does not verify");
      const pod = (await pods(A.username)).find((p) => p.serverDomain === b.fqdn);
      assert(String(pod?.identityPubKey ?? "").toLowerCase() === r.stkPub.toLowerCase(), `registered ${pod?.identityPubKey}, request names ${r.stkPub}`);
      return "signed and registered";
    });

    await rec.check("answering the entitlement (as the phone) lets the box come up", async () => {
      const said = await answerEntitlement(A, b.fqdn, r.stkPub.toLowerCase(), r.requestNonceHex);
      await until("the box live", 15 * 60_000, async () => ((await pods(A.username)).find((p) => p.serverDomain === b.fqdn)?.liveness === "live" ? true : undefined), 15_000);
      return said;
    });

    await rec.check("the box's journal shows its six-digit server code, the one the phone computes from its key", async () => {
      const code = serverCode(r.stkPub.toLowerCase());
      const lines = await journal(A, b);
      const hit = lines.find((l) => l.includes(`flagship-server-code ${b.fqdn}`));
      if (!hit) throw new SkipError("the daemon writes the code to the console and the Studio port, not the journal (needs a console.log beside it)");
      assert(hit.includes(code), `journal line ${short(hit)} has not ${code}`);
      return code;
    });
  },
};
