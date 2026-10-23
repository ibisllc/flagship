#!/usr/bin/env node
/**
 * Golden vectors for the tunnel frame protocol v1 (packages/tunnel-protocol/src/*Frames.ts).
 *
 * Every byte string and every expected outcome below comes from running the TypeScript
 * encoders, decoders and parsers themselves, so the file can only hold what TS does. The Rust
 * relay (rust/crates/flagship-relay/tests/frame_vectors.rs) must produce the same bytes from
 * the same arguments, decode the valid frames back, and refuse what TS refuses.
 *
 * Run:          node tools/tunnel-frame-vectors.mjs
 * CI freshness: node tools/tunnel-frame-vectors.mjs --check
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "packages/tunnel-protocol/test-vectors/frames.json");
const tp = await tsImport(pathToFileURL(resolve(root, "packages/tunnel-protocol/src/index.ts")).href, import.meta.url);

const hex = (b) => Buffer.from(b).toString("hex");
const utf8 = (s) => new TextEncoder().encode(s);
const H64 = "ab".repeat(32);
const H64B = "0f".repeat(32);
const H128 = "cd".repeat(64);

/** FNV-1a 64 over bytes, as lower hex; lets large frames be pinned without storing them. */
function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const frameOf = (name, f, args) => {
  const bytes = tp.encodeFrame(f);
  return { name, builder: args.builder, args: args.args ?? null, streamId: f.streamId, type: f.type, payloadHex: hex(f.payload), hex: hex(bytes) };
};

const encoded = [
  frameOf("hello-ack ok", tp.helloAckFrame(true), { builder: "helloAck", args: { ok: true } }),
  frameOf("hello-ack refused", tp.helloAckFrame(false, "HELLO version must be 2"), { builder: "helloAck", args: { ok: false, reason: "HELLO version must be 2" } }),
  frameOf("hello-ack escapes", tp.helloAckFrame(false, "q\"u\\o\nte\u0001 é/"), { builder: "helloAck", args: { ok: false, reason: "q\"u\\o\nte\u0001 é/" } }),
  frameOf(
    "hello-ack trust + caps",
    tp.helloAckFrame(true, undefined, { serviceBlessing: { v: 1, hubKeyPub: H64 }, hubSig: H128 }, [tp.CAPABILITY_OUTBOUND_V1, tp.CAPABILITY_PB_MAIL_V1]),
    { builder: "helloAck", args: { ok: true, serviceBlessingJson: JSON.stringify({ v: 1, hubKeyPub: H64 }), hubSig: H128, capabilities: ["outbound-v1", "pb-mail-v1"] } },
  ),
  frameOf("hello-ack empty caps omitted", tp.helloAckFrame(true, undefined, undefined, []), { builder: "helloAck", args: { ok: true, capabilities: [] } }),
  frameOf("domain-granted", tp.domainGrantedFrame({ fqdn: "chess.alice.flagship.services", ownerServerId: "home.alice.flagship.services" }), { builder: "domainGranted", args: { fqdn: "chess.alice.flagship.services", ownerServerId: "home.alice.flagship.services" } }),
  frameOf("request-transfer", tp.requestTransferFrame({ fqdn: "chess.alice.flagship.services" }), { builder: "requestTransfer", args: { fqdn: "chess.alice.flagship.services" } }),
  frameOf("open", tp.openFrame(7, "home.alice.flagship.services"), { builder: "open", args: { streamId: 7, sni: "home.alice.flagship.services" } }),
  frameOf("open max hub id", tp.openFrame(0x7fffffff, "a.b.flagship.services"), { builder: "open", args: { streamId: 0x7fffffff, sni: "a.b.flagship.services" } }),
  frameOf("data", tp.dataFrame(7, new Uint8Array([0x16, 3, 1, 0, 0])), { builder: "data", args: { streamId: 7, dataHex: "1603010000" } }),
  frameOf("data empty", tp.dataFrame(1, new Uint8Array(0)), { builder: "data", args: { streamId: 1, dataHex: "" } }),
  frameOf("close", tp.closeFrame(7), { builder: "close", args: { streamId: 7, remote: false } }),
  frameOf("close remote", tp.closeFrame(7, true), { builder: "close", args: { streamId: 7, remote: true } }),
  frameOf("outbound open", tp.outboundOpenFrame(0x80000001, { host: "api.openai.com", port: 443 }), { builder: "outboundOpen", args: { streamId: 0x80000001, host: "api.openai.com", port: 443 } }),
  frameOf("outbound result ok", tp.outboundResultFrame(0x80000001, { ok: true, reason: "disabled" }), { builder: "outboundResult", args: { streamId: 0x80000001, ok: true, reason: "disabled" } }),
  frameOf("outbound result refused", tp.outboundResultFrame(0x80000001, { ok: false, reason: "forbidden-host" }), { builder: "outboundResult", args: { streamId: 0x80000001, ok: false, reason: "forbidden-host" } }),
  frameOf("outbound result refused no reason", tp.outboundResultFrame(0x80000002, { ok: false }), { builder: "outboundResult", args: { streamId: 0x80000002, ok: false } }),
  frameOf("outbound credit", tp.outboundCreditFrame(0x80000001, 262144), { builder: "outboundCredit", args: { streamId: 0x80000001, bytes: 262144 } }),
  frameOf("outbound credit max", tp.outboundCreditFrame(0xffffffff, 0xffffffff), { builder: "outboundCredit", args: { streamId: 0xffffffff, bytes: 0xffffffff } }),
  frameOf("mailbox announce", tp.mailboxAnnounceFrame([{ pikPubHex: H64, epoch: 3, sigHex: H128 }]), { builder: "mailboxAnnounce", args: { announcements: [{ pikPubHex: H64, epoch: 3, sigHex: H128 }] } }),
  frameOf("mailbox announce empty", tp.mailboxAnnounceFrame([]), { builder: "mailboxAnnounce", args: { announcements: [] } }),
  frameOf("pb put", tp.pbPutFrame(9, { encChunkId: H64, shardIndex: 2, sizeBytes: 1048576, signature: H128 }), { builder: "pbPut", args: { streamId: 9, encChunkId: H64, shardIndex: 2, sizeBytes: 1048576, signature: H128 } }),
  frameOf("pb put ack", tp.pbPutAckFrame(9, { encChunkId: H64, shardIndex: 2, ok: false, reason: "full" }), { builder: "pbPutAck", args: { streamId: 9, encChunkId: H64, shardIndex: 2, ok: false, reason: "full" } }),
  frameOf("pb put ack ok", tp.pbPutAckFrame(9, { encChunkId: H64, shardIndex: 0, ok: true }), { builder: "pbPutAck", args: { streamId: 9, encChunkId: H64, shardIndex: 0, ok: true } }),
  frameOf("pb get", tp.pbGetFrame(9, { encChunkId: H64, shardIndex: 5 }), { builder: "pbGet", args: { streamId: 9, encChunkId: H64, shardIndex: 5 } }),
  frameOf("pb get data", tp.pbGetDataFrame(9, new Uint8Array([1, 2, 3])), { builder: "pbGetData", args: { streamId: 9, dataHex: "010203" } }),
  frameOf("pb get end", tp.pbGetEndFrame(9, { encChunkId: H64, shardIndex: 5, sha256: H64B }), { builder: "pbGetEnd", args: { streamId: 9, encChunkId: H64, shardIndex: 5, sha256: H64B } }),
  frameOf("pb challenge", tp.pbChallengeFrame(9, { encChunkId: H64, shardIndex: 5, nonce: H64B, offset: 4096, length: 512 }), { builder: "pbChallenge", args: { streamId: 9, encChunkId: H64, shardIndex: 5, nonce: H64B, offset: 4096, length: 512 } }),
  frameOf("pb response", tp.pbResponseFrame(9, { encChunkId: H64, shardIndex: 5, hash: H64B, signature: H128 }), { builder: "pbResponse", args: { streamId: 9, encChunkId: H64, shardIndex: 5, hash: H64B, signature: H128 } }),
];

/** decodeFrame on raw bytes: what TS says, verbatim. */
const decodeCase = (name, bytes) => {
  const r = tp.decodeFrame(bytes);
  const result =
    r.kind === "ok"
      ? { kind: "ok", streamId: r.frame.streamId, type: r.frame.type, payloadHex: hex(r.frame.payload), consumed: r.consumed }
      : r.kind === "incomplete"
        ? { kind: "incomplete", needAtLeast: r.needAtLeast }
        : { kind: "error", reason: r.reason };
  return { name, hex: hex(bytes), result };
};
const header = (id, type, len) => {
  const b = new Uint8Array(9);
  new DataView(b.buffer).setUint32(0, id);
  b[4] = type;
  new DataView(b.buffer).setUint32(5, len);
  return b;
};
const cat = (...a) => Buffer.concat(a.map((x) => Buffer.from(x)));
const okData = tp.encodeFrame(tp.dataFrame(3, utf8("hello")));
const decode = [
  decodeCase("empty", new Uint8Array(0)),
  decodeCase("short header", okData.subarray(0, 8)),
  decodeCase("header only", okData.subarray(0, 9)),
  decodeCase("short payload", okData.subarray(0, 12)),
  decodeCase("complete", okData),
  decodeCase("complete with trailing", cat(okData, okData.subarray(0, 4))),
  decodeCase("two frames", cat(okData, okData)),
  decodeCase("unknown type 0x00", header(1, 0x00, 0)),
  decodeCase("drain notice 0x05 is not a v1 type", header(0, 0x05, 2)),
  decodeCase("stream credit 0x06 is not a v1 type", cat(header(1, 0x06, 4), [0, 0, 0, 1])),
  decodeCase("unknown type 0x14", header(0, 0x14, 0)),
  decodeCase("unknown type 0xff", header(0, 0xff, 0)),
  decodeCase("payload at max, incomplete", header(1, 0x02, 1 << 20)),
  decodeCase("payload over max", header(1, 0x02, (1 << 20) + 1)),
  decodeCase("payload u32 max", header(1, 0x02, 0xffffffff)),
  decodeCase("unknown type wins over length", header(1, 0x99, 0xffffffff)),
  decodeCase("stream id u32 max", cat(header(0xffffffff, 0x03, 0))),
];
for (const t of [0x01, 0x02, 0x03, 0x04, 0x10, 0x11, 0x12, 0x13, 0x20, 0x21, 0x22, 0x23, 0x24, 0x30, 0x31, 0x40, 0x41, 0x42, 0x50, 0x51, 0x52]) {
  decode.push(decodeCase(`v1 type 0x${t.toString(16)}`, header(2, t, 0)));
}

const encodeErrors = [];
try {
  tp.encodeFrame({ streamId: 1, type: tp.FRAME_DATA, payload: new Uint8Array((1 << 20) + 1) });
} catch (e) {
  encodeErrors.push({ name: "payload over max", payloadLen: (1 << 20) + 1, error: String(e.message) });
}

/** Parsers over payload bytes. `result` is the TS return value (null = refused). */
const parse = (fn, cases) =>
  cases.map(([name, text]) => {
    const bytes = typeof text === "string" ? utf8(text) : new Uint8Array(text);
    let result;
    try {
      result = fn(bytes);
    } catch (e) {
      result = { threw: String(e.message) };
    }
    return { name, payloadHex: hex(bytes), result: result === undefined ? null : result };
  });

const parsers = {
  helloAck: parse(tp.parseHelloAck, [
    ["ok", '{"ok":true}'],
    ["truthy is not ok", '{"ok":1}'],
    ["reason + caps filtered", '{"ok":false,"reason":"nope","capabilities":["a",1,null,"b"]}'],
    ["blessing null dropped", '{"ok":true,"serviceBlessing":null,"hubSig":5}'],
    ["blessing kept", '{"ok":true,"serviceBlessing":{"x":[1,2]},"hubSig":"' + H128 + '"}'],
    ["array is an object", "[1,2]"],
    ["null", "null"],
    ["number", "7"],
    ["not json", "{ok:true}"],
    ["bom", [0xef, 0xbb, 0xbf, ...utf8('{"ok":true}')]],
    ["invalid utf8 in reason", [...utf8('{"ok":false,"reason":"'), 0xff, ...utf8('"}')]],
    ["duplicate key last wins", '{"ok":false,"ok":true}'],
    ["caps not array", '{"ok":true,"capabilities":"outbound-v1"}'],
  ]),
  outboundOpen: parse(tp.parseOutboundOpen, [
    ["ok", '{"host":"api.openai.com","port":443}'],
    ["port float integral", '{"host":"a","port":443.0}'],
    ["port fraction", '{"host":"a","port":443.5}'],
    ["port zero", '{"host":"a","port":0}'],
    ["port too big", '{"host":"a","port":65536}'],
    ["port string", '{"host":"a","port":"443"}'],
    ["empty host", '{"host":"","port":443}'],
    ["host 253", JSON.stringify({ host: "a".repeat(253), port: 443 })],
    ["host 254", JSON.stringify({ host: "a".repeat(254), port: 443 })],
    ["host 253 utf16 units", JSON.stringify({ host: "é".repeat(253), port: 443 })],
    ["host astral counts two", JSON.stringify({ host: "😀".repeat(127), port: 443 })],
    ["array", '["host"]'],
    ["not json", "x"],
  ]),
  outboundResult: parse(tp.parseOutboundResult, [
    ["ok", '{"ok":true}'],
    ["ok ignores reason", '{"ok":true,"reason":"disabled"}'],
    ["known refusal", '{"ok":false,"reason":"rate-limited"}'],
    ["unknown refusal", '{"ok":false,"reason":"teapot"}'],
    ["missing refusal", '{"ok":false}'],
    ["ok not bool", '{"ok":"true"}'],
    ["array", "[]"],
  ]),
  credit: parse(tp.parseOutboundCredit, [
    ["one", [0, 0, 0, 1]],
    ["max", [0xff, 0xff, 0xff, 0xff]],
    ["zero", [0, 0, 0, 0]],
    ["short", [0, 0, 1]],
    ["long", [0, 0, 0, 1, 0]],
  ]),
  mailboxAnnounce: parse(tp.decodeMailboxAnnounce, [
    ["one", JSON.stringify({ announcements: [{ pikPubHex: H64, epoch: 0, sigHex: H128 }] })],
    ["eight", JSON.stringify({ announcements: Array.from({ length: 8 }, (_, i) => ({ pikPubHex: H64, epoch: i, sigHex: H128 })) })],
    ["nine", JSON.stringify({ announcements: Array.from({ length: 9 }, (_, i) => ({ pikPubHex: H64, epoch: i, sigHex: H128 })) })],
    ["upper hex", JSON.stringify({ announcements: [{ pikPubHex: H64.toUpperCase(), epoch: 0, sigHex: H128 }] })],
    ["negative epoch", JSON.stringify({ announcements: [{ pikPubHex: H64, epoch: -1, sigHex: H128 }] })],
    ["fraction epoch", JSON.stringify({ announcements: [{ pikPubHex: H64, epoch: 1.5, sigHex: H128 }] })],
    ["epoch 1e20", `{"announcements":[{"pikPubHex":"${H64}","epoch":1e20,"sigHex":"${H128}"}]}`],
    ["null entry", '{"announcements":[null]}'],
    ["not array", '{"announcements":{}}'],
    ["top null", "null"],
    ["empty", '{"announcements":[]}'],
  ]),
  pbPut: parse(tp.decodePbPut, [
    ["ok", JSON.stringify({ encChunkId: H64, shardIndex: 2, sizeBytes: 10, signature: H128 })],
    ["fraction allowed", JSON.stringify({ encChunkId: H64, shardIndex: 2.5, sizeBytes: 0, signature: H128 })],
    ["negative", JSON.stringify({ encChunkId: H64, shardIndex: -1, sizeBytes: 10, signature: H128 })],
    ["short sig", JSON.stringify({ encChunkId: H64, shardIndex: 2, sizeBytes: 10, signature: H64 })],
    ["null", "null"],
    ["not json", "{"],
  ]),
  pbPutAck: parse(tp.decodePbPutAck, [
    ["ok", JSON.stringify({ encChunkId: H64, shardIndex: 0, ok: true })],
    ["reason", JSON.stringify({ encChunkId: H64, shardIndex: 0, ok: false, reason: "full" })],
    ["ok missing", JSON.stringify({ encChunkId: H64, shardIndex: 0 })],
  ]),
  pbGet: parse(tp.decodePbGet, [
    ["ok", JSON.stringify({ encChunkId: H64, shardIndex: 1 })],
    ["bad id", JSON.stringify({ encChunkId: "zz", shardIndex: 1 })],
  ]),
  pbGetEnd: parse(tp.decodePbGetEnd, [
    ["ok", JSON.stringify({ encChunkId: H64, shardIndex: 1, sha256: H64B })],
    ["bad sha", JSON.stringify({ encChunkId: H64, shardIndex: 1, sha256: "00" })],
  ]),
  pbChallenge: parse(tp.decodePbChallenge, [
    ["ok", JSON.stringify({ encChunkId: H64, shardIndex: 1, nonce: H64B, offset: 0, length: 1 })],
    ["zero length", JSON.stringify({ encChunkId: H64, shardIndex: 1, nonce: H64B, offset: 0, length: 0 })],
    ["missing offset", JSON.stringify({ encChunkId: H64, shardIndex: 1, nonce: H64B, length: 1 })],
  ]),
  pbResponse: parse(tp.decodePbResponse, [
    ["ok", JSON.stringify({ encChunkId: H64, shardIndex: 1, hash: H64B, signature: H128 })],
    ["bad hash", JSON.stringify({ encChunkId: H64, shardIndex: 1, hash: H128, signature: H128 })],
  ]),
};

const pattern = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 251);
const mailSplits = [
  ["req small", "req", 5, "mbx-1", 12],
  ["req empty", "req", 5, "", 0],
  ["req 2 chunks", "req", 6, "a".repeat(64), (1 << 20) + 10],
  ["resp small", "resp", 7, 200, 3],
  ["resp exactly one chunk", "resp", 7, 404, (1 << 20) - 64 - 2],
  ["resp one byte over", "resp", 7, 502, (1 << 20) - 64 - 1],
].map(([name, kind, streamId, head, size]) => {
  const env = pattern(size);
  const frames = kind === "req" ? tp.mailRequestFrames(streamId, head, env) : tp.mailResponseFrames(streamId, head, env);
  const enc = frames.map((f) => tp.encodeFrame(f));
  return {
    name,
    kind,
    streamId,
    ...(kind === "req" ? { mailboxId: head } : { status: head }),
    envelopeLen: size,
    frames: enc.map((b) => ({ len: b.length, fnv1a64: fnv1a64(b), headHex: hex(b.subarray(0, 24)) })),
  };
});

let mailIdTooLong = null;
try {
  tp.mailRequestFrames(1, "a".repeat(65), new Uint8Array(1));
} catch (e) {
  mailIdTooLong = String(e.message);
}

const assemble = (kind, payloads) => {
  const a = new tp.MailAssembler(kind);
  const steps = [];
  for (const p of payloads) {
    try {
      const r = a.push(new Uint8Array(p));
      steps.push(r.done ? { done: true, bodyHex: hex(r.body), mailboxId: a.mailboxId, status: a.status } : { done: false });
    } catch (e) {
      steps.push({ error: String(e.message) });
      break;
    }
  }
  return { kind, payloadsHex: payloads.map((p) => hex(p)), steps };
};
const mailAssembler = [
  ["single req", "req", [[3, 3, 0x6d, 0x62, 0x78, 0xaa, 0xbb]]],
  ["req short id", "req", [[3, 9, 0x6d]]],
  ["req no id byte", "req", [[3]]],
  ["resp status", "resp", [[3, 0x01, 0xf4, 0x01]]],
  ["resp one status byte", "resp", [[3, 0xc8]]],
  ["two frames", "resp", [[1, 0, 200, 1], [2, 2, 3]]],
  ["empty frame", "req", [[]]],
  ["no first", "resp", [[2, 1]]],
  ["restart", "req", [[1, 0], [1, 0]]],
  ["bom id", "req", [[3, 4, 0xef, 0xbb, 0xbf, 0x61]]],
].map(([name, kind, payloads]) => ({ name, ...assemble(kind, payloads) }));

const doc = {
  description: "Tunnel frame protocol v1 vectors, produced by the TypeScript encoders/decoders in packages/tunnel-protocol. Generated by tools/tunnel-frame-vectors.mjs; do not edit.",
  constants: {
    FRAME_HEADER_BYTES: tp.FRAME_HEADER_BYTES,
    MAX_FRAME_PAYLOAD: tp.MAX_FRAME_PAYLOAD,
    OUTBOUND_STREAM_ID_BASE: tp.OUTBOUND_STREAM_ID_BASE,
    OUTBOUND_INITIAL_WINDOW: tp.OUTBOUND_INITIAL_WINDOW,
    MAIL_MAX_ENVELOPE: tp.MAIL_MAX_ENVELOPE,
  },
  encoded,
  decode,
  encodeErrors,
  parsers,
  mail: { splits: mailSplits, idTooLong: mailIdTooLong, assembler: mailAssembler, envelopePattern: "byte i = (i*7+3) % 251" },
};
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const cur = await readFile(out, "utf8").catch(() => "");
  if (cur !== text) {
    console.error(`${out} is stale; run node tools/tunnel-frame-vectors.mjs`);
    process.exit(1);
  }
  console.log("frame vectors up to date");
} else {
  await writeFile(out, text);
  console.log(`wrote ${out}: ${encoded.length} encoded, ${decode.length} decode cases`);
}
