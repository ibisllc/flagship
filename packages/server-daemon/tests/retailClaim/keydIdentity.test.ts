import { describe, expect, it } from "vitest";
import { hybridSigKeygen, hybridSign, signBoxClaimReceipt, verifyBoxClaimReceipt } from "@flagship/protocol";
import { checkSign, BOX_SIGN_PURPOSES } from "../../../keyd/src/policy.js";
import { keydClaimIdentity } from "../../src/retailClaim/keydIdentity.js";

const edSeed = new Uint8Array(32).fill(0x71);
const mlSeed = new Uint8Array(32).fill(0x72);
const { publicKey, secretKey } = hybridSigKeygen(edSeed, mlSeed);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const keyd = {
  boxPublicKey: () => publicKey.subarray(0, 32),
  pqPublicKeyHex: () => hex(publicKey.subarray(32)),
  signHybridAsBox(msg: Uint8Array) {
    checkSign(msg, hex(publicKey.subarray(0, 32)), BOX_SIGN_PURPOSES, { mldsaPubHex: hex(publicKey.subarray(32)) });
    return hybridSign(secretKey, "flagship/box-claim-receipt/v1", msg);
  },
};

describe("claim receipts signed through keyd", () => {
  it("passes keyd's policy and verifies on the phone", async () => {
    const id = keydClaimIdentity(keyd);
    expect(id.stkHybridPubHex).toBe(hex(publicKey));
    const fields = {
      mode: "open" as const,
      serverDomain: "home.alice.flagship.services",
      serial: "retail-serial-0001",
      stkHybridPub: id.stkHybridPubHex,
      bootKeyBindingSha256: "",
      model: "Mini PC N100",
      imageVersion: "0.4.0",
      transcript: "0f".repeat(64),
      issuedAt: 1_790_000_000_000,
    };
    const receipt = await signBoxClaimReceipt(fields, id.sign);
    const v = verifyBoxClaimReceipt(receipt, { transcriptHex: fields.transcript, mode: "open", serverDomain: fields.serverDomain, serial: fields.serial });
    expect(v.stkPubHex).toBe(hex(publicKey.subarray(0, 32)));
  });

  it("refuses a keyd without an ML-DSA key", () => {
    expect(() => keydClaimIdentity({ ...keyd, pqPublicKeyHex: () => null })).toThrow(/ML-DSA/);
  });
});
