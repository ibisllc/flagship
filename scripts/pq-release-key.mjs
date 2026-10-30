#!/usr/bin/env node
// pq-release-key — the key ceremony for the release ML-DSA-65 key (docs/runbooks/pq-release-key.md).
//
// The release key is a hybrid pair: the existing YubiKey Ed25519 release key (PIV slot 9c, the
// ca-track holder) and an ML-DSA-65 key made here. The ML-DSA seed lives ONLY:
//   * encrypted with age to the owner's two YubiKeys (age-plugin-yubikey recipients), in a file
//     on the owner's Mac (default ~/.flagship-release/pq-release-key.age), never in the repo;
//   * on paper, as a checksummed base32 code.
// It is decrypted with PIN + touch only when signing, held in memory, then wiped. The plaintext
// seed is never written to disk. Label: "PQ release signature (software key, YubiKey-encrypted
// at rest)", pending external review.
//
// Usage:
//   node scripts/pq-release-key.mjs init --recipient age1yubikey1... --recipient age1yubikey1... \
//        [--identity <stubs>] [--out <file>] [--signing-key yubikey-piv:slot=9c] [--path .maintainers] [--no-paper]
//   node scripts/pq-release-key.mjs verify-yubikey     [--key-file <file>] [--identity <stubs>]
//   node scripts/pq-release-key.mjs paper-backup       [--key-file <file>] [--identity <stubs>]
//   node scripts/pq-release-key.mjs restore-from-paper --recipient ... --recipient ... [--out <file>] [--force]
//   node scripts/pq-release-key.mjs show-pub           [--path .maintainers]
//   node scripts/pq-release-key.mjs pin --key-id <hex> [--require-pq-after <releaseId>|auto|none]
//        [--ca-lease] [--box-artifact [--legacy-manifest <manifest.json> ...]]
//                      --ca-lease also pins the key for CA leases (CA_LEASE_PQ_PIN), listing every lease
//                      already in <path>/ca-endorsements as signed before the cut-over; --box-artifact
//                      pins it for box artifacts (release/box-artifact-trust.json "pq"), listing the given
//                      manifests (already published, still installable) the same way
//   node scripts/pq-release-key.mjs fake-yubikeys --fake-yubikey <dir>     (test mode only)
//   node scripts/pq-release-key.mjs sign-ca-lease --endorsement <file> [--key-file] [--signing-key] [--path .maintainers]
//   node scripts/pq-release-key.mjs sign-box-artifact --manifest <in.json> --out <out.json> [--key-file] [--signing-key]
//   node scripts/pq-release-key.mjs sign-runtime-manifest --manifest <in.json> --out <out.json> [--key-file] [--signing-key]
//
//   sign-ca-lease      writes the CA lease's PQ companion (pq-suites.md §16.3) to
//                      <path>/ca-pq/endorsements/<endorsementId>.json, the ca-track binding
//                      (subject flagship-ca-track) to <path>/ca-pq/bindings/ when it is missing,
//                      and regenerates <path>/ca-pq/bundle.json for the Worker
//   sign-box-artifact  adds the signer's PQ companion (pq-suites.md §16.2) to its signature in a
//                      box artifact manifest file, and its binding (subject flagship-box-artifact)
//                      to the file's pqBindings
//
//   --recipient     an age-plugin-yubikey recipient (age1yubikey1...); at least two, one per YubiKey
//   --identity      age-plugin-yubikey identity stubs (not secret; default
//                   ~/.flagship-release/yubikey-identities.txt). age asks for the PIN and touch on
//                   the terminal itself.
//   --out/--key-file the encrypted seed (default ~/.flagship-release/pq-release-key.age)
//   --signing-key   the Ed25519 half: yubikey-piv:slot=9c (PIN read from /dev/tty, like
//                   endorse-release.mjs), or file:<hex> for a drill
//   --path          maintainers folder (default .maintainers): the binding goes to
//                   <path>/release-pq/bindings/
//   --fake-yubikey  TEST MODE: a folder of fake YubiKeys instead of age and the token. PIN from
//                   FLAGSHIP_PQ_FAKE_PIN, the "inserted" key from FLAGSHIP_PQ_FAKE_INSERTED; the
//                   paper code goes to stdout and is read from stdin. Refused against the real
//                   repo's .maintainers.
//
// Exit codes: 0 ok, 1 error, 2 usage.

import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tty from "node:tty";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  boxArtifactV1Digest,
  caLeaseV1Digest,
  canonicalBoxArtifact,
  mldsa65PublicKey,
  pqKeyBindingFromWire,
  RELEASE_PQ_LABEL,
  RELEASE_PQ_PIN,
  releasePqKeyId,
  signReleasePqBinding,
  verifyReleasePqBindings,
} from "@flagship/protocol";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..");
export const DEFAULT_KEY_FILE = path.join(os.homedir(), ".flagship-release", "pq-release-key.age");
export const DEFAULT_IDENTITIES = path.join(os.homedir(), ".flagship-release", "yubikey-identities.txt");
export const PIN_FILE = path.join(REPO, "packages", "protocol", "src", "releasePqPin.ts");
const FAKE_FORMAT = "flagship-fake-yubikey/v1";

export class UsageError extends Error {}

// ── paper code ──────────────────────────────────────────────────────────────
// 0x01 || seed (32) || SHA-256("flagship/pq-release-paper/v1" || 0x01 || seed)[0..4], Crockford
// base32: 60 characters, printed as 3 rows of 4 groups of 5, each row with a 2-character check.

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAPER_TAG = "flagship/pq-release-paper/v1";

function b32encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(s, nBytes) {
  const out = new Uint8Array(nBytes);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new UsageError(`"${ch}" is not a paper-code character`);
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      if (i < nBytes) out[i++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (i !== nBytes) throw new UsageError("the paper code is too short");
  return out;
}

const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

const rowCheck = (i, row) => b32encode(sha256(`${PAPER_TAG}|row|${i}|${row}`)).slice(0, 2);

export function normalizePaper(s) {
  return s.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** The three printed rows for a 32-byte seed. */
export function paperRows(seed) {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const body = new Uint8Array(37);
  body[0] = 1;
  body.set(seed, 1);
  body.set(sha256(PAPER_TAG, Uint8Array.of(1), seed).subarray(0, 4), 33);
  const code = b32encode(body);
  body.fill(0);
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = code.slice(r * 20, r * 20 + 20);
    rows.push(`${row.match(/.{5}/g).join(" ")}  ${rowCheck(r + 1, row)}`);
  }
  return rows;
}

/** Checks one typed row (with its 2-character check); returns its 20 code characters. */
export function checkPaperRow(i, typed) {
  const n = normalizePaper(typed);
  if (n.length !== 22) throw new UsageError(`row ${i} must have 20 characters and its 2-character check (got ${n.length})`);
  const row = n.slice(0, 20);
  if (rowCheck(i, row) !== n.slice(20)) throw new UsageError(`row ${i} has a typo (its check does not match)`);
  return row;
}

/** The seed from the three rows; throws on any typo. */
export function seedFromPaper(rows) {
  if (rows.length !== 3) throw new UsageError("the paper code has 3 rows");
  const code = rows.map((r, i) => checkPaperRow(i + 1, r)).join("");
  const body = b32decode(code, 37);
  try {
    if (body[0] !== 1) throw new UsageError("unknown paper-code version");
    const seed = body.slice(1, 33);
    const want = sha256(PAPER_TAG, Uint8Array.of(1), seed).subarray(0, 4);
    if (!want.every((b, i) => b === body[33 + i])) {
      seed.fill(0);
      throw new UsageError("the paper code's checksum does not match");
    }
    return seed;
  } finally {
    body.fill(0);
  }
}

// ── vaults: where the seed is kept encrypted ────────────────────────────────

/** Real: age with age-plugin-yubikey recipients. age prompts for PIN and touch on the terminal. */
export function ageVault({ recipients = [], identities = [DEFAULT_IDENTITIES], ageBinary = "age" } = {}) {
  return {
    fake: false,
    describe: () => `age to ${recipients.length || "?"} YubiKey recipient(s)`,
    checkRecipients() {
      if (new Set(recipients).size < 2) throw new UsageError("give two distinct --recipient values, one per YubiKey");
      for (const r of recipients) {
        if (!/^age1yubikey1[0-9a-z]+$/.test(r)) throw new UsageError(`not an age-plugin-yubikey recipient: ${r}`);
      }
    },
    encrypt(seed) {
      this.checkRecipients();
      const r = spawnSync(ageBinary, ["--armor", ...recipients.flatMap((x) => ["-r", x])], {
        input: Buffer.from(seed),
        stdio: ["pipe", "pipe", "inherit"],
      });
      if (r.status !== 0 || !r.stdout?.length) throw new Error(`age could not encrypt (exit ${r.status ?? r.error?.message})`);
      return r.stdout;
    },
    decrypt(ciphertext) {
      const ids = identities.filter((f) => fs.existsSync(f));
      if (ids.length === 0) throw new UsageError(`no identity stubs found (${identities.join(", ")}); see the runbook`);
      const r = spawnSync(ageBinary, ["--decrypt", ...ids.flatMap((x) => ["-i", x])], {
        input: ciphertext,
        stdio: ["pipe", "pipe", "inherit"],
        maxBuffer: 4096,
      });
      if (r.status !== 0 || !r.stdout) throw new Error("age could not decrypt the release key (wrong YubiKey, PIN or no touch)");
      const seed = new Uint8Array(r.stdout);
      r.stdout.fill(0);
      if (seed.length !== 32) {
        seed.fill(0);
        throw new Error("the decrypted release key is not 32 bytes");
      }
      return seed;
    },
  };
}

/** TEST MODE: fake YubiKeys, each an AES-256-GCM key and a PIN in a folder. */
export function fakeVault({ dir, recipients = [], env = process.env }) {
  const load = (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
  return {
    fake: true,
    describe: () => `FAKE YubiKeys in ${dir} (test mode)`,
    checkRecipients() {
      if (new Set(recipients).size < 2) throw new UsageError("give two distinct --recipient values, one per YubiKey");
      for (const r of recipients) if (!/^fake-yubikey:[a-z0-9-]+$/.test(r)) throw new UsageError(`not a fake recipient: ${r}`);
    },
    encrypt(seed) {
      this.checkRecipients();
      const slots = recipients.map((recipient) => {
        const k = load(recipient.slice("fake-yubikey:".length));
        const iv = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", Buffer.from(k.keyHex, "hex"), iv);
        const ct = Buffer.concat([c.update(seed), c.final(), c.getAuthTag()]);
        return { recipient, iv: iv.toString("hex"), ct: ct.toString("hex") };
      });
      return Buffer.from(JSON.stringify({ format: FAKE_FORMAT, slots }) + "\n");
    },
    decrypt(ciphertext) {
      const doc = JSON.parse(ciphertext.toString("utf8"));
      if (doc.format !== FAKE_FORMAT) throw new Error("not a fake-YubiKey file");
      const inserted = env.FLAGSHIP_PQ_FAKE_INSERTED ?? doc.slots[0]?.recipient.slice("fake-yubikey:".length);
      const k = load(inserted);
      if (env.FLAGSHIP_PQ_FAKE_PIN !== k.pin) throw new Error("wrong PIN (fake YubiKey)");
      const slot = doc.slots.find((s) => s.recipient === `fake-yubikey:${inserted}`);
      if (!slot) throw new Error("the inserted YubiKey is not a recipient of this file");
      const raw = Buffer.from(slot.ct, "hex");
      const d = createDecipheriv("aes-256-gcm", Buffer.from(k.keyHex, "hex"), Buffer.from(slot.iv, "hex"));
      d.setAuthTag(raw.subarray(raw.length - 16));
      const seed = new Uint8Array(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]));
      if (seed.length !== 32) throw new Error("bad fake key file");
      return seed;
    },
  };
}

export function createFakeYubikeys(dir, names = ["yk-a", "yk-b"], pin = "123456") {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ name, keyHex: randomBytes(32).toString("hex"), pin }), { mode: 0o600 });
  }
  return names.map((n) => `fake-yubikey:${n}`);
}

// ── the Ed25519 half ────────────────────────────────────────────────────────

export async function loadMaintainersCli() {
  const candidates = [process.env.FLAGSHIP_MAINTAINERS_DIR, path.join(REPO, "maintainers"), path.join(REPO, "..", "maintainers")].filter(Boolean);
  for (const dir of candidates) {
    const file = path.join(dir, "packages", "cli", "dist", "index.js");
    if (fs.existsSync(file)) {
      const cli = await import(pathToFileURL(file).href);
      const keysource = await import(pathToFileURL(path.join(dir, "packages", "cli", "dist", "lib", "keysource.js")).href);
      const ceremony = await import(pathToFileURL(path.join(dir, "packages", "cli", "dist", "lib", "ceremony.js")).href);
      return { cli, keysource, ceremony };
    }
  }
  return null;
}

/**
 * `yubikey-piv:slot=9c`: the maintainers CLI's token signer (PIN from /dev/tty, touch per
 * signature). `file:<path>`: a hex Ed25519 seed for drills and tests.
 */
export async function loadEd25519Signer(source) {
  if (source.startsWith("file:")) {
    const hex = fs.readFileSync(source.slice(5), "utf8").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new UsageError(`${source}: expected a 64-hex Ed25519 seed`);
    const seed = Buffer.from(hex, "hex");
    return {
      source,
      token: false,
      pubHex: Buffer.from(ed25519.getPublicKey(seed)).toString("hex"),
      sign: async (m) => ed25519.sign(m, seed),
    };
  }
  if (!source.startsWith("yubikey-piv:")) throw new UsageError(`unsupported --signing-key ${source}`);
  const lib = await loadMaintainersCli();
  if (!lib) throw new UsageError("maintainers CLI not found (set FLAGSHIP_MAINTAINERS_DIR to its clone, built)");
  const signer = await lib.keysource.loadSigner(source, {
    pivTransport: lib.cli.defaultEnv.pivTransport,
    pivPin: lib.cli.defaultEnv.pivPin,
  });
  return {
    source,
    token: true,
    pubHex: signer.pubKey.toLowerCase(),
    sign: async (m) => Uint8Array.from(Buffer.from(await signer.sign(m), "hex")),
  };
}

// ── bindings on disk ────────────────────────────────────────────────────────

export function bindingsDir(root) {
  return path.join(root, "release-pq", "bindings");
}

export function readBindings(root) {
  const dir = bindingsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return pqKeyBindingFromWire(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The bound key whose ML-DSA half this seed makes, or null. */
export function boundKeyForSeed(root, seed) {
  const pub = Buffer.from(mldsa65PublicKey(seed)).toString("hex");
  return readBindings(root).find((b) => b.mldsaPubHex === pub) ?? null;
}

// ── seed handling ───────────────────────────────────────────────────────────

/** Decrypts the seed (PIN + touch), runs `use(seed)`, and wipes the seed whatever happens. */
export async function withSeed(vault, keyFile, use) {
  if (!fs.existsSync(keyFile)) throw new UsageError(`no encrypted release key at ${keyFile}`);
  const seed = vault.decrypt(fs.readFileSync(keyFile));
  try {
    return await use(seed);
  } finally {
    seed.fill(0);
  }
}

function writeEncrypted(file, ciphertext, force) {
  if (fs.existsSync(file) && !force) throw new UsageError(`${file} exists; refusing to overwrite (pass --force after checking it)`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, ciphertext, { mode: 0o600 });
}

// ── terminal ────────────────────────────────────────────────────────────────

/** Real: /dev/tty, so a pipe or redirect never captures the paper code. Fake: stdio. */
export function terminal(fake) {
  if (fake) {
    const lines = fs.readFileSync(0, "utf8").split(/\r?\n/);
    return {
      write: (s) => process.stdout.write(s),
      readLine: async () => lines.shift() ?? "",
      clear: () => {},
      close: () => {},
    };
  }
  const fd = fs.openSync("/dev/tty", "r+");
  const input = new tty.ReadStream(fd);
  const output = new tty.WriteStream(fd);
  return {
    write: (s) => output.write(s),
    readLine: (opts = {}) =>
      new Promise((resolve) => {
        let buf = "";
        input.setRawMode(Boolean(opts.hidden));
        const onData = (d) => {
          for (const ch of d.toString("utf8")) {
            if (ch === "\r" || ch === "\n") {
              input.off("data", onData);
              input.setRawMode(false);
              input.pause();
              if (opts.hidden) output.write("\n");
              resolve(buf);
              return;
            }
            if (ch === "\u0003") process.exit(130);
            if (ch === "\u007f") buf = buf.slice(0, -1);
            else buf += ch;
          }
        };
        input.on("data", onData);
        input.resume();
      }),
    clear: () => output.write("\x1b[2J\x1b[3J\x1b[H"),
    close: () => {
      input.destroy();
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}

async function printPaper(term, seed, keyId) {
  term.write("\n=== PAPER BACKUP: the release ML-DSA-65 key ===\n");
  term.write("Write these three rows on paper, check them, and store the paper safely.\n");
  term.write("Anyone holding this paper and a quantum computer could sign releases. Never photograph it.\n\n");
  for (const row of paperRows(seed)) term.write(`    ${row}\n`);
  term.write(`\n    release key id: ${keyId.slice(0, 16)}\n\n`);
  term.write("Press Enter once it is written down; the screen is then cleared.\n");
  await term.readLine();
  term.clear();
}

// ── commands ────────────────────────────────────────────────────────────────

function vaultFor(args) {
  if (args.fakeYubikey) return fakeVault({ dir: args.fakeYubikey, recipients: args.recipients });
  return ageVault({ recipients: args.recipients, identities: args.identities.length ? args.identities : [DEFAULT_IDENTITIES] });
}

function rootFor(args) {
  const root = path.resolve(args.path ?? ".maintainers");
  if (args.fakeYubikey && path.resolve(root) === path.join(REPO, ".maintainers")) {
    throw new UsageError("test mode (--fake-yubikey) must not write into the real .maintainers folder; pass --path");
  }
  return root;
}

export async function cmdInit(args, out) {
  const vault = vaultFor(args);
  vault.checkRecipients();
  const root = rootFor(args);
  const keyFile = path.resolve(args.out ?? DEFAULT_KEY_FILE);
  if (fs.existsSync(keyFile)) throw new UsageError(`${keyFile} exists; a release key was already made`);
  const ed = await loadEd25519Signer(args.signingKey ?? "yubikey-piv:slot=9c");
  out(`Ed25519 release key: ${ed.pubHex} (${ed.token ? "YubiKey" : "FILE KEY: drill only"})`);
  out(`Vault: ${vault.describe()}`);
  const seed = new Uint8Array(randomBytes(32));
  try {
    const mldsaPubHex = Buffer.from(mldsa65PublicKey(seed)).toString("hex");
    const keyId = releasePqKeyId(ed.pubHex, mldsaPubHex);
    // Sign first: the card connection opened to read the public key goes stale if the age plugin runs (and
    // touches the YubiKey) before the signature, and nothing is written to disk until the signature is in.
    out("Signing the release-key binding: approve on the YubiKey (PIN, then touch).");
    const file = path.join(bindingsDir(root), `${keyId.slice(0, 16)}.json`);
    const binding = await signReleasePqBinding({ ed25519PubHex: ed.pubHex, mldsaPubHex, issuedAt: Date.now() }, ed.sign, seed);
    const { bindings } = verifyReleasePqBindings([binding], { version: 1, keyIds: [keyId], requirePqAfter: null }, Date.now());
    if (bindings.length !== 1) throw new Error("the new binding does not verify");
    writeEncrypted(keyFile, vault.encrypt(seed), false);
    out(`Encrypted seed written to ${keyFile}`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(binding, null, 2) + "\n");
    } catch (e) {
      // No paper backup exists yet, so the file holds a seed nobody can recover: drop it, or the next attempt is
      // refused ("a release key was already made").
      fs.rmSync(keyFile, { force: true });
      throw e;
    }
    out(`Binding written to ${file}`);
    if (!args.noPaper) {
      const term = terminal(vault.fake);
      try {
        await printPaper(term, seed, keyId);
      } finally {
        term.close();
      }
    }
    out(`\nRelease key id: ${keyId}`);
    out(`Next: verify-yubikey with EACH YubiKey, then: node scripts/pq-release-key.mjs pin --key-id ${keyId} --require-pq-after auto`);
    return { keyId, keyFile, bindingFile: file, mldsaPubHex, ed25519PubHex: ed.pubHex };
  } finally {
    seed.fill(0);
  }
}

export async function cmdVerifyYubikey(args, out) {
  const vault = vaultFor(args);
  const root = rootFor(args);
  const keyFile = path.resolve(args.keyFile ?? args.out ?? DEFAULT_KEY_FILE);
  return withSeed(vault, keyFile, async (seed) => {
    const b = boundKeyForSeed(root, seed);
    if (!b) throw new Error("this YubiKey opened the file, but the key in it matches no binding in " + bindingsDir(root));
    const keyId = releasePqKeyId(b.ed25519PubHex, b.mldsaPubHex);
    out(`OK: the inserted YubiKey opens the release key ${keyId.slice(0, 16)}; nothing was written.`);
    return { keyId };
  });
}

export async function cmdPaperBackup(args, out) {
  const vault = vaultFor(args);
  const root = rootFor(args);
  const keyFile = path.resolve(args.keyFile ?? args.out ?? DEFAULT_KEY_FILE);
  return withSeed(vault, keyFile, async (seed) => {
    const b = boundKeyForSeed(root, seed);
    if (!b) throw new Error("the decrypted key matches no binding; refusing to print a backup of an unknown key");
    const keyId = releasePqKeyId(b.ed25519PubHex, b.mldsaPubHex);
    const term = terminal(vault.fake);
    try {
      await printPaper(term, seed, keyId);
    } finally {
      term.close();
    }
    out(`Paper backup printed for ${keyId.slice(0, 16)}.`);
    return { keyId };
  });
}

export async function cmdRestoreFromPaper(args, out) {
  const vault = vaultFor(args);
  vault.checkRecipients();
  const root = rootFor(args);
  const keyFile = path.resolve(args.out ?? DEFAULT_KEY_FILE);
  if (fs.existsSync(keyFile) && !args.force) throw new UsageError(`${keyFile} exists; refusing to overwrite (pass --force after checking it)`);
  const term = terminal(vault.fake);
  const rows = [];
  try {
    for (let i = 1; i <= 3; i++) {
      for (;;) {
        term.write(`Row ${i} (20 characters and the 2-character check): `);
        const typed = await term.readLine({ hidden: true });
        try {
          rows.push(checkPaperRow(i, typed));
          break;
        } catch (e) {
          if (vault.fake) throw e;
          term.write(`${e.message}; type it again.\n`);
        }
      }
    }
  } finally {
    term.close();
  }
  const withChecks = rows.map((r, i) => r + rowCheck(i + 1, r));
  const seed = seedFromPaper(withChecks);
  try {
    const b = boundKeyForSeed(root, seed);
    if (!b) throw new Error("the paper code is valid but its key matches no binding in " + bindingsDir(root));
    const keyId = releasePqKeyId(b.ed25519PubHex, b.mldsaPubHex);
    writeEncrypted(keyFile, vault.encrypt(seed), Boolean(args.force));
    out(`Restored release key ${keyId.slice(0, 16)}, encrypted to ${args.recipients.length} YubiKeys at ${keyFile}.`);
    return { keyId, keyFile };
  } finally {
    seed.fill(0);
  }
}

export function cmdShowPub(args, out, pin = RELEASE_PQ_PIN) {
  const root = path.resolve(args.path ?? ".maintainers");
  const bindings = readBindings(root);
  const rows = bindings.map((b) => {
    const keyId = releasePqKeyId(b.ed25519PubHex, b.mldsaPubHex);
    return {
      keyId,
      ed25519PubHex: b.ed25519PubHex,
      mldsaFingerprint: createHash("sha256").update(Buffer.from(b.mldsaPubHex, "hex")).digest("hex"),
      boundAt: new Date(b.issuedAt).toISOString(),
      pinned: pin.keyIds.includes(keyId),
    };
  });
  out(`${RELEASE_PQ_LABEL}; pending external review.`);
  if (rows.length === 0) out(`No release-key binding in ${bindingsDir(root)}.`);
  for (const r of rows) {
    out(`  key id:         ${r.keyId}${r.pinned ? "  (pinned)" : "  (NOT pinned)"}`);
    out(`  ed25519:        ${r.ed25519PubHex}`);
    out(`  ml-dsa-65 sha256: ${r.mldsaFingerprint}`);
    out(`  bound at:       ${r.boundAt}`);
  }
  out(`Pin: ${pin.keyIds.length ? pin.keyIds.join(", ") : "(empty: v1 endorsements alone are checked)"}; require PQ after: ${pin.requirePqAfter ? `${pin.requirePqAfter.releaseId} (${pin.requirePqAfter.commitHash.slice(0, 12)})` : "none"}`);
  return rows;
}

/** The newest committed v1 endorsement, for `--require-pq-after auto`. */
export function newestEndorsement(root) {
  const dir = path.join(root, "endorsements");
  let newest = null;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".json")) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (e?.kind === "ReleaseEndorsement" && (!newest || Date.parse(e.issuedAt) >= Date.parse(newest.issuedAt))) newest = e;
    } catch {
      /* skip */
    }
  }
  return newest;
}

export function renderPin(pin) {
  const keyIds = pin.keyIds.map((k) => `"${k}"`).join(", ");
  const marker = pin.requirePqAfter
    ? `{ releaseId: "${pin.requirePqAfter.releaseId}", commitHash: "${pin.requirePqAfter.commitHash}" }`
    : "null";
  return [
    "// BEGIN RELEASE_PQ_PIN (generated)",
    "export const RELEASE_PQ_PIN: ReleasePqPin = Object.freeze({",
    "  version: 1,",
    `  keyIds: Object.freeze([${keyIds}]) as readonly string[],`,
    `  requirePqAfter: ${marker},`,
    "});",
    "// END RELEASE_PQ_PIN",
  ].join("\n");
}

/** The client copies of the pin's key ids (security notices' PQ half, pq-suites.md §14). */
export const CLIENT_PIN_FILES = [
  { file: path.join(REPO, "apps/web/public/webapp/lib/releasePqPin.js"), render: (ids) => `export const RELEASE_PQ_KEY_IDS = Object.freeze([${ids.map((k) => `"${k}"`).join(", ")}]);` },
  { file: path.join(REPO, "apps/mobile/shared/Sources/FlagshipCore/SecurityNotice.swift"), render: (ids) => `    public static let keyIds: [String] = [${ids.map((k) => `"${k}"`).join(", ")}]` },
  { file: path.join(REPO, "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/SecurityNotice.kt"), render: (ids) => `    val RELEASE_PQ_KEY_IDS: List<String> = listOf(${ids.map((k) => `"${k}"`).join(", ")})` },
];

export function writeClientPins(keyIds, files = CLIENT_PIN_FILES) {
  const re = /(\/\/ BEGIN RELEASE_PQ_KEY_IDS \(generated\)\n)[\s\S]*?(\n\s*\/\/ END RELEASE_PQ_KEY_IDS)/;
  for (const { file, render } of files) {
    const src = fs.readFileSync(file, "utf8");
    if (!re.test(src)) throw new Error(`${file} has no generated RELEASE_PQ_KEY_IDS block`);
    fs.writeFileSync(file, src.replace(re, (_, a, b) => a + render(keyIds) + b));
  }
}

export function cmdPin(args, out, { pinFile = PIN_FILE, current = RELEASE_PQ_PIN } = {}) {
  const root = path.resolve(args.path ?? ".maintainers");
  const keyId = String(args.keyId ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(keyId)) throw new UsageError("--key-id must be the 64-hex release key id (show-pub prints it)");
  const bound = readBindings(root).some((b) => releasePqKeyId(b.ed25519PubHex, b.mldsaPubHex) === keyId);
  if (!bound) throw new UsageError(`no binding for ${keyId.slice(0, 16)} in ${bindingsDir(root)}: commit the binding first`);
  let requirePqAfter = current.requirePqAfter;
  const mode = args.requirePqAfter ?? "auto";
  if (mode === "none") requirePqAfter = null;
  else if (mode === "auto") {
    if (!requirePqAfter) {
      const e = newestEndorsement(root);
      requirePqAfter = e ? { releaseId: e.releaseId, commitHash: e.commitHash.toLowerCase() } : null;
    }
  } else {
    const dir = path.join(root, "endorsements");
    const e = fs
      .readdirSync(dir)
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .find((x) => x?.releaseId === mode);
    if (!e) throw new UsageError(`no endorsement with releaseId ${mode}`);
    requirePqAfter = { releaseId: e.releaseId, commitHash: e.commitHash.toLowerCase() };
  }
  const pin = { version: 1, keyIds: [...new Set([...current.keyIds, keyId])], requirePqAfter };
  const src = fs.readFileSync(pinFile, "utf8");
  const re = /\/\/ BEGIN RELEASE_PQ_PIN \(generated\)[\s\S]*?\/\/ END RELEASE_PQ_PIN/;
  if (!re.test(src)) throw new Error(`${pinFile} has no generated pin block`);
  fs.writeFileSync(pinFile, src.replace(re, renderPin(pin)));
  if (pinFile === PIN_FILE) writeClientPins(pin.keyIds);
  out(`Pin written to ${pinFile}: ${pin.keyIds.length} key(s); require PQ after ${requirePqAfter ? requirePqAfter.releaseId : "every endorsement"}.`);
  if (args.caLease) pinCaLease(root, keyId, out);
  if (args.boxArtifact) pinBoxArtifact(keyId, args.legacyManifests ?? [], out);
  out("Rebuild (npx tsc -b), run the tests, commit the pin and the binding together. From the next release a box needs both signatures.");
  return pin;
}

export const CA_LEASE_PIN_FILE = path.join(REPO, "packages", "protocol", "src", "caLeasePq.ts");
export const CA_LEASE_WEB_MIRROR = path.join(REPO, "apps", "web", "public", "webapp", "lib", "maintainerTrust.js");
export const BOX_ARTIFACT_TRUST_FILE = path.join(REPO, "release", "box-artifact-trust.json");

/** CA_LEASE_PQ_PIN: this key, and every lease already committed counted as signed before the cut-over. */
export function pinCaLease(root, keyId, out, pinFile = CA_LEASE_PIN_FILE, webMirror = pinFile === CA_LEASE_PIN_FILE ? CA_LEASE_WEB_MIRROR : null) {
  const dir = path.join(root, "ca-endorsements");
  const legacy = new Set();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".json") || f === "bundle.json") continue;
    let e;
    try {
      e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const d = e && caLeaseV1Digest(e);
    if (d) legacy.add(d);
  }
  const src = fs.readFileSync(pinFile, "utf8");
  const re = /\/\/ BEGIN CA_LEASE_PQ_PIN \(generated\)[\s\S]*?\/\/ END CA_LEASE_PQ_PIN/;
  const cur = /keyIds: Object\.freeze\(\[([^\]]*)\]\)/.exec(src.match(re)?.[0] ?? "");
  if (!cur) throw new Error(`${pinFile} has no generated CA_LEASE_PQ_PIN block`);
  const keyIds = [...new Set([...(cur[1].match(/[0-9a-f]{64}/g) ?? []), keyId])];
  const list = (xs) => xs.map((x) => `"${x}"`).join(", ");
  fs.writeFileSync(
    pinFile,
    src.replace(
      re,
      [
        "// BEGIN CA_LEASE_PQ_PIN (generated)",
        "export const CA_LEASE_PQ_PIN: CaLeasePqPin = Object.freeze({",
        "  version: 1,",
        `  keyIds: Object.freeze([${list(keyIds)}]) as readonly string[],`,
        `  legacyLeases: Object.freeze([${list([...legacy].sort())}]) as readonly string[],`,
        "});",
        "// END CA_LEASE_PQ_PIN",
      ].join("\n"),
    ),
  );
  // The webapp keeps a hand-mirrored copy of this pin (lib/maintainerTrust.js); a test fails when they differ.
  if (webMirror && fs.existsSync(webMirror)) {
    const web = fs.readFileSync(webMirror, "utf8");
    const line = /^export const CA_LEASE_PQ_PIN = .*$/m;
    if (!line.test(web)) throw new Error(`${webMirror} has no CA_LEASE_PQ_PIN line to update`);
    const frozen = (xs) => `Object.freeze([${list(xs)}])`;
    fs.writeFileSync(webMirror, web.replace(line, `export const CA_LEASE_PQ_PIN = Object.freeze({ version: 1, keyIds: ${frozen(keyIds)}, legacyLeases: ${frozen([...legacy].sort())} });`));
  }
  out(`CA lease pin written: ${keyIds.length} key(s), ${legacy.size} lease(s) signed before the cut-over. Sign each new lease's companion with sign-ca-lease.`);
}

/** release/box-artifact-trust.json "pq": this key, and the given published manifests as signed before the cut-over. */
export function pinBoxArtifact(keyId, legacyManifestFiles, out, trustFile = BOX_ARTIFACT_TRUST_FILE) {
  const t = JSON.parse(fs.readFileSync(trustFile, "utf8"));
  const pq = t.pq ?? { keyIds: [], legacyManifests: [] };
  const legacy = new Set(pq.legacyManifests ?? []);
  for (const f of legacyManifestFiles) {
    const doc = JSON.parse(fs.readFileSync(f, "utf8"));
    legacy.add(boxArtifactV1Digest(canonicalBoxArtifact(doc.manifest)));
  }
  t.pq = { keyIds: [...new Set([...(pq.keyIds ?? []), keyId])], legacyManifests: [...legacy].sort() };
  fs.writeFileSync(trustFile, JSON.stringify(t, null, 2) + "\n");
  out(`Box artifact pin written to ${trustFile}: ${t.pq.keyIds.length} key(s), ${t.pq.legacyManifests.length} legacy manifest(s). Run node scripts/gen-box-release.mjs --write.`);
}

// ── argv ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { recipients: [], identities: [] };
  const [verb, ...rest] = argv;
  out.verb = verb;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => {
      const v = rest[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--recipient") out.recipients.push(val());
    else if (a === "--identity") out.identities.push(val());
    else if (a === "--out") out.out = val();
    else if (a === "--key-file") out.keyFile = val();
    else if (a === "--signing-key") out.signingKey = val();
    else if (a === "--path") out.path = val();
    else if (a === "--fake-yubikey") out.fakeYubikey = path.resolve(val());
    else if (a === "--key-id") out.keyId = val();
    else if (a === "--endorsement") out.endorsement = val();
    else if (a === "--manifest") out.manifest = val();
    else if (a === "--require-pq-after") out.requirePqAfter = val();
    else if (a === "--no-paper") out.noPaper = true;
    else if (a === "--ca-lease") out.caLease = true;
    else if (a === "--box-artifact") out.boxArtifact = true;
    else if (a === "--legacy-manifest") (out.legacyManifests ??= []).push(val());
    else if (a === "--force") out.force = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
  if (args.help || !args.verb) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    process.stdout.write(src.slice(1, src.findIndex((l, i) => i > 2 && !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return args.help ? 0 : 2;
  }
  const out = (s) => process.stdout.write(s + "\n");
  if (args.fakeYubikey) out("TEST MODE: fake YubiKeys. Nothing here protects a real release key.");
  const run = {
    init: () => cmdInit(args, out),
    "verify-yubikey": () => cmdVerifyYubikey(args, out),
    "paper-backup": () => cmdPaperBackup(args, out),
    "restore-from-paper": () => cmdRestoreFromPaper(args, out),
    "show-pub": () => cmdShowPub(args, out),
    pin: () => cmdPin(args, out),
    "sign-ca-lease": async () => {
      if (!args.endorsement) throw new UsageError("sign-ca-lease needs --endorsement <file>");
      const r = await signCaLeaseCompanion({
        root: rootFor(args),
        endorsement: JSON.parse(fs.readFileSync(args.endorsement, "utf8")),
        signingKey: args.signingKey ?? "yubikey-piv:slot=9c",
        vault: vaultFor(args),
        keyFile: args.keyFile ?? DEFAULT_KEY_FILE,
        out,
      });
      out(`wrote ${r.file} (key id ${r.keyId})`);
    },
    "sign-box-artifact": async () => {
      if (!args.manifest || !args.out) throw new UsageError("sign-box-artifact needs --manifest <in> and --out <out>");
      const doc = await signBoxArtifactCompanion({
        doc: JSON.parse(fs.readFileSync(args.manifest, "utf8")),
        signingKey: args.signingKey ?? "yubikey-piv:slot=9c",
        vault: vaultFor(args),
        keyFile: args.keyFile ?? DEFAULT_KEY_FILE,
        out,
      });
      fs.writeFileSync(args.out, JSON.stringify(doc, null, 2) + "\n");
      out(`wrote ${args.out}`);
    },
    "sign-runtime-manifest": async () => {
      if (!args.manifest || !args.out) throw new UsageError("sign-runtime-manifest needs --manifest <in> and --out <out>");
      const doc = await signRuntimeManifestCompanion({
        doc: JSON.parse(fs.readFileSync(args.manifest, "utf8")),
        signingKey: args.signingKey ?? "yubikey-piv:slot=9c",
        vault: vaultFor(args),
        keyFile: args.keyFile ?? DEFAULT_KEY_FILE,
        out,
      });
      fs.writeFileSync(args.out, JSON.stringify(doc, null, 2) + "\n");
      out(`wrote ${args.out}`);
    },
    "fake-yubikeys": () => {
      if (!args.fakeYubikey) throw new UsageError("fake-yubikeys needs --fake-yubikey <dir>");
      for (const r of createFakeYubikeys(args.fakeYubikey)) out(r);
    },
  }[args.verb];
  if (!run) {
    process.stderr.write(`error: unknown command ${args.verb}\n`);
    return 2;
  }
  try {
    await run();
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
      process.exit(1);
    },
  );
}

// ── used by scripts/endorse-release.mjs ─────────────────────────────────────

export function companionsDir(root) {
  return path.join(root, "release-pq", "endorsements");
}

/**
 * Signs and writes the hybrid companion for a v1 endorsement already on disk: decrypt the
 * ML-DSA seed (PIN + touch), sign M' with the Ed25519 token (PIN + touch), check the result with
 * the same verifier boxes run, wipe the seed.
 */
export async function signReleaseCompanion({ root, endorsement, signingKey, vault, keyFile, out = () => {} }) {
  const { releasePqKeyId: kid, signReleaseEndorsementPq, verifyReleaseEndorsementPq } = await import("@flagship/protocol");
  const ed = await loadEd25519Signer(signingKey);
  if (ed.pubHex !== String(endorsement.signedBy).toLowerCase()) {
    throw new Error(`the signing key ${ed.pubHex.slice(0, 16)} did not sign endorsement ${endorsement.releaseId}`);
  }
  out("Opening the release ML-DSA key: PIN and touch on a YubiKey.");
  return withSeed(vault, keyFile, async (seed) => {
    const b = boundKeyForSeed(root, seed);
    if (!b) throw new Error(`the decrypted key matches no binding in ${bindingsDir(root)}`);
    if (b.ed25519PubHex !== ed.pubHex) throw new Error("the bound Ed25519 key is not the signing key");
    out("Signing the PQ companion: approve on the YubiKey (PIN, then touch).");
    const wire = await signReleaseEndorsementPq(endorsement, b, ed.sign, seed);
    const keyId = kid(b.ed25519PubHex, b.mldsaPubHex);
    const pin = { version: 1, keyIds: [keyId], requirePqAfter: null };
    const { bindings } = verifyReleasePqBindings([b], pin, Date.now());
    verifyReleaseEndorsementPq(endorsement, wire, { pin, bindings });
    const file = path.join(companionsDir(root), `${endorsement.semverTag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(wire, null, 2) + "\n");
    return { file, keyId, wire };
  });
}

export function vaultFromFlags({ fakeYubikey, identities = [] }) {
  return fakeYubikey ? fakeVault({ dir: fakeYubikey }) : ageVault({ identities: identities.length ? identities : [DEFAULT_IDENTITIES] });
}

// ── the box artifact's and CA leases' PQ companions (pq-suites.md §16.2, §16.3) ───────────

/**
 * The `release-key` binding of the release key for another subject (the CA track, the box
 * artifact): the same Ed25519 token and ML-DSA seed, a statement naming that subject. Compact (wire v2): the
 * YubiKey signs the Ed25519 half, and its PIV applet takes about 3 KB of message (the v1 statement is 6 KB).
 */
export async function signSubjectBinding(subjectId, ed, seed, issuedAt = Date.now()) {
  const { canonicalPqKeyBindingV2, hybridSignExternal, pqBindingPublicKey } = await import("@flagship/protocol");
  const s = {
    role: "release-key",
    subjectId,
    ed25519PubHex: ed.pubHex,
    mldsaPubHex: Buffer.from(mldsa65PublicKey(seed)).toString("hex"),
    issuedAt,
  };
  const sig = await hybridSignExternal(pqBindingPublicKey(s), "flagship/pq-key-binding/v2", canonicalPqKeyBindingV2(s), ed.sign, seed);
  return { v: 2, ...s, signature: Buffer.from(sig).toString("hex") };
}

function caPqDir(root, sub) {
  return path.join(root, "ca-pq", sub);
}

/** The Worker's `.maintainers/ca-pq/bundle.json`: every binding and companion, filename-sorted. */
export function writeCaPqBundle(root) {
  const read = (sub) => {
    const dir = caPqDir(root, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  };
  const file = path.join(root, "ca-pq", "bundle.json");
  fs.writeFileSync(file, JSON.stringify({ bindings: read("bindings"), endorsements: read("endorsements") }, null, 2) + "\n");
  return file;
}

/**
 * Signs and writes a CA lease's companion: the lease must be signed by the same Ed25519 key, the
 * result is checked with the gate boxes and the Worker run (under a pin naming this key).
 */
export async function signCaLeaseCompanion({ root, endorsement, signingKey, vault, keyFile, out = () => {}, now = Date.now() }) {
  const { CA_LEASE_PQ_BINDING_SUBJECT, gateCaLeasesPq, signCaLeasePq } = await import("@flagship/protocol");
  const ed = await loadEd25519Signer(signingKey);
  if (ed.pubHex !== String(endorsement.signedBy).toLowerCase()) {
    throw new Error(`the signing key ${ed.pubHex.slice(0, 16)} did not sign lease ${endorsement.endorsementId}`);
  }
  out("Opening the release ML-DSA key: PIN and touch on a YubiKey.");
  return withSeed(vault, keyFile, async (seed) => {
    const mldsaPubHex = Buffer.from(mldsa65PublicKey(seed)).toString("hex");
    const bdir = caPqDir(root, "bindings");
    fs.mkdirSync(bdir, { recursive: true });
    const have = fs.readdirSync(bdir).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(bdir, f), "utf8")))
      .find((b) => b.ed25519PubHex === ed.pubHex && b.mldsaPubHex === mldsaPubHex && b.subjectId === CA_LEASE_PQ_BINDING_SUBJECT);
    out("Signing the PQ companion: approve on the YubiKey (PIN, then touch).");
    const binding = have ?? (await signSubjectBinding(CA_LEASE_PQ_BINDING_SUBJECT, ed, seed, now));
    const wire = await signCaLeasePq(endorsement, { ed25519PubHex: ed.pubHex, mldsaPubHex }, ed.sign, seed);
    const pin = { version: 1, keyIds: [wire.keyId], legacyLeases: [] };
    const ok = gateCaLeasesPq([endorsement], { bindings: [binding], endorsements: [wire] }, { pin, now }).accepted.length === 1;
    if (!ok) throw new Error("the new companion does not pass the CA lease gate; nothing written");
    if (!have) fs.writeFileSync(path.join(bdir, `${ed.pubHex.slice(0, 16)}-${mldsaPubHex.slice(0, 16)}.json`), JSON.stringify(binding, null, 2) + "\n");
    const file = path.join(caPqDir(root, "endorsements"), `${endorsement.endorsementId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(wire, null, 2) + "\n");
    writeCaPqBundle(root);
    return { file, keyId: wire.keyId, wire, binding };
  });
}

/**
 * Adds the PQ companion to the signer's signature in a box artifact manifest file
 * (`{ manifest, signatures, pqBindings? }`), checked with the verifier boxes and the installer run.
 */
export async function signBoxArtifactCompanion({ doc, signingKey, vault, keyFile, out = () => {}, now = Date.now() }) {
  const p = await import("@flagship/protocol");
  const ed = await loadEd25519Signer(signingKey);
  const sigEntry = (doc.signatures ?? []).find((s) => String(s.keyHex).toLowerCase() === ed.pubHex);
  if (!sigEntry) throw new Error(`the manifest has no Ed25519 signature by ${ed.pubHex.slice(0, 16)}; sign it first (tools/box-artifact/build.ts sign)`);
  const canonical = p.canonicalBoxArtifact(doc.manifest);
  out("Opening the release ML-DSA key: PIN and touch on a YubiKey.");
  return withSeed(vault, keyFile, async (seed) => {
    const mldsaPubHex = Buffer.from(mldsa65PublicKey(seed)).toString("hex");
    const pk = p.pqBindingPublicKey({ ed25519PubHex: ed.pubHex, mldsaPubHex });
    const keyId = Buffer.from(p.pqKeyId(p.SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk)).toString("hex");
    out("Signing the PQ companion: approve on the YubiKey (PIN, then touch).");
    const sig = await p.hybridSignExternal(pk, p.TAG_BOX_ARTIFACT_V2, p.canonicalBoxArtifactV2(canonical, ed.pubHex, keyId), ed.sign, seed);
    const existing = (doc.pqBindings ?? []).find((b) => b.ed25519PubHex === ed.pubHex && b.mldsaPubHex === mldsaPubHex && b.subjectId === p.BOX_ARTIFACT_PQ_BINDING_SUBJECT);
    const binding = existing ?? (await signSubjectBinding(p.BOX_ARTIFACT_PQ_BINDING_SUBJECT, ed, seed, now));
    const next = {
      ...doc,
      signatures: doc.signatures.map((s) => (String(s.keyHex).toLowerCase() === ed.pubHex ? { ...s, pq: { keyId, signatureHex: Buffer.from(sig).toString("hex") } } : s)),
      pqBindings: [...(doc.pqBindings ?? []).filter((b) => b !== existing), binding],
    };
    const bindings = p.verifiedBoxArtifactBindings(next.pqBindings, { version: 1, keyIds: [keyId], legacyManifests: [] }, now);
    const entry = next.signatures.find((s) => String(s.keyHex).toLowerCase() === ed.pubHex);
    if (!p.verifyBoxArtifactPq(canonical, ed.pubHex, entry.pq, bindings)) throw new Error("the new companion does not verify; nothing written");
    return next;
  });
}

/**
 * Adds the PQ companion to the signer's signature in a signed runtime manifest file
 * (`{ manifest, signatures, pqBindings?, lockJson }`; packages/protocol/src/runtimeManifest.ts). The same release key and
 * `release-key` binding as the box artifact's, a different statement (`flagship/runtime-manifest/v2`).
 */
export async function signRuntimeManifestCompanion({ doc, signingKey, vault, keyFile, out = () => {}, now = Date.now() }) {
  const p = await import("@flagship/protocol");
  const ed = await loadEd25519Signer(signingKey);
  const sigEntry = (doc.signatures ?? []).find((s) => String(s.keyHex).toLowerCase() === ed.pubHex);
  if (!sigEntry) throw new Error(`the manifest has no Ed25519 signature by ${ed.pubHex.slice(0, 16)}; sign it first (tools/box-artifact/runtime-manifest.ts sign)`);
  const canonical = p.canonicalRuntimeManifest(doc.manifest);
  out("Opening the release ML-DSA key: PIN and touch on a YubiKey.");
  return withSeed(vault, keyFile, async (seed) => {
    const mldsaPubHex = Buffer.from(mldsa65PublicKey(seed)).toString("hex");
    const pk = p.pqBindingPublicKey({ ed25519PubHex: ed.pubHex, mldsaPubHex });
    const keyId = Buffer.from(p.pqKeyId(p.SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk)).toString("hex");
    out("Signing the PQ companion: approve on the YubiKey (PIN, then touch).");
    const sig = await p.hybridSignExternal(pk, p.TAG_RUNTIME_MANIFEST_V2, p.canonicalRuntimeManifestV2(canonical, ed.pubHex, keyId), ed.sign, seed);
    const existing = (doc.pqBindings ?? []).find((b) => b.ed25519PubHex === ed.pubHex && b.mldsaPubHex === mldsaPubHex && b.subjectId === p.BOX_ARTIFACT_PQ_BINDING_SUBJECT);
    const binding = existing ?? (await signSubjectBinding(p.BOX_ARTIFACT_PQ_BINDING_SUBJECT, ed, seed, now));
    const next = {
      ...doc,
      signatures: doc.signatures.map((s) => (String(s.keyHex).toLowerCase() === ed.pubHex ? { ...s, pq: { keyId, signatureHex: Buffer.from(sig).toString("hex") } } : s)),
      pqBindings: [...(doc.pqBindings ?? []).filter((b) => b !== existing), binding],
    };
    // The check a verifier makes, against a pin naming only this key.
    const r = p.verifyRuntimeManifest(next.manifest, next.signatures, {
      trust: { keys: [ed.pubHex], threshold: 1 },
      pqPin: { version: 1, keyIds: [keyId], legacyManifests: [] },
      pqBindings: next.pqBindings,
      lockText: next.lockJson,
      lockSigners: [],
      now,
    });
    if (!r.ok && r.code !== "expired") throw new Error(`the new companion does not verify (${r.code}); nothing written`);
    return next;
  });
}
