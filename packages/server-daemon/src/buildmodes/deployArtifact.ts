/**
 * Deploy a build artifact — a `Record<path, content>` tree with a
 * top-level `flagship.app.json` — into a running app. This is the common
 * deploy primitive every build mode funnels through (scratch / git /
 * mcp), so the harness-only Forgejo push, docker build, signed install,
 * and URL composition happen in exactly ONE place.
 *
 * It is the mode-agnostic generalization of `llm/deploySession.ts`
 * (which deploys from a VibeCodeSession's parsed files); the logic is the
 * same — write the tree, push to per-app Forgejo (harness-only), docker
 * build, sign + install via ServicePlatform — but it takes a plain files
 * map so git and mcp builds reuse it verbatim.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  signInstallService,
  verifyInstallService,
  type InstallServiceRequest,
  type Keypair,
} from "@flagship/protocol";
import type { CommandRunner } from "../serviceRunner.js";
import type { ServicePlatform } from "../servicePlatform.js";
import type { ForgejoAppAdmin } from "../forgejoServiceAdmin.js";
import type { BuildJournal, BuildMode } from "./buildJournal.js";

export interface DeployArtifactDeps {
  servicePlatform: ServicePlatform;
  hostIrk: Keypair;
  hostUsername: string;
  workingDir: string;
  cmd: CommandRunner;
  /** Harness-only Forgejo push. Null in dev/test (tree stays on disk). */
  forgejoAdmin?: ForgejoAppAdmin | null;
  journal?: BuildJournal | null;
  now?: () => number;
}

export interface DeployArtifactArgs {
  files: Record<string, string>;
  serverFqdn: string;
  /** Journalled under this id when a journal is configured. */
  buildId?: string;
  /** The build mode, so deploy entries carry the correct mode. */
  mode?: BuildMode;
}

export type DeployResult =
  | { ok: true; serviceId: string; url: string; image: string }
  | { ok: false; reason: string };

export function buildArtifactDeployer(deps: DeployArtifactDeps) {
  const now = deps.now ?? (() => Date.now());

  async function note(
    buildId: string | undefined,
    mode: BuildMode,
    kind: "build-started" | "build-phase" | "deployed" | "error",
    summary: string,
    serviceId?: string,
  ) {
    if (!deps.journal || !buildId) return;
    await deps.journal.append(buildId, {
      mode,
      kind,
      actor: "system",
      summary,
      ...(serviceId != null ? { serviceId } : {}),
    });
  }

  return async function deploy(args: DeployArtifactArgs): Promise<DeployResult> {
    const { files, serverFqdn, buildId } = args;
    const mode: BuildMode = args.mode ?? "scratch";
    const manifestJson = files["flagship.app.json"];
    if (!manifestJson) return { ok: false, reason: "artifact has no flagship.app.json" };

    let manifest: { name?: unknown; runtime?: { image?: unknown } };
    try {
      manifest = JSON.parse(manifestJson);
    } catch (e) {
      return { ok: false, reason: `manifest is not valid JSON: ${(e as Error).message}` };
    }
    if (typeof manifest.name !== "string" || !manifest.name) {
      return { ok: false, reason: "manifest.name missing" };
    }

    const creator = deps.hostUsername;
    const slug = manifest.name;
    const serviceId = `${creator}-${slug}`;
    const appDir = join(deps.workingDir, serviceId);

    await note(buildId, mode, "build-started", `building ${slug}`);

    // 1. Write the source tree (reproducible: blow away any prior tree).
    try {
      await rm(appDir, { recursive: true, force: true });
      await mkdir(appDir, { recursive: true });
      for (const [path, content] of Object.entries(files)) {
        if (path.includes("..") || path.startsWith("/")) {
          return { ok: false, reason: `unsafe path in artifact files: ${path}` };
        }
        const full = join(appDir, path);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content, "utf8");
      }
    } catch (e) {
      return { ok: false, reason: `failed to write source tree: ${(e as Error).message}` };
    }

    const revision = String(now());

    // 2. Harness-only Forgejo push (browse/review/revert via the existing
    // /apps/:serviceId/git/* surface). EXTERNAL actors never push here —
    // they go through chat / git-import / mcp, and the harness materializes.
    if (deps.forgejoAdmin) {
      try {
        await deps.forgejoAdmin.createRepo(slug, { description: `Flagship app: ${slug}` });
        const repoFiles = Object.entries(files).map(([path, content]) => ({ path, content }));
        await deps.forgejoAdmin.commitFiles(slug, repoFiles, `deploy ${slug} @ ${revision}`);
      } catch (e) {
        return { ok: false, reason: `forgejo push failed: ${(e as Error).message}` };
      }
    }

    // 3. docker build.
    const image = `flagship-vibe-${serviceId}:${revision}`.toLowerCase();
    await note(buildId, mode, "build-phase", "docker build");
    try {
      await deps.cmd.run("docker", ["build", "-t", image, appDir]);
    } catch (e) {
      await note(buildId, mode, "error", `docker build failed`);
      return { ok: false, reason: `docker build failed: ${(e as Error).message}` };
    }

    // 4. Patch the manifest's runtime.image to our local tag.
    const patchedManifestJson = JSON.stringify({
      ...manifest,
      runtime: { ...((manifest as { runtime?: object }).runtime ?? {}), image },
    });

    // 5. Sign + install.
    const request: InstallServiceRequest = {
      serverId: serverFqdn,
      creator,
      slug,
      manifestJson: patchedManifestJson,
      addOwnerToMembership: true,
      issuedAt: now(),
    };
    const signature = signInstallService(request, deps.hostIrk);
    const installResult = await deps.servicePlatform.install({ request, signature, verify: verifyInstallService });
    if (!installResult.ok) {
      await note(buildId, mode, "error", `install rejected: ${installResult.reason}`);
      return { ok: false, reason: `install rejected: ${installResult.reason}` };
    }

    const urlLabel = creator === deps.hostUsername ? slug : `${slug}-${creator}`;
    const url = `https://${urlLabel}.${serverFqdn}`;
    await note(buildId, mode, "deployed", `live at ${url}`, serviceId);
    return { ok: true, serviceId, url, image };
  };
}
