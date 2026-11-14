#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for `flagship/box-claim/v1` (docs/retail-box-setup.md §7.3, §15). The TypeScript
 * port (packages/protocol/src/boxClaim.ts) GENERATES them; the TS test checks every case, and the
 * Rust, Swift and Kotlin ports are to read the same file.
 *
 * Run:          npx tsx tools/box-claim-vectors.ts
 * CI freshness: npx tsx tools/box-claim-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hybridSigKeygen, hybridSign } from "../packages/protocol/src/pqHybrid.js";
import {
  BoxClaimError,
  acceptBoxClaim,
  canonicalBoxClaimKey,
  completeBoxClaim,
  confirmBoxClaim,
  finishBoxClaim,
  formatSetupCode,
  fragmentClaimMessage,
  generateSetupCode,
  judgePressReport,
  normalizeSetupCode,
  setupCodeKey,
  setupCodeLink,
  setupCodeMailboxId,
  signBoxClaimKey,
  signBoxClaimReceipt,
  startBoxClaim,
  verifyBoxClaimReceipt,
  type BoxClaimAdvertState,
  type BoxClaimMode,
  type BoxClaimRandomness,
} from "../packages/protocol/src/boxClaim.js";
import { ed } from "../packages/protocol/src/edSync.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/box-claim/vectors.json");

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

const NOW = 1_790_000_000_000;
const DOMAIN = "home.alice.flagship.services";
const SERIAL = "retail-serial-0001";

const CODE_RAND = fill(13, 0x5a);
const CODE = generateSetupCode(CODE_RAND);
const OTHER_CODE = generateSetupCode(fill(13, 0x3c));

const rands = (base: number): { phone: BoxClaimRandomness; box: BoxClaimRandomness } => ({
  phone: { ephemeralSeed: fill(32, base), nonce: fill(32, base + 1), encapsulation: fill(64, base + 2) },
  box: { ephemeralSeed: fill(32, base + 3), nonce: fill(32, base + 4), encapsulation: fill(64, base + 5) },
});

const randWire = (r: { phone: BoxClaimRandomness; box: BoxClaimRandomness }) => ({
  phone: { ephemeralSeedHex: hex(r.phone.ephemeralSeed!), nonceHex: hex(r.phone.nonce!), encapsulationHex: hex(r.phone.encapsulation!) },
  box: { ephemeralSeedHex: hex(r.box.ephemeralSeed!), nonceHex: hex(r.box.nonce!), encapsulationHex: hex(r.box.encapsulation!) },
});

const STK_ED = fill(32, 0x71);
const STK_MLDSA = fill(32, 0x72);
const STK = hybridSigKeygen(STK_ED, STK_MLDSA);

function errCode(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof BoxClaimError) return e.code;
    throw e;
  }
  return "ok";
}

function run(mode: BoxClaimMode, state: BoxClaimAdvertState, phoneCode: string | undefined, boxCode: string | null, base: number) {
  const r = rands(base);
  const start = startBoxClaim({ mode, ...(phoneCode !== undefined ? { code: phoneCode } : {}), randomness: r.phone });
  const { accept, pending: boxPending } = acceptBoxClaim({ hello: start.hello, state, codeKey: boxCode ? setupCodeKey(boxCode) : null, randomness: r.box });
  const { finish, pending: phonePending } = finishBoxClaim(start, accept, r.phone);
  const { ready, channel: boxCh } = completeBoxClaim(boxPending, finish);
  const phoneCh = confirmBoxClaim(phonePending, ready);
  return { r, hello: start.hello, accept, finish, ready, boxCh, phoneCh };
}

async function transcript(name: string, mode: BoxClaimMode, state: BoxClaimAdvertState, base: number) {
  const code = mode === "code" ? CODE : undefined;
  const t = run(mode, state, code, code ?? null, base);
  if (t.boxCh.transcriptHex !== t.phoneCh.transcriptHex) throw new Error("transcripts differ");
  const phoneMsgs = [{ t: "arm" }, { t: "claim", recipe: '{"blob":{},"blobSignature":"00"}' }];
  const boxMsgs = [{ t: "armed" }, { t: "press", atMs: 4200, count: 1, long: false }, { t: "press-result", ok: true }];
  const records = [
    ...phoneMsgs.map((m, seq) => ({ from: "phone", seq, plaintext: JSON.stringify(m), recordHex: hex(t.phoneCh.sealJson(m as never)) })),
    ...boxMsgs.map((m, seq) => ({ from: "box", seq, plaintext: JSON.stringify(m), recordHex: hex(t.boxCh.sealJson(m as never)) })),
  ];
  const receipt = await signBoxClaimReceipt(
    {
      mode,
      serverDomain: DOMAIN,
      serial: SERIAL,
      stkHybridPub: hex(STK.publicKey),
      bootKeyBindingSha256: "",
      model: "Mini PC N100",
      imageVersion: "0.4.0",
      transcript: t.boxCh.transcriptHex,
      issuedAt: NOW,
    },
    (purpose, payload) => hybridSign(STK.secretKey, purpose, payload, { deterministic: true }),
  );
  verifyBoxClaimReceipt(receipt, { transcriptHex: t.phoneCh.transcriptHex, mode, serverDomain: DOMAIN, serial: SERIAL });
  return {
    name,
    mode,
    state,
    ...(code ? { code } : {}),
    randomness: randWire(t.r),
    hello: t.hello,
    accept: t.accept,
    finish: t.finish,
    ready: t.ready,
    transcriptHex: t.boxCh.transcriptHex,
    sessionIdHex: t.boxCh.sessionIdHex,
    records,
    receipt,
  };
}

function negatives() {
  const out: Array<{ name: string; expect: string; [k: string]: unknown }> = [];

  out.push({
    name: "wrong-code",
    phoneCode: OTHER_CODE,
    boxCode: CODE,
    randomness: randWire(rands(0x40)),
    expect: errCode(() => run("code", "unclaimed", OTHER_CODE, CODE, 0x40)),
  });

  out.push({
    name: "box-without-code",
    randomness: randWire(rands(0x48)),
    expect: errCode(() => {
      const r = rands(0x48);
      const s = startBoxClaim({ mode: "code", code: CODE, randomness: r.phone });
      acceptBoxClaim({ hello: s.hello, state: "unclaimed", codeKey: null, randomness: r.box });
    }),
  });

  for (const mode of ["open", "code"] as const) {
    const base = mode === "open" ? 0x50 : 0x58;
    out.push({
      name: `state-forgery-${mode}`,
      mode,
      randomness: randWire(rands(base)),
      tamper: "accept.state reset-window -> unclaimed",
      expect: errCode(() => {
        const r = rands(base);
        const code = mode === "code" ? CODE : undefined;
        const s = startBoxClaim({ mode, ...(code ? { code } : {}), randomness: r.phone });
        const { accept, pending } = acceptBoxClaim({ hello: s.hello, state: "reset-window", codeKey: code ? setupCodeKey(code) : null, randomness: r.box });
        const { finish } = finishBoxClaim(s, { ...accept, state: "unclaimed" }, r.phone);
        completeBoxClaim(pending, finish);
      }),
    });
  }

  out.push({
    name: "mode-downgrade",
    randomness: randWire(rands(0x60)),
    tamper: "the phone asked mode code; an answer in mode open",
    expect: errCode(() => {
      const r = rands(0x60);
      const s = startBoxClaim({ mode: "code", code: CODE, randomness: r.phone });
      const open = startBoxClaim({ mode: "open", randomness: rands(0x61).phone });
      const { accept } = acceptBoxClaim({ hello: { ...open.hello, ephemeralPub: s.hello.ephemeralPub }, state: "unclaimed", codeKey: null, randomness: r.box });
      finishBoxClaim(s, accept, r.phone);
    }),
  });

  out.push({
    name: "relay-key-swap",
    randomness: { phoneToRelay: randWire(rands(0x68)), relayToBox: randWire(rands(0x70)) },
    tamper: "a relay runs one session with the phone and one with the box and passes the box's receipt on",
    expect: (() => {
      const a = run("open", "unclaimed", undefined, null, 0x68);
      const b = run("open", "unclaimed", undefined, null, 0x70);
      const receipt = {
        v: 1 as const,
        mode: "open" as const,
        serverDomain: DOMAIN,
        serial: SERIAL,
        stkHybridPub: hex(STK.publicKey),
        bootKeyBindingSha256: "",
        model: "Mini PC N100",
        imageVersion: "0.4.0",
        transcript: b.boxCh.transcriptHex,
        issuedAt: NOW,
        signature: "00".repeat(3373),
      };
      return errCode(() => verifyBoxClaimReceipt(receipt, { transcriptHex: a.phoneCh.transcriptHex, mode: "open", serverDomain: DOMAIN, serial: SERIAL }));
    })(),
  });

  out.push({
    name: "record-replay",
    randomness: randWire(rands(0x78)),
    tamper: "the phone's first record delivered twice",
    expect: errCode(() => {
      const t = run("open", "unclaimed", undefined, null, 0x78);
      const rec = t.phoneCh.sealJson({ t: "arm" });
      t.boxCh.open(rec);
      t.boxCh.open(rec);
    }),
  });

  return out;
}

function pressCases() {
  const base = { armSentAt: NOW, instructionAt: NOW + 4_000 };
  const cases = [
    { name: "on-time", atMs: 5_000, count: 1, long: false, receivedAt: NOW + 7_400 },
    { name: "before-instruction", atMs: 1_500, count: 1, long: false, receivedAt: NOW + 3_900 },
    { name: "reported-before-instruction-arrived-after", atMs: 2_000, count: 1, long: false, receivedAt: NOW + 4_100 },
    { name: "too-late", atMs: 9_500, count: 1, long: false, receivedAt: NOW + 11_700 },
    { name: "two-presses", atMs: 5_000, count: 2, long: false, receivedAt: NOW + 7_400 },
    { name: "long-press", atMs: 5_000, count: 1, long: true, receivedAt: NOW + 7_400 },
  ];
  return cases.map((c) => ({ ...c, ...base, verdict: judgePressReport({ ...base, ...c }) }));
}

function claimKey() {
  const seed = fill(32, 0x81);
  const pub = ed.getPublicKey(seed);
  const k = { username: "alice", serial: SERIAL, serverDomain: DOMAIN, stkPubHex: hex(STK.publicKey.subarray(0, 32)), issuedAt: NOW };
  return {
    signerSeedHex: hex(seed),
    signerPubHex: hex(pub),
    fields: k,
    canonical: new TextDecoder().decode(canonicalBoxClaimKey(k)),
    signatureHex: hex(signBoxClaimKey(k, { publicKey: pub, privateKey: seed })),
  };
}

async function build() {
  const msg = new Uint8Array(70).map((_, i) => i);
  return {
    version: 1,
    note: "Generated by tools/box-claim-vectors.ts; do not edit.",
    now: NOW,
    serverDomain: DOMAIN,
    serial: SERIAL,
    stk: { ed25519SeedHex: hex(STK_ED), mldsaSeedHex: hex(STK_MLDSA), hybridPubHex: hex(STK.publicKey) },
    setupCodes: [CODE_RAND, fill(13, 0x3c), fill(13, 0x00), fill(13, 0xff)].map((rnd) => {
      const code = generateSetupCode(rnd);
      return {
        randomHex: hex(rnd),
        code,
        formatted: formatSetupCode(code),
        codeKeyHex: hex(setupCodeKey(code)),
        mailboxId: setupCodeMailboxId(code),
        link: setupCodeLink(code),
      };
    }),
    normalize: [
      { input: formatSetupCode(CODE).toLowerCase(), output: CODE },
      { input: ` ${CODE.slice(0, 10)} ${CODE.slice(10)} `, output: CODE },
      { input: "OIL0" + CODE.slice(4), output: normalizeSetupCode("OIL0" + CODE.slice(4)) },
      { input: CODE.slice(1), output: null },
      { input: CODE.slice(0, 19) + "U", output: null },
    ],
    transcripts: [await transcript("open-unclaimed", "open", "unclaimed", 0x10), await transcript("open-reset-window", "open", "reset-window", 0x20), await transcript("code-unclaimed", "code", "unclaimed", 0x30)],
    negatives: negatives(),
    press: pressCases(),
    claimKey: claimKey(),
    frames: { mtu: 23, messageHex: hex(msg), frames: fragmentClaimMessage(msg, 23).map(hex) },
  };
}

const json = JSON.stringify(await build(), null, 2) + "\n";
if (process.argv.includes("--check")) {
  const cur = readFileSync(OUT, "utf8");
  if (cur !== json) {
    console.error("box-claim vectors are stale: run npx tsx tools/box-claim-vectors.ts");
    process.exit(1);
  }
  console.log("box-claim vectors are current");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
}
