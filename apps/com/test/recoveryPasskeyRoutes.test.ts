/**
 * SEC-REPAIR-001 through the Worker's routes and the real D1 schema (migration 0112): enrolment
 * keeps the passkey's key, `/challenge` issues what the passkey signs, and `/fetch` releases the
 * wrapped key only with that signature.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { recoveryPasskeyPolicy } from "@flagship/control-plane";
import { ed, signRecoveryRecord, type RecoveryRecordV2 } from "@flagship/protocol";

const v = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/recovery-passkey/vectors.json", import.meta.url), "utf8"));
const ED = v.entries[1];
const SEED = new Uint8Array(32).fill(0x22); // the vector's Ed25519 passkey
const ORIGIN = "https://flagshipserver.com";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

async function setup() {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  const irkSeed = new Uint8Array(32).fill(9);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(ed.getPublicKey(irkSeed)), claimedAt: 1 });
  const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, FLAGSHIP_RECOVERY_PROOF_SECRET: "route-secret" };
  return { env, storage, irkSeed, close: () => sqlite.close() };
}

const call = async (env: ControlPlaneEnv, method: string, path: string, body?: unknown) => {
  const r = await tryControlPlane(new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
  return { status: r!.status, body: (await r!.json()) as Record<string, unknown> };
};

function assertion(challenge: string) {
  const authenticatorData = Buffer.concat([sha("flagshipserver.com"), Buffer.from([0x05, 0, 0, 0, 9])]);
  const origin = recoveryPasskeyPolicy().origins.find((o) => o.startsWith("android:"))!;
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
  const signature = ed.sign(Buffer.concat([authenticatorData, sha(clientDataJSON)]), SEED);
  return { credentialId: Buffer.from(ED.credentialIdHex, "hex").toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), clientDataJSON: clientDataJSON.toString("base64url"), signature: Buffer.from(signature).toString("base64url") };
}

describe("recovery passkey through the routes and D1", () => {
  it("enrols with the key, issues a challenge, and fetches only with the passkey's signature over it", async () => {
    const w = await setup();
    try {
      const fetchToken = new Uint8Array(32).fill(3);
      const wrapped = new Uint8Array([1, 2, 3]);
      const claim: RecoveryRecordV2 = {
        op: "put", username: "alice", irkPubHex: hex(ed.getPublicKey(w.irkSeed)), adminRootPubHex: "none", credentialIdHex: ED.credentialIdHex,
        wrappedUmkDigestHex: hex(sha(wrapped)), adminRoot: { change: "none" }, acmeKey: { change: "none" }, fetchTokenHashHex: hex(sha(fetchToken)),
        prfSaltHashHex: "cd".repeat(32), kdfVersion: 1, algVersion: 1, policy: "passkey-and-passphrase", generation: 1,
        nonceHex: "ab".repeat(16), priorDigestHex: "genesis", issuedAt: Date.now(),
      };
      const up = await call(w.env, "POST", "/api/recovery", {
        claim, signature: hex(signRecoveryRecord(claim, { privateKey: w.irkSeed, publicKey: ed.getPublicKey(w.irkSeed) })),
        wrappedUmk: Buffer.from(wrapped).toString("base64"), passkeyAttestationObject: ED.attestationObject,
      });
      expect(up).toMatchObject({ status: 200, body: { passkeyChecked: true } });
      expect((await w.storage.webauthnRecovery.get("alice"))?.passkey).toEqual({ coseHex: ED.coseHex, alg: -8 });
      expect((await call(w.env, "GET", "/api/recovery/by-username/alice")).body).toMatchObject({ passkeyRequired: true });

      const ch = await call(w.env, "POST", "/api/recovery/by-username/alice/challenge");
      expect(ch.status).toBe(200);
      const challenge = ch.body.challenge as string;
      const fetchBody = { fetchToken: hex(fetchToken), issuedAt: Date.now() };
      expect((await call(w.env, "POST", "/api/recovery/by-username/alice/fetch", fetchBody)).body).toMatchObject({ code: "passkey-required" });
      const ok = await call(w.env, "POST", "/api/recovery/by-username/alice/fetch", { ...fetchBody, passkey: { challenge, assertion: assertion(challenge) } });
      expect(ok).toMatchObject({ status: 200, body: { passkeyChecked: true, wrappedUmk: Buffer.from(wrapped).toString("base64") } });
    } finally {
      w.close();
    }
  });
});
