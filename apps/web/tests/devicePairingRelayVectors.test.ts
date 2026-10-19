import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module
import { aeadOpen, deriveMaterial } from "../public/webapp/lib/pairingRelay.js";

// test-vectors/device-pairing-relay.json: the file Android (and iOS) read. The
// web is the reference, so this runs it for real against the file.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const V = JSON.parse(readFileSync(join(ROOT, "test-vectors/device-pairing-relay.json"), "utf8")) as Record<string, any>;

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const privateKey = (hex: string) =>
  crypto.subtle.importKey("pkcs8", Buffer.concat([PKCS8_X25519, Buffer.from(hex, "hex")]), { name: "X25519" }, false, ["deriveBits"]);

describe("device-pairing-relay vectors", () => {
  it("both ends derive the file's code and open its sealed bytes", async () => {
    const admin = await deriveMaterial(await privateKey(V.adminPrivHex), V.incomingPubB64u);
    const incoming = await deriveMaterial(await privateKey(V.incomingPrivHex), V.adminPubB64u);
    expect(admin.sas).toBe(V.sas);
    expect(incoming.sas).toBe(V.sas);
    for (const name of ["leg1Payload", "bundle"]) {
      const e = V[name];
      const plain = await aeadOpen(incoming.kEncDecrypt, e.ciphertextB64u, e.nonceB64u);
      expect(new TextDecoder().decode(plain)).toBe(e.plaintext);
    }
  });
});
