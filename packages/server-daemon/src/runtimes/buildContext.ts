/**
 * Before any app build: when the app's manifest names a runtime, the box
 * writes the build itself into the (box-owned) context, replacing whatever
 * Dockerfile the app carried (docs/app-runtimes.md §6.2).
 */
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "@flagship/protocol";
import { runtimeBuildFile } from "./buildFile.js";
import type { RuntimeId } from "./catalog.js";

const OTHER_BUILD_FILES = ["dockerfile", "Containerfile", "containerfile", "Dockerfile.dockerignore"];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** The runtime the context was prepared for, or null when the app isn't a runtime app. */
export async function prepareRuntimeContext(contextDir: string): Promise<RuntimeId | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(contextDir, "flagship.app.json"), "utf8"));
  } catch {
    return null;
  }
  const parsed = parseManifest(raw);
  if (!parsed.ok || !parsed.manifest.runtime.base) return null;
  const rt = parsed.manifest.runtime;
  const build = runtimeBuildFile({
    base: rt.base!,
    port: rt.port,
    start: rt.start ?? null,
    ...(rt.root ? { root: rt.root } : {}),
    has: {
      packageJson: await exists(join(contextDir, "package.json")),
      packageLock: await exists(join(contextDir, "package-lock.json")),
      requirements: await exists(join(contextDir, "requirements.txt")),
    },
  });
  if (!build.ok) throw new Error(build.reason);
  for (const f of OTHER_BUILD_FILES) await rm(join(contextDir, f), { force: true });
  await writeFile(join(contextDir, "Dockerfile"), build.dockerfile);
  await writeFile(join(contextDir, ".dockerignore"), build.dockerignore);
  return rt.base!;
}
