// A retail box's first boot after a claim (docs/retail-box-setup.md §2, §16): the claim left the
// owner's recipe in the retail folder, and the appliance specializer (flagship-builder appliance.ts)
// turns it into a server exactly as it does a VM's seed disk. This makes that seed on the box, from
// the recipe and the release's own preseed engine (packages/flagship-builder/engine), so the
// bootstrap a retail box runs is the one every Studio and phone would have made from that recipe.
// The bootstrap then runs with FLAGSHIP_BOX_KEY_IN_KEYD=1: it keeps the key keyd made at first boot
// (the one the receipt named and the phone registered) and writes no key file.

import { createHash } from "node:crypto";
import vm from "node:vm";
import type { ClaimLifecycle } from "./claimState.js";

export interface RetailSeed {
  version: 1;
  recipeBase64: string;
  bootstrapBase64: string;
  recipeSha256: string;
}

interface Engine {
  buildBootstrapFromRecipe(recipeJson: string, burnOptsJson?: string): string;
  buildInstallBlobJsonFromRecipe(recipeJson: string): string;
}

/** The engine bundle in a bare context: ECMAScript built-ins only, as the Studios and phones run it. */
function loadEngine(engineSource: string): Engine {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(engineSource, sandbox, { filename: "preseed-engine.js", timeout: 30_000 });
  const api = (sandbox as { FlagshipPreseed?: Engine }).FlagshipPreseed;
  if (!api || typeof api.buildBootstrapFromRecipe !== "function" || typeof api.buildInstallBlobJsonFromRecipe !== "function") {
    throw new Error("the preseed engine did not load");
  }
  return api;
}

/** The specializer's seed (flagship-builder ApplianceSeedPayload) for a claimed recipe. */
export function retailSeedFromRecipe(recipeText: string, engineSource: string): RetailSeed {
  const engine = loadEngine(engineSource);
  const blob = engine.buildInstallBlobJsonFromRecipe(recipeText);
  const bootstrap = engine.buildBootstrapFromRecipe(recipeText, "{}");
  if (!blob || !bootstrap.startsWith("#!")) throw new Error("the engine made no bootstrap");
  const blobBytes = Buffer.from(blob, "utf8");
  return {
    version: 1,
    recipeBase64: blobBytes.toString("base64"),
    bootstrapBase64: Buffer.from(bootstrap, "utf8").toString("base64"),
    recipeSha256: createHash("sha256").update(blobBytes).digest("hex"),
  };
}

export type RetailBootMode = "claim-only" | "serve";

/**
 * What the daemon runs on a retail box. Until a claim has been through its first boot the box has no
 * owner configuration, so it runs the claim service alone (an unclaimed box, a locked one, or a
 * claimed one whose first boot has not finished: its 5-press reset still works). `first-boot-done`
 * lives in the retail folder, which a wipe empties, so a released box never serves its old setup.
 */
export function retailBootMode(lifecycle: ClaimLifecycle, firstBootDone: boolean): RetailBootMode {
  return lifecycle === "claimed" && firstBootDone ? "serve" : "claim-only";
}

/**
 * Why the claim helper must not restart the box into a first boot now, or null. The claim service
 * runs unprivileged and its folder is its own, so root checks everything it relies on again: a
 * retail image, a box the claim state calls claimed, no first boot done yet, and a claimed recipe
 * whose signature verifies under the account key it names (its expiry is `.com`'s to judge at
 * registration). Then the specializer, as root, runs only a recipe a real claim could have left.
 */
export function firstBootRestartRefusal(s: {
  retailImage: boolean;
  lifecycle: ClaimLifecycle;
  firstBootDone: boolean;
  recipeText: string | null;
  verify: (text: string) => boolean;
}): string | null {
  if (!s.retailImage) return "not a retail image";
  if (s.lifecycle !== "claimed") return "the box is not claimed";
  if (s.firstBootDone) return "the first boot already ran";
  if (!s.recipeText) return "no claimed recipe";
  if (!s.verify(s.recipeText)) return "the claimed recipe does not verify";
  return null;
}
