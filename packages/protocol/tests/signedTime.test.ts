import { describe, expect, it } from "vitest";
import { ed } from "../src/edSync.js";
import { canonicalSignedTime, signSignedTime, verifySignedTime } from "../src/signedTime.js";

const CA = new Uint8Array(32).fill(0xca);
const CA_PUB = Buffer.from(ed.getPublicKey(CA)).toString("hex");
const NONCE = "ab".repeat(32);
const T = 1_790_000_000_000;
const PIN = "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae";
const chain = (keys: string[], until = Infinity) => ({ authorizedCaKeys: (now: number) => (now < until ? keys : []) });

describe("CA-signed time", () => {
  it("accepts the answer to this nonce signed by a CA key authorized at that time", () => {
    expect(new TextDecoder().decode(canonicalSignedTime(NONCE, T))).toBe(`flagship/signed-time/v1|${NONCE}|${T}`);
    expect(verifySignedTime(signSignedTime(NONCE, T, CA), NONCE, chain([CA_PUB]), PIN)).toEqual({ ok: true, timeMs: T });
  });

  it("refuses a replayed nonce, an unauthorized key, a lease that ended, a forged signature and no pin", () => {
    const w = signSignedTime(NONCE, T, CA);
    expect(verifySignedTime(w, "cd".repeat(32), chain([CA_PUB]), PIN)).toEqual({ ok: false, code: "nonce" });
    expect(verifySignedTime(w, NONCE, chain(["00".repeat(32)]), PIN)).toEqual({ ok: false, code: "key-not-authorized" });
    expect(verifySignedTime(w, NONCE, chain([CA_PUB], T), PIN)).toEqual({ ok: false, code: "key-not-authorized" });
    expect(verifySignedTime({ ...w, timeMs: T + 1 }, NONCE, chain([CA_PUB]), PIN)).toEqual({ ok: false, code: "signature" });
    expect(verifySignedTime(w, NONCE, chain([CA_PUB]), "")).toEqual({ ok: false, code: "key-not-authorized" });
    expect(verifySignedTime({ ...w, timeMs: "1" }, NONCE, chain([CA_PUB]), PIN)).toEqual({ ok: false, code: "malformed" });
    expect(verifySignedTime(null, NONCE, null, PIN)).toEqual({ ok: false, code: "malformed" });
  });
});
