#!/usr/bin/env node
/**
 * Bootstrap Flagship's own `.maintainers/` folder.
 *
 * Idempotent — given the same fixed seeds it produces byte-identical
 * files on every run. Running it twice against an existing folder
 * overwrites with the same content, so commits stay clean.
 *
 * The two keys baked in here (`harry@flagship.services` +
 * `harrybackup@flagship.services`) are PLACEHOLDERS derived from fixed
 * seeds so any contributor can re-derive them locally and verify the
 * chain offline. Before public release, swap these for the real
 * Yubikey-held pubkeys via a fresh succession mandate signed by the
 * placeholder (it is a named successor of itself), listing the real
 * key as the new holder.
 *
 * **LOCKED Phase-2 v2 model.** Mirrors the cli's `upsert-mandate`
 * from-scratch (root) shape so the on-disk envelopes are
 * indistinguishable from those a real `maintainers upsert-mandate`
 * invocation would produce: one self-signed root `Mandate` per
 * track, with the succession policy folded INLINE into the mandate
 * (`approvalRule` / `successors` / `minSuccessors` /
 * `maxDurationSeconds` / `defaultDurationSeconds` / project metadata).
 * There is NO `policy.json` (root or per-track) — the v2 model
 * dissolved the unsigned-policy hole (L2). Each root is trusted purely
 * via its baked canonical-hash PIN (#30 generalised L1).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  generateKeypair,
  signMandate,
  mandatePinHash,
  signKeyFile,
} from "@ibisllc/maintainers";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const TARGET = path.join(REPO_ROOT, ".maintainers");

// ---- Fixed values that make the script deterministic ----------------
//
// Bumping any of these constants rotates every derived artifact, so be
// thoughtful — the test fixture asserts on the exact bytes the script
// emits with these inputs.

const GENESIS_ISO = "2026-05-11T00:00:00.000Z";
const HARRY_SEED_LABEL = "flagship-maintainers/harry/v1";
const BACKUP_SEED_LABEL = "flagship-maintainers/harrybackup/v1";

const TRACKS = [
  { name: "release", durationDays: 60 },
  { name: "ca", durationDays: 180 },
  { name: "ops", durationDays: 60 },
];

const HARRY = generateKeypair(deriveSeed(HARRY_SEED_LABEL));
const BACKUP = generateKeypair(deriveSeed(BACKUP_SEED_LABEL));

function deriveSeed(label) {
  // SHA-256 over a 32-byte all-1 base + the label, mirrored on the
  // task description (`deriveSWK({seed:Uint8Array(32).fill(1)}, "maintainers")`).
  // Anyone can re-derive locally by running this script.
  const base = Buffer.alloc(32, 1);
  const h = createHash("sha256");
  h.update(base);
  h.update(Buffer.from(label, "utf8"));
  return new Uint8Array(h.digest());
}

function deterministicUuid(label) {
  // Shape: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx with v4 + variant bits.
  // We derive the 16 bytes from sha256 so re-running emits the same id.
  const digest = createHash("sha256").update(label).digest();
  const b = digest.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function isoFromDays(base, days) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// ---- Build envelopes ------------------------------------------------

function buildKeyFile(holder, displayName, email, introductionMandateId) {
  const unsigned = {
    kind: "KeyFile",
    version: 1,
    pubkey: holder.pubKey,
    displayName,
    currentEmail: email,
    emailHistory: [{ email, from: GENESIS_ISO, to: null }],
    metadata: {
      photo: null,
      github: null,
      role: "maintainer placeholder (deterministic test pubkey — replace with real Yubikey pubkey before public release)",
    },
    introductionMandate: introductionMandateId,
  };
  return signKeyFile(unsigned, holder.privKey);
}

/**
 * Build a from-scratch (root) v2 mandate for a track — the
 * genesis-equivalent in the LOCKED v2 model. Self-signed by its
 * holder; the succession policy is folded INLINE (L2): a 1-of-N
 * threshold over `successors` (one signature from any named successor
 * authorises the next mandate — same operational laxity as the prior
 * v1 `1-of-anyAuthorizedSigner` track policy), `minSuccessors: 1`, and
 * a conservative `maxDurationSeconds` equal to THIS window so the next
 * mandate cannot silently outlast it (mirrors the cli
 * `upsert-mandate` from-scratch default). `project` carries the
 * project-level metadata that the deleted root `policy.json` used to
 * hold.
 */
function buildRootMandate(track, holder, successors, durationDays) {
  const issuedAt = GENESIS_ISO;
  const expiresAt = isoFromDays(GENESIS_ISO, durationDays);
  const windowSeconds = durationDays * 24 * 60 * 60;
  return signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: deterministicUuid(`flagship/${track}/genesis-2026-05-11`),
      track,
      holder: holder.pubKey,
      issuedAt,
      expiresAt,
      successors,
      approvalRule: { kind: "threshold", threshold: 1 },
      minSuccessors: 1,
      maxDurationSeconds: windowSeconds,
      defaultDurationSeconds: windowSeconds,
      project: {
        name: "Flagship",
        contact: "harry@flagship.services",
        homepage: "https://flagshipserver.com/",
        tracks: TRACKS.map((t) => t.name),
      },
      signedBy: holder.pubKey,
    },
    [{ privKey: holder.privKey }],
  );
}

// ---- Emit --------------------------------------------------------------

function emit() {
  fs.mkdirSync(TARGET, { recursive: true });

  // README
  fs.writeFileSync(
    path.join(TARGET, "README.md"),
    [
      "# Flagship maintainers",
      "",
      "Flagship dogfoods the maintainers protocol it ships in `maintainers/`.",
      "This folder declares **who is currently authorized to sign Flagship",
      "release endorsements, certificate-authority operations, and",
      "operational advisories** — and which exact commits the current",
      "authority has endorsed for production deployment.",
      "",
      "Three tracks:",
      "",
      "| Track     | Cadence | Purpose                                                       |",
      "|-----------|---------|---------------------------------------------------------------|",
      "| `release` | 60 d    | Signs `ReleaseEndorsement` envelopes for production commits.  |",
      "| `ca`      | 180 d   | Signs CA-style envelopes for the user-pubkey directory.       |",
      "| `ops`     | 60 d    | Signs operational advisories (e.g. security disclosures).     |",
      "",
      "## Current authority",
      "",
      "- `harry@flagship.services` — primary holder on every track.",
      "- `harrybackup@flagship.services` — a named successor on every",
      "  track; under each track's inline `approvalRule` (1-of-N) it can",
      "  sign the next mandate unilaterally if the primary's mandate lapses.",
      "",
      "Each track is a single self-signed **root (from-scratch)**",
      "`Mandate` whose succession policy is folded INLINE (no",
      "`policy.json` — the LOCKED v2 model dissolved the unsigned-policy",
      "hole). The pubkeys checked in here are **placeholders derived from",
      "fixed seeds** so anyone can re-derive them locally with",
      "`scripts/bootstrap-flagship-maintainers.mjs` and verify the chain",
      "offline. Before the public alpha, the root mandates will be",
      "rotated to Yubikey-held pubkeys via a normal succession flow",
      "(the placeholder is a named successor of itself).",
      "",
      "## Contact",
      "",
      "All maintainer correspondence: `harry@flagship.services`.",
      "",
      "## Spec",
      "",
      "See [`maintainers/docs/spec/v1.md`](../maintainers/docs/spec/v1.md)",
      "for the protocol definition. The reference verifier is",
      "[`@ibisllc/maintainers`](../maintainers/packages/protocol/).",
      "",
    ].join("\n"),
    "utf8",
  );

  // v2: NO root policy.json — the project-level metadata that used to
  // live there is folded into each root mandate's `project` field.

  // Root (from-scratch) mandates first — KeyFiles reference their
  // mandateId. v2: NO per-track policy.json; the succession rule is
  // inline in each mandate.
  const releaseMandate = buildRootMandate(
    "release",
    HARRY,
    [HARRY.pubKey, BACKUP.pubKey],
    TRACKS[0].durationDays,
  );
  const caMandate = buildRootMandate(
    "ca",
    HARRY,
    [HARRY.pubKey, BACKUP.pubKey],
    TRACKS[1].durationDays,
  );
  const opsMandate = buildRootMandate(
    "ops",
    HARRY,
    [HARRY.pubKey, BACKUP.pubKey],
    TRACKS[2].durationDays,
  );

  for (const [track, mandate] of [
    ["release", releaseMandate],
    ["ca", caMandate],
    ["ops", opsMandate],
  ]) {
    writeJson(
      path.join(
        TARGET,
        "tracks",
        track,
        "mandates",
        `2026-05-11-genesis.json`,
      ),
      mandate,
    );
  }

  // KeyFiles. Each references its introduction mandate; we pin the
  // primary's introduction to the release-track genesis (the most
  // load-bearing track), and the backup's to the same — they were both
  // listed as successors at genesis time.
  writeJson(
    path.join(TARGET, "keys", "harry@flagship.services.json"),
    buildKeyFile(
      HARRY,
      "Harry Winner Kamdem",
      "harry@flagship.services",
      releaseMandate.mandateId,
    ),
  );
  writeJson(
    path.join(TARGET, "keys", "harrybackup@flagship.services.json"),
    buildKeyFile(
      BACKUP,
      "Harry Winner Kamdem (backup)",
      "harrybackup@flagship.services",
      releaseMandate.mandateId,
    ),
  );

  console.log(`wrote .maintainers/ under ${TARGET}`);
  console.log(`  harry primary pubkey:  ${HARRY.pubKey}`);
  console.log(`  harry backup pubkey:   ${BACKUP.pubKey}`);
  console.log(`  release mandateId:     ${releaseMandate.mandateId}`);
  console.log(`  ca mandateId:          ${caMandate.mandateId}`);
  console.log(`  ops mandateId:         ${opsMandate.mandateId}`);
  // The #30-generalised baked anchor for the load-bearing release
  // track (stdout only; not written to disk). When the placeholder
  // roots are rotated to real Yubikey-held keys, the post-rotation
  // root's PIN — printed the same way — is what gets baked per surface.
  console.log(`  release root PIN:      ${mandatePinHash(releaseMandate)}`);
}

emit();
