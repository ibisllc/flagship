// The webapp's verify side of packages/protocol/test-vectors/pq-authority: a device grant's
// canonical bytes and its hybrid companion through the browser's critical-signature gate
// (lib/pqBinding.js), and the new admin root's binding a rotation companion carries. The
// browser signs neither record (keyless-web rule) and never reads a rotation chain, so the
// rotation's own v2 signature is checked by the box, .com and the phones, not here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PqBindingError, verifyCriticalSignature, verifyPqKeyBinding } from "../public/webapp/lib/pqBinding.js";
import { TAG_DEVICE_GRANT, deviceGrantCanonicalBytes } from "../public/webapp/lib/crossDevicePairing.js";

const V = JSON.parse(readFileSync(join(__dirname, "../../../packages/protocol/test-vectors/pq-authority/vectors.json"), "utf8"));
const webGrant = (f: { devicePubKeyHex: string }) => ({ ...f, devicePubHex: f.devicePubKeyHex });
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof PqBindingError) return e.code;
    throw e;
  }
  return "ok";
};
const binding = (name: string | null) => {
  if (name === null) return null;
  const w = V.bindings[name];
  return verifyPqKeyBinding(w, { role: w.role, subjectId: w.subjectId, ed25519PubHex: w.ed25519PubHex, now: V.now });
};

describe("pq-authority vectors in the webapp", () => {
  it("builds each grant's canonical bytes", () => {
    expect(TAG_DEVICE_GRANT).toBe("flagship/device-capability-grant/v2");
    for (const g of Object.values(V.grants) as { fields: { devicePubKeyHex: string }; canonical: string }[]) {
      expect(new TextDecoder().decode(deviceGrantCanonicalBytes(webGrant(g.fields)))).toBe(g.canonical);
    }
  });

  for (const c of V.grantCases) {
    it(`grant: ${c.name}`, () => {
      const got = code(() => verifyCriticalSignature({
        message: deviceGrantCanonicalBytes(webGrant(c.grant)),
        expectedPurpose: TAG_DEVICE_GRANT,
        envelope: c.pq,
        signerEd25519PubHex: V.bindings[c.signer].ed25519PubHex,
        binding: binding(c.signerBinding ?? null),
        policy: c.policy,
      }));
      expect(got).toBe(c.expect.ok ? "ok" : c.expect.code);
    });
  }

  it("verifies the new root's binding a rotation companion carries, and refuses one for another account", () => {
    const f = V.rotation.fields;
    const expectNew = { role: "admin-root", subjectId: f.username, ed25519PubHex: f.newAdminRootPubHex, now: V.now };
    expect(verifyPqKeyBinding(V.rotation.pq.newRootBinding, expectNew).mldsaPubHex).toBe(V.bindings.newRoot.mldsaPubHex);
    expect(code(() => verifyPqKeyBinding(V.bindings.newRootWrongSubject, expectNew))).toBe("binding-subject");
  });
});
