// The claim service inside the daemon (docs/retail-box-setup.md §7, §15). It runs only on a retail
// image (the marker in wipe.ts), never on a VM appliance or a USB install.
//
// An unclaimed or locked retail box runs the claim service and nothing else: no owner, no apps, no
// tunnel. A claimed one runs as any box, with the claim service beside it for the 5-press reset
// window and "Release this box".
//
// Claim state lives outside the owner's data volume (RETAIL_STATE_DIR), so it outlasts the wipe.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { writeFileDurable } from "../durableFile.js";
import { runSetupStep, runsUnprivileged } from "../privileged.js";
import { localCommandRunner, type CommandRunner } from "../serviceRunner.js";
import { BLUEZ_FRESH_IDENTITY_DROP_IN, BLUEZ_FRESH_IDENTITY_DROP_IN_PATH, BLUEZ_MAIN_CONF, BLUEZ_MAIN_CONF_PATH, BluezPeripheral } from "./bluez.js";
import { ClaimStateStore, type ClaimLifecycle } from "./claimState.js";
import { RetailClaimService, type ClaimEvent, type ClaimIdentity } from "./claimService.js";
import { ConsoleCodeDisplay, type CodeDisplay } from "./codeDisplay.js";
import { DbusConnection } from "./dbus.js";
import { connectAndDiagnose, systemNetworkProbes } from "./network.js";
import { EvdevPowerKeySource, ensureLogindPowerKeyIgnored, type PowerKeySource } from "./powerKey.js";
import { verifyClaimRecipe } from "./recipe.js";
import { defaultEntropyReader } from "./rngGate.js";
import { SetupCodeStore } from "./setupCode.js";
import { httpMailboxClient, type ClaimPeripheral } from "./transport.js";
import { retailWipeAsRoot, type RetailImage, type RetailWipeResult } from "./wipe.js";

export const RETAIL_STATE_DIR = "/var/lib/flagship-retail";

export function retailPaths(dir = RETAIL_STATE_DIR) {
  return {
    state: join(dir, "claim-state.json"),
    marker: join(dir, "reset-marker.json"),
    code: join(dir, "setup-code.json"),
    release: join(dir, "box-release.json"),
    recipe: join(dir, "claimed-recipe.json"),
  };
}

export async function retailLifecycle(dir = RETAIL_STATE_DIR): Promise<ClaimLifecycle> {
  const p = retailPaths(dir);
  return (await new ClaimStateStore(p.state, p.marker).load()).lifecycle;
}

/**
 * The host settings a retail box needs from its first boot: logind ignores short presses of the
 * power key, and bluetoothd runs LE-only with a private address and no hostname. The image ships
 * them; this puts them back if they went missing (root only; a daemon without root leaves them).
 */
export async function ensureRetailHostConfig(log: (m: string) => void, cmd: CommandRunner = localCommandRunner): Promise<void> {
  if (runsUnprivileged() || process.getuid?.() !== 0) return;
  await ensureLogindPowerKeyIgnored(cmd, { log }).catch((e) => log(`[retail] logind drop-in: ${(e as Error).message}`));
  let changed = false;
  for (const [path, text] of [
    [BLUEZ_MAIN_CONF_PATH, BLUEZ_MAIN_CONF],
    [BLUEZ_FRESH_IDENTITY_DROP_IN_PATH, BLUEZ_FRESH_IDENTITY_DROP_IN],
  ] as const) {
    if ((await readFile(path, "utf8").catch(() => null)) === text) continue;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, text, { mode: 0o644 });
      changed = true;
    } catch (e) {
      log(`[retail] ${path}: ${(e as Error).message}`);
    }
  }
  if (!changed) return;
  await cmd.run("systemctl", ["daemon-reload"]).catch(() => {});
  await cmd.run("systemctl", ["restart", "bluetooth"]).catch((e) => log(`[retail] restart bluetooth: ${(e as Error).message}`));
}

/** A radio that never advertises: a box whose Bluetooth is missing can still be claimed by setup code. */
export const silentPeripheral: ClaimPeripheral = { advertise: async () => {}, stop: async () => {}, onLink: () => {} };

export async function bluezPeripheral(log: (m: string) => void): Promise<ClaimPeripheral> {
  try {
    const bus = await DbusConnection.connect();
    return new BluezPeripheral({ bus, log });
  } catch (e) {
    log(`[retail] no system bus for Bluetooth (${(e as Error).message}); claims by setup code only`);
    return silentPeripheral;
  }
}

/** The wipe, as root (the box still runs as root before privd is in) or through the root step. */
export async function retailWipe(image: RetailImage, dir = RETAIL_STATE_DIR, log: (m: string) => void = () => {}): Promise<void> {
  let r: RetailWipeResult | null;
  if (runsUnprivileged()) {
    r = await runSetupStep<RetailWipeResult>("retail-wipe");
  } else {
    r = await retailWipeAsRoot({
      image,
      markerPresent: existsSync(retailPaths(dir).marker),
      run: async (c, a) => (await localCommandRunner.capture!(c, a, { timeoutMs: 5 * 60_000 })).stdout,
      log,
    });
  }
  if (!r?.erased) throw new Error("the wipe did not finish");
}

/**
 * What a claimed retail box does with its recipe. The retail first-boot step that formats a fresh
 * data volume under the new owner's key and runs the bootstrap in its preinstalled mode is part of
 * the retail image (not built: docs/retail-box-setup.md §13.3 item 10); the daemon hands it the
 * recipe and restarts into it.
 */
export async function retailProvision(recipeText: string, dir: string, restart: () => Promise<void>, log: (m: string) => void): Promise<void> {
  await writeFileDurable(retailPaths(dir).recipe, recipeText, 0o600);
  log("[retail] claimed: restarting into the new owner's first boot");
  setTimeout(() => void restart().catch((e) => log(`[retail] restart failed: ${(e as Error).message}`)), 3_000);
}

export interface RetailClaimOptions {
  image: RetailImage;
  dir?: string;
  bootAt?: number;
  controlPlaneBaseUrl: string;
  relayHost?: string;
  identity: () => Promise<ClaimIdentity>;
  restart: () => Promise<void>;
  notify?: (e: ClaimEvent) => void;
  model?: string;
  imageVersion?: string;
  peripheral?: ClaimPeripheral;
  keys?: PowerKeySource;
  display?: CodeDisplay;
  cmd?: CommandRunner;
  log?: (m: string) => void;
}

export async function startRetailClaim(o: RetailClaimOptions): Promise<RetailClaimService> {
  const log = o.log ?? ((m: string) => console.log(m));
  const dir = o.dir ?? RETAIL_STATE_DIR;
  const p = retailPaths(dir);
  const control = new URL(o.controlPlaneBaseUrl).host;
  const relay = o.relayHost ?? "flagship.services";
  const probes = systemNetworkProbes(o.cmd ?? localCommandRunner, { control, relay });
  const svc = new RetailClaimService({
    now: () => Date.now(),
    bootAt: o.bootAt ?? Date.now() - Math.round(process.uptime() * 1000),
    store: new ClaimStateStore(p.state, p.marker),
    codes: new SetupCodeStore(p.code, log),
    peripheral: o.peripheral ?? (await bluezPeripheral(log)),
    keys: o.keys ?? new EvdevPowerKeySource({ log }),
    display: o.display ?? new ConsoleCodeDisplay({ apex: control }),
    mailbox: httpMailboxClient(o.controlPlaneBaseUrl),
    entropy: defaultEntropyReader,
    verifyRecipe: verifyClaimRecipe,
    createIdentity: () => o.identity(),
    wipe: () => retailWipe(o.image, dir, log),
    network: { scan: () => probes.scanWifi(), connect: (wifi) => connectAndDiagnose(probes, wifi, { control, relay }) },
    provision: (text) => retailProvision(text, dir, o.restart, log),
    ...(o.notify ? { notify: o.notify } : {}),
    model: o.model ?? "Flagship box",
    imageVersion: o.imageVersion ?? "0.4",
    log,
  });
  await svc.start();
  return svc;
}
