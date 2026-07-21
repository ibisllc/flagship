/**
 * Engine entry — the ONE function the native builders (macOS/iOS JavaScriptCore,
 * Android Rhino) call to turn a signed recipe + burn options into the unattended
 * install config. It runs the SAME canonical generator (`buildDebianPreseed` /
 * `buildAutoinstallUserData`) as the Node CLI, so there is exactly ONE
 * implementation of this security-critical, signed-bootstrap path — no Swift /
 * Kotlin re-implementation to drift. The output is proven byte-identical across
 * Node + JSC + Rhino against shared golden vectors (tests/preseedEngine.test.ts +
 * the per-platform engine tests).
 *
 * IMPORTANT — this does NOT verify the recipe signature. Verification stays on
 * the native side (each builder already verifies the phone's signature with its
 * native crypto before it ever calls here), which keeps this bundle pure
 * ECMAScript — no @noble/BigInt crypto, no Node — so it runs unchanged on every
 * engine. We only PARSE (hex→bytes) + GENERATE.
 *
 * `installAsEngineGlobal()` attaches the API to `globalThis.FlagshipPreseed` so a
 * bare JSContext / Rhino scope (which has no module loader) can reach it after
 * evaluating the bundle.
 */
import { parseInstallBlob } from "./installBlobParse.js";
import type { LoadedBlob } from "./loadBlob.js";
import { buildDebianPreseed } from "./preseed.js";
import {
  buildAutoinstallUserData,
  buildBootstrapScript,
  resolveBootstrapInputs,
  type UserDataOptions,
} from "./userdata.js";

/** Burn-time options the recipe doesn't carry (Wi-Fi is never in the recipe). */
export interface EngineBurnOptions {
  /** LUKS root (default true). false is the internal plaintext debug escape. */
  encryptRoot?: boolean;
  wifiSSID?: string;
  wifiPassword?: string;
  installerGitRef?: string;
  flagshipRepoUrl?: string;
  bootHost?: string;
}

/** Parse a recipe JSON (envelope or flattened) into generator options, WITHOUT
 *  verifying the signature (the native caller already did). Mirrors the sibling
 *  extraction in loadBlobFromString so the engine path is byte-identical to the
 *  CLI path. Throws on a structurally invalid blob. */
export function optionsFromRecipeJson(recipeJson: string, burn: EngineBurnOptions = {}): UserDataOptions {
  const parsed = JSON.parse(recipeJson) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") throw new Error("recipe is not an object");

  const siblings = readSiblings(parsed);

  // Accept both the issued envelope { blob, blobSignature } and the flattened recipe.
  let obj = parsed;
  if (parsed.blob && typeof parsed.blob === "object" && typeof parsed.blobSignature === "string") {
    obj = { ...(parsed.blob as Record<string, unknown>), blobSignatureHex: parsed.blobSignature };
  }
  const sigHex = obj.blobSignatureHex;
  if (typeof sigHex !== "string") throw new Error("missing blobSignatureHex");
  const blob = parseInstallBlob(obj);
  if (!blob) throw new Error("InstallBlob fields incomplete/malformed");

  return {
    blob,
    blobSignatureHex: sigHex,
    ...(siblings.pairingOrder ? { pairingOrder: siblings.pairingOrder } : {}),
    ...(siblings.swkHex ? { swkHex: siblings.swkHex } : {}),
    ...(siblings.debugGrant ? { debugGrant: siblings.debugGrant } : {}),
    ...(burn.encryptRoot !== undefined ? { encryptRoot: burn.encryptRoot } : {}),
    ...(burn.wifiSSID ? { wifiSSID: burn.wifiSSID } : {}),
    ...(burn.wifiPassword ? { wifiPassword: burn.wifiPassword } : {}),
    ...(burn.installerGitRef ? { installerGitRef: burn.installerGitRef } : {}),
    ...(burn.flagshipRepoUrl ? { flagshipRepoUrl: burn.flagshipRepoUrl } : {}),
    ...(burn.bootHost ? { bootHost: burn.bootHost } : {}),
  };
}

function readSiblings(parsed: Record<string, unknown>): Pick<LoadedBlob, "pairingOrder" | "swkHex" | "debugGrant"> {
  const asStr = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : v && typeof v === "object" ? JSON.stringify(v) : undefined;
  const rawSwk = parsed.swkHex;
  return {
    pairingOrder: asStr(parsed.pairingOrder),
    swkHex: typeof rawSwk === "string" && /^[0-9a-f]{64}$/i.test(rawSwk) ? rawSwk.toLowerCase() : undefined,
    debugGrant: asStr(parsed.debugGrant),
  };
}

/** Debian d-i preseed.cfg from a signed recipe + burn options (both JSON strings). */
export function buildPreseedFromRecipe(recipeJson: string, burnOptsJson?: string): string {
  return buildDebianPreseed(optionsFromRecipeJson(recipeJson, parseBurn(burnOptsJson)));
}

/** Ubuntu autoinstall user-data from a signed recipe + burn options. */
export function buildUserDataFromRecipe(recipeJson: string, burnOptsJson?: string): string {
  return buildAutoinstallUserData(optionsFromRecipeJson(recipeJson, parseBurn(burnOptsJson)));
}

/** Generate the per-owner half of appliance specialization. The generalized
 * image already contains packages + the built repository; first boot runs this
 * canonical bootstrap with FLAGSHIP_APPLIANCE_PREINSTALLED=1 so identity,
 * registration, LUKS re-key, initramfs unlock, and units cannot drift from the
 * installer path. */
export function buildBootstrapFromRecipe(recipeJson: string, burnOptsJson?: string): string {
  const opts = optionsFromRecipeJson(recipeJson, parseBurn(burnOptsJson));
  const { ref, repo, bootHost, encryptRoot, bootUnlockMode } = resolveBootstrapInputs(opts);
  return buildBootstrapScript({
    ref,
    repoUrl: repo,
    encryptRoot,
    bootUnlockMode,
    bootHost,
    family: "debian",
    wifiSSID: opts.wifiSSID,
    wifiPassword: opts.wifiPassword,
    debugSshAuthorizedKey: opts.debugSshAuthorizedKey,
  });
}

function parseBurn(json?: string): EngineBurnOptions {
  if (!json) return {};
  const o = JSON.parse(json) as EngineBurnOptions;
  return o && typeof o === "object" ? o : {};
}

/**
 * Attach the engine API to the global scope so a bare JSContext / Rhino scope
 * (no module loader) can call it after evaluating the bundle, e.g.
 *   FlagshipPreseed.buildPreseedFromRecipe(recipeJson, burnOptsJson)
 */
export function installAsEngineGlobal(): void {
  const g = globalThis as unknown as { FlagshipPreseed?: unknown };
  g.FlagshipPreseed = {
    buildPreseedFromRecipe,
    buildUserDataFromRecipe,
    buildBootstrapFromRecipe,
    version: 2,
  };
}

// Auto-install when this module is the bundle entry (esbuild builds it directly).
installAsEngineGlobal();
