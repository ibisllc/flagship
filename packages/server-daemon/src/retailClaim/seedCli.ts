// `node seedCli.js <claimed recipe> <preseed engine>`: prints the specializer's seed for a claimed
// retail box (firstBoot.ts). Run as root by the appliance specializer on the retail first boot.

import { readFileSync } from "node:fs";
import { retailSeedFromRecipe } from "./firstBoot.js";

const [recipePath, enginePath] = process.argv.slice(2);
if (!recipePath || !enginePath) {
  console.error("usage: seedCli <claimed recipe> <preseed engine>");
  process.exit(2);
}
try {
  process.stdout.write(JSON.stringify(retailSeedFromRecipe(readFileSync(recipePath, "utf8"), readFileSync(enginePath, "utf8"))) + "\n");
} catch (e) {
  console.error(`[retail] could not make the first-boot seed: ${(e as Error).message}`);
  process.exit(1);
}
