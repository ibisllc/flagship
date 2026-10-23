import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { attestationField, challengeBytes, fetchPasskeyField } from "../public/recovery/recoveryPasskey.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/recovery-passkey/vectors.json"), "utf8"));
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

describe("web recovery passkey wire", () => {
  it("builds the enrolment field and the fetch field .com checks, from platform-shaped objects", () => {
    expect(Buffer.from(challengeBytes(v.challenge)).toString("base64url")).toBe(v.challenge);
    for (const e of v.entries) {
      expect(attestationField(bytes(e.attestationObject).buffer)).toBe(e.attestationObject);
      const credential = {
        rawId: bytes(e.assertion.credentialId).buffer,
        response: { authenticatorData: bytes(e.assertion.authenticatorData).buffer, clientDataJSON: bytes(e.assertion.clientDataJSON).buffer, signature: bytes(e.assertion.signature).buffer },
      };
      expect(fetchPasskeyField(v.challenge, credential)).toEqual(e.fetchPasskeyField);
    }
  });
});
