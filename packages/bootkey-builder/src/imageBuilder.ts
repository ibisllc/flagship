import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { BuildPlan } from "./buildPlan.js";
import { nixosConfigFiles } from "./nixos.js";

const execFileAsync = promisify(execFile);

export interface BuildArtifacts {
  outDir: string;
  rootfsDir: string;
  planJsonPath: string;
  configFilePaths: string[];
  /** Path the eventual disk image would be written to (created only if mkosi runs). */
  diskImagePath: string;
}

export type ImageBuildResult =
  | { ok: true; diskImagePath: string }
  | { ok: false; reason: "mkosi-not-installed"; rootfsDir: string }
  | { ok: false; reason: "mkosi-failed"; stderr: string };

/**
 * v0: materializes the BuildPlan as a directory tree (rootfs config + plan.json).
 *
 * v1 will shell out to `mkosi` or `debootstrap` against this rootfs to produce
 * an actual bootable disk.img. The interface here is stable: callers feed in a
 * BuildPlan and get back artifacts that the next step can consume.
 */
export async function materializePlan(plan: BuildPlan, outDir: string): Promise<BuildArtifacts> {
  const root = resolve(outDir);
  const rootfs = resolve(root, "rootfs");
  await mkdir(root, { recursive: true });
  await mkdir(rootfs, { recursive: true });

  const planJsonPath = resolve(root, "build-plan.json");
  await writeFile(planJsonPath, serializePlan(plan));

  const allFiles = [...plan.configFiles, ...nixosConfigFiles(plan)];
  const configFilePaths: string[] = [];
  for (const cf of allFiles) {
    const target = resolve(rootfs, "." + cf.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, cf.content, { mode: cf.mode ?? 0o644 });
    configFilePaths.push(target);
  }

  const diskImagePath = resolve(root, "disk.img");
  return { outDir: root, rootfsDir: rootfs, planJsonPath, configFilePaths, diskImagePath };
}

/**
 * Invokes mkosi against the materialized rootfs tree to produce a bootable
 * `disk.img`. Gracefully degrades when mkosi is not installed: the rootfs
 * tree itself remains the artifact.
 */
export async function invokeMkosi(artifacts: BuildArtifacts): Promise<ImageBuildResult> {
  try {
    await execFileAsync("mkosi", ["--version"]);
  } catch {
    return { ok: false, reason: "mkosi-not-installed", rootfsDir: artifacts.rootfsDir };
  }
  try {
    await execFileAsync(
      "mkosi",
      [
        "--distribution=nixos",
        `--root-directory=${artifacts.rootfsDir}`,
        `--output=${artifacts.diskImagePath}`,
      ],
      { maxBuffer: 100 * 1024 * 1024 },
    );
    return { ok: true, diskImagePath: artifacts.diskImagePath };
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? String(e);
    return { ok: false, reason: "mkosi-failed", stderr };
  }
}

function serializePlan(plan: BuildPlan): string {
  return (
    JSON.stringify(
      {
        spec: {
          ...plan.spec,
          irkPublicKey: bytesToHex(plan.spec.irkPublicKey),
          bakPublicKey: bytesToHex(plan.spec.bakPublicKey),
          swkProvisioningTokenHash: bytesToHex(plan.spec.swkProvisioningTokenHash),
        },
        partitions: plan.partitions,
        initramfsModules: plan.initramfsModules,
        systemdUnits: plan.systemdUnits,
        configFiles: plan.configFiles.map((c) => ({
          path: c.path,
          mode: c.mode ?? 0o644,
          bytes: c.content.length,
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
