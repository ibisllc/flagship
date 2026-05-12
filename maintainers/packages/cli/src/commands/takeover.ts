/**
 * `maintainers takeover` — a named successor unilaterally issues a new
 * mandate after the predecessor expired. Per spec §4: first successor to
 * land wins (canonical-log ordering resolves races).
 *
 * The successor signs the new mandate using their own key; the new holder
 * can be the same person or a delegate. The takeover mandate's signedBy
 * MUST appear in the predecessor's successors[] list.
 */

import { signMandate, type Mandate } from "@maintainers/protocol";
import { parseDurationMs, isoFromMsSince } from "../lib/duration.js";
import { CliError, type ParsedArgs, requireFlag, optionalFlag } from "../lib/args.js";
import { loadPrivKey, loadPubKey, loadPubKeyList, type KeySourceFs } from "../lib/keysource.js";
import { readStore, writeMandate } from "../lib/store.js";

export interface TakeoverOptions {
  track: string;
  duration: string;
  successorKeySource: string;
  newHolderSource: string;
  successorsSource: string | undefined;
  rootDir: string;
  now: () => Date;
  io: KeySourceFs;
  uuid: () => string;
}

export function buildTakeover(opts: TakeoverOptions): Mandate {
  const store = readStore(opts.rootDir);
  const prior = store.mandatesByTrack.get(opts.track) ?? [];
  if (prior.length === 0) {
    throw new CliError(`no prior mandates on track "${opts.track}"; nothing to take over`);
  }
  const last = prior[prior.length - 1]!;
  const signer = loadPrivKey(opts.successorKeySource, opts.io);
  if (!last.successors.includes(signer.pubKey)) {
    throw new CliError(
      `signer ${signer.pubKey.slice(0, 8)}… is not a named successor on the last mandate; valid successors: ${last.successors.map((s) => s.slice(0, 8) + "…").join(", ")}`,
    );
  }
  const newHolder = loadPubKey(opts.newHolderSource, opts.io);

  const issuedAtMs = opts.now().getTime();
  const predExpiresMs = Date.parse(last.expiresAt);
  if (Number.isFinite(predExpiresMs) && issuedAtMs < predExpiresMs) {
    throw new CliError(
      `predecessor mandate has not yet expired (expiresAt=${last.expiresAt}); takeover is only valid at or after expiry`,
    );
  }

  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = isoFromMsSince(issuedAtMs, parseDurationMs(opts.duration));
  const successors = opts.successorsSource
    ? loadPubKeyList(opts.successorsSource, opts.io).map((k) => k.pubKey)
    : [newHolder.pubKey];

  return signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: opts.uuid(),
      track: opts.track,
      holder: newHolder.pubKey,
      issuedAt,
      expiresAt,
      successors,
      signedBy: signer.pubKey,
    },
    [{ privKey: signer.privKey }],
  );
}

export interface TakeoverCmdEnv {
  now: () => Date;
  io: KeySourceFs;
  uuid: () => string;
  println: (line: string) => void;
}

export function runTakeover(args: ParsedArgs, env: TakeoverCmdEnv): number {
  const track = requireFlag(args, "track");
  const duration = optionalFlag(args, "duration") ?? "60d";
  const successorKey = requireFlag(args, "successor-key");
  const newHolder = requireFlag(args, "new-holder");
  const successorsCsv = optionalFlag(args, "successors");
  const rootDir = optionalFlag(args, "path") ?? ".maintainers";

  const m = buildTakeover({
    track,
    duration,
    successorKeySource: successorKey,
    newHolderSource: newHolder,
    successorsSource: successorsCsv,
    rootDir,
    now: env.now,
    io: env.io,
    uuid: env.uuid,
  });
  const written = writeMandate(rootDir, m);
  env.println(`wrote takeover mandate for track "${track}" → ${written.relative}`);
  env.println(`  new holder: ${m.holder}`);
  env.println(`  signed by:  ${m.signedBy}`);
  env.println(`  issuedAt:   ${m.issuedAt}`);
  env.println(`  expiresAt:  ${m.expiresAt}`);
  env.println(`  mandateId:  ${m.mandateId}`);
  return 0;
}
