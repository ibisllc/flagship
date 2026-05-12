/**
 * `maintainers endorsement` — sign a release endorsement for a commit.
 *
 * --intermediates `auto`   : derive via `git rev-list --first-parent <prev>..<commit>`
 *                            (chronological-old-to-new order per spec §3.5).
 * --intermediates `file:X` : read newline-separated commit hashes from file.
 * --intermediates `<csv>`  : comma-separated commit hashes inline.
 *
 * The Merkle root is computed from the intermediates list per
 * protocol/intermediateMerkleRoot. The endorsement is signed by the
 * current release-track holder.
 */

import {
  intermediateMerkleRoot,
  signReleaseEndorsement,
  type ReleaseEndorsement,
} from "@maintainers/protocol";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { CliError, type ParsedArgs, requireFlag, optionalFlag } from "../lib/args.js";
import { loadPrivKey, type KeySourceFs } from "../lib/keysource.js";
import { readStore, writeEndorsement } from "../lib/store.js";
import { newUuid } from "../lib/uuid.js";

export interface EndorsementOptions {
  commit: string;
  tag: string;
  previousId: string | null;
  previousCommit: string | null;
  intermediatesSpec: string;
  signingKeySource: string;
  track: string;
  rootDir: string;
  now: () => Date;
  io: KeySourceFs;
  uuid: () => string;
  gitDir?: string;
  gitRunner?: (args: string[]) => string;
}

export function buildEndorsement(opts: EndorsementOptions): ReleaseEndorsement {
  const store = readStore(opts.rootDir);
  const trackMandates = store.mandatesByTrack.get(opts.track) ?? [];
  if (trackMandates.length === 0) {
    throw new CliError(
      `no mandates found on track "${opts.track}"; bootstrap with "genesis" first`,
    );
  }
  const signer = loadPrivKey(opts.signingKeySource, opts.io);

  const commit = expectCommitHash(opts.commit, "commit");
  const previousCommit = opts.previousCommit
    ? expectCommitHash(opts.previousCommit, "previous-commit")
    : null;

  const intermediates = resolveIntermediates(opts.intermediatesSpec, {
    commit,
    previousCommit,
    gitDir: opts.gitDir,
    gitRunner: opts.gitRunner,
  });
  for (const c of intermediates) expectCommitHash(c, "intermediate");
  const merkle = intermediateMerkleRoot(intermediates);

  const issuedAt = opts.now().toISOString();
  return signReleaseEndorsement(
    {
      kind: "ReleaseEndorsement",
      version: 1,
      releaseId: opts.uuid(),
      semverTag: opts.tag,
      commitHash: commit,
      previousReleaseId: opts.previousId,
      previousCommitHash: previousCommit,
      intermediateCommits: intermediates,
      intermediateMerkleRoot: merkle,
      endorsedNotes: null,
      issuedAt,
      signedBy: signer.pubKey,
    },
    [{ privKey: signer.privKey }],
  );
}

export interface EndorsementCmdEnv {
  now: () => Date;
  io: KeySourceFs;
  uuid: () => string;
  println: (line: string) => void;
}

export function runEndorsement(args: ParsedArgs, env: EndorsementCmdEnv): number {
  const commit = requireFlag(args, "commit");
  const tag = requireFlag(args, "tag");
  const previousId = optionalFlag(args, "previous-id") ?? null;
  const previousCommit = optionalFlag(args, "previous-commit") ?? null;
  const intermediatesSpec = optionalFlag(args, "intermediates") ?? "auto";
  const signingKey = requireFlag(args, "signing-key");
  const track = optionalFlag(args, "track") ?? "release";
  const rootDir = optionalFlag(args, "path") ?? ".maintainers";

  if ((previousId === null) !== (previousCommit === null)) {
    throw new CliError(
      "--previous-id and --previous-commit must both be set (non-genesis) or both omitted (genesis)",
    );
  }

  const e = buildEndorsement({
    commit,
    tag,
    previousId,
    previousCommit,
    intermediatesSpec,
    signingKeySource: signingKey,
    track,
    rootDir,
    now: env.now,
    io: env.io,
    uuid: env.uuid,
  });
  const written = writeEndorsement(rootDir, e);
  env.println(`wrote endorsement for ${tag} (commit ${commit.slice(0, 12)}…) → ${written.relative}`);
  env.println(`  releaseId:   ${e.releaseId}`);
  env.println(`  signedBy:    ${e.signedBy}`);
  env.println(`  intermediates: ${e.intermediateCommits.length} commit(s)`);
  env.println(`  merkleRoot:  ${e.intermediateMerkleRoot}`);
  return 0;
}

export function newUuidForEndorsement(): string {
  return newUuid();
}

interface IntermediatesContext {
  commit: string;
  previousCommit: string | null;
  gitDir?: string;
  gitRunner?: (args: string[]) => string;
}

export function resolveIntermediates(
  spec: string,
  ctx: IntermediatesContext,
): string[] {
  if (spec === "auto") {
    if (ctx.previousCommit === null) {
      // Genesis endorsement covering only the head commit.
      return [ctx.commit];
    }
    const runner = ctx.gitRunner ?? defaultGitRunner(ctx.gitDir);
    const out = runner([
      "rev-list",
      "--first-parent",
      "--reverse",
      `${ctx.previousCommit}..${ctx.commit}`,
    ]);
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length > 0);
    if (lines.length === 0) {
      throw new CliError(
        `git rev-list returned no commits between ${ctx.previousCommit} and ${ctx.commit}`,
      );
    }
    return lines;
  }
  if (spec.startsWith("file:")) {
    const path = spec.slice("file:".length);
    let raw: string;
    try {
      raw = fs.readFileSync(path, "utf8");
    } catch (err) {
      throw new CliError(
        `failed to read intermediates file "${path}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return raw
      .split(/\r?\n|,/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }
  return spec.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}

function defaultGitRunner(gitDir: string | undefined) {
  return (args: string[]): string => {
    const base = gitDir ? ["-C", gitDir, ...args] : args;
    try {
      return execFileSync("git", base, { encoding: "utf8" });
    } catch (err) {
      throw new CliError(
        `git ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}

function expectCommitHash(value: string, label: string): string {
  const v = value.trim().toLowerCase();
  if (v.length !== 40) {
    throw new CliError(`${label} must be a 40-character commit hash; got "${value}"`);
  }
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);
    if (!ok) throw new CliError(`${label} contains non-hex character at index ${i}`);
  }
  return v;
}

export const _internal = { resolveIntermediates, expectCommitHash };
