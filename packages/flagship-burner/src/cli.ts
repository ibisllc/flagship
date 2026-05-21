#!/usr/bin/env node
/**
 * Flagship Burner CLI.
 *
 *   flagship-burn verify <recipe.json>                 verify the signed blob
 *   flagship-burn verify-iso <iso-path>                check ISO against pinned distros
 *   flagship-burn user-data <recipe.json> <out>        emit cloud-init user-data
 *   flagship-burn prepare <recipe.json> <iso> <out>    bake a flashable ISO
 *   flagship-burn distros                              list supported distros
 *
 * The recipe is the signed InstallBlob the website produces after the
 * user scans the QR with their phone. The Burner NEVER fetches it from
 * flagshipserver.com — the phone's signature is the trust root and
 * .com's involvement in the burn step is a non-feature.
 *
 * Phase 1 omits the "actually write USB" step. That gets added once
 * the recipe + user-data plumbing is end-to-end verified on a real
 * laptop boot.
 */
import { writeFile, unlink } from "node:fs/promises";
import {
  loadBlobFromFile,
  BurnerLoadError,
  buildAutoinstallUserData,
  verifyIsoHash,
  PINNED_DISTROS,
} from "./index.js";
import { writeIsoWithCidata } from "./writeIsoWithCidata.js";

const args = process.argv.slice(2);
const subcommand = args[0];

async function main(): Promise<void> {
  switch (subcommand) {
    case "verify":
      return cmdVerify(args.slice(1));
    case "verify-iso":
      return cmdVerifyIso(args.slice(1));
    case "user-data":
      return cmdUserData(args.slice(1));
    case "prepare":
      return cmdPrepare(args.slice(1));
    case "distros":
      return cmdDistros();
    case undefined:
    case "--help":
    case "-h":
      return cmdHelp();
    default:
      console.error(`unknown subcommand: ${subcommand}`);
      cmdHelp();
      process.exit(1);
  }
}

async function cmdVerify(rest: string[]): Promise<void> {
  const path = rest[0];
  if (!path) {
    console.error("usage: flagship-burn verify <recipe.json>");
    process.exit(2);
  }
  try {
    const loaded = await loadBlobFromFile(path);
    const { blob } = loaded;
    console.log(
      JSON.stringify(
        {
          ok: true,
          source: loaded.source,
          serverDomain: blob.serverDomain,
          username: blob.username,
          serverName: blob.serverName,
          expiresAt: new Date(blob.expiresAt).toISOString(),
          installerGitRef: blob.installerGitRef,
          signatureValid: true,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    if (e instanceof BurnerLoadError) {
      console.error(`verify failed (${e.code}): ${e.message}`);
    } else {
      console.error(`verify failed: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

async function cmdVerifyIso(rest: string[]): Promise<void> {
  const path = rest[0];
  if (!path) {
    console.error("usage: flagship-burn verify-iso <path>");
    process.exit(2);
  }
  const r = await verifyIsoHash(path);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

async function cmdUserData(rest: string[]): Promise<void> {
  const recipePath = rest[0];
  const outPath = rest[1];
  if (!recipePath || !outPath) {
    console.error("usage: flagship-burn user-data <recipe.json> <out-path>");
    process.exit(2);
  }
  let loaded;
  try {
    loaded = await loadBlobFromFile(recipePath);
  } catch (e) {
    console.error(`load recipe failed: ${(e as Error).message}`);
    process.exit(1);
  }
  const yaml = buildAutoinstallUserData({
    blob: loaded.blob,
    blobSignatureHex: loaded.blobSignatureHex,
  });
  await writeFile(outPath, yaml, { mode: 0o600 });
  console.log(`wrote ${yaml.length} bytes to ${outPath}`);
  console.log(`server-domain: ${loaded.blob.serverDomain}`);
  console.log(`expires:       ${new Date(loaded.blob.expiresAt).toISOString()}`);
  // Auto-shred the recipe file after we've consumed it. The signed
  // ticket is single-use; leaving it on disk extends the attack window.
  // User can pass --keep-recipe to skip if they want.
  if (!rest.includes("--keep-recipe")) {
    try {
      await unlink(recipePath);
      console.log(`shredded recipe: ${recipePath}`);
    } catch (e) {
      console.warn(`could not shred ${recipePath}: ${(e as Error).message}`);
    }
  }
}

async function cmdPrepare(rest: string[]): Promise<void> {
  // `prepare` — take a stock distro ISO + a signed recipe; produce a
  // ready-to-flash ISO with cloud-init user-data baked into a CIDATA
  // partition appended at the end. The user can then write the output
  // ISO to USB with `dd`, balenaEtcher, Rufus, or any tool of choice.
  //
  // This is the "burn elsewhere" use case — the desktop GUI omits it
  // (its Phase 2 `write` subcommand bundles prepare+flash in one
  // step), but the CLI keeps it because some users need to hand an
  // ISO to a friend or burn it on a different machine.
  const recipePath = rest[0];
  const isoPath = rest[1];
  const outPath = rest[2];
  if (!recipePath || !isoPath || !outPath) {
    console.error("usage: flagship-burn prepare <recipe.json> <input.iso> <output.iso>");
    process.exit(2);
  }
  let loaded;
  try {
    loaded = await loadBlobFromFile(recipePath);
  } catch (e) {
    console.error(`load recipe failed: ${(e as Error).message}`);
    process.exit(1);
  }
  const isoResult = await verifyIsoHash(isoPath);
  if (!isoResult.ok) {
    console.error(`ISO verify failed: ${isoResult.reason}`);
    process.exit(1);
  }
  const yaml = buildAutoinstallUserData({
    blob: loaded.blob,
    blobSignatureHex: loaded.blobSignatureHex,
  });
  await writeIsoWithCidata({ srcIsoPath: isoPath, outIsoPath: outPath, userDataYaml: yaml });
  console.log(`wrote prepared ISO to ${outPath}`);
  console.log(`server-domain: ${loaded.blob.serverDomain}`);
  console.log(
    `expires:       ${new Date(loaded.blob.authCode.expiresAt).toISOString()}`,
  );
  // Auto-shred the recipe — same one-shot semantics as `user-data`.
  if (!rest.includes("--keep-recipe")) {
    try {
      await unlink(recipePath);
      console.log(`shredded recipe: ${recipePath}`);
    } catch (e) {
      console.warn(`could not shred ${recipePath}: ${(e as Error).message}`);
    }
  }
}

function cmdDistros(): void {
  for (const d of PINNED_DISTROS) {
    console.log(`${d.id}  ${d.displayName}`);
    console.log(`  url:   ${d.upstreamUrl}`);
    console.log(`  sha:   ${d.sha256}`);
    console.log(`  size:  ${d.sizeBytes} bytes`);
    console.log(`  boot:  ${d.boot}`);
  }
}

function cmdHelp(): void {
  console.log(`flagship-burn — flash a Flagship install onto a USB drive

usage:
  flagship-burn verify <recipe.json>           verify the signed blob
  flagship-burn verify-iso <path>              check ISO against pinned distros
  flagship-burn user-data <recipe.json> <out>  emit cloud-init user-data
                                               (auto-shreds recipe after use;
                                                pass --keep-recipe to skip)
  flagship-burn distros                        list supported distros

The recipe is the signed JSON the website produces after you scan the
QR code with your phone. Bring it here — the Burner verifies the
phone's signature locally and never phones home to flagshipserver.com.

Phase-1 prototype. The "write to USB" step is not yet implemented;
once the recipe + user-data plumbing is end-to-end verified on a real
laptop boot, the next phase adds the raw-disk write.`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
