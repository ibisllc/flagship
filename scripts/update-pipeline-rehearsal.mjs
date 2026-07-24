#!/usr/bin/env node
// update-pipeline-rehearsal — a faithful, hermetic dress rehearsal of the whole
// "Update this server" box pipeline, on REAL local git, using the REAL daemon
// code paths (runUpdateConsumer + runUpdateBootGate + the Phase-1 release gate +
// the 2-of-2 authorization gate). No cloud, no prod, no YubiKey: it stands in a
// throwaway ca authority (the FLAGSHIP_MAINTAINER_PIN_OVERRIDE seam) and a
// throwaway owner IRK, so every gate runs for real against material we control.
//
// It proves, end to end, exactly what the cloud dummy box will do:
//   1. an admin(owner-IRK)-signed UpdateOrder is decoded + passes the 2-of-2
//      AUTHORIZATION gate + every anti-replay gate (domain, freshness, nonce,
//      fromCommit == HEAD);
//   2. git fetch → the AUTHENTICITY gate accepts a ca-holder-signed release
//      endorsement (the Phase-1 fallback) after a real first-parent lineage walk;
//   3. real `git checkout <target>` + rebuild + pending marker + restart;
//   4. the boot health gate COMMITS on a healthy boot;
//   5. ROLLBACK DRILL: a second (endorsed) update that never boots healthy is
//      auto-rolled-back to the prior commit — a bad update cannot brick the box.
//
// Run: npx tsc -b && node scripts/update-pipeline-rehearsal.mjs
//   (it imports the daemon's built dist/, so the workspace must be compiled)
// Exit 0 = every assertion held.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { webcrypto } from "node:crypto";
import {
  signUpdateOrder,
  verifyUpdateOrder,
  ed,
} from "@flagship/protocol";
import {
  generateKeypair as genMaintainerKp,
  signMandate,
  signReleaseEndorsement,
  intermediateMerkleRoot,
  mandatePinHash,
} from "@ibisllc/maintainers";
import {
  runUpdateConsumer,
  fileUsedNonceStore,
  filePendingVerifyStore,
} from "@flagship/server-daemon/dist/updateConsumer.js";
import { runUpdateBootGate } from "@flagship/server-daemon/dist/updateHealthGate.js";
import { buildMaintainersReleaseGate } from "@flagship/server-daemon/dist/selfUpdateReleaseGate.js";

const DOMAIN = "home.rehearsal.flagship.services";
let failures = 0;
function check(label, cond) {
  process.stdout.write(`  ${cond ? "✓" : "✗ FAIL"}  ${label}\n`);
  if (!cond) failures++;
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function commitAll(cwd, msg) {
  git(cwd, ["add", "-A"]);
  execFileSync("git", ["-C", cwd, "commit", "-q", "-m", msg], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_AUTHOR_DATE: "2026-07-24T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-24T00:00:00Z",
    },
  });
  return git(cwd, ["rev-parse", "HEAD"]).toLowerCase();
}

function firstParent(cwd, range) {
  return git(cwd, ["rev-list", "--first-parent", "--reverse", range])
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

// A ReleaseEndorsement covering the full first-parent history to `target`,
// signed by the throwaway ca holder — exactly what scripts/endorse-release.mjs
// mints for a genesis endorsement.
function genesisEndorsement(originDir, target, caKp, tag) {
  const intermediates = firstParent(originDir, target);
  return signReleaseEndorsement(
    {
      kind: "ReleaseEndorsement",
      version: 1,
      releaseId: `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e12)
        .toString()
        .padStart(12, "0")}`,
      semverTag: tag,
      commitHash: target,
      previousReleaseId: null,
      previousCommitHash: null,
      intermediateCommits: intermediates,
      intermediateMerkleRoot: intermediateMerkleRoot(intermediates),
      endorsedNotes: null,
      issuedAt: "2026-07-24T00:00:00Z",
      signedBy: caKp.pubKey,
    },
    [{ privKey: caKp.privKey }],
  );
}

// The deposited carrier the box GETs from .com: hex(UTF-8 JSON {order,signature}).
function carrier(order, sig) {
  const json = JSON.stringify({
    order,
    signature: Buffer.from(sig).toString("hex"),
  });
  return Buffer.from(json, "utf8").toString("hex");
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-update-rehearsal-"));
  const originDir = path.join(scratch, "origin");
  const boxDir = path.join(scratch, "box");
  const dataDir = path.join(scratch, "data");
  fs.mkdirSync(originDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // ---- throwaway authorities -------------------------------------------
  // Owner IRK (legacy, no admin root) authorizes the order.
  const irkSeed = new Uint8Array(32);
  webcrypto.getRandomValues(irkSeed);
  const ownerIrk = { privateKey: irkSeed, publicKey: ed.getPublicKey(irkSeed) };
  // ca-track holder endorses releases (the pre-release collapse).
  const caSeed = new Uint8Array(32);
  caSeed[0] = 123;
  const caKp = genMaintainerKp(caSeed);

  // ---- build the origin repo -------------------------------------------
  git(originDir, ["init", "-q", "-b", "main"]);
  git(originDir, ["config", "commit.gpgsign", "false"]);
  // A genesis ca mandate held by the throwaway key; capture its pin for the
  // FLAGSHIP_MAINTAINER_PIN_OVERRIDE the box gate uses.
  const caMandate = signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: "99999999-9999-4999-8999-999999999999",
      track: "ca",
      holder: caKp.pubKey,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
      successors: [caKp.pubKey],
      approvalRule: { kind: "threshold", threshold: 1 },
      minSuccessors: 1,
      maxDurationSeconds: 31536000,
      defaultDurationSeconds: 5184000,
      signedBy: caKp.pubKey,
    },
    [{ privKey: caKp.privKey }],
  );
  const pin = mandatePinHash(caMandate);
  const maintDir = path.join(originDir, ".maintainers", "tracks", "ca", "mandates");
  fs.mkdirSync(maintDir, { recursive: true });
  fs.writeFileSync(path.join(maintDir, "genesis.json"), JSON.stringify(caMandate));
  fs.writeFileSync(path.join(originDir, "VERSION"), "base\n");
  const c0 = commitAll(originDir, "c0 base + ca mandate");

  // ---- the box is a SHALLOW clone at c0 (exactly like a real demo box:
  //      `git clone --depth 50`) so the rehearsal exercises the shallow-deepen
  //      the consumer must do before the genesis-endorsement lineage walk.
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${originDir}`, boxDir]);
  git(boxDir, ["config", "commit.gpgsign", "false"]);
  git(boxDir, ["config", "advice.detachedHead", "false"]);
  check("box starts at c0", git(boxDir, ["rev-parse", "HEAD"]).toLowerCase() === c0);
  check("box clone is SHALLOW (like a real box)",
    git(boxDir, ["rev-parse", "--is-shallow-repository"]) === "true");

  // A build runner: real git; npm/npx are controllable stubs (a file named
  // FAIL-BUILD in the checked-out tree makes the rebuild fail — used never here,
  // the rollback drill uses the health path instead). This keeps the git
  // orchestration 100% real while the (irrelevant-to-orchestration) rebuild is
  // fast + deterministic.
  const runner = async (cmd, args, opts) => {
    if (cmd === "git") {
      const stdout = execFileSync("git", args, {
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        encoding: "utf8",
      });
      return { stdout };
    }
    // npm / npx tsc -b — simulate a build.
    if (fs.existsSync(path.join(boxDir, "FAIL-BUILD"))) {
      throw new Error("simulated build failure");
    }
    return { stdout: "" };
  };

  const releaseGate = buildMaintainersReleaseGate({
    repoPath: boxDir,
    pinnedMandateHash: pin,
    onLog: () => {},
  });

  const consumerBase = {
    serverDomain: DOMAIN,
    ownerIrkPub: ownerIrk.publicKey,
    username: "rehearsal",
    controlPlaneBaseUrl: "https://example.invalid",
    repoPath: boxDir,
    releaseGate,
    runner,
    usedNonceStore: fileUsedNonceStore(path.join(dataDir, "nonces.json")),
    pendingStore: filePendingVerifyStore(path.join(dataDir, "pending.json")),
    now: () => Date.parse("2026-07-24T01:00:00Z"),
    requestExit: () => {}, // rehearsal drives the boot gate manually below
    onLog: () => {},
  };

  // A deposit oracle: returns the sealed carrier for the current order.
  let currentCarrier = null;
  const fetchImpl = async (url, init) => {
    if (init?.method === "GET" || !init?.method) {
      if (!currentCarrier) return new Response(null, { status: 404 });
      return new Response(JSON.stringify({ sealed: currentCarrier }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };

  function orderFor(from, target) {
    const order = {
      serverDomain: DOMAIN,
      targetCommit: target,
      fromCommit: from,
      nonce: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("hex"),
      issuedAt: Date.parse("2026-07-24T01:00:00Z"),
    };
    const sig = signUpdateOrder(order, ownerIrk);
    check(`order verifies under the owner IRK (${from.slice(0, 6)}→${target.slice(0, 6)})`,
      verifyUpdateOrder(order, sig, ownerIrk.publicKey));
    return carrier(order, sig);
  }

  // ============ GOOD UPDATE: c0 → c1, committed on healthy boot ============
  process.stdout.write("\n[1] good update c0 → c1\n");
  fs.writeFileSync(path.join(originDir, "VERSION"), "v1\n");
  const c1 = commitAll(originDir, "c1 target code");
  const e1 = genesisEndorsement(originDir, c1, caKp, "v0.0.1");
  const endDir = path.join(originDir, ".maintainers", "endorsements");
  fs.mkdirSync(endDir, { recursive: true });
  fs.writeFileSync(path.join(endDir, "v0.0.1.json"), JSON.stringify(e1));
  commitAll(originDir, "c2 endorsement for c1"); // origin/main the box will fetch

  currentCarrier = orderFor(c0, c1);
  const out1 = await runUpdateConsumer({ ...consumerBase, fetchImpl });
  check("consumer applied the update", out1.applied === true);
  check("consumer reports c0 → c1", out1.applied && out1.previousCommit === c0 && out1.targetCommit === c1);
  check("box worktree is now at c1", git(boxDir, ["rev-parse", "HEAD"]).toLowerCase() === c1);
  check("pending marker written", fs.existsSync(path.join(dataDir, "pending.json")));

  // Simulate the systemd restart into the new code: the boot health gate runs.
  const gate1 = await runUpdateBootGate({
    pendingStore: consumerBase.pendingStore,
    repoPath: boxDir,
    runner,
    awaitHealthy: async () => true, // healthy boot
    requestRestart: () => {},
    onLog: () => {},
  });
  check("boot gate COMMITTED the update", gate1.action === "committed" && gate1.targetCommit === c1);
  check("pending marker cleared after commit", !fs.existsSync(path.join(dataDir, "pending.json")));
  check("box remains at c1", git(boxDir, ["rev-parse", "HEAD"]).toLowerCase() === c1);

  // ============ REPLAY: the same order must not re-apply ============
  process.stdout.write("\n[2] replay defense\n");
  const out1b = await runUpdateConsumer({ ...consumerBase, fetchImpl });
  check("same nonce is rejected as replay", !out1b.applied && out1b.reason === "replayed-nonce");

  // ============ UNENDORSED: a real commit with NO endorsement is refused ====
  process.stdout.write("\n[3] unendorsed target is refused\n");
  fs.writeFileSync(path.join(originDir, "VERSION"), "rogue\n");
  const rogue = commitAll(originDir, "cR unendorsed rogue commit");
  currentCarrier = orderFor(c1, rogue);
  const outR = await runUpdateConsumer({ ...consumerBase, fetchImpl });
  check("unendorsed commit is refused (halts)", !outR.applied && outR.reason === "unendorsed");
  check("box still at c1 after refusal", git(boxDir, ["rev-parse", "HEAD"]).toLowerCase() === c1);

  // ============ ROLLBACK DRILL: c1 → c3 (endorsed) never boots healthy ======
  process.stdout.write("\n[4] rollback drill c1 → c3 (unhealthy → auto-rollback)\n");
  // Reset origin/main to a clean line off c1 that carries c3 + its endorsement
  // (drop the rogue commit so the first-parent walk is clean).
  git(originDir, ["reset", "-q", "--hard", c1]);
  fs.writeFileSync(path.join(originDir, "VERSION"), "v3\n");
  const c3 = commitAll(originDir, "c3 target code");
  const e3 = genesisEndorsement(originDir, c3, caKp, "v0.0.3");
  fs.mkdirSync(endDir, { recursive: true });
  fs.writeFileSync(path.join(endDir, "v0.0.3.json"), JSON.stringify(e3));
  commitAll(originDir, "c4 endorsement for c3");

  currentCarrier = orderFor(c1, c3);
  const out3 = await runUpdateConsumer({ ...consumerBase, fetchImpl });
  check("consumer applied c1 → c3", out3.applied === true && out3.targetCommit === c3);
  check("box worktree at c3 (staged)", git(boxDir, ["rev-parse", "HEAD"]).toLowerCase() === c3);

  // Boot health gate with an UNHEALTHY boot + a 1-boot budget: attempt 1 retries,
  // attempt 2 exceeds the budget and rolls back to c1.
  let restarts = 0;
  const bootOpts = {
    pendingStore: consumerBase.pendingStore,
    repoPath: boxDir,
    runner,
    awaitHealthy: async () => false, // never becomes healthy
    requestRestart: () => {
      restarts++;
    },
    maxBootAttempts: 1,
    onLog: () => {},
  };
  const b1 = await runUpdateBootGate(bootOpts); // attempt 1 → retry
  check("boot 1 asks for a restart (retry)", b1.action === "retry-restart");
  const b2 = await runUpdateBootGate(bootOpts); // attempt 2 → rollback
  check("boot 2 ROLLED BACK to c1", b2.action === "rolled-back" && b2.previousCommit === c1);
  check("box worktree restored to c1", git(boxDir, ["rev-parse", "HEAD"]).toLowerCase() === c1);
  check("pending marker cleared after rollback", !fs.existsSync(path.join(dataDir, "pending.json")));
  check("restart was requested during the drill", restarts >= 1);

  // cleanup
  fs.rmSync(scratch, { recursive: true, force: true });

  process.stdout.write(
    `\n${failures === 0 ? "ALL ASSERTIONS PASSED ✓" : `${failures} ASSERTION(S) FAILED ✗`}\n`,
  );
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(String(err?.stack ?? err) + "\n");
    process.exit(1);
  },
);
