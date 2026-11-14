import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BoxClaimError,
  ClaimFrameReassembler,
  acceptBoxClaim,
  canonicalBoxClaimKey,
  completeBoxClaim,
  confirmBoxClaim,
  finishBoxClaim,
  formatSetupCode,
  fragmentClaimMessage,
  generateSetupCode,
  hybridSign,
  instructionPauseMs,
  judgePressReport,
  normalizeSetupCode,
  parsePhoneMessage,
  parseSetupCodeLink,
  setupCodeKey,
  setupCodeLink,
  setupCodeMailboxId,
  signBoxClaimKey,
  signBoxClaimReceipt,
  startBoxClaim,
  validWiFiConfig,
  verifyBoxClaimKey,
  verifyBoxClaimReceipt,
  BOX_CLAIM_INSTRUCTION_PAUSE_MAX_MS,
  BOX_CLAIM_INSTRUCTION_PAUSE_MIN_MS,
  type BoxClaimRandomness,
} from "../src/index.js";
import { ed } from "../src/edSync.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/box-claim/vectors.json", import.meta.url), "utf8"));
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const rand = (w: { ephemeralSeedHex: string; nonceHex: string; encapsulationHex: string }): BoxClaimRandomness => ({
  ephemeralSeed: unhex(w.ephemeralSeedHex),
  nonce: unhex(w.nonceHex),
  encapsulation: unhex(w.encapsulationHex),
});

function code(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof BoxClaimError) return e.code;
    throw e;
  }
  return "ok";
}

const stkSecret = new Uint8Array([...unhex(V.stk.ed25519SeedHex), ...unhex(V.stk.mldsaSeedHex)]);

describe("box-claim setup codes", () => {
  for (const c of V.setupCodes) {
    it(`${c.formatted}: code, key, mailbox and link`, () => {
      const generated = generateSetupCode(unhex(c.randomHex));
      expect(generated).toBe(c.code);
      expect(formatSetupCode(generated)).toBe(c.formatted);
      expect(hex(setupCodeKey(c.code))).toBe(c.codeKeyHex);
      expect(setupCodeMailboxId(c.code)).toBe(c.mailboxId);
      expect(setupCodeLink(c.code)).toBe(c.link);
      expect(parseSetupCodeLink(c.link)).toBe(c.code);
      expect(c.mailboxId).not.toBe(c.codeKeyHex);
    });
  }
  it("normalizes typed codes", () => {
    for (const n of V.normalize) expect(normalizeSetupCode(n.input)).toBe(n.output);
  });
  it("draws a fresh code each time", () => {
    expect(generateSetupCode()).not.toBe(generateSetupCode());
  });
});

describe("box-claim handshake vectors", () => {
  for (const t of V.transcripts) {
    it(`${t.name}: reproduces every message, key and record`, async () => {
      const rp = rand(t.randomness.phone);
      const rb = rand(t.randomness.box);
      const s = startBoxClaim({ mode: t.mode, ...(t.code ? { code: t.code } : {}), randomness: rp });
      expect(s.hello).toEqual(t.hello);
      const { accept, pending } = acceptBoxClaim({ hello: t.hello, state: t.state, codeKey: t.code ? setupCodeKey(t.code) : null, randomness: rb });
      expect(accept).toEqual(t.accept);
      const { finish, pending: pp } = finishBoxClaim(s, accept, rp);
      expect(finish).toEqual(t.finish);
      const { ready, channel: box } = completeBoxClaim(pending, finish);
      expect(ready).toEqual(t.ready);
      const phone = confirmBoxClaim(pp, ready);
      expect(box.transcriptHex).toBe(t.transcriptHex);
      expect(phone.transcriptHex).toBe(t.transcriptHex);
      expect(box.sessionIdHex).toBe(t.sessionIdHex);
      expect(phone.advertState).toBe(t.state);
      for (const r of t.records) {
        const [sender, receiver] = r.from === "phone" ? [phone, box] : [box, phone];
        expect(hex(sender.sealJson(JSON.parse(r.plaintext)))).toBe(r.recordHex);
        expect(JSON.stringify(receiver.openJson(unhex(r.recordHex)))).toBe(r.plaintext);
      }
      const again = await signBoxClaimReceipt(
        { ...t.receipt, signature: undefined, v: undefined } as never,
        (purpose, payload) => hybridSign(stkSecret, purpose, payload, { deterministic: true }),
      );
      expect({ ...again }).toMatchObject({ signature: t.receipt.signature });
      const v = verifyBoxClaimReceipt(t.receipt, { transcriptHex: t.transcriptHex, mode: t.mode, serverDomain: V.serverDomain, serial: V.serial });
      expect(v.stkPubHex).toBe(V.stk.hybridPubHex.slice(0, 64));
    });
  }

  it("refuses a receipt with a changed field", () => {
    const t = V.transcripts[0];
    const bad = { ...t.receipt, model: "Other" };
    expect(code(() => verifyBoxClaimReceipt(bad, { transcriptHex: t.transcriptHex, mode: t.mode, serverDomain: V.serverDomain, serial: V.serial }))).toBe("bad-receipt");
    expect(code(() => verifyBoxClaimReceipt(t.receipt, { transcriptHex: t.transcriptHex, mode: t.mode, serverDomain: V.serverDomain, serial: "another-serial-01" }))).toBe("bad-receipt");
  });
});

describe("box-claim negative vectors", () => {
  const byName = new Map<string, { expect: string; randomness: never }>(V.negatives.map((n: { name: string }) => [n.name, n]));
  const run = (mode: "open" | "code", state: "unclaimed" | "reset-window", phoneCode: string | undefined, boxCode: string | null, w: never) => {
    const r = w as unknown as { phone: never; box: never };
    const s = startBoxClaim({ mode, ...(phoneCode ? { code: phoneCode } : {}), randomness: rand(r.phone) });
    const a = acceptBoxClaim({ hello: s.hello, state, codeKey: boxCode ? setupCodeKey(boxCode) : null, randomness: rand(r.box) });
    const f = finishBoxClaim(s, a.accept, rand(r.phone));
    const c = completeBoxClaim(a.pending, f.finish);
    return { phone: confirmBoxClaim(f.pending, c.ready), box: c.channel, s, a, f };
  };
  const CODE = V.transcripts[2].code;

  it("wrong code", () => {
    const n = byName.get("wrong-code")!;
    const other = V.setupCodes[1].code;
    expect(code(() => run("code", "unclaimed", other, CODE, n.randomness))).toBe(n.expect);
    expect(n.expect).toBe("wrong-code");
  });

  it("a box without a live code refuses mode code", () => {
    const n = byName.get("box-without-code")!;
    const r = n.randomness as unknown as { phone: never; box: never };
    const s = startBoxClaim({ mode: "code", code: CODE, randomness: rand(r.phone) });
    expect(code(() => acceptBoxClaim({ hello: s.hello, state: "unclaimed", codeKey: null, randomness: rand(r.box) }))).toBe(n.expect);
  });

  for (const mode of ["open", "code"] as const) {
    it(`state forged in transit (${mode})`, () => {
      const n = byName.get(`state-forgery-${mode}`)!;
      const r = n.randomness as unknown as { phone: never; box: never };
      const c = mode === "code" ? CODE : undefined;
      const s = startBoxClaim({ mode, ...(c ? { code: c } : {}), randomness: rand(r.phone) });
      const a = acceptBoxClaim({ hello: s.hello, state: "reset-window", codeKey: c ? setupCodeKey(c) : null, randomness: rand(r.box) });
      const f = finishBoxClaim(s, { ...a.accept, state: "unclaimed" }, rand(r.phone));
      expect(code(() => completeBoxClaim(a.pending, f.finish))).toBe(n.expect);
    });
  }

  it("mode downgrade", () => {
    const s = startBoxClaim({ mode: "code", code: CODE });
    const open = startBoxClaim({ mode: "open" });
    const { accept } = acceptBoxClaim({ hello: { ...open.hello, ephemeralPub: s.hello.ephemeralPub }, state: "unclaimed", codeKey: null });
    expect(code(() => finishBoxClaim(s, accept))).toBe(byName.get("mode-downgrade")!.expect);
  });

  it("relay passing the real box's receipt on", () => {
    const n = byName.get("relay-key-swap")! as unknown as { expect: string; randomness: { phoneToRelay: never; relayToBox: never } };
    const a = run("open", "unclaimed", undefined, null, n.randomness.phoneToRelay);
    const b = run("open", "unclaimed", undefined, null, n.randomness.relayToBox);
    expect(a.phone.transcriptHex).not.toBe(b.box.transcriptHex);
    const t = V.transcripts[0];
    const forwarded = { ...t.receipt, transcript: b.box.transcriptHex };
    expect(code(() => verifyBoxClaimReceipt(forwarded, { transcriptHex: a.phone.transcriptHex, mode: "open", serverDomain: V.serverDomain, serial: V.serial }))).toBe(n.expect);
  });

  it("replayed and reordered records", () => {
    const n = byName.get("record-replay")!;
    const t = run("open", "unclaimed", undefined, null, n.randomness);
    const r0 = t.phone.sealJson({ t: "arm" });
    const r1 = t.phone.sealJson({ t: "wifi-scan" });
    expect(code(() => t.box.open(r1))).toBe("replay");
    t.box.open(r0);
    expect(code(() => t.box.open(r0))).toBe(n.expect);
  });

  it("a record sealed for the other direction does not open", () => {
    const t = run("open", "unclaimed", undefined, null, byName.get("record-replay")!.randomness);
    const fromBox = t.box.sealJson({ t: "armed" });
    expect(code(() => t.box.open(fromBox))).toBe("decrypt-failed");
  });

  it("each handshake state is single use", () => {
    const t = run("open", "unclaimed", undefined, null, byName.get("record-replay")!.randomness);
    expect(code(() => finishBoxClaim(t.s, t.a.accept))).toBe("claim-malformed");
    expect(code(() => completeBoxClaim(t.a.pending, t.f.finish))).toBe("claim-malformed");
  });
});

describe("box-claim press check", () => {
  for (const p of V.press) {
    it(p.name, () => {
      expect(judgePressReport(p)).toBe(p.verdict);
    });
  }
  it("pauses 2 to 6 seconds", () => {
    expect(instructionPauseMs(Uint8Array.of(0, 0))).toBe(BOX_CLAIM_INSTRUCTION_PAUSE_MIN_MS);
    expect(instructionPauseMs(Uint8Array.of(255, 255))).toBe(BOX_CLAIM_INSTRUCTION_PAUSE_MAX_MS);
    for (let i = 0; i < 50; i++) {
      const ms = instructionPauseMs();
      expect(ms).toBeGreaterThanOrEqual(BOX_CLAIM_INSTRUCTION_PAUSE_MIN_MS);
      expect(ms).toBeLessThanOrEqual(BOX_CLAIM_INSTRUCTION_PAUSE_MAX_MS);
    }
  });
});

describe("box-claim key pre-registration", () => {
  it("canonical bytes and signature", () => {
    const k = V.claimKey;
    expect(new TextDecoder().decode(canonicalBoxClaimKey(k.fields))).toBe(k.canonical);
    const pub = unhex(k.signerPubHex);
    expect(hex(ed.getPublicKey(unhex(k.signerSeedHex)))).toBe(k.signerPubHex);
    expect(hex(signBoxClaimKey(k.fields, { publicKey: pub, privateKey: unhex(k.signerSeedHex) }))).toBe(k.signatureHex);
    expect(verifyBoxClaimKey(k.fields, unhex(k.signatureHex), pub)).toBe(true);
    expect(verifyBoxClaimKey({ ...k.fields, stkPubHex: "00".repeat(32) }, unhex(k.signatureHex), pub)).toBe(false);
  });
});

describe("box-claim frames and messages", () => {
  it("fragments and reassembles", () => {
    const f = V.frames;
    expect(fragmentClaimMessage(unhex(f.messageHex), f.mtu).map(hex)).toEqual(f.frames);
    const r = new ClaimFrameReassembler();
    let out: Uint8Array | null = null;
    for (const fr of f.frames) out = r.push(unhex(fr));
    expect(hex(out!)).toBe(f.messageHex);
  });
  it("refuses a frame out of order", () => {
    const frames = fragmentClaimMessage(new Uint8Array(100), 23);
    const r = new ClaimFrameReassembler();
    expect(code(() => r.push(frames[1]!))).toBe("claim-malformed");
    r.push(frames[0]!);
    expect(code(() => r.push(frames[0]!))).toBe("claim-malformed");
  });
  it("parses only the phone's message kinds", () => {
    expect(parsePhoneMessage({ t: "arm" })).toEqual({ t: "arm" });
    expect(code(() => parsePhoneMessage({ t: "arm", x: 1 }))).toBe("claim-malformed");
    expect(code(() => parsePhoneMessage({ t: "receipt" }))).toBe("claim-malformed");
    const wifi = { ssid: "Home|Net", psk: "pass|word1", regulatoryRegion: "DE", issuedAt: 1 };
    expect(parsePhoneMessage({ t: "network", wifi })).toEqual({ t: "network", wifi });
    expect(parsePhoneMessage({ t: "network", wifi: null })).toEqual({ t: "network", wifi: null });
    expect(validWiFiConfig({ ...wifi, psk: "short" })).toBe(false);
    expect(validWiFiConfig({ ...wifi, ssid: "x".repeat(33) })).toBe(false);
  });
});
