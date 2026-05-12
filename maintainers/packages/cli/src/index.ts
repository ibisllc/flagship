/**
 * maintainers CLI entrypoint.
 *
 * Usage:
 *   maintainers genesis     --track <name> --duration <60d> --holder-key file:./pub
 *   maintainers mandate     --track <name> --duration <60d> [--successors file:a,file:b]
 *   maintainers endorsement --commit <40hex> --tag <semver> [--previous-id <uuid> --previous-commit <40hex>] [--intermediates auto|file:X|csv] --signing-key file:./priv
 *   maintainers takeover    --track <name> --successor-key file:./priv --new-holder file:./pub
 *   maintainers verify      [--path ./.maintainers/] [--as-of <RFC3339|now>]
 *   maintainers status      [--path ./.maintainers/] [--as-of <RFC3339|now>]
 *
 * Yubikey-via-PIV key sources (`yubikey:slot=<n>`) are recognized but not yet
 * implemented; the protocol library currently signs Ed25519 only. See the
 * README for the staging plan around ES256 support.
 */

import { CliError, parseArgs, type ParsedArgs } from "./lib/args.js";
import { realFs, type KeySourceFs } from "./lib/keysource.js";
import { newUuid } from "./lib/uuid.js";
import { runGenesis } from "./commands/genesis.js";
import { runMandate } from "./commands/mandate.js";
import { runEndorsement } from "./commands/endorsement.js";
import { runTakeover } from "./commands/takeover.js";
import { runStatus, runVerify } from "./commands/verify.js";

export interface CliEnv {
  now: () => Date;
  io: KeySourceFs;
  uuid: () => string;
  println: (line: string) => void;
  printerr: (line: string) => void;
}

export const defaultEnv: CliEnv = {
  now: () => new Date(),
  io: realFs,
  uuid: newUuid,
  println: (line: string) => process.stdout.write(line + "\n"),
  printerr: (line: string) => process.stderr.write(line + "\n"),
};

export function dispatch(args: ParsedArgs, env: CliEnv): number {
  try {
    switch (args.command) {
      case "genesis":
        return runGenesis(args, env);
      case "mandate":
        return runMandate(args, env);
      case "endorsement":
        return runEndorsement(args, env);
      case "takeover":
        return runTakeover(args, env);
      case "verify":
        return runVerify(args, env);
      case "status":
        return runStatus(args, env);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printUsage(env.println);
        return 0;
      case "version":
      case "--version":
      case "-v":
        env.println("maintainers 0.1.0");
        return 0;
      default:
        env.printerr(`unknown command: ${args.command}`);
        printUsage(env.printerr);
        return 2;
    }
  } catch (err) {
    if (err instanceof CliError) {
      env.printerr(`error: ${err.message}`);
      return 1;
    }
    env.printerr(`unexpected: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return 1;
  }
}

export function run(argv: string[], env: CliEnv = defaultEnv): number {
  const parsed = parseArgs(argv);
  const code = dispatch(parsed, env);
  // run() returns; the bin shim calls process.exit. We avoid calling
  // process.exit here so the function is easy to unit-test.
  return code;
}

function printUsage(println: (s: string) => void): void {
  println("maintainers — authority-management CLI");
  println("");
  println("commands:");
  println("  genesis      --track NAME --duration 60d --holder-key file:KEY [--signing-key file:PRIV] [--successors file:A,file:B] [--output DIR]");
  println("  mandate      --track NAME --duration 60d --signing-key file:PRIV [--successors file:A,file:B] [--path .maintainers]");
  println("  endorsement  --commit 40HEX --tag SEMVER --signing-key file:PRIV [--previous-id UUID --previous-commit 40HEX] [--intermediates auto|file:X|csv] [--track release] [--path .maintainers]");
  println("  takeover     --track NAME --successor-key file:PRIV --new-holder file:PUB [--successors file:A,file:B] [--duration 60d] [--path .maintainers]");
  println("  verify       [--path .maintainers] [--as-of RFC3339|now]");
  println("  status       [--path .maintainers] [--as-of RFC3339|now]");
  println("");
  println("key sources:");
  println("  file:<path>           local 32-byte hex Ed25519 key (priv or pub)");
  println("  yubikey:slot=<piv>    Yubikey via PIV (STAGED — not yet implemented)");
}

// Re-exports so tests and embedders can drive the CLI without spawning a process.
export { parseArgs } from "./lib/args.js";
export { buildGenesis } from "./commands/genesis.js";
export { buildRenewal } from "./commands/mandate.js";
export { buildEndorsement } from "./commands/endorsement.js";
export { buildTakeover } from "./commands/takeover.js";
export { buildReport } from "./commands/verify.js";
