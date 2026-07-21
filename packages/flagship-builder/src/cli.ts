#!/usr/bin/env node
/**
 * Flagship Studio CLI.
 *
 *   flagship-build verify <recipe.json>                 verify the signed blob
 *   flagship-build verify-iso <iso-path>                check ISO against pinned distros
 *   flagship-build user-data <recipe.json> <out>        emit cloud-init user-data
 *   flagship-build prepare <recipe.json> <iso> <out>    bake a flashable ISO
 *   flagship-build write <recipe.json> <iso>            raw-write ISO + CIDATA to USB
 *   flagship-build distros                              list supported distros
 *
 * The recipe is the signed InstallBlob the website produces after the
 * user scans the QR with their phone. The Builder NEVER fetches it from
 * flagshipserver.com — the phone's signature is the trust root and
 * .com's involvement in the burn step is a non-feature.
 */
import { writeFile, unlink, readFile, stat, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createReadStream } from "node:fs";
import {
  loadBlobFromFile,
  loadBlobFromStdin,
  BuilderLoadError,
  buildAutoinstallUserData,
  buildDebianPreseed,
  verifyIsoHash,
  PINNED_DISTROS,
  runWriteCommand,
  runWriteImageCommand,
  remasterIsoWithInstaller,
  detectIsoFamily,
  debugSshKeyFromGrant,
  buildBootstrapFromRecipe,
  encodeApplianceSeed,
  buildDebianApplianceFactoryPreseed,
  buildDebianCloudApplianceFactoryUserData,
  buildNocloudSeedIso,
  remasterIsoWithPreseed,
  type IsoFamily,
} from "./index.js";

import { runPair } from "./pair.js";

const args = process.argv.slice(2);
const subcommand = args[0];

// A recipe path of "-" means "read the JSON from stdin" (copy-paste flow:
// `pbpaste | flagship-build verify -`). Otherwise it's a file path.
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
    case "appliance-provision":
      return cmdApplianceProvision(args.slice(1));
    case "appliance-factory-iso":
      return cmdApplianceFactoryIso(args.slice(1));
    case "appliance-cloud-factory-seed":
      return cmdApplianceCloudFactorySeed(args.slice(1));
    case "appliance-manifest":
      return cmdApplianceManifest(args.slice(1));
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
    console.error("usage: flagship-build verify <recipe.json>");
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
    if (e instanceof BuilderLoadError) {
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
    console.error("usage: flagship-build verify-iso <path>");
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
    console.error("usage: flagship-build user-data <recipe.json> <out-path>");
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
    debugGrant: loaded.debugGrant,
    // The debug SSH key baked at install time (SSH-diagnosable pre-daemon). An
    // explicit --debug-ssh-key[-file] (dev / e2e diagnosis) OVERRIDES the key
    // carried in the owner-Face-ID-signed debug grant (the production path).
    debugSshAuthorizedKey:
      (await resolveDebugSshKey(rest)) ?? debugSshKeyFromGrant(loaded.debugGrant),
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
    console.error("usage: flagship-build prepare <recipe.json> <input.iso> <output.iso>");
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
    debugGrant: loaded.debugGrant,
    // The debug SSH key baked at install time (SSH-diagnosable pre-daemon). An
    // explicit --debug-ssh-key[-file] (dev / e2e diagnosis) OVERRIDES the key
    // carried in the owner-Face-ID-signed debug grant (the production path).
    debugSshAuthorizedKey:
      (await resolveDebugSshKey(rest)) ?? debugSshKeyFromGrant(loaded.debugGrant),
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

interface ApplianceBaseManifest {
  version: number;
  arch: "amd64" | "arm64";
  installerGitRef: string;
  sha256: string;
  sizeBytes: number;
  virtualSizeBytes: number;
}

/** Linux/Windows host specialization seam. The desktop passes an already
 * downloaded raw base plus its adjacent manifest; this command verifies the
 * phone-signed recipe, exact image digest/size/arch/ref, creates a thin qcow2
 * overlay, and emits the byte-identical seed used by macOS. Nothing owner-
 * specific is ever written to the generalized base. */
async function cmdApplianceProvision(rest: string[]): Promise<void> {
  const recipePath = rest[0];
  const basePath = rest[1];
  const manifestPath = rest[2];
  const diskPath = rest[3];
  const seedPath = rest[4];
  const arch = extractFlagValue(rest, "--arch");
  const diskSizeRaw = extractFlagValue(rest, "--disk-size");
  const qemuImg = extractFlagValue(rest, "--qemu-img");
  if (!recipePath || !basePath || !manifestPath || !diskPath || !seedPath
      || (arch !== "amd64" && arch !== "arm64") || !diskSizeRaw || !qemuImg) {
    console.error("usage: flagship-build appliance-provision <recipe.json> <base.raw> <manifest.json> <disk.qcow2> <seed.img> --arch amd64|arm64 --disk-size <bytes> --qemu-img <path>");
    process.exit(2);
  }
  const diskSize = Number(diskSizeRaw);
  if (!Number.isSafeInteger(diskSize) || diskSize <= 0) throw new Error("invalid --disk-size");

  const loaded = await loadRecipe(recipePath);
  const recipe = await readFile(recipePath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ApplianceBaseManifest;
  if (manifest.version !== 1 || (manifest.arch !== "amd64" && manifest.arch !== "arm64")
      || !/^[0-9a-f]{64}$/.test(manifest.sha256)
      || !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0
      || !Number.isSafeInteger(manifest.virtualSizeBytes)
      || manifest.virtualSizeBytes < manifest.sizeBytes) {
    throw new Error("prebuilt appliance manifest is malformed or unsupported");
  }
  if (manifest.arch !== arch) throw new Error(`prebuilt appliance is ${manifest.arch}; this host needs ${arch}`);
  if (manifest.installerGitRef !== loaded.blob.installerGitRef) {
    throw new Error(`prebuilt appliance contains installer ref ${manifest.installerGitRef}; recipe requires ${loaded.blob.installerGitRef}`);
  }
  const baseStat = await stat(basePath);
  if (baseStat.size !== manifest.sizeBytes) {
    throw new Error(`prebuilt appliance size mismatch: manifest=${manifest.sizeBytes} actual=${baseStat.size}`);
  }
  if (diskSize < manifest.virtualSizeBytes) {
    throw new Error(`hosted disk is too small: image needs ${manifest.virtualSizeBytes}; configured=${diskSize}`);
  }
  const baseHasher = createHash("sha256");
  for await (const chunk of createReadStream(basePath)) baseHasher.update(chunk);
  const got = baseHasher.digest("hex");
  if (got !== manifest.sha256) throw new Error(`prebuilt appliance checksum mismatch: expected=${manifest.sha256} got=${got}`);

  const bootstrap = buildBootstrapFromRecipe(recipe.toString("utf8"), JSON.stringify({
    installerGitRef: loaded.blob.installerGitRef,
    encryptRoot: loaded.blob.diskEncryption !== "none",
  }));
  const seed = encodeApplianceSeed(recipe, bootstrap);
  await writeFile(seedPath, seed, { mode: 0o600, flag: "wx" });
  try {
    await promisify(execFile)(qemuImg, [
      "create", "-f", "qcow2", "-F", "raw", "-b", resolve(basePath),
      diskPath, String(diskSize),
    ]);
    await chmod(diskPath, 0o600);
  } catch (error) {
    await unlink(seedPath).catch(() => undefined);
    throw error;
  }
  console.log(`verified prebuilt appliance sha256=${got} ref=${manifest.installerGitRef} arch=${arch}`);
  console.log(`created thin overlay: ${diskPath}`);
  console.log(`wrote one-use specialization seed: ${seedPath}`);
}

async function cmdApplianceFactoryIso(rest: string[]): Promise<void> {
  const input = rest[0];
  const output = rest[1];
  const gitRef = extractFlagValue(rest, "--git-ref");
  if (!input || !output || !gitRef) {
    console.error("usage: flagship-build appliance-factory-iso <debian.iso> <factory.iso> --git-ref <ref>");
    process.exit(2);
  }
  await remasterIsoWithPreseed({
    srcIsoPath: input,
    outIsoPath: output,
    preseedCfg: buildDebianApplianceFactoryPreseed(gitRef),
  });
  console.log(`wrote secret-free appliance factory ISO: ${output}`);
}

async function cmdApplianceCloudFactorySeed(rest: string[]): Promise<void> {
  const output = rest[0];
  const gitRef = extractFlagValue(rest, "--git-ref");
  if (!output || !gitRef) {
    console.error("usage: flagship-build appliance-cloud-factory-seed <seed.iso> --git-ref <ref>");
    process.exit(2);
  }
  await buildNocloudSeedIso({
    outIsoPath: output,
    userDataYaml: buildDebianCloudApplianceFactoryUserData(gitRef),
    networkConfigYaml: `version: 2
ethernets:
  factory:
    match:
      name: "en*"
    dhcp4: true
    dhcp6: true
    nameservers:
      addresses: [10.0.2.3]
`,
  });
  console.log(`wrote secret-free cloud appliance factory seed: ${output}`);
}

async function cmdApplianceManifest(rest: string[]): Promise<void> {
  const basePath = rest[0];
  const output = rest[1];
  const arch = extractFlagValue(rest, "--arch");
  const gitRef = extractFlagValue(rest, "--git-ref");
  if (!basePath || !output || (arch !== "amd64" && arch !== "arm64") || !gitRef) {
    console.error("usage: flagship-build appliance-manifest <base.raw> <manifest.json> --arch amd64|arm64 --git-ref <ref>");
    process.exit(2);
  }
  const info = await stat(basePath);
  const hasher = createHash("sha256");
  for await (const chunk of createReadStream(basePath)) hasher.update(chunk);
  const manifest: ApplianceBaseManifest = {
    version: 1,
    arch,
    installerGitRef: gitRef,
    sha256: hasher.digest("hex"),
    sizeBytes: info.size,
    virtualSizeBytes: info.size,
  };
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644, flag: "wx" });
  console.log(`wrote appliance manifest: ${output}`);
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
      "usage: flagship-build write <recipe.json> <iso-path> [--device /dev/diskN|auto] [--yes] [--keep-recipe]",
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
      "usage: flagship-build write-image <image.iso> [--device /dev/diskN|auto] [--yes]",
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

/**
 * DEBUG-ONLY: resolve the dev SSH public key that turns the image into a
 * remote-access-only diagnostic box (sshd + this key on the `flagship` user,
 * NO provisioning, NO LUKS re-key — see userdata.ts buildBootstrapScriptDebug).
 * `--debug-ssh-key-file <path>` reads the key from a file (the usual case — a
 * public key has spaces); `--debug-ssh-key "<key>"` takes it inline. Absent ⇒
 * undefined ⇒ the normal production bootstrap (byte-identical to before). This
 * is a bring-up/diagnosis mechanism, never a user-facing GUI feature.
 */
async function resolveDebugSshKey(rest: string[]): Promise<string | undefined> {
  const file = extractFlagValue(rest, "--debug-ssh-key-file");
  if (file) {
    const key = (await readFile(file, "utf8")).trim();
    if (!key) throw new Error(`--debug-ssh-key-file ${file} is empty`);
    return key;
  }
  const inline = extractFlagValue(rest, "--debug-ssh-key");
  return inline && inline.trim() ? inline.trim() : undefined;
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
  // GUI hosts (the desktop apps) drive this as a subprocess and render a native
  // cover. `--emit-events` prints one machine-readable `FLAGSHIP_PAIR <json>`
  // line per milestone on stdout (alongside the human logs, which they ignore).
  const emitEvents = rest.includes("--emit-events");
  await runPair({
    ...(host ? { host } : {}),
    ...(out ? { out } : {}),
    insecure: rest.includes("--insecure"),
    debug: rest.includes("--debug"),
    ...(emitEvents
      ? { emitEvents: (ev) => process.stdout.write(`FLAGSHIP_PAIR ${JSON.stringify(ev)}\n`) }
      : {}),
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
  console.log(`flagship-build — flash a Flagship install onto a USB drive

usage:
  (a recipe arg of "-" reads the JSON from stdin: pbpaste | flagship-build verify -)
  flagship-build verify <recipe.json|->                     verify the signed blob
  flagship-build verify-iso <path>                          check ISO against pinned distros
  flagship-build user-data <recipe.json|-> <out>            emit the unattended install config
                                                           (Ubuntu autoinstall by default; --debian for a d-i preseed)
                                                           (auto-shreds recipe; pass --keep-recipe to skip)
  flagship-build prepare <recipe.json|-> <iso> <out.iso>    bake a flashable unattended ISO
                                                           (auto-detects Ubuntu vs Debian; --family to force)
  flagship-build appliance-provision <recipe> <base.raw> <manifest.json> <disk.qcow2> <seed.img>
                                                           verify + create a thin hosted-VM specialization
                                                           [--arch amd64|arm64] [--disk-size bytes] [--qemu-img path]
  flagship-build appliance-factory-iso <debian.iso> <factory.iso> --git-ref <ref>
                                                           build the secret-free generalized-base installer
  flagship-build appliance-cloud-factory-seed <seed.iso> --git-ref <ref>
                                                           convert an official Debian cloud disk into the encrypted base
  flagship-build appliance-manifest <base.raw> <manifest.json> --arch <arch> --git-ref <ref>
                                                           hash + describe a completed generalized raw disk
  flagship-build write <recipe.json> <iso>                  prepare + raw-write to a USB device
                                                           [--device /dev/diskN | auto] [--yes] [--keep-recipe]
                                                           (needs sudo; interactive picker if no --device)
  flagship-build write-image <image.iso>                    raw-write an already-prepared image
                                                           [--device /dev/diskN | auto] [--yes]
                                                           (needs sudo; pairs with prepare)
  flagship-build pair                                       pair with your phone (shows a QR + code),
                                                           receive + verify the recipe over the live relay
                                                           [--out <recipe.json>] [--host <control-host>] [--debug]
                                                           [--emit-events: machine-readable milestones for GUI hosts]
                                                           (--debug = Advanced: request an owner-signed debug-access
                                                            grant; you approve it on your phone with Face ID, and the
                                                            box enables a debug console user only after verifying it)
  flagship-build distros                                    list supported distros

Wi-Fi (for a target box with no Ethernet) — pass to user-data/prepare/write:
  --wifi-ssid <name> --wifi-password <pass>   bake netplan Wi-Fi into the image
  (a burn-time local input; NEVER part of the signed recipe)

Debug remote-access image (bring-up / diagnosis only) — pass to user-data/prepare:
  --debug-ssh-key-file <path> | --debug-ssh-key "<pubkey>"
  Bakes sshd + this key on the 'flagship' user and does NOTHING ELSE — no
  provisioning, no LUKS re-key — so a first-boot that never registers is still
  reachable to diagnose (ssh flagship@<box>). NOT a production/user feature.

The recipe is the signed JSON the website produces after you scan the
QR code with your phone. Bring it here — the Builder verifies the
phone's signature locally and never phones home to flagshipserver.com.

\`write\` requires root (raw block-device access). macOS + Linux only.`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
