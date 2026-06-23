import { describe, expect, it } from "vitest";
import { gcm } from "@noble/ciphers/aes";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  PAIR_PROTOCOL_VERSION,
  PAIR_SESSION_LOCK_MS,
  buildWifiDepositBlob,
  parseWifiDepositBlob,
  LED_SAS_ALPHABET,
  LED_SAS_GLANCES_REQUIRED,
  LED_SAS_PULSE_MS,
  LED_SAS_PULSES_PER_GLANCE,
  LED_SAS_RETRIES,
  deriveSAS,
  deriveSessionKey,
  deriveSharedSecret,
  encodeLedSas,
  encodeSasForDisplay,
  ledSasGlances,
  isWellFormedGlance,
  verifyLedGlance,
  verifyLedSas,
  openWiFiConfig,
  sealWiFiConfig,
  signBoxUnpair,
  signPair,
  stkPubToSuffix6,
  verifyBoxUnpair,
  verifyPair,
  type BoxUnpair,
  type PairPayload,
  type WiFiConfig,
} from "../src/nfcPair.js";
import type { Bytes, Keypair } from "../src/types.js";

function ed25519Keypair(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  const pub = ed25519.getPublicKey(priv);
  return { publicKey: pub, privateKey: priv };
}

function x25519Pair(seed: number): { priv: Bytes; pub: Bytes } {
  const priv = new Uint8Array(32).fill(seed);
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

function makePair(stkPub: Bytes, eBoxPub: Bytes): PairPayload {
  return {
    v: PAIR_PROTOCOL_VERSION,
    stkPub,
    eBoxPub,
    nonce: new Uint8Array(16).fill(7),
    sessionId: new Uint8Array(16).fill(9),
    hint: {
      mdnsName: "flagship-abc.local",
      cloudRendezvousId: "rendezvous-xyz",
      suffix6: stkPubToSuffix6(stkPub),
    },
  };
}

describe("N-PROTO-1: PAIR sign/verify", () => {
  const stk = ed25519Keypair(1);
  const eBox = x25519Pair(2);
  const p = makePair(stk.publicKey, eBox.pub);

  it("round-trips a valid signature", () => {
    const sig = signPair(p, stk);
    expect(verifyPair(p, sig)).toBe(true);
  });

  it("rejects a sig from a different STK", () => {
    const stk2 = ed25519Keypair(99);
    const sig = signPair(p, stk2);
    expect(verifyPair(p, sig)).toBe(false);
  });

  it("rejects tampered eBoxPub (binds ECDH key to identity)", () => {
    const sig = signPair(p, stk);
    const tampered: PairPayload = { ...p, eBoxPub: x25519Pair(3).pub };
    expect(verifyPair(tampered, sig)).toBe(false);
  });

  it("rejects tampered nonce", () => {
    const sig = signPair(p, stk);
    const tampered: PairPayload = { ...p, nonce: new Uint8Array(16).fill(8) };
    expect(verifyPair(tampered, sig)).toBe(false);
  });

  it("rejects tampered hint (MitM swapping discovery target)", () => {
    const sig = signPair(p, stk);
    const tampered: PairPayload = {
      ...p,
      hint: { ...p.hint, mdnsName: "evil.local" },
    };
    expect(verifyPair(tampered, sig)).toBe(false);
  });

  it("encodes suffix6 as last-6 hex of stkPub", () => {
    expect(p.hint.suffix6.length).toBe(6);
    expect(p.hint.suffix6).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe("N-PROTO-1: ECDH + K_session + SAS", () => {
  const stk = ed25519Keypair(1);
  const eBox = x25519Pair(2);
  const ePhone = x25519Pair(3);
  const p = makePair(stk.publicKey, eBox.pub);

  it("both sides derive the same shared secret", () => {
    const ssPhone = deriveSharedSecret(ePhone.priv, eBox.pub);
    const ssBox = deriveSharedSecret(eBox.priv, ePhone.pub);
    expect(ssPhone).toEqual(ssBox);
  });

  it("K_session is 32 bytes and deterministic across peers", () => {
    const ssPhone = deriveSharedSecret(ePhone.priv, eBox.pub);
    const ssBox = deriveSharedSecret(eBox.priv, ePhone.pub);
    const kPhone = deriveSessionKey({
      sharedSecret: ssPhone,
      stkPub: p.stkPub,
      eBoxPub: p.eBoxPub,
      ePhonePub: ePhone.pub,
      nonce: p.nonce,
      sessionId: p.sessionId,
    });
    const kBox = deriveSessionKey({
      sharedSecret: ssBox,
      stkPub: p.stkPub,
      eBoxPub: p.eBoxPub,
      ePhonePub: ePhone.pub,
      nonce: p.nonce,
      sessionId: p.sessionId,
    });
    expect(kPhone.length).toBe(32);
    expect(kPhone).toEqual(kBox);
  });

  it("K_session differs when ePhonePub differs (transcript binding)", () => {
    const ss = deriveSharedSecret(ePhone.priv, eBox.pub);
    const fakePhone = x25519Pair(50);
    const k1 = deriveSessionKey({
      sharedSecret: ss,
      stkPub: p.stkPub,
      eBoxPub: p.eBoxPub,
      ePhonePub: ePhone.pub,
      nonce: p.nonce,
      sessionId: p.sessionId,
    });
    const k2 = deriveSessionKey({
      sharedSecret: ss,
      stkPub: p.stkPub,
      eBoxPub: p.eBoxPub,
      ePhonePub: fakePhone.pub,
      nonce: p.nonce,
      sessionId: p.sessionId,
    });
    expect(k1).not.toEqual(k2);
  });

  it("SAS is 4 bytes and deterministic across peers", () => {
    const ss = deriveSharedSecret(ePhone.priv, eBox.pub);
    const sasPhone = deriveSAS({
      sharedSecret: ss,
      stkPub: p.stkPub,
      eBoxPub: p.eBoxPub,
      ePhonePub: ePhone.pub,
      nonce: p.nonce,
      sessionId: p.sessionId,
    });
    const sasBox = deriveSAS({
      sharedSecret: ss,
      stkPub: p.stkPub,
      eBoxPub: p.eBoxPub,
      ePhonePub: ePhone.pub,
      nonce: p.nonce,
      sessionId: p.sessionId,
    });
    expect(sasPhone.length).toBe(4);
    expect(sasPhone).toEqual(sasBox);
  });

  it("K_session and SAS use distinct HKDF info tags (no overlap)", () => {
    const ss = deriveSharedSecret(ePhone.priv, eBox.pub);
    const args = {
      sharedSecret: ss,
      stkPub: p.stkPub,
      eBoxPub: p.eBoxPub,
      ePhonePub: ePhone.pub,
      nonce: p.nonce,
      sessionId: p.sessionId,
    };
    const k = deriveSessionKey(args);
    const sas = deriveSAS(args);
    // First 4 bytes of K_session must NOT equal SAS, or the SAS is
    // just a key-prefix leak.
    expect(k.slice(0, 4)).not.toEqual(sas);
  });
});

describe("N-PROTO-2: BoxUnpair (IRK-signed, rebind-only)", () => {
  const irk = ed25519Keypair(11);
  const u: BoxUnpair = {
    userId: "user-abc",
    boxId: "deadbeef00112233",
    issuedAt: 1_716_000_000_000,
  };

  it("round-trips a valid IRK signature", () => {
    const sig = signBoxUnpair(u, irk);
    expect(verifyBoxUnpair(u, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a sig from a different IRK", () => {
    const wrong = ed25519Keypair(12);
    const sig = signBoxUnpair(u, wrong);
    expect(verifyBoxUnpair(u, sig, irk.publicKey)).toBe(false);
  });

  it("rejects tampered userId / boxId / issuedAt", () => {
    const sig = signBoxUnpair(u, irk);
    expect(verifyBoxUnpair({ ...u, userId: "user-evil" }, sig, irk.publicKey)).toBe(
      false,
    );
    expect(verifyBoxUnpair({ ...u, boxId: "00" + u.boxId.slice(2) }, sig, irk.publicKey)).toBe(
      false,
    );
    expect(verifyBoxUnpair({ ...u, issuedAt: u.issuedAt + 1 }, sig, irk.publicKey)).toBe(
      false,
    );
  });
});

describe("N-PROTO-3: WiFiConfig sealed under K_session", () => {
  const k = new Uint8Array(32).fill(123);
  const w: WiFiConfig = {
    ssid: "Home-2G",
    psk: "correct-horse-battery-staple",
    regulatoryRegion: "US",
    issuedAt: 1_716_000_000_000,
  };

  it("round-trips through seal+open", () => {
    const blob = sealWiFiConfig(w, k);
    const got = openWiFiConfig(blob, k);
    expect(got).toEqual(w);
  });

  it("each seal uses a fresh nonce (AEAD nonce reuse safety)", () => {
    const a = sealWiFiConfig(w, k);
    const b = sealWiFiConfig(w, k);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("rejects open under a different K_session", () => {
    const blob = sealWiFiConfig(w, k);
    const wrong = new Uint8Array(32).fill(124);
    expect(() => openWiFiConfig(blob, wrong)).toThrow();
  });

  it("rejects open of tampered ciphertext", () => {
    const blob = sealWiFiConfig(w, k);
    const bad = { ...blob, ciphertext: new Uint8Array(blob.ciphertext) };
    bad.ciphertext[0]! ^= 1;
    expect(() => openWiFiConfig(bad, k)).toThrow();
  });

  it("rejects open of a non-WiFiConfig plaintext with valid AEAD", () => {
    // Encrypt a payload that authenticates but isn't WiFiConfig — open
    // must reject by tag check, not just AEAD verification.
    const fakePlaintext = new TextEncoder().encode("flagship/some-other-tag/v1|x|y|z");
    const nonce = new Uint8Array(12).fill(5);
    const ct = gcm(k, nonce).encrypt(fakePlaintext);
    expect(() => openWiFiConfig({ ciphertext: ct, nonce }, k)).toThrow(/malformed/);
  });

  it("throws if K_session is not 32 bytes", () => {
    const short = new Uint8Array(16).fill(1);
    expect(() => sealWiFiConfig(w, short)).toThrow();
    expect(() => openWiFiConfig({ ciphertext: new Uint8Array(0), nonce: new Uint8Array(12) }, short)).toThrow();
  });
});

describe("N-PROTO-4: SAS + LED-SAS encoding", () => {
  it("LED alphabet is 4 symbols, fixed order", () => {
    expect(LED_SAS_ALPHABET).toEqual(["R", "G", "B", "Y"]);
  });

  it("constants match locked design decisions", () => {
    expect(LED_SAS_PULSES_PER_GLANCE).toBe(3);
    expect(LED_SAS_GLANCES_REQUIRED).toBe(3);
    expect(LED_SAS_PULSE_MS).toBe(10_000);
    expect(LED_SAS_RETRIES).toBe(3);
  });

  it("encodes 9 pulses (= 3 glances × 3 pulses) from 4 SAS bytes", () => {
    const sas = new Uint8Array([0b00011011, 0b11100100, 0b10010110, 0xff]);
    const seq = encodeLedSas(sas);
    expect(seq.length).toBe(9);
    // First byte 0b00_01_10_11 → R, G, B, Y
    // Second byte 0b11_10_01_00 → Y, B, G, R
    // Third byte top-2 bits 0b10 → B
    expect(seq).toBe("RGBYYBGRB");
  });

  it("rejects short SAS input", () => {
    const tooShort = new Uint8Array(2).fill(0);
    expect(() => encodeLedSas(tooShort)).toThrow();
  });

  it("uses only the fixed alphabet", () => {
    const sas = new Uint8Array(4).fill(0x55); // 01010101 → alternating G/G
    const seq = encodeLedSas(sas);
    for (const ch of seq) {
      expect(LED_SAS_ALPHABET.includes(ch as (typeof LED_SAS_ALPHABET)[number])).toBe(
        true,
      );
    }
  });

  it("encodeSasForDisplay returns 6 hex chars by default", () => {
    const sas = new Uint8Array([0xab, 0xcd, 0xef, 0x12]);
    expect(encodeSasForDisplay(sas)).toBe("abcdef");
    expect(encodeSasForDisplay(sas, 4)).toBe("abcd");
  });

  it("stkPubToSuffix6 returns last 6 hex chars of pub", () => {
    const pub = new Uint8Array(32);
    pub[30] = 0xab;
    pub[31] = 0xcd;
    expect(stkPubToSuffix6(pub)).toBe("00abcd");
  });
});

describe("N-PHONE-6: LED-SAS capture/decode + match", () => {
  // 0b00011011, 0b11100100, 0b10010110 → "RGBYYBGRB" (see encode test above).
  const sas = new Uint8Array([0b00011011, 0b11100100, 0b10010110, 0xff]);
  const expectedSeq = "RGBYYBGRB";

  it("splits the 9-pulse sequence into 3 glances of 3", () => {
    expect(ledSasGlances(expectedSeq)).toEqual(["RGB", "YYB", "GRB"]);
  });

  it("rejects a wrong-length sequence in ledSasGlances", () => {
    expect(() => ledSasGlances("RGB")).toThrow();
    expect(() => ledSasGlances(expectedSeq + "R")).toThrow();
  });

  it("isWellFormedGlance accepts only 3 alphabet symbols", () => {
    expect(isWellFormedGlance("RGB")).toBe(true);
    expect(isWellFormedGlance("YYB")).toBe(true);
    expect(isWellFormedGlance("RG")).toBe(false); // too short
    expect(isWellFormedGlance("RGBY")).toBe(false); // too long
    expect(isWellFormedGlance("RGX")).toBe(false); // unknown symbol
    expect(isWellFormedGlance("rgb")).toBe(false); // case-sensitive
  });

  it("verifyLedGlance is exact-match", () => {
    expect(verifyLedGlance("RGB", "RGB")).toBe("match");
    expect(verifyLedGlance("RGB", "RGY")).toBe("mismatch");
  });

  it("verifyLedSas confirms a correct 3-of-3 capture", () => {
    expect(verifyLedSas(sas, ["RGB", "YYB", "GRB"])).toBe(true);
  });

  it("verifyLedSas rejects any single mismatched glance (fail-closed, not best-of-3)", () => {
    expect(verifyLedSas(sas, ["RGB", "YYR", "GRB"])).toBe(false); // glance 2 wrong
    expect(verifyLedSas(sas, ["RGY", "YYB", "GRB"])).toBe(false); // glance 1 wrong
    expect(verifyLedSas(sas, ["RGB", "YYB", "GRY"])).toBe(false); // glance 3 wrong
  });

  it("verifyLedSas rejects a malformed glance (garbled read, not a mismatch)", () => {
    expect(verifyLedSas(sas, ["RGB", "YY", "GRB"])).toBe(false); // short
    expect(verifyLedSas(sas, ["RGB", "YYX", "GRB"])).toBe(false); // unknown symbol
  });

  it("verifyLedSas requires exactly the glance count", () => {
    expect(verifyLedSas(sas, ["RGB", "YYB"])).toBe(false); // too few
    expect(verifyLedSas(sas, ["RGB", "YYB", "GRB", "RGB"])).toBe(false); // too many
  });

  it("verifyLedSas agrees with the box-derived sequence from a real SAS", () => {
    const derived = encodeLedSas(sas);
    expect(verifyLedSas(sas, ledSasGlances(derived))).toBe(true);
  });
});

describe("wifi deposit blob (ePhonePub || ciphertext)", () => {
  it("round-trips ePhonePub + sealed ciphertext through the relay shape", () => {
    const phone = x25519Pair(7);
    const kSession = new Uint8Array(32).fill(0x42);
    const sealed = sealWiFiConfig(
      { ssid: "HomeNet", psk: "hunter22", regulatoryRegion: "US", issuedAt: 1718000000000 },
      kSession,
    );
    const blob = buildWifiDepositBlob(phone.pub, sealed);
    const parsed = parseWifiDepositBlob(blob);
    expect(Array.from(parsed.ePhonePub)).toEqual(Array.from(phone.pub));
    expect(Array.from(parsed.ciphertext)).toEqual(Array.from(sealed.ciphertext));
    const opened = openWiFiConfig({ ciphertext: parsed.ciphertext, nonce: sealed.nonce }, kSession);
    expect(opened.ssid).toBe("HomeNet");
  });

  it("rejects a wrong-size ePhonePub at build time", () => {
    const sealed = sealWiFiConfig(
      { ssid: "x", psk: "", regulatoryRegion: "", issuedAt: 1 },
      new Uint8Array(32),
    );
    expect(() => buildWifiDepositBlob(new Uint8Array(31), sealed)).toThrow();
  });

  it("rejects a blob too short to carry pub + AEAD tag (foreign deposit)", () => {
    expect(() => parseWifiDepositBlob(new Uint8Array(47))).toThrow();
    expect(() => parseWifiDepositBlob(new Uint8Array(0))).toThrow();
  });

  it("tampered ePhonePub prefix fails the AEAD open downstream", () => {
    const box = x25519Pair(9);
    const phone = x25519Pair(10);
    const stk = ed25519Keypair(11);
    const nonce16 = new Uint8Array(16).fill(1);
    const sessionId = new Uint8Array(16).fill(2);
    const args = {
      stkPub: stk.publicKey, eBoxPub: box.pub, nonce: nonce16, sessionId,
    };
    const ssPhone = deriveSharedSecret(phone.priv, box.pub);
    const kPhone = deriveSessionKey({ sharedSecret: ssPhone, ePhonePub: phone.pub, ...args });
    const sealed = sealWiFiConfig(
      { ssid: "n", psk: "p", regulatoryRegion: "US", issuedAt: 5 },
      kPhone,
    );
    const blob = buildWifiDepositBlob(phone.pub, sealed);
    blob[3] ^= 0xff; // MitM flips a prefix byte in transit
    const parsed = parseWifiDepositBlob(blob);
    // Box derives K_session from the (tampered) prefix it received.
    const ssBox = deriveSharedSecret(box.priv, parsed.ePhonePub);
    const kBox = deriveSessionKey({ sharedSecret: ssBox, ePhonePub: parsed.ePhonePub, ...args });
    expect(() =>
      openWiFiConfig({ ciphertext: parsed.ciphertext, nonce: sealed.nonce }, kBox),
    ).toThrow();
  });

  it("PAIR_SESSION_LOCK_MS is the locked 30 s window", () => {
    expect(PAIR_SESSION_LOCK_MS).toBe(30_000);
  });
});
