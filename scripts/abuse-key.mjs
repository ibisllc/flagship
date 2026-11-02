#!/usr/bin/env node
// abuse-key — the Messages abuse keys (docs/voici-and-messages.md §9.3; .maintainers/abuse-keys/README.md).
//
//   npm run abuse-key -- generate --epoch <N> --recipient <age1yubikey1…> --recipient <age1yubikey1…>
//                                 [--not-before <time>] [--not-after <time>]
//       Makes one X-Wing key pair in memory, writes the 32-byte seed encrypted with age to both YubiKeys
//       (<path>/abuse-keys/<N>.age) and the public half (<N>.pub.json). The seed is never printed or written in clear.
//       Default window: from now for 100 days (a quarter plus overlap).
//   npm run abuse-key -- sign --epoch <N> [--sign] [--signing-key yubikey-piv:slot=9c]
//       PREVIEW by default: prints the canonical bytes flagship/abuse-key/v1|… and whether the signing key is the
//       ca-track authority. Only with --sign does it sign (the cold ca-track YubiKey: PIN + touch, an owner step)
//       and add the entry to <path>/abuse-keys/list.json, which `.com` bundles at its next deploy.
//   npm run abuse-key -- status
//       Every entry in list.json and every key file: window, signed or not, current or not.
//
//   --path <dir>            maintainers folder (default .maintainers)
//   --fake-yubikey <dir>    TEST MODE: fake YubiKeys (scripts/pq-release-key.mjs), recipients fake-yubikey:<name>
//   --signing-key file:<f>  a hex Ed25519 seed instead of the token (drills and tests only)
//
// <time>: ISO 8601, a date (UTC midnight), "now" or +30m / +6h / +7d.
// Rotation: a new epoch every quarter, signed before the old one's notAfter; destroy <N>.age 120 days after its
// notAfter. Exit codes: 0 ok, 1 error, 2 usage.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalAbuseKeyEntry, hybridSealKeygen, verifyAbuseKeyEntry } from "@flagship/protocol";
import { ageVault, fakeVault, loadEd25519Signer, loadMaintainersCli, UsageError } from "./pq-release-key.mjs";
import { authorityKeysAt } from "./security-notice.mjs";

const DAY = 86_400_000;

export function parseTime(s, now) {
  if (s === "now") return now;
  const rel = /^\+(\d+)([mhd])$/.exec(s);
  if (rel) return now + Number(rel[1]) * { m: 60_000, h: 3_600_000, d: DAY }[rel[2]];
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (!Number.isFinite(t)) throw new UsageError(`not a time: ${s}`);
  return t;
}

export function parseArgs(argv) {
  const o = { verb: argv[0], recipients: [], sign: false, path: ".maintainers", signingKey: "yubikey-piv:slot=9c" };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new UsageError(`${a} needs a value`);
      return x;
    };
    if (a === "--epoch") o.epoch = Number(v());
    else if (a === "--recipient") o.recipients.push(v());
    else if (a === "--not-before") o.notBefore = v();
    else if (a === "--not-after") o.notAfter = v();
    else if (a === "--path") o.path = v();
    else if (a === "--signing-key") o.signingKey = v();
    else if (a === "--fake-yubikey") o.fakeYubikey = v();
    else if (a === "--sign") o.sign = true;
    else throw new UsageError(`unknown argument: ${a}`);
  }
  if (!["generate", "sign", "status"].includes(o.verb)) throw new UsageError("first argument: generate | sign | status");
  if (o.verb !== "status" && (!Number.isSafeInteger(o.epoch) || o.epoch < 1)) throw new UsageError("--epoch takes a whole number from 1");
  return o;
}

const dirOf = (root) => path.join(root, "abuse-keys");
const listFile = (root) => path.join(dirOf(root), "list.json");

export function readList(root) {
  const f = listFile(root);
  if (!fs.existsSync(f)) return { version: 1, entries: [] };
  const doc = JSON.parse(fs.readFileSync(f, "utf8"));
  if (doc.version !== 1 || !Array.isArray(doc.entries)) throw new Error(`${f}: not an abuse key list`);
  return doc;
}

export function generate(o, { now = Date.now(), out = console.log } = {}) {
  const vault = o.fakeYubikey ? fakeVault({ dir: o.fakeYubikey, recipients: o.recipients }) : ageVault({ recipients: o.recipients });
  vault.checkRecipients();
  const notBefore = o.notBefore ? parseTime(o.notBefore, now) : now;
  const notAfter = o.notAfter ? parseTime(o.notAfter, now) : notBefore + 100 * DAY;
  if (notAfter <= notBefore) throw new UsageError("--not-after must be after --not-before");
  if (readList(o.path).entries.some((e) => e.epoch === o.epoch)) throw new UsageError(`epoch ${o.epoch} is already in list.json`);
  const dir = dirOf(o.path);
  const sealedFile = path.join(dir, `${o.epoch}.age`);
  const pubFile = path.join(dir, `${o.epoch}.pub.json`);
  if (fs.existsSync(sealedFile) || fs.existsSync(pubFile)) throw new UsageError(`${sealedFile} or ${pubFile} exists; pick another epoch`);
  const seed = new Uint8Array(randomBytes(32));
  try {
    const xwingPub = Buffer.from(hybridSealKeygen(seed).publicKey).toString("hex");
    const entry = { epoch: o.epoch, xwingPub, notBefore, notAfter };
    canonicalAbuseKeyEntry(entry);
    out(`Encrypting the seed to ${vault.describe()}…`);
    const ct = vault.encrypt(seed);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sealedFile, ct, { mode: 0o600 });
    fs.writeFileSync(pubFile, JSON.stringify(entry, null, 2) + "\n");
    out(`Wrote ${sealedFile} and ${pubFile}.`);
    out(`Window: ${new Date(notBefore).toISOString()} to ${new Date(notAfter).toISOString()}.`);
    out(`Next: npm run abuse-key -- sign --epoch ${o.epoch}   (preview), then again with --sign on the ca-track YubiKey.`);
    return entry;
  } finally {
    seed.fill(0);
  }
}

export async function sign(o, { now = Date.now(), out = console.log, confirm, authority: given } = {}) {
  const pubFile = path.join(dirOf(o.path), `${o.epoch}.pub.json`);
  if (!fs.existsSync(pubFile)) throw new UsageError(`no ${pubFile}; run generate first`);
  const p = JSON.parse(fs.readFileSync(pubFile, "utf8"));
  const entry = { epoch: p.epoch, xwingPub: p.xwingPub, notBefore: p.notBefore, notAfter: p.notAfter };
  if (entry.epoch !== o.epoch) throw new Error(`${pubFile} names epoch ${entry.epoch}`);
  const bytes = canonicalAbuseKeyEntry(entry);
  const authority = given ?? (await authorityKeysAt(o.path, now, await import("@ibisllc/maintainers")));
  let signerPub = null;
  let signerNote = "";
  if (o.signingKey.startsWith("file:")) signerPub = (await loadEd25519Signer(o.signingKey)).pubHex;
  else {
    const lib = await loadMaintainersCli();
    if (lib) signerPub = (await lib.keysource.loadSignerBoundPubKey(o.signingKey).catch((e) => ((signerNote = e.message), null)))?.toLowerCase() ?? null;
    else signerNote = "maintainers CLI not found (set FLAGSHIP_MAINTAINERS_DIR to its clone, built)";
  }
  const text = new TextDecoder().decode(bytes);
  out("\n=== abuse key preview ===");
  out(`  epoch:            ${entry.epoch}`);
  out(`  window:           ${new Date(entry.notBefore).toISOString()} to ${new Date(entry.notAfter).toISOString()}`);
  out(`  signing key:      ${o.signingKey}`);
  out(`  signer pubkey:    ${signerPub ?? `(could not read: ${signerNote})`}`);
  out(`  ca authority now: ${authority.length ? authority.join(", ") : "(none)"}`);
  if (signerPub) out(`  signer matches:   ${authority.includes(signerPub) ? "yes" : "NO: .com would ignore this entry"}`);
  out(`  canonical bytes:  ${text.slice(0, 60)}…${text.slice(-60)} (${bytes.length} bytes)`);
  if (!o.sign) {
    out("\nDRY RUN: nothing signed, nothing written. Re-run with --sign to sign on the ca-track YubiKey.\n");
    return null;
  }
  if (!signerPub || !authority.includes(signerPub)) throw new Error("the signing key is not the current ca-track authority. Nothing signed.");
  if (!o.signingKey.startsWith("file:")) {
    const lib = await loadMaintainersCli();
    const ok = confirm ? await confirm() : await lib.ceremony.ttyConfirm({ ceremony: "abuse-key", phrase: "ABUSE-KEY" }).catch(() => false);
    if (!ok) throw new Error("aborted at the confirmation prompt: nothing was signed or written.");
    out("Approve the signature on your token when prompted…");
  }
  const signer = await loadEd25519Signer(o.signingKey);
  const signature = Buffer.from(await signer.sign(bytes)).toString("hex");
  if (!verifyAbuseKeyEntry(entry, signature, authority)) throw new Error("the signature does not verify; nothing written");
  const list = readList(o.path);
  list.entries = [...list.entries.filter((e) => e.epoch !== entry.epoch), { ...entry, signature }].sort((a, b) => a.epoch - b.epoch);
  fs.writeFileSync(listFile(o.path), JSON.stringify(list, null, 2) + "\n");
  out(`Added epoch ${entry.epoch} to ${listFile(o.path)}. Commit it, land it on main, then deploy .com (it bundles the file).`);
  return { ...entry, signature };
}

export async function status(o, { now = Date.now(), out = console.log } = {}) {
  const list = readList(o.path);
  const maintainers = await import("@ibisllc/maintainers");
  const chain = maintainers.verifyMandateChainFromPin((await import("@flagship/protocol")).MAINTAINER_PINNED_MANDATE_HASH, (await import("./security-notice.mjs")).readCaMandates(o.path));
  const holders = chain.validMandates.map((m) => m.holder.toLowerCase());
  const dir = dirOf(o.path);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const epochs = new Set([...list.entries.map((e) => e.epoch), ...files.map((f) => Number(f.split(".")[0])).filter((n) => Number.isSafeInteger(n) && n > 0)]);
  if (epochs.size === 0) out("No abuse keys yet: Messages attestations answer 503 no-abuse-key until one is signed and deployed.");
  let current = null;
  for (const epoch of [...epochs].sort((a, b) => a - b)) {
    const e = list.entries.find((x) => x.epoch === epoch);
    const sealed = files.includes(`${epoch}.age`);
    const valid = e ? verifyAbuseKeyEntry(e, e.signature, holders) : false;
    const live = e && valid && now >= e.notBefore && now < e.notAfter;
    if (live && (!current || epoch > current)) current = epoch;
    const destroyBy = e ? new Date(e.notAfter + 120 * DAY).toISOString().slice(0, 10) : "-";
    out(`  epoch ${epoch}: ${e ? `${new Date(e.notBefore).toISOString().slice(0, 10)} to ${new Date(e.notAfter).toISOString().slice(0, 10)}` : "not in list.json"}; ${e ? (valid ? "signed" : "SIGNATURE DOES NOT VERIFY") : "unsigned"}; seed file ${sealed ? "present" : "absent"}${e && sealed && now > e.notAfter + 120 * DAY ? ` (destroy: past ${destroyBy})` : ""}${live ? "; in its window" : ""}`);
  }
  out(current ? `Current: epoch ${current}.` : "No key is in its window now.");
  return current;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    process.stderr.write(src.slice(1, src.findIndex((l, i) => i > 2 && !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 2;
  }
  try {
    if (o.verb === "generate") generate(o);
    else if (o.verb === "sign") await sign(o);
    else await status(o);
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code));
}
