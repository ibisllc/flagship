// flagship-claim.service: the claim service of a retail box with no owner yet (docs/retail-box-setup.md
// §16), unprivileged. It runs as `flagship-claim` with the BlueZ calls the D-Bus policy allows, the
// power button's event nodes and keyd's socket, and nothing else. Its two root steps (the wipe, the
// restart into a claim's first boot) go to the claim helper, flagship-privd in its retail-claim
// profile, which checks each step's preconditions again (setup.ts). The box's daemon takes over once a
// claim's first boot has finished (firstBoot.ts retailBootMode).

import { existsSync } from "node:fs";
import { KeydCustodian } from "../keydCustodian.js";
import { runSetupStep, runsUnprivileged } from "../privileged.js";
import { RETAIL_STATE_DIR, freshKeydIdentity, retailLifecycle, retailPaths, startRetailClaim } from "./daemon.js";
import { retailBootMode } from "./firstBoot.js";
import { readRetailImage } from "./wipe.js";

const log = (m: string) => console.log(m);

async function main(): Promise<void> {
  if (!runsUnprivileged()) {
    console.error("[retail] the claim service runs only unprivileged, with its helper (flagship-claim.service)");
    process.exit(2);
  }
  const image = await readRetailImage();
  if (!image) {
    log("[retail] not a retail image: nothing to claim");
    return;
  }
  if (retailBootMode(await retailLifecycle(), existsSync(retailPaths(RETAIL_STATE_DIR).firstBootDone)) === "serve") {
    log("[retail] this box has an owner: the daemon runs its claim service");
    return;
  }
  log(`[retail] this box has no owner yet: claim service as uid ${process.getuid?.()}`);
  const claim = await startRetailClaim({
    image,
    controlPlaneBaseUrl: process.env.FLAGSHIP_CONTROL_PLANE_BASE_URL ?? "https://flagshipserver.com",
    identity: () => freshKeydIdentity(() => new KeydCustodian({ socketPath: process.env.FLAGSHIP_KEYD_SOCKET ?? "/run/flagship-keyd/keyd.sock", component: "retail-claim" })),
    restart: async () => {
      await runSetupStep("retail-first-boot");
    },
    log,
  });
  const stop = () => void claim.stop().finally(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await new Promise<never>(() => {});
}

main().catch((e) => {
  console.error(`[retail] claim service: ${(e as Error).message}`);
  process.exit(1);
});
