// Regenerates test-vectors/server-backup/vectors.json and
// test-vectors/server-restore/vectors.json:
//   npx tsx packages/protocol/tests/genServerBackupVectors.ts
// Every input is fixed, so the output is byte-stable.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK, deriveServerArchiveKey } from "../src/keys.js";
import {
  backupPasscodeKek,
  generateBackupPasscode,
  sealBackupFile,
  serializeBackupFile,
  serverRestoreCanonicalBytes,
  signServerRestoreOrder,
  wrapAccountSlot,
  wrapPasscodeSlot,
  type BackupBody,
  type ServerRestoreOrder,
} from "../src/serverBackup.js";

const here = dirname(fileURLToPath(import.meta.url));
const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
const seq = (n: number, start: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 255);
const counterRng = () => {
  let i = 0;
  return (n: number) => Uint8Array.from({ length: n }, () => (i++ * 37 + 11) & 255);
};

const umkSeed = fill(32, 0x16);
const archiveId = "00112233445566778899aabbccddeeff";
const contentKey = seq(32, 0x40);
const accountKek = deriveServerArchiveKey({ seed: umkSeed }, archiveId);
const passcode = "k7qm-2xhd-9twp-4frn-6cyb";
const small = { m: 64, t: 1, p: 1 };
const passcodeSlot = wrapPasscodeSlot(archiveId, contentKey, passcode, seq(16, 0x10), seq(12, 0x20), small);
const accountSlot = wrapAccountSlot(archiveId, contentKey, accountKek, seq(12, 0x30));
const body: BackupBody = {
  createdAt: 1792000000000,
  server: { name: "home", domain: "home.harry.flagship.services", bootUnlockMode: "approve", diskEncryption: "luks" },
  apps: [
    { serviceId: "harry--notes", name: "Notes" },
    { serviceId: "harry--chess", name: "Chess Club" },
  ],
  left: [{ serviceId: "harry--old", name: "Old", reason: "its source isn't on this server and its image can't be fetched elsewhere" }],
  includes: ["app databases"],
  excludes: ["the Git host"],
  data: { fileName: "home-2026-10-15.flagship-data", bytes: 123456789, sha256: "ab".repeat(32), frameBytes: 1048576 },
};
const file = sealBackupFile(archiveId, contentKey, [passcodeSlot, accountSlot], body, seq(12, 0x50));
const text = serializeBackupFile(file);

const flipHex = (h: string, at: number) => h.slice(0, at) + (h[at] === "0" ? "1" : "0") + h.slice(at + 1);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const variant = (f: (o: any) => void) => {
  const o = JSON.parse(text);
  f(o);
  return `${JSON.stringify(o)}\n`;
};

const defaultKdf = { algo: "argon2id" as const, m: 65536, t: 3, p: 4, saltHex: bytesToHex(seq(16, 0x60)) };

const backup = {
  about:
    "Server backup files (docs/server-backup-and-clone.md). One random 32-byte content key; slots wrap it with AES-256-GCM (12-byte nonce, 16-byte tag appended). Account slot KEK = deriveServerArchiveKey(UMK, archiveId) = HKDF-SHA256(seed, empty salt, \"flagship/server-archive/v1|<archiveId>\"); AAD \"flagship/server-backup-slot/v2|account|<archiveId>\". Passcode slot KEK = Argon2id v1.3 (NFC(trim(passcode)) as UTF-8, salt, m/t/p, 32 bytes); AAD \"flagship/server-backup-slot/v2|passcode|<archiveId>|argon2id|m=<m>|t=<t>|p=<p>|<saltHex>\". Body = AES-256-GCM(contentKey, bodyNonce, AAD \"flagship/server-backup-body/v2|<archiveId>\", body JSON). The file is JSON {magic,v,archiveId,slots,bodyNonceHex,bodyHex} plus a newline. Generated passcodes: five groups of four, each symbol = alphabet[byte & 31]. Rules: 20+ characters, or 12+ with three of lower/upper/digit/other.",
  alphabet: "abcdefghijkmnpqrstuvwxyz23456789",
  umkSeedHex: bytesToHex(umkSeed),
  archiveId,
  contentKeyHex: bytesToHex(contentKey),
  accountKekHex: bytesToHex(accountKek),
  passcode,
  passcodeKekHex: bytesToHex(backupPasscodeKek(passcode, passcodeSlot.kdf)),
  slots: { passcode: passcodeSlot, account: accountSlot },
  slotNonces: { passcodeSaltHex: bytesToHex(seq(16, 0x10)), passcodeNonceHex: bytesToHex(seq(12, 0x20)), accountNonceHex: bytesToHex(seq(12, 0x30)), bodyNonceHex: bytesToHex(seq(12, 0x50)) },
  body,
  file: text,
  defaultParamsKdf: { passcode, kdf: defaultKdf, kekHex: bytesToHex(backupPasscodeKek(passcode, defaultKdf)) },
  normalize: [
    { input: "  k7qm-2xhd-9twp-4frn-6cyb\n", kekHex: bytesToHex(backupPasscodeKek(passcode, passcodeSlot.kdf)) },
    {
      input: "Café Café Café Café",
      kekHex: bytesToHex(backupPasscodeKek("Café Café Café Café", passcodeSlot.kdf)),
    },
  ],
  generatedPasscode: { rngBytesHex: bytesToHex(counterRng()(20)), passcode: generateBackupPasscode(counterRng()) },
  passcodeRules: {
    ok: ["k7qm-2xhd-9twp-4frn-6cyb", "Tr0ub4dor&3x", "correct horse battery staple", "aaaaaaaaaaaaaaaaaaaa"],
    weak: ["", "short", "alllowercaseletters", "Abcdefghijkl", "abcdefgh1234", "  Ab1Ab1Ab1  "],
  },
  wrongPasscode: "k7qm-2xhd-9twp-4frn-6cyc",
  wrongUmkSeedHex: bytesToHex(fill(32, 0x17)),
  tampered: [
    { why: "body changed", file: variant((o) => (o.bodyHex = flipHex(o.bodyHex, 10))) },
    { why: "archiveId changed", file: variant((o) => (o.archiveId = "ffeeddccbbaa99887766554433221100")) },
    { why: "passcode params changed", file: variant((o) => (o.slots[0].kdf.t = 2)) },
    {
      why: "slots swapped",
      file: variant((o) => {
        const a = o.slots[0];
        const b = o.slots[1];
        o.slots = [
          { kind: "passcode", kdf: a.kdf, nonceHex: b.nonceHex, wrappedHex: b.wrappedHex },
          { kind: "account", nonceHex: a.nonceHex, wrappedHex: a.wrappedHex },
        ];
      }),
    },
  ],
  malformed: [
    { why: "not json", file: "flagship-backup-data/v2\n", code: "malformed" },
    { why: "wrong magic", file: variant((o) => (o.magic = "flagship-archive")), code: "malformed" },
    { why: "old version", file: variant((o) => (o.v = 1)), code: "version" },
    { why: "newer version", file: variant((o) => (o.v = 3)), code: "version" },
    { why: "bad archive id", file: variant((o) => (o.archiveId = "00112233")), code: "malformed" },
    { why: "no slots", file: variant((o) => (o.slots = [])), code: "malformed" },
    { why: "unknown slot kind", file: variant((o) => (o.slots[1].kind = "yubikey")), code: "malformed" },
    { why: "kdf memory too large", file: variant((o) => (o.slots[0].kdf.m = 2097152)), code: "malformed" },
  ],
};

const irk = deriveIRK({ seed: fill(32, 0x2a) });
const orders: ServerRestoreOrder[] = [
  { serverDomain: "home2.harry.flagship.services", archiveId, bytes: 123456789, sha256: "ab".repeat(32), issuedAt: 1792000000000 },
  { serverDomain: "clone.harry.flagship.services", archiveId: "ffeeddccbbaa99887766554433221100", bytes: 24, sha256: "0f".repeat(32), issuedAt: 1700000000000 },
];
const restore = {
  about:
    "flagship/server-restore/v1 (docs/server-backup-and-clone.md): the owner's order that a new server waits for one backup. Canonical: tag|serverDomain|archiveId|bytes|sha256|issuedAt (archiveId 16 bytes, sha256 32 bytes, lowercase hex; bytes >= 1). Signed by the IRK derived from the UMK seed. It rides in the pairing order JSON as \"restore\": {\"order\": {...}, \"signatureHex\": \"...\"}.",
  umkSeedHex: bytesToHex(fill(32, 0x2a)),
  pub: hex(irk.publicKey),
  cases: orders.map((o) => ({
    order: o,
    canonical: new TextDecoder().decode(serverRestoreCanonicalBytes(o)),
    signature: hex(signServerRestoreOrder(o, irk)),
  })),
  invalid: [
    { ...orders[0], serverDomain: "" },
    { ...orders[0], serverDomain: "a|b" },
    { ...orders[0], archiveId: "AB".repeat(16) },
    { ...orders[0], bytes: 0 },
    { ...orders[0], sha256: "ab" },
    { ...orders[0], issuedAt: -1 },
  ],
};

for (const [dir, v] of [
  ["server-backup", backup],
  ["server-restore", restore],
] as const) {
  const p = join(here, "../test-vectors", dir, "vectors.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
  console.log(`wrote ${p}`);
}
