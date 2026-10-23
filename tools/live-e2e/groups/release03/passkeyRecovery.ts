// Passkey-checked recovery on the gym .com (SEC-REPAIR-001, 0.3), through the HTTP routes: the challenge
// answers for any name (no account oracle) and fails closed without its secret; a record set up without a
// passkey key keeps the passphrase-only path and says `passkeyLegacy`; a registration for another site is
// refused. A full passkey ceremony needs a browser on the gym's recovery page (a Playwright virtual
// authenticator, once that page follows its own host); it is not run here.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha256";
import { ciphertextDigestHex, signRecoveryRecord, type RecoveryRecordV2 } from "@flagship/protocol";
import { CONTROL, assert, http, postJson, short } from "../../lib/harness.js";
import type { Group } from "../types.js";

const VECTORS = join(import.meta.dirname, "../../../../packages/protocol/test-vectors/recovery-passkey/vectors.json");

export const passkeyRecovery: Group = {
  name: "passkey-recovery",
  title: "recovery: challenge without an account oracle, the legacy passphrase path, a passkey for another site refused",
  needs: ["A1"],
  phase: 1,
  async run({ A, rec }) {
    const base = `https://${CONTROL}/api/recovery/by-username`;
    await rec.check("a challenge is issued for the account, and for a name that does not exist (no oracle)", async () => {
      const r = await postJson(`${base}/${A.username}/challenge`, {});
      if (r.status === 503) throw new Error("passkey-unavailable: set FLAGSHIP_RECOVERY_PROOF_SECRET on the gym Worker");
      assert(r.status === 200 && typeof r.json?.challenge === "string" && r.json.expiresAt > Date.now(), `got ${r.status}: ${short(r.text)}`);
      const ghost = await postJson(`${base}/nobody${randomBytes(3).toString("hex")}/challenge`, {});
      assert(ghost.status === 200, `a missing name got ${ghost.status}`);
      return `expires in ${Math.round((r.json.expiresAt - Date.now()) / 1000)} s`;
    });

    const user = await http(`https://${CONTROL}/api/username/${A.username}`);
    const adminRootPubHex = typeof user.json?.adminRootPub === "string" ? user.json.adminRootPub.toLowerCase() : "none";
    const fetchToken = randomBytes(32);
    const wrappedUmk = randomBytes(60);
    const record = (credentialIdHex: string): RecoveryRecordV2 => ({
      op: "put", username: A.username, irkPubHex: bytesToHex(A.keys.irk.publicKey), adminRootPubHex, credentialIdHex,
      wrappedUmkDigestHex: ciphertextDigestHex(wrappedUmk), adminRoot: { change: "none" }, acmeKey: { change: "none" },
      fetchTokenHashHex: bytesToHex(sha256(fetchToken)), prfSaltHashHex: bytesToHex(randomBytes(32)), kdfVersion: 1, algVersion: 1,
      policy: "passkey-and-passphrase", generation: 1, nonceHex: randomBytes(16).toString("hex"), priorDigestHex: "genesis", issuedAt: Date.now(),
    });
    const upload = (claim: RecoveryRecordV2, extra: Record<string, unknown> = {}) =>
      postJson(`https://${CONTROL}/api/recovery`, { claim, signature: bytesToHex(signRecoveryRecord(claim, A.keys.irk)), wrappedUmk: wrappedUmk.toString("base64"), ...extra });

    await rec.check("a passkey registered for another site is refused at enrolment", async () => {
      const v = JSON.parse(readFileSync(VECTORS, "utf8")) as { entries: Array<{ credentialIdHex: string; attestationObject: string }> };
      const e = v.entries[0]!;
      const r = await upload(record(e.credentialIdHex), { passkeyAttestationObject: e.attestationObject });
      assert(r.status === 403, `got ${r.status}: ${short(r.text)}`);
      return short(r.json?.error, 80);
    });
    const up = await rec.check("a record without a passkey key is stored (passkeyChecked false) and says passkeyRequired false", async () => {
      const r = await upload(record(randomBytes(16).toString("hex")));
      assert(r.status === 200 && r.json?.passkeyChecked === false, `upload ${r.status}: ${short(r.text)}`);
      const meta = await http(`${base}/${A.username}`);
      assert(meta.status === 200 && meta.json?.passkeyRequired === false, `metadata ${meta.status}: ${short(meta.text)}`);
      return "legacy record";
    });
    if (!up) return;
    await rec.check("its fetch takes the passphrase token alone and says passkeyLegacy (the apps ask once to update)", async () => {
      const r = await postJson(`${base}/${A.username}/fetch`, { fetchToken: fetchToken.toString("hex"), issuedAt: Date.now() });
      assert(r.status === 200 && r.json?.passkeyLegacy === true, `got ${r.status}: ${short(r.text)}`);
      return "passkeyLegacy: true";
    });
    await rec.check("a wrong passphrase token is refused", async () => {
      const r = await postJson(`${base}/${A.username}/fetch`, { fetchToken: randomBytes(32).toString("hex"), issuedAt: Date.now() });
      assert(r.status === 403 || r.status === 429, `got ${r.status}: ${short(r.text)}`);
      return String(r.status);
    });
  },
};
