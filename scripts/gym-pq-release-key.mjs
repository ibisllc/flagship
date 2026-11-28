#!/usr/bin/env node
// gym-pq-release-key — the GYM's PQ release key, so gym boxes need hybrid companions the way production boxes do.
//
// Production pins its ML-DSA-65 release key (scripts/pq-release-key.mjs, YubiKey-encrypted at rest) in
// RELEASE_PQ_PIN and release/box-artifact-trust.json "pq". The gym signs its own box artifacts with its own
// classical key (~/.config/flagship/gym-artifact-key), so it needs its own hybrid key: that Ed25519 key plus an
// ML-DSA-65 seed kept here, in plain JSON (mode 600) like the other gym keys. A test key: it protects nothing outside
// the gym, and it never goes into the repo. Only its key id and its bindings are committed, on the `gym` branch.
//
//   node scripts/gym-pq-release-key.mjs init               make the key (once; prints the key id)
//   node scripts/gym-pq-release-key.mjs show               print the key id
//   node scripts/gym-pq-release-key.mjs pin --worktree <gym worktree> [--base-url <gym artifact base>] [--require-pq-after <releaseId>]
//        writes, in the gym worktree: the release-key binding (.maintainers/release-pq/bindings), RELEASE_PQ_PIN naming
//        only this key with production's requirePqAfter marker (read from origin/main), the client copies of the key
//        ids, and release/box-artifact-trust.json "pq" naming this key, with every manifest the gym already publishes
//        listed as signed before the cut-over (the newest three and the update/rollback targets, so the update group's older
//        install still verifies). Then regenerates
//        the compiled box-release constants. Commit the result on the gym branch.
//   node scripts/gym-pq-release-key.mjs sign-box-artifact --manifest <in.json> --out <out.json>
//        adds the PQ companion beside the gym key's Ed25519 signature (gym-box-artifact.sh, gym-update-target.sh)
//   node scripts/gym-pq-release-key.mjs check --worktree <gym worktree> [--base-url <url>] [--arch amd64,arm64]
//        fails unless the gym branch pins this key and the published manifest of the gym's box release (and of the
//        update target built on it, when one is) carries a valid PQ companion. A legacy listing does not excuse it.
//
// Env: GYM_PQ_RELEASE_KEY_FILE (default ~/.config/flagship/gym-release-pq-key.json),
//      GYM_ARTIFACT_KEY_FILE   (default ~/.config/flagship/gym-artifact-key, the Ed25519 half).
// Exit codes: 0 ok, 1 error or failed check, 2 usage.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@flagship/protocol";
import { CLIENT_PIN_FILES, REPO, UsageError, loadEd25519Signer, renderPin, signBoxArtifactCompanion, writeClientPins } from "./pq-release-key.mjs";

export const DEFAULT_KEY_FILE = process.env.GYM_PQ_RELEASE_KEY_FILE || path.join(os.homedir(), ".config", "flagship", "gym-release-pq-key.json");
export const DEFAULT_ARTIFACT_KEY_FILE = process.env.GYM_ARTIFACT_KEY_FILE || path.join(os.homedir(), ".config", "flagship", "gym-artifact-key");
export const GYM_ARTIFACT_BASE = "https://gym.flagshipserver.com/build/iso";
const FORMAT = "flagship-gym-release-pq-key/v1";
const hex = (b) => Buffer.from(b).toString("hex");

/** The key file's contents, checked; the seed stays in the returned object only for the caller's one use. */
export function readKey(keyFile = DEFAULT_KEY_FILE) {
  if (!fs.existsSync(keyFile)) throw new UsageError(`no gym PQ release key at ${keyFile} (run: node scripts/gym-pq-release-key.mjs init)`);
  const k = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  if (k.format !== FORMAT || !/^[0-9a-f]{64}$/.test(k.seedHex ?? "") || !/^[0-9a-f]{64}$/.test(k.ed25519PubHex ?? "")) throw new Error(`${keyFile} is not a gym PQ release key`);
  const mldsaPubHex = hex(p.mldsa65PublicKey(Buffer.from(k.seedHex, "hex")));
  const keyId = p.releasePqKeyId(k.ed25519PubHex, mldsaPubHex);
  if (k.keyId !== keyId || k.mldsaPubHex !== mldsaPubHex) throw new Error(`${keyFile} does not match its own seed`);
  return { ...k, mldsaPubHex, keyId };
}

/** The vault pq-release-key.mjs's signers expect: here the seed is plain, so "decrypting" is reading it. */
export const plainVault = { fake: false, describe: () => "gym key file (plain, test only)", decrypt: (buf) => new Uint8Array(Buffer.from(JSON.parse(buf.toString("utf8")).seedHex, "hex")) };

export async function cmdInit({ keyFile = DEFAULT_KEY_FILE, artifactKeyFile = DEFAULT_ARTIFACT_KEY_FILE } = {}, out = console.log) {
  const ed = await loadEd25519Signer(`file:${artifactKeyFile}`);
  if (fs.existsSync(keyFile)) {
    const k = readKey(keyFile);
    if (k.ed25519PubHex !== ed.pubHex) throw new Error(`${keyFile} is bound to Ed25519 ${k.ed25519PubHex.slice(0, 16)}, but the gym artifact key is ${ed.pubHex.slice(0, 16)}: the artifact key changed; move the old file away and init again`);
    out(k.keyId);
    return k;
  }
  const seed = new Uint8Array(randomBytes(32));
  const mldsaPubHex = hex(p.mldsa65PublicKey(seed));
  const k = {
    format: FORMAT,
    about: "GYM ONLY: the gym's ML-DSA-65 release key (scripts/gym-pq-release-key.mjs). Its Ed25519 half is the gym artifact key. Never production.",
    ed25519PubHex: ed.pubHex,
    mldsaPubHex,
    keyId: p.releasePqKeyId(ed.pubHex, mldsaPubHex),
    seedHex: hex(seed),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, JSON.stringify(k, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  seed.fill(0);
  out(k.keyId);
  return readKey(keyFile);
}

/** Production's marker, so the gym's pin has the same shape: the newest endorsement signed before the PQ key existed. */
export function mainMarker(wt) {
  const src = execFileSync("git", ["-C", wt, "show", "origin/main:packages/protocol/src/releasePqPin.ts"], { encoding: "utf8" });
  const m = /requirePqAfter: \{ releaseId: "([^"]+)", commitHash: "([0-9a-f]{40})" \}/.exec(src);
  if (!m) throw new Error("origin/main's RELEASE_PQ_PIN has no requirePqAfter marker to copy");
  return { releaseId: m[1], commitHash: m[2] };
}

export function readPin(wt) {
  const src = fs.readFileSync(path.join(wt, "packages/protocol/src/releasePqPin.ts"), "utf8");
  const block = /\/\/ BEGIN RELEASE_PQ_PIN \(generated\)[\s\S]*?\/\/ END RELEASE_PQ_PIN/.exec(src)?.[0];
  if (!block) throw new Error("releasePqPin.ts has no generated pin block");
  const ids = /keyIds: Object\.freeze\(\[([^\]]*)\]\)/.exec(block)?.[1] ?? "";
  const marker = /requirePqAfter: \{ releaseId: "([^"]+)", commitHash: "([0-9a-f]{40})" \}/.exec(block);
  return { keyIds: ids.match(/[0-9a-f]{64}/g) ?? [], requirePqAfter: marker ? { releaseId: marker[1], commitHash: marker[2] } : null };
}

async function fetchJson(url, fetchImpl) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(25_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}

/**
 * The manifests a gym box may still install after the cut-over: the newest `keep` of the releases index (the update group
 * installs the one before the current release) and the hidden update and rollback targets. Older ones stay refused, as
 * production lists only what is still installable.
 */
export async function publishedManifests(base, fetchImpl = fetch, keep = 3) {
  const idx = (await fetchJson(`${base}/releases.json`, fetchImpl)) ?? { releases: [] };
  const wanted = new Map();
  const newest = [...(idx.releases ?? [])].sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0)).slice(0, keep);
  for (const r of newest) for (const a of r.arch ?? ["amd64"]) wanted.set(`${r.commit}-${a}`, [r.commit, a]);
  for (const t of ["update-target.json", "rollback-target.json"]) {
    const j = await fetchJson(`${base}/${t}`, fetchImpl).catch(() => null);
    if (j?.commit) for (const a of j.arch ?? ["amd64"]) wanted.set(`${j.commit}-${a}`, [j.commit, a]);
  }
  const docs = [];
  for (const [commit, arch] of wanted.values()) {
    const d = await fetchJson(`${base}/flagship-box-${commit.slice(0, 12)}-${arch}.manifest.json`, fetchImpl).catch(() => null);
    if (d?.manifest) docs.push(d);
  }
  return docs;
}

export async function cmdPin({ wt, keyFile = DEFAULT_KEY_FILE, artifactKeyFile = DEFAULT_ARTIFACT_KEY_FILE, base = GYM_ARTIFACT_BASE, requirePqAfter, fetchImpl = fetch, now = Date.now(), regenerate = true } = {}, out = console.log) {
  if (!wt) throw new UsageError("pin needs --worktree <gym worktree>");
  const k = readKey(keyFile);
  const ed = await loadEd25519Signer(`file:${artifactKeyFile}`);
  if (ed.pubHex !== k.ed25519PubHex) throw new Error("the gym artifact key is not this key's Ed25519 half");
  const seed = plainVault.decrypt(fs.readFileSync(keyFile));
  try {
    // 1. The release-key binding, next to production's (which the gym's pin does not name).
    const bdir = path.join(wt, ".maintainers/release-pq/bindings");
    fs.mkdirSync(bdir, { recursive: true });
    const bfile = path.join(bdir, `${k.keyId.slice(0, 16)}.json`);
    if (!fs.existsSync(bfile)) {
      const binding = await p.signReleasePqBinding({ ed25519PubHex: k.ed25519PubHex, mldsaPubHex: k.mldsaPubHex, issuedAt: now }, ed.sign, seed);
      const { bindings } = p.verifyReleasePqBindings([binding], { version: 1, keyIds: [k.keyId], requirePqAfter: null }, now);
      if (bindings.length !== 1) throw new Error("the new binding does not verify");
      fs.writeFileSync(bfile, JSON.stringify(binding, null, 2) + "\n");
      out(`binding written: ${path.relative(wt, bfile)}`);
    }
  } finally {
    seed.fill(0);
  }
  // 2. RELEASE_PQ_PIN: only the gym key, with production's marker.
  const marker = requirePqAfter ?? mainMarker(wt);
  const pinFile = path.join(wt, "packages/protocol/src/releasePqPin.ts");
  const src = fs.readFileSync(pinFile, "utf8").replace(/^\/\/ ⚠️ GYM TEST BRANCH ONLY: the gym endorses releases with its own classical key K.*\n/m, "");
  const note = "// ⚠️ GYM TEST BRANCH ONLY: the gym's own PQ release key (scripts/gym-pq-release-key.mjs; Ed25519 half = the gym artifact key),\n// with production's requirePqAfter marker. Production pins its YubiKey-encrypted key here.\n";
  const re = /(?:\/\/ ⚠️ GYM TEST BRANCH ONLY: the gym's own PQ release key[^\n]*\n\/\/[^\n]*\n)?\/\/ BEGIN RELEASE_PQ_PIN \(generated\)[\s\S]*?\/\/ END RELEASE_PQ_PIN/;
  fs.writeFileSync(pinFile, src.replace(re, note + renderPin({ version: 1, keyIds: [k.keyId], requirePqAfter: marker })));
  writeClientPins([k.keyId], CLIENT_PIN_FILES.map((f) => ({ ...f, file: path.join(wt, path.relative(REPO, f.file)) })));
  out(`RELEASE_PQ_PIN: ${k.keyId.slice(0, 16)}…, require PQ after ${marker.releaseId}`);
  // 3. The box artifact pin: the gym key, and today's published manifests as signed before the cut-over.
  const trustFile = path.join(wt, "release/box-artifact-trust.json");
  const t = JSON.parse(fs.readFileSync(trustFile, "utf8"));
  if (t.threshold !== 1 || t.keys?.length !== 1 || t.keys[0] !== k.ed25519PubHex) throw new Error(`${trustFile} does not name exactly the gym artifact key (run gym-box-artifact.sh once first)`);
  const legacy = new Set(t.pq?.keyIds?.includes(k.keyId) ? (t.pq.legacyManifests ?? []) : []);
  for (const d of await publishedManifests(base, fetchImpl)) {
    if ((d.signatures ?? []).some((s) => s.pq)) continue;
    legacy.add(p.boxArtifactV1Digest(p.canonicalBoxArtifact(d.manifest)));
  }
  t.pq = { keyIds: [k.keyId], legacyManifests: [...legacy].sort() };
  fs.writeFileSync(trustFile, JSON.stringify(t, null, 2) + "\n");
  out(`box artifact pin: ${k.keyId.slice(0, 16)}…, ${legacy.size} manifest(s) signed before the cut-over`);
  if (regenerate) execFileSync("node", ["scripts/gen-box-release.mjs", "--write"], { cwd: wt, stdio: "ignore" });
  return { keyId: k.keyId, legacy: [...legacy] };
}

export async function cmdSign({ manifest, outFile, keyFile = DEFAULT_KEY_FILE, artifactKeyFile = DEFAULT_ARTIFACT_KEY_FILE, now = Date.now() }, out = console.log) {
  if (!manifest || !outFile) throw new UsageError("sign-box-artifact needs --manifest <in> and --out <out>");
  readKey(keyFile);
  const doc = await signBoxArtifactCompanion({
    doc: JSON.parse(fs.readFileSync(manifest, "utf8")),
    signingKey: `file:${artifactKeyFile}`,
    vault: plainVault,
    keyFile,
    out: () => {},
    now,
  });
  fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + "\n");
  out(`PQ companion added: ${outFile}`);
}

/** Does this manifest file carry, for enough trusted signers, a PQ companion that verifies under the pin? Legacy excuses nothing. */
export function manifestHasCompanion(doc, trust, now = Date.now()) {
  const r = p.verifyBoxArtifact(doc.manifest, doc.signatures ?? [], {
    trust: { keys: trust.keys, threshold: trust.threshold },
    pqPin: { version: 1, keyIds: trust.pq?.keyIds ?? [], legacyManifests: [] },
    pqBindings: doc.pqBindings ?? [],
    verifierVersion: Number.MAX_SAFE_INTEGER,
    now,
  });
  return r.ok ? { ok: true } : { ok: false, why: `${r.code}${r.detail ? ` (${r.detail})` : ""}` };
}

export async function cmdCheck({ wt, keyFile = DEFAULT_KEY_FILE, base = GYM_ARTIFACT_BASE, arches = ["amd64"], fetchImpl = fetch, now = Date.now() }, out = console.log) {
  if (!wt) throw new UsageError("check needs --worktree <gym worktree>");
  const fails = [];
  const k = readKey(keyFile);
  const pin = readPin(wt);
  if (pin.keyIds.length !== 1 || pin.keyIds[0] !== k.keyId) fails.push(`RELEASE_PQ_PIN on the gym branch names [${pin.keyIds.map((x) => x.slice(0, 16)).join(", ")}], not the gym key ${k.keyId.slice(0, 16)} (node scripts/gym-pq-release-key.mjs pin)`);
  if (!pin.requirePqAfter) fails.push("RELEASE_PQ_PIN on the gym branch has no requirePqAfter marker");
  const trust = JSON.parse(fs.readFileSync(path.join(wt, "release/box-artifact-trust.json"), "utf8"));
  if (!(trust.pq?.keyIds ?? []).includes(k.keyId)) fails.push("release/box-artifact-trust.json on the gym branch does not pin the gym PQ key");
  const release = JSON.parse(fs.readFileSync(path.join(wt, "release/box-release.json"), "utf8")).commit;
  const targets = [[release, "box release"]];
  const ut = await fetchJson(`${base}/update-target.json`, fetchImpl).catch(() => null);
  if (ut?.commit && ut.from === release) targets.push([ut.commit, "update target"]);
  for (const [commit, what] of targets) {
    for (const arch of what === "box release" ? arches : ["amd64"]) {
      const name = `flagship-box-${commit.slice(0, 12)}-${arch}.manifest.json`;
      const doc = await fetchJson(`${base}/${name}`, fetchImpl).catch((e) => ({ error: e.message }));
      if (!doc?.manifest) {
        fails.push(`${what} ${name}: not published${doc?.error ? ` (${doc.error})` : ""}`);
        continue;
      }
      const r = manifestHasCompanion(doc, trust, now);
      if (r.ok) out(`  ${what} ${commit.slice(0, 12)} ${arch}: PQ companion verifies`);
      else fails.push(`${what} ${name}: no valid PQ companion (${r.why})`);
    }
  }
  if (fails.length) throw new Error(`gym PQ check failed:\n  ${fails.join("\n  ")}`);
  out("gym PQ check OK");
}

function argOf(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
  return v;
}

async function main(argv) {
  const [verb, ...rest] = argv;
  const wt = argOf(rest, "worktree");
  const base = (argOf(rest, "base-url") ?? GYM_ARTIFACT_BASE).replace(/\/+$/, "");
  const keyFile = argOf(rest, "key-file") ?? DEFAULT_KEY_FILE;
  switch (verb) {
    case "init":
      return void (await cmdInit({ keyFile }));
    case "show":
      return void console.log(readKey(keyFile).keyId);
    case "pin": {
      const id = argOf(rest, "require-pq-after");
      let requirePqAfter;
      if (id) {
        const e = fs.readdirSync(path.join(wt, ".maintainers/endorsements")).map((f) => JSON.parse(fs.readFileSync(path.join(wt, ".maintainers/endorsements", f), "utf8"))).find((x) => x.releaseId === id);
        if (!e) throw new UsageError(`no endorsement with releaseId ${id}`);
        requirePqAfter = { releaseId: e.releaseId, commitHash: e.commitHash.toLowerCase() };
      }
      return void (await cmdPin({ wt, keyFile, base, ...(requirePqAfter ? { requirePqAfter } : {}) }));
    }
    case "sign-box-artifact":
      return void (await cmdSign({ manifest: argOf(rest, "manifest"), outFile: argOf(rest, "out"), keyFile }));
    case "check":
      return void (await cmdCheck({ wt, keyFile, base, arches: (argOf(rest, "arch") ?? "amd64").split(",") }));
    default:
      throw new UsageError("usage: gym-pq-release-key.mjs init|show|pin|sign-box-artifact|check (see the header)");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`gym-pq-release-key: ${e.message}\n`);
      process.exit(e instanceof UsageError ? 2 : 1);
    },
  );
}
