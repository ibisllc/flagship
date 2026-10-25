/**
 * V01 adversarial integration: first contact between a new server and the device that created it
 * (docs/first-contact.md, protocol enrollment.ts, boxKeyPin.ts). The attacker is a hostile `.com` or
 * relay that sees the box's first request and wants the phone to pin a key of its own, or a thief
 * holding a stolen recipe.
 *
 *   AT-FC-01  the enrollment proof binds secret, server, key and order serial
 *   AT-FC-02  the box proves from its recipe once, then forgets the secret
 *   AT-FC-03  Studio's "seen" MAC cannot be forged or moved to another server or key
 *   AT-FC-04  the six-digit code is 20 bits: collisions are cheap, so only the proof binds the key
 *   AT-FC-05  after pinning, any other key (whatever spelling) is a mismatch, never a silent re-pin
 *   AT-FC-06  a boot-only key is accepted only under the PINNED STK and this server's name
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideBoxKeyPin,
  ed,
  enrollmentProofHex,
  serverCode,
  serverSeenMacHex,
  signBootKeyBinding,
  verifyBootKeyBinding,
  verifyEnrollmentProof,
  verifyServerSeen,
  type EnrollmentStatement,
} from "../../../packages/protocol/src/index.js";
import { enrollmentDeviceInfo, forgetEnrollmentSecret } from "../../../packages/server-daemon/src/enrollment.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const SECRET = new Uint8Array(32).fill(0x42);
const STK = hex(ed.getPublicKey(new Uint8Array(32).fill(1)));
const MITM = hex(ed.getPublicKey(new Uint8Array(32).fill(2)));
const S: EnrollmentStatement = { serverDomain: "home.alice.flagship.services", stkPubHex: STK, authCodeSerial: "SER-1" };

describe("first contact", () => {
  it("AT-FC-01 a proof for (server, key, serial) under the recipe secret verifies only for exactly that statement (catches: a hostile .com substituting its key, or moving a proof to another server or order)", () => {
    const proof = enrollmentProofHex(SECRET, S);
    expect(verifyEnrollmentProof(SECRET, S, proof)).toBe(true);
    expect(verifyEnrollmentProof(SECRET, { ...S, serverDomain: "HOME.ALICE.FLAGSHIP.SERVICES" }, proof)).toBe(true); // DNS case only
    expect(verifyEnrollmentProof(SECRET, { ...S, stkPubHex: MITM }, proof)).toBe(false);
    expect(verifyEnrollmentProof(SECRET, { ...S, serverDomain: "home2.alice.flagship.services" }, proof)).toBe(false);
    expect(verifyEnrollmentProof(SECRET, { ...S, authCodeSerial: "SER-2" }, proof)).toBe(false);
    expect(verifyEnrollmentProof(new Uint8Array(32).fill(0x43), S, proof)).toBe(false);
    // Malformed inputs never throw and never pass.
    for (const bad of [undefined, null, "", proof.slice(0, 63), `${proof}00`, 42, { proof }]) expect(verifyEnrollmentProof(SECRET, S, bad)).toBe(false);
    expect(verifyEnrollmentProof(SECRET, { ...S, stkPubHex: STK.toUpperCase() }, proof)).toBe(false);
    // The separator cannot alias two statements.
    expect(verifyEnrollmentProof(SECRET, { ...S, authCodeSerial: "SER-1|x" }, proof)).toBe(false);
  });

  it("AT-FC-02 the box proves from its install blob, then forgets the secret so a later copy of the disk cannot enroll another key (catches: a reusable enrollment secret)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-"));
    const blob = join(dir, "install-blob.json");
    writeFileSync(blob, JSON.stringify({ enrollmentKeyHex: hex(SECRET), authCode: { serial: "SER-1" }, other: 1 }));
    const first = await enrollmentDeviceInfo({ blobPath: blob, serverDomain: S.serverDomain, stkPubHex: STK });
    expect(verifyEnrollmentProof(SECRET, S, first.enrollmentProof)).toBe(true);
    await forgetEnrollmentSecret(blob);
    const after = JSON.parse(readFileSync(blob, "utf8")) as Record<string, unknown>;
    expect(after.enrollmentKeyHex).toBeUndefined();
    expect(after.other).toBe(1);
    expect(await enrollmentDeviceInfo({ blobPath: blob, serverDomain: S.serverDomain, stkPubHex: MITM })).toEqual({});
    // A malformed secret proves nothing.
    writeFileSync(blob, JSON.stringify({ enrollmentKeyHex: "zz", authCode: { serial: "SER-1" } }));
    expect(await enrollmentDeviceInfo({ blobPath: blob, serverDomain: S.serverDomain, stkPubHex: STK })).toEqual({});
  });

  it("AT-FC-03 Studio's seen-MAC verifies only under the confirm key for that server and key, and is not interchangeable with the enrollment proof (catches: .com forging 'Studio saw this key')", () => {
    const k = new Uint8Array(32).fill(0x55);
    const mac = serverSeenMacHex(k, S.serverDomain, STK);
    expect(verifyServerSeen(k, S.serverDomain, STK, mac)).toBe(true);
    expect(verifyServerSeen(k, S.serverDomain, MITM, mac)).toBe(false);
    expect(verifyServerSeen(k, "home2.alice.flagship.services", STK, mac)).toBe(false);
    expect(verifyServerSeen(new Uint8Array(32).fill(0x56), S.serverDomain, STK, mac)).toBe(false);
    // Same key bytes used for both: the tags keep the two statements apart.
    expect(serverSeenMacHex(SECRET, S.serverDomain, STK)).not.toBe(enrollmentProofHex(SECRET, S));
    expect(verifyServerSeen(SECRET, S.serverDomain, STK, enrollmentProofHex(SECRET, S))).toBe(false);
  });

  it("AT-FC-04 two keys sharing a six-digit server code are found in a few thousand tries, and the enrollment proof still refuses the impostor (catches: treating the human-compared code as the binding)", () => {
    const seen = new Map<string, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; i < 20_000 && !pair; i++) {
      const k = hex(ed.getPublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j < 4 ? (i >> (8 * j)) & 255 : 7))));
      const c = serverCode(k);
      const prior = seen.get(c);
      if (prior) pair = [prior, k];
      else seen.set(c, k);
    }
    expect(pair).not.toBeNull();
    const [real, impostor] = pair!;
    expect(serverCode(real)).toBe(serverCode(impostor));
    const proof = enrollmentProofHex(SECRET, { ...S, stkPubHex: real });
    expect(verifyEnrollmentProof(SECRET, { ...S, stkPubHex: impostor }, proof)).toBe(false);
  });

  it("AT-FC-05 once a server's key is pinned, another key is a mismatch in any spelling; garbage is invalid, never 'first' (catches: a later .com echo silently re-pinning)", () => {
    expect(decideBoxKeyPin(null, STK)).toBe("first");
    expect(decideBoxKeyPin(STK, STK.toUpperCase())).toBe("match");
    expect(decideBoxKeyPin(STK, MITM)).toBe("mismatch");
    expect(decideBoxKeyPin(STK.toUpperCase(), MITM)).toBe("mismatch");
    for (const bad of [`0x${STK}`, STK.slice(2), `${STK} `, "", "g".repeat(64)]) {
      expect(decideBoxKeyPin(STK, bad), bad).toBe("invalid");
      expect(decideBoxKeyPin(null, bad), bad).toBe("invalid");
    }
  });

  it("AT-FC-06 a boot-only key binding verifies only under the pinned STK and for this server (catches: .com handing the phone a boot key it chose)", () => {
    const stk = new Uint8Array(32).fill(1);
    const b = { serverDomain: S.serverDomain, bootPubHex: hex(ed.getPublicKey(new Uint8Array(32).fill(9))), issuedAt: 1 };
    const sig = signBootKeyBinding(b, { privateKey: stk, publicKey: ed.getPublicKey(stk) });
    expect(verifyBootKeyBinding(b, sig, ed.getPublicKey(stk), S.serverDomain)).toBe(true);
    expect(verifyBootKeyBinding(b, sig, ed.getPublicKey(new Uint8Array(32).fill(2)), S.serverDomain)).toBe(false);
    expect(verifyBootKeyBinding(b, sig, ed.getPublicKey(stk), "home2.alice.flagship.services")).toBe(false);
    const mitmSig = signBootKeyBinding(b, { privateKey: new Uint8Array(32).fill(2), publicKey: ed.getPublicKey(new Uint8Array(32).fill(2)) });
    expect(verifyBootKeyBinding(b, mitmSig, ed.getPublicKey(stk), S.serverDomain)).toBe(false);
  });
});
