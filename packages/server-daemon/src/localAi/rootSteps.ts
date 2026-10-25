/**
 * Local AI's root steps: the models volume and a training job's output volume, through the
 * privileged helper's narrow `localai` host operation when the daemon runs unprivileged
 * (packages/privd/src/policy.ts `localAiHostExec`, the Rust broker's `local_ai_host`), or directly
 * when it runs as root.
 */
import { privd, runsUnprivileged } from "../privileged.js";
import type { CommandRunner } from "../serviceRunner.js";
import { modelFileName } from "./catalog.js";
import { MODELS_VOLUME, outVolume } from "./containers.js";
import type { ModelInstaller } from "./modelStore.js";

/** The installed models' folder and the training output's, as the engine keeps them. */
async function volumeDir(cmd: CommandRunner, volume: string): Promise<string> {
  await cmd.run("docker", ["volume", "create", volume]);
  if (!cmd.capture) throw new Error("the volume's folder is not available");
  const dir = (await cmd.capture("docker", ["volume", "inspect", "-f", "{{.Mountpoint}}", volume])).stdout.trim();
  if (!/^\/var\/lib\/(?:docker\/volumes|containers\/storage\/volumes)\/[A-Za-z0-9_.-]+\/_data$/.test(dir)) throw new Error("unexpected volume folder");
  return dir;
}

/**
 * Real installs: unprivileged, the broker's `localai model-install` (it copies the daemon's file
 * into its own folder, checks the digest there, installs it root-owned 0444); as root, the same
 * steps here.
 */
export function realModelInstaller(cmd: CommandRunner): ModelInstaller {
  return {
    async install(sha256, src) {
      const dir = await volumeDir(cmd, MODELS_VOLUME);
      if (runsUnprivileged()) {
        await privd().host("localai", ["model-install", sha256, dir]);
        return;
      }
      const { createHash } = await import("node:crypto");
      const { createReadStream } = await import("node:fs");
      const { copyFile, chmod, rename } = await import("node:fs/promises");
      const tmp = `${dir}/${modelFileName(sha256)}.partial`;
      await copyFile(src, tmp);
      const h = createHash("sha256");
      for await (const c of createReadStream(tmp)) h.update(c as Buffer);
      if (h.digest("hex") !== sha256) throw new Error("the copied model doesn't match its digest");
      await chmod(tmp, 0o444);
      await rename(tmp, `${dir}/${modelFileName(sha256)}`);
    },
    async remove(sha256) {
      const dir = await volumeDir(cmd, MODELS_VOLUME);
      if (runsUnprivileged()) {
        await privd().host("localai", ["model-remove", sha256, dir]);
        return;
      }
      const { rm } = await import("node:fs/promises");
      await rm(`${dir}/${modelFileName(sha256)}`, { force: true });
    },
  };
}

/** A training job's output volume, made and handed to the container's user. */
export async function prepareOutVolume(cmd: CommandRunner, hex: string): Promise<void> {
  const dir = await volumeDir(cmd, outVolume(hex));
  if (runsUnprivileged()) {
    await privd().host("localai", ["out-prepare", hex, dir]);
    return;
  }
  const { chown, chmod } = await import("node:fs/promises");
  await chown(dir, 10001, 10001);
  await chmod(dir, 0o700);
}
