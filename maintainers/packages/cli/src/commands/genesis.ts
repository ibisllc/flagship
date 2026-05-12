/**
 * `maintainers genesis` — emit a self-signed genesis mandate for a track.
 *
 * A genesis mandate is the bootstrap: the holder signs it themselves; trust
 * is rooted in the user's choice to clone this repo at all (spec §4).
 */

import { signMandate, type Mandate } from "@maintainers/protocol";
import { parseDurationMs, isoFromMsSince } from "../lib/duration.js";
import { CliError, type ParsedArgs, requireFlag, optionalFlag } from "../lib/args.js";
import { loadPrivKey, loadPubKey, loadPubKeyList, type KeySourceFs } from "../lib/keysource.js";
import { newUuid } from "../lib/uuid.js";
import { writeMandate, writeTrackPolicyIfMissing } from "../lib/store.js";

export interface GenesisOptions {
  track: string;
  duration: string;
  holderKeySource: string;
  signingKeySource: string;
  successorsSource: string | undefined;
  outputDir: string | undefined;
  now: () => Date;
  io: KeySourceFs;
  uuid: () => string;
}

export function buildGenesis(opts: GenesisOptions): Mandate {
  const holder = loadPubKey(opts.holderKeySource, opts.io);
  const signer = loadPrivKey(opts.signingKeySource, opts.io);
  if (signer.pubKey !== holder.pubKey) {
    throw new CliError(
      "genesis: signing key does not match --holder-key (genesis must be self-signed)",
    );
  }
  const successors = opts.successorsSource
    ? loadPubKeyList(opts.successorsSource, opts.io).map((k) => k.pubKey)
    : [holder.pubKey];

  const issuedAtMs = opts.now().getTime();
  const durMs = parseDurationMs(opts.duration);
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = isoFromMsSince(issuedAtMs, durMs);

  return signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: opts.uuid(),
      track: opts.track,
      holder: holder.pubKey,
      issuedAt,
      expiresAt,
      successors,
      signedBy: holder.pubKey,
    },
    [{ privKey: signer.privKey }],
  );
}

export function runGenesis(args: ParsedArgs, env: GenesisCmdEnv): number {
  const track = requireFlag(args, "track");
  const duration = requireFlag(args, "duration");
  const holderKey = requireFlag(args, "holder-key");
  const signingKey = optionalFlag(args, "signing-key") ?? holderKey;
  const successorsCsv = optionalFlag(args, "successors");
  const output = optionalFlag(args, "output") ?? `.maintainers/tracks/${track}/mandates/`;
  const rootDir = resolveRootDir(output);

  const mandate = buildGenesis({
    track,
    duration,
    holderKeySource: holderKey,
    signingKeySource: signingKey,
    successorsSource: successorsCsv,
    outputDir: output,
    now: env.now,
    io: env.io,
    uuid: env.uuid,
  });

  writeTrackPolicyIfMissing(rootDir, {
    track,
    defaultMandateDuration: duration,
    approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
  });
  const written = writeMandate(rootDir, mandate);
  env.println(`wrote genesis mandate for track "${track}" → ${written.relative}`);
  env.println(`  holder:    ${mandate.holder}`);
  env.println(`  issuedAt:  ${mandate.issuedAt}`);
  env.println(`  expiresAt: ${mandate.expiresAt}`);
  env.println(`  mandateId: ${mandate.mandateId}`);
  return 0;
}

export interface GenesisCmdEnv {
  now: () => Date;
  io: KeySourceFs;
  uuid: () => string;
  println: (line: string) => void;
}

/**
 * `--output ./.maintainers/tracks/release/mandates/` → root is `./.maintainers`.
 * The writer takes the root and appends `tracks/<track>/mandates/`.
 */
function resolveRootDir(output: string): string {
  // Trim trailing slashes.
  let s = output.replace(/\/+$/, "");
  // Strip mandate-leaf paths the user might supply for convenience.
  s = s.replace(/\/tracks\/[^/]+\/mandates$/, "");
  if (s.endsWith("/mandates")) s = s.slice(0, -"/mandates".length);
  if (s.includes("/tracks/")) s = s.slice(0, s.indexOf("/tracks/"));
  return s.length > 0 ? s : ".maintainers";
}

export const _internal = { resolveRootDir };

export function newUuidWithGuard(): string {
  return newUuid();
}
