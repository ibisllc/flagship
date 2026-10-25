// SEC-REPAIR-001 on the webapp: the recovery record carries the passkey's attestation, a recovery
// maps `.com`'s passkey refusals to the shared sentences, a record made before the passkey check is
// updated in the recovery window (or asked about once), and wipe & restart sends the new passkey's
// attestation. Pinned against packages/protocol/test-vectors/recovery-passkey.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed } from "@flagship/protocol";

const session: { umk: Uint8Array | null; username: string | null } = { umk: null, username: null };
vi.mock("../public/webapp/lib/state.js", () => ({ getSession: () => session }));
vi.mock("../public/webapp/lib/toast.js", () => ({ toast: vi.fn() }));

// @ts-expect-error plain browser module
import * as rec from "../public/webapp/lib/recovery.js";
// @ts-expect-error plain browser module
import { maybeAskRecoveryUpdate, RECOVERY_UPDATE_COPY } from "../public/webapp/lib/recoveryUpdate.js";
// @ts-expect-error plain browser module
import { recoveryUpdateAsked } from "../public/webapp/lib/recoveryUpdateFlag.js";
// @ts-expect-error plain browser module
import { deriveIrkVersioned, bytesToHex } from "../public/webapp/keystore.js";
// @ts-expect-error plain browser module
import { canonicalRecoveryRecordBytes } from "../public/webapp/lib/recoveryRecord.js";
// @ts-expect-error plain browser module
import { runWipeRestartCeremony } from "../public/webapp/lib/wipeRestartCeremony.js";

const vectors = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/recovery-passkey/vectors.json"), "utf8"));
const ATT: string = vectors.entries[0].attestationObject;
const CRED: string = vectors.entries[0].credentialIdHex;

const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const b64 = (n: number) => Buffer.from(Uint8Array.from({ length: n }, (_, i) => i)).toString("base64");

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

type Sent = { url: string; init?: RequestInit };
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let sent: Sent[] = [];
let irkPubHex = "";
let stored: Record<string, unknown> | null = null;

beforeEach(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  sent = [];
  stored = null;
  irkPubHex = bytesToHex((await deriveIrkVersioned(SEED, 1)).publicKey);
  session.umk = SEED;
  session.username = "alice";
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    if (url.endsWith("/api/username/alice")) return json(200, { username: "alice", irkPub: irkPubHex, adminRootPub: null });
    if (url.endsWith("/api/recovery/by-username/alice")) return stored ? json(200, stored) : json(404, { error: "no recovery record" });
    if (url.endsWith("/api/recovery") && init?.method === "POST") return json(200, { ok: true, passkeyChecked: true });
    return json(404, { error: "no stub" });
  });
});

afterEach(() => {
  rec.setRecoveryFlowForTests(null);
  vi.unstubAllGlobals();
});

const uploads = () => sent.filter((s) => s.url.endsWith("/api/recovery") && s.init?.method === "POST").map((s) => JSON.parse(String(s.init!.body)));

describe("enrolment sends the passkey's attestation beside the signed record", () => {
  it("setupCloudRecovery posts passkeyAttestationObject from the recovery window", async () => {
    rec.setRecoveryFlowForTests(async (mode: string) => {
      expect(mode).toBe("enroll");
      return { type: "flagship-recovery-enroll-result", credentialIdHex: CRED, wrappedUmkB64: b64(48), fetchTokenHashHex: "ab".repeat(32), prfSaltHashHex: "cd".repeat(32), passkeyAttestationObject: ATT };
    });
    await rec.setupCloudRecovery("alice");
    const [body] = uploads();
    expect(body.passkeyAttestationObject).toBe(ATT);
    expect(body.claim.credentialIdHex).toBe(CRED);
    // The attestation rides beside the claim, never inside the signed bytes.
    expect(new TextDecoder().decode(canonicalRecoveryRecordBytes(body.claim))).not.toContain(ATT);
    expect(recoveryUpdateAsked("alice")).toBe(true);
  });

  it("enrollNewRecoveryPasskey hands the attestation to wipe & restart, which sends it", async () => {
    rec.setRecoveryFlowForTests(async () => ({ type: "flagship-recovery-enroll-result", credentialIdHex: CRED, wrappedUmkB64: b64(48), passkeyAttestationObject: ATT }));
    const reg = await rec.enrollNewRecoveryPasskey(new Uint8Array(32).fill(4), "alice");
    expect(reg.passkeyAttestationObject).toBe(ATT);
    let body: Record<string, unknown> | null = null;
    await runWipeRestartCeremony(
      { username: "alice", umk: SEED, enrollPasskey: async () => reg },
      {
        requireOwnerProfile: () => {},
        fetch: async (_u: string, init: RequestInit) => {
          body = JSON.parse(String(init.body));
          return json(200, { ok: true, auditSeq: 1, revokedGrantIds: [] });
        },
      },
    );
    expect(body!.newPasskeyAttestationObject).toBe(ATT);
    expect((body!.request as { newCredentialId: string }).newCredentialId).toBe(CRED);
  });
});

describe("recovery", () => {
  it("maps .com's passkey refusals to the shared sentences", async () => {
    for (const code of ["passkey-required", "passkey-challenge", "passkey-invalid", "passkey-unavailable"]) {
      rec.setRecoveryFlowForTests(async () => {
        const e = new Error("raw") as Error & { code?: string };
        e.code = code;
        throw e;
      });
      await expect(rec.recoverFromCloud("alice")).rejects.toThrow(rec.RECOVERY_PASSKEY_ERRORS[code]);
    }
    expect(rec.RECOVERY_PASSKEY_ERRORS["passkey-invalid"]).toBe("That passkey isn't the one your account recovery uses.");
  });

  it("tells the window not to ask again once this device asked", async () => {
    const seen: unknown[] = [];
    rec.setRecoveryFlowForTests(async (_m: string, payload: unknown) => {
      seen.push(payload);
      return { type: "flagship-recovery-recover-result", umk: Array.from(SEED), recordLegacy: true, passkeyLegacy: true, updateDeclined: true, username: "alice" };
    });
    await rec.recoverFromCloud("alice");
    expect(seen[0]).toMatchObject({ askUpdate: true });
    expect(recoveryUpdateAsked("alice")).toBe(true);
    await rec.recoverFromCloud("alice");
    expect(seen[1]).toMatchObject({ askUpdate: false });
    expect(uploads()).toHaveLength(0);
  });

  it("an Update chosen in the recovery window writes the new record with the attestation, signed by the account's key", async () => {
    stored = { credentialId: "aa".repeat(16), wrappedUmkHash: "00".repeat(32), hasFetchTokenGate: true, passkeyRequired: false, legacy: true };
    rec.setRecoveryFlowForTests(async () => ({
      type: "flagship-recovery-recover-result",
      username: "alice",
      umk: Array.from(SEED),
      recordLegacy: true,
      passkeyLegacy: true,
      update: { credentialIdHex: CRED, wrappedUmkB64: b64(40), fetchTokenHashHex: "ab".repeat(32), prfSaltHashHex: "cd".repeat(32), passkeyAttestationObject: ATT },
    }));
    session.umk = null;
    await rec.recoverFromCloud("alice");
    const [body] = uploads();
    expect(body.passkeyAttestationObject).toBe(ATT);
    expect(body.claim).toMatchObject({ credentialIdHex: CRED, irkPubHex, priorDigestHex: "legacy", generation: 1 });
    const pub = Buffer.from(irkPubHex, "hex");
    expect(ed.verify(Buffer.from(body.signature, "hex"), canonicalRecoveryRecordBytes(body.claim), pub)).toBe(true);
    expect(rec.takeRecoveryUpdateOutcome()).toBe("updated");
  });

  it("reads a record from before the passkey check as legacy", async () => {
    stored = { credentialId: "aa".repeat(16), passkeyRequired: false };
    expect(await rec.recoveryPasskeyStatus("alice")).toEqual({ exists: true, legacy: true });
    stored = { credentialId: "aa".repeat(16), passkeyRequired: true };
    expect(await rec.recoveryPasskeyStatus("alice")).toEqual({ exists: true, legacy: false });
    stored = null;
    expect(await rec.recoveryPasskeyStatus("alice")).toEqual({ exists: false, legacy: false });
  });
});

describe("the one-time update prompt", () => {
  it("asks once for a legacy record; Not now is remembered and nothing runs", async () => {
    const ask = vi.fn(async () => "later");
    const run = vi.fn();
    const status = async () => ({ exists: true, legacy: true });
    expect(await maybeAskRecoveryUpdate("alice", { status, ask, run })).toBe("later");
    expect(await maybeAskRecoveryUpdate("alice", { status, ask, run })).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("Update runs the re-enrolment; a current record or no record asks nothing", async () => {
    const run = vi.fn(async () => {});
    expect(await maybeAskRecoveryUpdate("bob", { status: async () => ({ exists: true, legacy: true }), ask: async () => "update", run })).toBe("update");
    expect(run).toHaveBeenCalledWith("bob");
    const ask = vi.fn();
    expect(await maybeAskRecoveryUpdate("carol", { status: async () => ({ exists: true, legacy: false }), ask })).toBeNull();
    expect(await maybeAskRecoveryUpdate("dave", { status: async () => ({ exists: false, legacy: false }), ask })).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("uses the shared wording", () => {
    expect(RECOVERY_UPDATE_COPY.title).toBe("Update your account recovery");
    expect(RECOVERY_UPDATE_COPY.body).toBe(
      "Account recovery can now also check your passkey, so your passphrase alone can't download your recovery copy. Enter your recovery passphrase, then confirm with your passkey once.",
    );
    expect([RECOVERY_UPDATE_COPY.update, RECOVERY_UPDATE_COPY.notNow, RECOVERY_UPDATE_COPY.done]).toEqual(["Update", "Not now", "Account recovery updated."]);
  });
});

describe("the recovery window (recovery.<apex>)", () => {
  const page = readFileSync(resolve(__dirname, "../public/recovery/recovery.js"), "utf8");
  const html = readFileSync(resolve(__dirname, "../public/recovery/index.html"), "utf8");
  it("asks .com for a challenge, signs it in the one passkey sheet and sends the answer with the fetch", () => {
    expect(page).toContain('import { attestationField, challengeBytes, fetchPasskeyField } from "./recoveryPasskey.js";');
    expect(page).toContain("/challenge`, { method: \"POST\" }");
    expect(page).toContain("challenge ? challengeBytes(challenge) : randBytes(32)");
    expect(page).toContain("...(passkey ? { passkey } : {})");
    expect(page).toContain("passkeyAttestationObject: attestationField(cred.response.attestationObject)");
    // Passphrase first, then the challenge, then the sheet, then the fetch.
    const order = ["derivePassphraseSecrets(pp, username)", "recoveryChallenge(username", "passkeySheet(hexToBytes(meta.credentialId)", "fetchWrappedUmk(username, fetchToken"].map((s) => page.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("says the shared sentences and offers the update once", () => {
    for (const s of ["This recovery needs your passkey. Try again and choose your Flagship passkey.", "The passkey check expired. Try again.", "That passkey isn't the one your account recovery uses.", "Passkey recovery isn't available right now. Try again later.", "Use at least 8 characters."]) {
      expect(page).toContain(s);
    }
    expect(html).toContain("Longer is stronger and there is no upper limit: a whole sentence you will remember works well");
    expect(html).toContain("Update your account recovery");
    expect(html).toContain('id="recover-update-later"');
  });
});
