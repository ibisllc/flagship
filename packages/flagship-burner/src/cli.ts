#!/usr/bin/env node
/**
 * Flagship Burner CLI.
 *
 *   flagship-burn verify <recipe.json>                 verify the signed blob
 *   flagship-burn verify-iso <iso-path>                check ISO against pinned distros
 *   flagship-burn user-data <recipe.json> <out>        emit cloud-init user-data
 *   flagship-burn prepare <recipe.json> <iso> <out>    bake a flashable ISO
 *   flagship-burn write <recipe.json> <iso>            raw-write ISO + CIDATA to USB
 *   flagship-burn distros                              list supported distros
 *
 * The recipe is the signed InstallBlob the website produces after the
 * user scans the QR with their phone. The Burner NEVER fetches it from
 * flagshipserver.com — the phone's signature is the trust root and
 * .com's involvement in the burn step is a non-feature.
 */
import { writeFile, unlink } from "node:fs/promises";
import {
  loadBlobFromFile,
  loadBlobFromStdin,
  BurnerLoadError,
  buildAutoinstallUserData,
  buildDebianPreseed,
  verifyIsoHash,
  PINNED_DISTROS,
  runWriteCommand,
  runWriteImageCommand,
  remasterIsoWithInstaller,
  detectIsoFamily,
  type IsoFamily,
} from "./index.js";

import { runPair } from "./pair.js";

const args = process.argv.slice(2);
const subcommand = args[0];

// A recipe path of "-" means "read the JSON from stdin" (copy-paste flow:
// `pbpaste | flagship-burn verify -`). Otherwise it's a file path.
const loadRecipe = (path: string) =>
  path === "-" ? loadBlobFromStdin() : loadBlobFromFile(path);

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
    case "write":
      return cmdWrite(args.slice(1));
    case "write-image":
      return cmdWriteImage(args.slice(1));
    case "distros":
      return cmdDistros();
    case "pair":
      return cmdPair(args.slice(1));
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
    const loaded = await loadRecipe(path);
    const { blob } = loaded;
    console.log(
      JSON.stringify(
        {
          ok: true,
          source: loaded.source,
          serverDomain: blob.serverDomain,
          username: blob.username,
          serverName: blob.serverName,
          expiresAt: new Date(blob.authCode.expiresAt).toISOString(),
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
    loaded = await loadRecipe(recipePath);
  } catch (e) {
    console.error(`load recipe failed: ${(e as Error).message}`);
    process.exit(1);
  }
  const genOpts = {
    blob: loaded.blob,
    blobSignatureHex: loaded.blobSignatureHex,
    pairingOrder: loaded.pairingOrder,
    swkHex: loaded.swkHex,
    // LUKS is the locked default. --plaintext-root is an undocumented debug
    // escape (bisect a boot failure against the proven unencrypted path).
    encryptRoot: !rest.includes("--plaintext-root"),
    wifiSSID: extractFlagValue(rest, "--wifi-ssid"),
    wifiPassword: extractFlagValue(rest, "--wifi-password"),
  };
  // Emit a Debian d-i preseed.cfg with --debian (or --family debian); default
  // stays the Ubuntu autoinstall user-data (this command is for inspection;
  // `prepare`/`write` auto-detect the family from the ISO).
  const family: IsoFamily =
    rest.includes("--debian") || extractFlagValue(rest, "--family") === "debian"
      ? "debian"
      : "ubuntu";
  const out = family === "debian" ? buildDebianPreseed(genOpts) : buildAutoinstallUserData(genOpts);
  await writeFile(outPath, out, { mode: 0o600 });
  console.log(`wrote ${out.length} bytes to ${outPath} (${family})`);
  console.log(`server-domain: ${loaded.blob.serverDomain}`);
  console.log(`expires:       ${new Date(loaded.blob.authCode.expiresAt).toISOString()}`);
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
  // `prepare` — take a Linux installer ISO + a signed recipe; produce a
  // ready-to-flash autoinstall ISO. We do NOT verify the ISO against a
  // pinned hash: the tool advises (see `distros` + the website) but the
  // user supplies whatever image they choose.
  const recipePath = rest[0];
  const isoPath = rest[1];
  const outPath = rest[2];
  if (!recipePath || !isoPath || !outPath) {
    console.error("usage: flagship-burn prepare <recipe.json> <input.iso> <output.iso>");
    process.exit(2);
  }
  let loaded;
  try {
    loaded = await loadRecipe(recipePath);
  } catch (e) {
    console.error(`load recipe failed: ${(e as Error).message}`);
    process.exit(1);
  }
  const genOpts = {
    blob: loaded.blob,
    blobSignatureHex: loaded.blobSignatureHex,
    pairingOrder: loaded.pairingOrder,
    swkHex: loaded.swkHex,
    // LUKS is the locked default. --plaintext-root is an undocumented debug
    // escape (bisect a boot failure against the proven unencrypted path).
    encryptRoot: !rest.includes("--plaintext-root"),
    wifiSSID: extractFlagValue(rest, "--wifi-ssid"),
    wifiPassword: extractFlagValue(rest, "--wifi-password"),
  };
  // Detect Ubuntu vs Debian from the ISO and bake the matching unattended
  // mechanism (NoCloud autoinstall vs d-i preseed). --family overrides.
  const forced = extractFlagValue(rest, "--family");
  const family: IsoFamily | undefined =
    forced === "debian" || forced === "ubuntu" ? forced : undefined;
  const used = await remasterIsoWithInstaller({
    srcIsoPath: isoPath,
    outIsoPath: outPath,
    userDataYaml: buildAutoinstallUserData(genOpts),
    preseedCfg: buildDebianPreseed(genOpts),
    family,
  });
  console.log(`wrote prepared ISO to ${outPath} (${used})`);
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

async function cmdWrite(rest: string[]): Promise<void> {
  // `write` — full burn: verify recipe + ISO, pick a removable USB
  // target (interactive picker by default), get a typed-yes from the
  // user, remaster the autoinstall ISO, then raw-write it to the device.
  // Auto-shreds the recipe on success. Needs root + read access to the
  // recipe/ISO; the GUI instead splits this into `prepare` + `write-image`
  // so root never reads a protected folder.
  const positional = rest.filter((a) => !a.startsWith("--"));
  const recipePath = positional[0];
  const isoPath = positional[1];
  if (!recipePath || !isoPath) {
    console.error(
      "usage: flagship-burn write <recipe.json> <iso-path> [--device /dev/diskN|auto] [--yes] [--keep-recipe]",
    );
    process.exit(2);
  }
  const device = extractFlagValue(rest, "--device");
  const yes = rest.includes("--yes");
  const keepRecipe = rest.includes("--keep-recipe");
  if (device === "auto" && !yes) {
    console.error("--device auto requires --yes (CI-friendly only; never prompts).");
    process.exit(2);
  }
  const result = await runWriteCommand({
    recipePath,
    isoPath,
    device,
    yes,
    keepRecipe,
    // LUKS is the locked default. --plaintext-root is an undocumented debug
    // escape (bisect a boot failure against the proven unencrypted path).
    encryptRoot: !rest.includes("--plaintext-root"),
    wifiSSID: extractFlagValue(rest, "--wifi-ssid"),
    wifiPassword: extractFlagValue(rest, "--wifi-password"),
  });
  if (!result.ok) {
    console.error(`write failed: ${result.reason}`);
    process.exit(result.exitCode);
  }
  console.log(`wrote ${result.bytesWritten} bytes to ${result.devicePath}`);
  if (!keepRecipe) {
    console.log(`shredded recipe: ${recipePath}`);
  }
}

async function cmdWriteImage(rest: string[]): Promise<void> {
  // `write-image` — the privileged half of the GUI flow. Writes an
  // already-prepared image (from `prepare`) verbatim to a USB target. No
  // recipe/ISO reads happen here, so root never touches a protected folder.
  const positional = rest.filter((a) => !a.startsWith("--"));
  const imagePath = positional[0];
  if (!imagePath) {
    console.error(
      "usage: flagship-burn write-image <image.iso> [--device /dev/diskN|auto] [--yes]",
    );
    process.exit(2);
  }
  const device = extractFlagValue(rest, "--device");
  const yes = rest.includes("--yes");
  if (device === "auto" && !yes) {
    console.error("--device auto requires --yes (CI-friendly only; never prompts).");
    process.exit(2);
  }
  const result = await runWriteImageCommand({ imagePath, device, yes });
  if (!result.ok) {
    console.error(`write-image failed: ${result.reason}`);
    process.exit(result.exitCode);
  }
  console.log(`wrote ${result.bytesWritten} bytes to ${result.devicePath}`);
}

/** Extract `--flag value` or `--flag=value` from argv. */
function extractFlagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === flag) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) return next;
    }
    if (a.startsWith(`${flag}=`)) {
      return a.slice(flag.length + 1);
    }
  }
  return undefined;
}

async function cmdPair(rest: string[]): Promise<void> {
  const host = extractFlagValue(rest, "--host");
  const out = extractFlagValue(rest, "--out");
  await runPair({
    ...(host ? { host } : {}),
    ...(out ? { out } : {}),
    insecure: rest.includes("--insecure"),
    debug: rest.includes("--debug"),
  });
}

function cmdDistros(): void {
  for (const d of PINNED_DISTROS) {
    const tag = d.recommended ? "  [recommended]" : "";
    console.log(`${d.id}  ${d.displayName}${tag}`);
    console.log(`  url:    ${d.upstreamUrl}`);
    console.log(`  sha:    ${d.sha256}`);
    console.log(`  size:   ${d.sizeBytes} bytes`);
    console.log(`  family: ${d.family}`);
    console.log(`  boot:   ${d.boot}`);
  }
}

function cmdHelp(): void {
  console.log(`flagship-burn — flash a Flagship install onto a USB drive

usage:
  (a recipe arg of "-" reads the JSON from stdin: pbpaste | flagship-burn verify -)
  flagship-burn verify <recipe.json|->                     verify the signed blob
  flagship-burn verify-iso <path>                          check ISO against pinned distros
  flagship-burn user-data <recipe.json|-> <out>            emit the unattended install config
                                                           (Ubuntu autoinstall by default; --debian for a d-i preseed)
                                                           (auto-shreds recipe; pass --keep-recipe to skip)
  flagship-burn prepare <recipe.json|-> <iso> <out.iso>    bake a flashable unattended ISO
                                                           (auto-detects Ubuntu vs Debian; --family to force)
  flagship-burn write <recipe.json> <iso>                  prepare + raw-write to a USB device
                                                           [--device /dev/diskN | auto] [--yes] [--keep-recipe]
                                                           (needs sudo; interactive picker if no --device)
  flagship-burn write-image <image.iso>                    raw-write an already-prepared image
                                                           [--device /dev/diskN | auto] [--yes]
                                                           (needs sudo; pairs with prepare)
  flagship-burn pair                                       pair with your phone (shows a QR + code),
                                                           receive + verify the recipe over the live relay
                                                           [--out <recipe.json>] [--host <control-host>] [--debug]
                                                           (--debug = Advanced: request an owner-signed debug-access
                                                            grant; you approve it on your phone with Face ID, and the
                                                            box enables a debug console user only after verifying it)
  flagship-burn distros                                    list supported distros

Wi-Fi (for a target box with no Ethernet) — pass to user-data/prepare/write:
  --wifi-ssid <name> --wifi-password <pass>   bake netplan Wi-Fi into the image
  (a burn-time local input; NEVER part of the signed recipe)

The recipe is the signed JSON the website produces after you scan the
QR code with your phone. Bring it here — the Burner verifies the
phone's signature locally and never phones home to flagshipserver.com.

\`write\` requires root (raw block-device access). macOS + Linux only.`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
