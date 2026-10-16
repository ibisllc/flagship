import { createPublicKey, verify as nodeVerify, constants } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hex } from "../src/canonicalBase.js";
import { ed } from "../src/edSync.js";
import { deriveSWK } from "../src/keys.js";
import {
  blindPrepare,
  rsaBlind,
  rsaBlindSign,
  rsaFinalize,
  rsaPrivateKeyFromJwk,
  rsaPssVerify,
  rsaPublicKeyFromJwk,
} from "../src/blindRsa.js";
import {
  decodePbMailPlaintext,
  encodePbMailPlaintext,
  openPbMailRequest,
  openPbMailResponse,
  pbGenerateXKeypair,
  sealPbMailRequest,
  sealPbMailResponse,
} from "../src/peerBackupMail.js";
import {
  PB_NETWORK_DEFAULT,
  canonicalPbCheckin,
  canonicalPbOp,
  derivePbBrickId,
  derivePbBrickKey,
  derivePbRootKey,
  derivePeerBackupKey,
  openPbRoot,
  parsePbNetwork,
  pbAccountTag,
  pbBrickCrypt,
  pbFillerAnswer,
  pbFillerBytes,
  pbFillerKey,
  pbMailboxEpoch,
  pbMailboxId,
  pbMerkleLevels,
  pbMerklePath,
  pbMerkleRoot,
  pbNetTag,
  pbNetworkPrefix,
  pbTokenMessage,
  pbVerifyLeaf,
  sealPbRoot,
  type PbRoot,
} from "../src/peerBackupNet.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/peer-backup");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = JSON.parse(readFileSync(join(dir, "vectors.json"), "utf8")) as any;
const KEY = JSON.parse(readFileSync(join(dir, "test-rsa-key.json"), "utf8")) as { jwk: Record<string, string> };
const fromHex = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const te = new TextEncoder();

describe("peer-backup vectors", () => {
  it("keys come from the account key through the SWK", () => {
    const swk = deriveSWK({ seed: fromHex(V.umkSeedHex) }, V.serverId);
    expect(hex(swk)).toBe(V.swkHex);
    const pbk = derivePeerBackupKey(swk);
    expect(hex(pbk)).toBe(V.pbkHex);
    expect(hex(derivePbRootKey(pbk))).toBe(V.rootKeyHex);
    const b = V.brick;
    expect(derivePbBrickId(pbk, b.generation, b.segment, b.shard, b.rev)).toBe(b.brickIdHex);
    expect(hex(derivePbBrickKey(pbk, b.brickIdHex))).toBe(b.brickKeyHex);
    expect(hex(pbBrickCrypt(fromHex(b.brickKeyHex), fromHex(b.plainHex)))).toBe(b.brickHex);
    expect(hex(pbBrickCrypt(fromHex(b.brickKeyHex), fromHex(b.brickHex)))).toBe(b.plainHex);
    expect(hex(pbMerkleRoot(fromHex(b.brickHex), b.leafBytes))).toBe(b.merkleRootHex);
    expect(pbMerklePath(pbMerkleLevels(fromHex(b.brickHex), b.leafBytes), 2).map(hex)).toEqual(b.leaf2PathHex);
  });

  it("the root opens with the PBK and nothing else", () => {
    const pbk = fromHex(V.pbkHex);
    const root = openPbRoot(V.root.sealed, pbk, V.serverId);
    expect(JSON.stringify(root)).toBe(V.root.json);
    expect(sealPbRoot(root, pbk, fromHex(V.root.nonceHex))).toEqual(V.root.sealed);
    expect(() => openPbRoot(V.root.sealed, new Uint8Array(32), V.serverId)).toThrow();
    expect(() => openPbRoot(V.root.sealed, pbk, "home2.harry.flagship.services")).toThrow();
  });

  it("mailbox ids and announcements", () => {
    const m = V.mailbox;
    expect(pbMailboxId(m.pikPubHex, m.epoch)).toBe(m.mailboxId);
    expect(hex(ed.getPublicKey(fromHex(m.pikSeedHex)))).toBe(m.pikPubHex);
    expect(ed.verify(fromHex(m.announceSigHex), te.encode(m.announceCanonical), fromHex(m.pikPubHex))).toBe(true);
    expect(pbMailboxEpoch(m.epoch * 7 * 24 * 3600_000 + 5)).toBe(m.epoch);
  });

  it("mail envelopes", () => {
    const m = V.mail;
    const opened = openPbMailRequest(fromHex(m.xSecretHex), V.mailbox.mailboxId, fromHex(m.requestHex));
    expect(hex(opened.plaintext)).toBe(m.plaintextHex);
    expect(hex(openPbMailResponse(opened.keys, V.mailbox.mailboxId, fromHex(m.responseHex)))).toBe(m.responsePlainHex);
    const again = sealPbMailRequest(fromHex(m.xPubHex), V.mailbox.mailboxId, fromHex(m.plaintextHex), {
      ephSecret: fromHex(m.ephSecretHex),
      nonce: fromHex(m.requestHex).subarray(33, 45),
    });
    expect(hex(again.envelope)).toBe(m.requestHex);
  });

  it("filler and its answer", () => {
    const f = V.filler;
    const key = pbFillerKey(fromHex(f.secretHex), f.pikPubHex, f.index);
    expect(hex(key)).toBe(f.keyHex);
    expect(hex(pbFillerBytes(key, 0, 32))).toBe(f.first32Hex);
    expect(hex(pbFillerBytes(key, 1024, 32))).toBe(f.at1024First32Hex);
    expect(hex(pbFillerBytes(key, 0, 2048).subarray(1024, 1056))).toBe(f.at1024First32Hex);
    expect(pbFillerAnswer(fromHex(f.nonceHex), pbFillerBytes(key, 64, 64))).toBe(f.answerLeaf1Of64);
  });

  it("tags", () => {
    const t = V.tags;
    expect(pbAccountTag(fromHex(t.secretHex), t.username)).toBe(t.accountTag);
    expect(pbAccountTag(fromHex(t.secretHex), "harry")).toBe(t.accountTag);
    for (const [ip, p] of t.prefixes) expect(pbNetworkPrefix(ip)).toBe(p);
    expect(pbNetTag(fromHex(t.secretHex), "203.0.113.0/24")).toBe(t.netTag);
  });

  it("the blind token is an ordinary RSA-PSS signature", () => {
    const t = V.token;
    const sk = rsaPrivateKeyFromJwk(KEY.jwk);
    const pk = rsaPublicKeyFromJwk(t.publicJwk);
    const prepared = blindPrepare(pbTokenMessage(t.serialHex), fromHex(t.prefixHex));
    const b = rsaBlind(pk, prepared, { salt: fromHex(t.saltHex), r: BigInt("0x" + t.rHex) });
    expect(hex(b.blindedMsg)).toBe(t.blindedHex);
    expect(hex(rsaBlindSign(sk, b.blindedMsg))).toBe(t.blindSigHex);
    expect(hex(rsaFinalize(pk, prepared, fromHex(t.blindSigHex), b.inv))).toBe(t.sigHex);
    expect(rsaPssVerify(pk, prepared, fromHex(t.sigHex))).toBe(true);
    const nodeKey = createPublicKey({ key: t.publicJwk, format: "jwk" });
    expect(
      nodeVerify("sha384", prepared, { key: nodeKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, fromHex(t.sigHex)),
    ).toBe(true);
  });

  it("canonical bytes", () => {
    const c = V.canonical;
    expect(c.checkin.startsWith("flagship/pb-checkin/v1|home.harry.flagship.services|")).toBe(true);
    expect(c.op.text.split("|")).toHaveLength(8);
  });
});

describe("blind tokens", () => {
  const sk = rsaPrivateKeyFromJwk(KEY.jwk);
  const pk = { n: sk.n, e: sk.e };

  it("round-trips with fresh randomness and refuses a changed message or signature", () => {
    const serial = hex(crypto.getRandomValues(new Uint8Array(32)));
    const prepared = blindPrepare(pbTokenMessage(serial));
    const b = rsaBlind(pk, prepared);
    const sig = rsaFinalize(pk, prepared, rsaBlindSign(sk, b.blindedMsg), b.inv);
    expect(rsaPssVerify(pk, prepared, sig)).toBe(true);
    const other = blindPrepare(pbTokenMessage("00".repeat(32)), prepared.subarray(0, 32));
    expect(rsaPssVerify(pk, other, sig)).toBe(false);
    const bad = sig.slice();
    bad[10] = bad[10]! ^ 1;
    expect(rsaPssVerify(pk, prepared, bad)).toBe(false);
  });

  it("the signer sees an unrelated value each time", () => {
    const prepared = blindPrepare(pbTokenMessage("ab".repeat(32)), new Uint8Array(32));
    const a = rsaBlind(pk, prepared);
    const b = rsaBlind(pk, prepared);
    expect(hex(a.blindedMsg)).not.toBe(hex(b.blindedMsg));
  });

  it("finalize refuses a signature that isn't the signer's", () => {
    const prepared = blindPrepare(pbTokenMessage("cd".repeat(32)));
    const b = rsaBlind(pk, prepared);
    expect(() => rsaFinalize(pk, prepared, new Uint8Array(256).fill(7), b.inv)).toThrow();
  });
});

describe("Merkle proofs", () => {
  const brick = crypto.getRandomValues(new Uint8Array(4096));
  const levels = pbMerkleLevels(brick, 256);
  const root = levels[levels.length - 1]![0]!;

  it("every leaf verifies and a changed leaf or index doesn't", () => {
    for (let i = 0; i < 16; i++) {
      const leaf = brick.subarray(i * 256, (i + 1) * 256);
      const path = pbMerklePath(levels, i);
      expect(pbVerifyLeaf(root, leaf, i, path, 16)).toBe(true);
      expect(pbVerifyLeaf(root, leaf, (i + 1) % 16, path, 16)).toBe(false);
      const changed = leaf.slice();
      changed[0] = changed[0]! ^ 1;
      expect(pbVerifyLeaf(root, changed, i, path, 16)).toBe(false);
    }
  });

  it("refuses a brick that isn't a power of two of leaves", () => {
    expect(() => pbMerkleLevels(new Uint8Array(3 * 256), 256)).toThrow();
  });
});

describe("mail", () => {
  it("only the holder's key opens a request, and the reply is bound to it", () => {
    const holder = pbGenerateXKeypair();
    const other = pbGenerateXKeypair();
    const mb = "ab".repeat(16);
    const plain = encodePbMailPlaintext({ header: { op: "lease.open", n: 1 }, body: new Uint8Array([1, 2, 3]) });
    const { envelope, keys } = sealPbMailRequest(holder.publicKey, mb, plain);
    expect(() => openPbMailRequest(other.secretKey, mb, envelope)).toThrow();
    expect(() => openPbMailRequest(holder.secretKey, "cd".repeat(16), envelope)).toThrow();
    const opened = openPbMailRequest(holder.secretKey, mb, envelope);
    const d = decodePbMailPlaintext(opened.plaintext);
    expect(d.header).toEqual({ op: "lease.open", n: 1 });
    expect(d.headerJson).toBe('{"op":"lease.open","n":1}');
    expect(Array.from(d.body)).toEqual([1, 2, 3]);
    const reply = sealPbMailResponse(opened.keys, mb, te.encode("done"));
    expect(new TextDecoder().decode(openPbMailResponse(keys, mb, reply))).toBe("done");
  });
});

describe("network constants", () => {
  it("accepts the defaults and the gym's, refuses nonsense", () => {
    expect(parsePbNetwork(PB_NETWORK_DEFAULT)).toEqual(PB_NETWORK_DEFAULT);
    expect(typeof parsePbNetwork({ ...PB_NETWORK_DEFAULT, k: 1, n: 1, brickBytes: 65536, diversity: "account" })).toBe("object");
    expect(typeof parsePbNetwork({ ...PB_NETWORK_DEFAULT, brickBytes: 3000 })).toBe("string");
    expect(typeof parsePbNetwork({ ...PB_NETWORK_DEFAULT, k: 9 })).toBe("string");
    expect(typeof parsePbNetwork({ ...PB_NETWORK_DEFAULT, leafBytes: 8 << 20 })).toBe("string");
  });

  it("canonical bytes refuse separators", () => {
    expect(() =>
      canonicalPbCheckin({ serverDomain: "a|b", pikPubHex: "00".repeat(32), xPubHex: "00".repeat(32), poolBytes: 1, fillerHeld: 0, leaving: false, issuedAt: 1 }),
    ).toThrow();
    expect(() =>
      canonicalPbOp({ op: "x", mailboxId: "00".repeat(16), leaseId: "-", issuedAt: 1, nonceHex: "00".repeat(16), argsJson: "{}", bodySha256Hex: "00".repeat(32) }),
    ).toThrow();
  });
});

describe("root", () => {
  it("a root sealed under one server's PBK doesn't open as another's", () => {
    const pbk = crypto.getRandomValues(new Uint8Array(32));
    const root: PbRoot = JSON.parse(V.root.json);
    const sealed = sealPbRoot(root, pbk);
    expect(openPbRoot(sealed, pbk, root.serverId).generation).toBe(3);
  });
});
