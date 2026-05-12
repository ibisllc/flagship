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
 * Yubikey-held pubkeys via a fresh genesis mandate signed by the
 * placeholder, listing the real key as a successor.
 *
 * Mirrors the cli's genesis-command shape so the on-disk envelopes are
 * indistinguishable from those a real `maintainers genesis` invocation
 * would produce.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  generateKeypair,
  signMandate,
  signKeyFile,
} from "@maintainers/protocol";

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

function buildGenesisMandate(track, holder, successors, durationDays) {
  const issuedAt = GENESIS_ISO;
  const expiresAt = isoFromDays(GENESIS_ISO, durationDays);
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
      "- `harrybackup@flagship.services` — listed as successor on every track;",
      "  takes over unilaterally if the primary's mandate lapses.",
      "",
      "The pubkeys checked in here are **placeholders derived from fixed",
      "seeds** so anyone can re-derive them locally with",
      "`scripts/bootstrap-flagship-maintainers.mjs` and verify the chain",
      "offline. Before the public alpha, the genesis mandates will be",
      "rotated to Yubikey-held pubkeys via a normal renewal flow.",
      "",
      "## Contact",
      "",
      "All maintainer correspondence: `harry@flagship.services`.",
      "",
      "## Spec",
      "",
      "See [`maintainers/docs/spec/v1.md`](../maintainers/docs/spec/v1.md)",
      "for the protocol definition. The reference verifier is",
      "[`@maintainers/protocol`](../maintainers/packages/protocol/).",
      "",
    ].join("\n"),
    "utf8",
  );

  // Root policy
  writeJson(path.join(TARGET, "policy.json"), {
    schemaVersion: 1,
    project: {
      name: "Flagship",
      homepage: "https://flagshipserver.com/",
      contact: "harry@flagship.services",
    },
    tracks: TRACKS.map((t) => t.name),
  });

  // Genesis mandates first — KeyFiles reference their mandateId.
  const releaseMandate = buildGenesisMandate(
    "release",
    HARRY,
    [HARRY.pubKey, BACKUP.pubKey],
    TRACKS[0].durationDays,
  );
  const caMandate = buildGenesisMandate(
    "ca",
    HARRY,
    [HARRY.pubKey, BACKUP.pubKey],
    TRACKS[1].durationDays,
  );
  const opsMandate = buildGenesisMandate(
    "ops",
    HARRY,
    [HARRY.pubKey, BACKUP.pubKey],
    TRACKS[2].durationDays,
  );

  for (const [track, mandate, durationDays] of [
    ["release", releaseMandate, TRACKS[0].durationDays],
    ["ca", caMandate, TRACKS[1].durationDays],
    ["ops", opsMandate, TRACKS[2].durationDays],
  ]) {
    writeJson(path.join(TARGET, "tracks", track, "policy.json"), {
      track,
      description: `Flagship ${track} track — ${durationDays}-day cadence; 1-of-N approval (one signature from any authorized signer).`,
      defaultMandateDuration: `${durationDays}d`,
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    });
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
}

emit();
