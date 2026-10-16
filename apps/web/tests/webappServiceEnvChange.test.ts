// The webapp's env changes (public/webapp/lib/serviceEnvChange.js) against
// packages/protocol/test-vectors/service-env-change: byte-identical canonical
// bytes, signatures the protocol accepts, and the request bodies both env
// views send.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveIRK, ed, verifyServiceEnvChange, type ServiceEnvChange } from "@flagship/protocol";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/service-env-change/vectors.json"), "utf8"),
) as {
  umkSeedHex: string;
  pub: string;
  cases: Array<{ change: ServiceEnvChange; value?: string; canonical: string; signature: string }>;
  invalid: ServiceEnvChange[];
};
const lib = () => import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "lib", "serviceEnvChange.js")).href);
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });

describe("service-env-change on the webapp (test-vectors/service-env-change)", () => {
  it("reproduces every vector's hash and canonical bytes", async () => {
    const m = await lib();
    for (const c of V.cases) {
      if (c.value !== undefined) expect(await m.serviceEnvValueSha256(c.value)).toBe(c.change.valueSha256);
      expect(utf8(m.canonicalServiceEnvChange(c.change))).toBe(c.canonical);
      expect(ed.verify(fromHex(c.signature), m.canonicalServiceEnvChange(c.change), fromHex(V.pub))).toBe(true);
    }
  });

  it("refuses every invalid change", async () => {
    const m = await lib();
    for (const c of V.invalid) expect(() => m.canonicalServiceEnvChange(c)).toThrow();
  });

  it("signs a set and an unset the box verifies, each with its own fresh nonce", async () => {
    const m = await lib();
    const sign = async (bytes: Uint8Array) => ed.sign(bytes, irk.privateKey);
    const base = { serverId: "home.alice.flagship.services", serviceId: "alice--weatherbot" };
    const set = await m.signedEnvChangeBody({ ...base, op: "set", name: "API_KEY", value: "s|cret" }, sign, 1792000000000);
    expect(set.value).toBe("s|cret");
    expect(set.change).toMatchObject({ ...base, op: "set", name: "API_KEY", issuedAt: 1792000000000 });
    expect(verifyServiceEnvChange(set.change, fromHex(set.signature), irk.publicKey)).toBe(true);
    const unset = await m.signedEnvChangeBody({ ...base, op: "unset", name: "API_KEY" }, sign, 1792000000001);
    expect("value" in unset).toBe(false);
    expect(unset.change.valueSha256).toBe("");
    expect(verifyServiceEnvChange(unset.change, fromHex(unset.signature), irk.publicKey)).toBe(true);
    expect(unset.change.nonce).not.toBe(set.change.nonce);
  });

  it("says why a name can't be used", async () => {
    const m = await lib();
    expect(m.envNameError("API_KEY")).toBeNull();
    expect(m.envNameError("my-key")).toMatch(/letters, digits and _/);
    expect(m.envNameError("FLAGSHIP_APP_ID")).toMatch(/set by your server/);
  });
});
