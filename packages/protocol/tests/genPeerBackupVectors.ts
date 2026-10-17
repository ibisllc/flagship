// Regenerate test-vectors/peer-backup/vectors.json:
//   npx tsx packages/protocol/tests/genPeerBackupVectors.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed } from "../src/edSync.js";
import { hex } from "../src/canonicalBase.js";
import { deriveSWK } from "../src/keys.js";
import { blindPrepare, rsaBlind, rsaBlindSign, rsaFinalize, rsaPrivateKeyFromJwk } from "../src/blindRsa.js";
import { encodePbMailPlaintext, pbXPublicKey, sealPbMailRequest, sealPbMailResponse } from "../src/peerBackupMail.js";
import {
  PB_NETWORK_DEFAULT,
  canonicalPbCheckin,
  canonicalPbDirectory,
  canonicalPbFillerFetch,
  canonicalPbFillerProof,
  canonicalPbMailboxAnnounce,
  canonicalPbOp,
  canonicalPbPikBind,
  canonicalPbRedeem,
  canonicalPbRootDeposit,
  canonicalPbTokens,
  derivePbBrickId,
  derivePbBrickKey,
  derivePbRootKey,
  derivePeerBackupKey,
  pbAccountTag,
  pbBlindedDigest,
  pbBrickCrypt,
  pbFillerAnswer,
  pbFillerBytes,
  pbFillerKey,
  pbMailboxId,
  pbMerkleLevels,
  pbMerklePath,
  pbMerkleRoot,
  pbNetTag,
  pbNetworkPrefix,
  pbSpendsDigest,
  pbTokenMessage,
  sealPbRoot,
  type PbRoot,
} from "../src/peerBackupNet.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../test-vectors/peer-backup");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const td = new TextDecoder();
const te = new TextEncoder();

const umkSeedHex = "5c".repeat(32);
const serverId = "home.harry.flagship.services";
const swk = deriveSWK({ seed: fromHex(umkSeedHex) }, serverId);
const pbk = derivePeerBackupKey(swk);

const brickIdHex = derivePbBrickId(pbk, 3, 7, 5, 1);
const brickPlain = Uint8Array.from({ length: 256 }, (_, i) => (i * 7 + 3) & 255);
const brick = pbBrickCrypt(derivePbBrickKey(pbk, brickIdHex), brickPlain);
const levels = pbMerkleLevels(brick, 64);

const pikSeedHex = "11".repeat(32);
const pikPubHex = hex(ed.getPublicKey(fromHex(pikSeedHex)));
const xSecretHex = "22".repeat(32);
const xPubHex = hex(pbXPublicKey(fromHex(xSecretHex)));
const fillerSecretHex = "33".repeat(32);
const tagSecretHex = "44".repeat(32);
const fillerKey = pbFillerKey(fromHex(fillerSecretHex), pikPubHex, 9);

const root: PbRoot = {
  v: 1,
  serverId,
  generation: 3,
  revision: 2,
  createdAt: 1792000000000,
  network: { ...PB_NETWORK_DEFAULT, k: 1, n: 1 },
  archive: {
    archiveId: "00112233445566778899aabbccddeeff",
    createdAt: 1791990000000,
    bytes: 1000,
    sha256: "ab".repeat(32),
    backupFile: '{"v":2,"slots":[]}',
  },
  payloadBytes: 1000,
  segments: 1,
  indexSegments: 1,
  stripes: [[{ pikPubHex, xPubHex, leaseId: "cd".repeat(16), leaseKeySeedHex: "ef".repeat(32), rev: 0, expiresAt: 1799776000000 }]],
  indexShardHashes: ["aa".repeat(32), "bb".repeat(32)],
};
const rootNonceHex = "0102030405060708090a0b0c";
const sealedRoot = sealPbRoot(root, pbk, fromHex(rootNonceHex));

const rsaKey = JSON.parse(readFileSync(join(dir, "test-rsa-key.json"), "utf8")) as { jwk: Record<string, string> };
const sk = rsaPrivateKeyFromJwk(rsaKey.jwk);
const serialHex = "5e".repeat(32);
const prefixHex = "6f".repeat(32);
const saltHex = "7a".repeat(48);
const rHex = "0f".repeat(64);
const prepared = blindPrepare(pbTokenMessage(serialHex), fromHex(prefixHex));
const blinded = rsaBlind(sk, prepared, { salt: fromHex(saltHex), r: BigInt("0x" + rHex) });
const blindSig = rsaBlindSign(sk, blinded.blindedMsg);
const sig = rsaFinalize(sk, prepared, blindSig, blinded.inv);

const mailboxId = pbMailboxId(pikPubHex, 2961);
const mailPlain = encodePbMailPlaintext({ header: { op: "brick.get", leaseId: "cd".repeat(16) }, body: te.encode("hi") });
const mailReq = sealPbMailRequest(fromHex(xPubHex), mailboxId, mailPlain, {
  ephSecret: fromHex("55".repeat(32)),
  nonce: fromHex("aabbccddeeff001122334455"),
});
const mailResp = sealPbMailResponse(mailReq.keys, mailboxId, te.encode("ok"), fromHex("665544332211ffeeddccbbaa"));

const spends = [{ leaseId: "cd".repeat(16), serialHex, prefixHex, sigHex: hex(sig) }];
const blindedHex = [hex(blinded.blindedMsg)];
const argsJson = JSON.stringify({ op: "brick.get", leaseId: "cd".repeat(16), brickId: brickIdHex });

const out = {
  about:
    "Peer backup between accounts (docs/peer-backup.md). Keys: SWK = deriveSWK(UMK, serverId); PBK = HKDF-SHA256(SWK, salt empty, info 'flagship/peer-backup-key/v1'); rootKey = HKDF(PBK, info 'flagship/pb-root/v1'); brickKey = HKDF(PBK, info 'flagship/pb-brick/v1|'+brickIdHex); brickId = HMAC-SHA256(PBK, 'flagship/pb-brick-id/v1|gen|seg|shard|rev')[0..16]. Bricks: AES-256-CTR IV 0. Merkle: leaf SHA-256(0x00||leaf), node SHA-256(0x01||l||r). Root: AES-256-GCM(rootKey, nonce, JSON, aad 'flagship/pb-root/v1|'+serverId). Filler: AES-256-CTR(HMAC-SHA256(secret, 'flagship/pb-filler/v1|pik|index'), counter = offset/16). Tokens: RFC 9474 RSABSSA-SHA384-PSS-Randomized over 'flagship/pb-token/v1|serialHex'.",
  umkSeedHex,
  serverId,
  swkHex: hex(swk),
  pbkHex: hex(pbk),
  rootKeyHex: hex(derivePbRootKey(pbk)),
  brick: {
    generation: 3,
    segment: 7,
    shard: 5,
    rev: 1,
    brickIdHex,
    brickKeyHex: hex(derivePbBrickKey(pbk, brickIdHex)),
    plainHex: hex(brickPlain),
    brickHex: hex(brick),
    leafBytes: 64,
    merkleRootHex: hex(pbMerkleRoot(brick, 64)),
    leaf2PathHex: pbMerklePath(levels, 2).map(hex),
  },
  root: { json: JSON.stringify(root), nonceHex: rootNonceHex, sealed: sealedRoot },
  mailbox: {
    pikSeedHex,
    pikPubHex,
    epoch: 2961,
    mailboxId,
    announceCanonical: td.decode(canonicalPbMailboxAnnounce(pikPubHex, 2961)),
    announceSigHex: hex(ed.sign(canonicalPbMailboxAnnounce(pikPubHex, 2961), fromHex(pikSeedHex))),
  },
  mail: {
    xSecretHex,
    xPubHex,
    ephSecretHex: "55".repeat(32),
    plaintextHex: hex(mailPlain),
    requestHex: hex(mailReq.envelope),
    responsePlainHex: hex(te.encode("ok")),
    responseHex: hex(mailResp),
  },
  filler: {
    secretHex: fillerSecretHex,
    pikPubHex,
    index: 9,
    keyHex: hex(fillerKey),
    first32Hex: hex(pbFillerBytes(fillerKey, 0, 32)),
    at1024First32Hex: hex(pbFillerBytes(fillerKey, 1024, 32)),
    nonceHex: "99".repeat(16),
    answerLeaf1Of64: pbFillerAnswer(fromHex("99".repeat(16)), pbFillerBytes(fillerKey, 64, 64)),
  },
  tags: {
    secretHex: tagSecretHex,
    username: "Harry",
    accountTag: pbAccountTag(fromHex(tagSecretHex), "Harry"),
    prefixes: [
      ["203.0.113.77", pbNetworkPrefix("203.0.113.77")],
      ["2001:db8:abcd:12::1", pbNetworkPrefix("2001:db8:abcd:12::1")],
      ["::1", pbNetworkPrefix("::1")],
      ["nope", pbNetworkPrefix("nope")],
    ],
    netTag: pbNetTag(fromHex(tagSecretHex), "203.0.113.0/24"),
  },
  token: {
    publicJwk: { kty: "RSA", n: rsaKey.jwk.n, e: rsaKey.jwk.e },
    serialHex,
    prefixHex,
    saltHex,
    rHex,
    messageUtf8: td.decode(pbTokenMessage(serialHex)),
    blindedHex: hex(blinded.blindedMsg),
    blindSigHex: hex(blindSig),
    sigHex: hex(sig),
  },
  canonical: {
    checkin: td.decode(
      canonicalPbCheckin({ serverDomain: serverId, pikPubHex, xPubHex, poolBytes: 1 << 30, fillerHeld: 12, leaving: false, issuedAt: 1792000000000 }),
    ),
    pikBind: td.decode(canonicalPbPikBind(serverId, pikPubHex, xPubHex)),
    directory: td.decode(canonicalPbDirectory(serverId, 1792000000000)),
    tokens: td.decode(canonicalPbTokens(serverId, 1, pbBlindedDigest(blindedHex), 1792000000000)),
    redeem: td.decode(canonicalPbRedeem(serverId, pikPubHex, pbSpendsDigest(spends), 1792000000000)),
    fillerFetch: td.decode(canonicalPbFillerFetch(serverId, 9, 1792000000000)),
    fillerProof: td.decode(canonicalPbFillerProof(serverId, "ab".repeat(16), "cd".repeat(32), 1792000000000)),
    rootDeposit: td.decode(canonicalPbRootDeposit(serverId, 3, 2, "ef".repeat(32), 1792000000000)),
    op: {
      argsJson,
      text: td.decode(
        canonicalPbOp({
          op: "brick.get",
          mailboxId,
          leaseId: "cd".repeat(16),
          issuedAt: 1792000000000,
          nonceHex: "01".repeat(16),
          argsJson,
          bodySha256Hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        }),
      ),
    },
  },
};

writeFileSync(join(dir, "vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote", join(dir, "vectors.json"));
