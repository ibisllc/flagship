/**
 * Deploy a VibeCodeSession's parsed manifest + source files into a
 * running app.
 *
 * Flow:
 *   1. Pull the manifest JSON + source files out of the session.
 *   2. Write the source tree to disk under <workingDir>/<appId>/.
 *   3. (Optional) Push the tree to the per-app Forgejo repo so the
 *      user can browse/review/revert the LLM's commits via the
 *      existing /apps/:appId/git/* surface. First deploy creates the
 *      repo; subsequent deploys add a commit on top.
 *   4. Run `docker build -t flagship-vibe-<appId>:<revision> <workingDir>`
 *      to produce a local image. The image ref replaces the manifest's
 *      runtime.image so AppPlatform.install hands the right tag to
 *      AppRunner.
 *   5. Construct + sign an InstallAppRequest with the host's IRK
 *      (vibe-coded apps are always self-authored on the calling pod's
 *      host — creator === username).
 *   6. Call AppPlatform.install.
 *   7. Return the canonical URL the app will live at.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  signInstallApp,
  verifyInstallApp,
  type InstallAppRequest,
  type Keypair,
} from "@flagship/protocol";
import type { CommandRunner } from "../appRunner.js";
import type { AppPlatform } from "../appPlatform.js";
import type { ForgejoAppAdmin } from "../forgejoAppAdmin.js";
import type { VibeCodeSession } from "./vibeCodeSession.js";

export interface DeploySessionDeps {
  appPlatform: AppPlatform;
  /** The host's IRK keypair — signs the InstallAppRequest. */
  hostIrk: Keypair;
  /** Daemon username (the creator/host of vibe-coded apps). */
  hostUsername: string;
  /**
   * Where to write source trees + run docker build. Each app gets a
   * subdirectory `<workingDir>/<appId>/`.
   */
  workingDir: string;
  /**
   * Command runner for `docker build`. Defaults to the same real
   * runner AppRunner uses; tests inject a mock.
   */
  cmd: CommandRunner;
  /**
   * When set, the deploy step ensures a per-app repo exists in Forgejo
   * and commits the session's files before docker build. When null
   * (e.g. dev environments without Forgejo provisioned), the source
   * tree only lives on disk — useful for tests and minimal dev runs.
   */
  forgejoAdmin?: ForgejoAppAdmin | null;
  /** Override for tests / observability. */
  now?: () => number;
}

export type DeployResult =
  | { ok: true; appId: string; url: string; image: string }
  | { ok: false; reason: string };

export function buildDeploySession(deps: DeploySessionDeps) {
  const now = deps.now ?? (() => Date.now());

  return async function deploy(session: VibeCodeSession): Promise<DeployResult> {
    const files = session.files();
    const manifestJson = files["flagship.app.json"];
    if (!manifestJson) {
      return { ok: false, reason: "session has no flagship.app.json" };
    }
    let manifest: { name?: unknown; runtime?: { image?: unknown } };
    try {
      manifest = JSON.parse(manifestJson);
    } catch (e) {
      return { ok: false, reason: `manifest is not valid JSON: ${(e as Error).message}` };
    }
    if (typeof manifest.name !== "string" || !manifest.name) {
      return { ok: false, reason: "manifest.name missing" };
    }

    // Self-authored: creator is the host. Cross-creator vibe-coding
    // would need a different signing path (the original creator's IRK).
    const creator = deps.hostUsername;
    const slug = manifest.name;
    // Single-dash composite (creator is hyphen-free → unambiguous).
    // Kept inline rather than importing AppPlatform as a value just
    // for the static; the format is pinned by appPlatform.appId +
    // its test.
    const appId = `${creator}-${slug}`;
    const appDir = join(deps.workingDir, appId);

    // 1. Write the source tree. We blow away any prior working tree
    // so a re-deploy is reproducible.
    try {
      await rm(appDir, { recursive: true, force: true });
      await mkdir(appDir, { recursive: true });
      for (const [path, content] of Object.entries(files)) {
        if (path.includes("..") || path.startsWith("/")) {
          return { ok: false, reason: `unsafe path in session files: ${path}` };
        }
        const full = join(appDir, path);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content, "utf8");
      }
    } catch (e) {
      return { ok: false, reason: `failed to write source tree: ${(e as Error).message}` };
    }

    const revision = String(now());

    // 2. Push to Forgejo so the user can browse/review/revert the
    // LLM's output through the existing /apps/:appId/git/* surface.
    // First deploy creates the repo (idempotent). Subsequent deploys
    // add a commit on top — commitFiles infers create/update per file
    // from the live tree.
    if (deps.forgejoAdmin) {
      try {
        await deps.forgejoAdmin.createRepo(slug, {
          description: `Vibe-coded Flagship app: ${slug}`,
        });
        const repoFiles = Object.entries(files).map(([path, content]) => ({
          path,
          content,
        }));
        await deps.forgejoAdmin.commitFiles(
          slug,
          repoFiles,
          `deploy ${slug} @ ${revision}`,
        );
      } catch (e) {
        return { ok: false, reason: `forgejo push failed: ${(e as Error).message}` };
      }
    }

    // 3. Build the image. Tag includes a per-deploy revision so
    // re-deploys produce a fresh tag (avoids stale cached images on
    // restart).
    const image = `flagship-vibe-${appId}:${revision}`.toLowerCase();
    try {
      await deps.cmd.run("docker", ["build", "-t", image, appDir]);
    } catch (e) {
      return { ok: false, reason: `docker build failed: ${(e as Error).message}` };
    }

    // 4. Update the manifest's runtime.image to our local tag. The
    // LLM may have emitted a placeholder ref it doesn't actually have
    // permission to push to.
    const patchedManifestJson = JSON.stringify(
      { ...manifest, runtime: { ...(manifest as { runtime?: object }).runtime ?? {}, image } },
    );

    // 5. Build + sign the InstallAppRequest.
    const request: InstallAppRequest = {
      serverId: session.meta.serverFqdn,
      creator,
      slug,
      manifestJson: patchedManifestJson,
      addOwnerToMembership: true,
      issuedAt: now(),
    };
    const signature = signInstallApp(request, deps.hostIrk);

    // 6. Install via AppPlatform — provisions data, mints token,
    // deploys the container. Owner-set env vars (if any) are applied
    // via a separate signed set-app-env order and injected into the
    // container's process env on deploy; they are NOT part of this
    // signed install envelope.
    const installResult = await deps.appPlatform.install({
      request,
      signature,
      verify: verifyInstallApp,
    });
    if (!installResult.ok) {
      return { ok: false, reason: `install rejected: ${installResult.reason}` };
    }

    // 7. Compose the canonical URL. AppPlatform exposes urlLabel via
    // its static helper; we rebuild it here to avoid coupling.
    const urlLabel = creator === deps.hostUsername ? slug : `${slug}-${creator}`;
    const url = `https://${urlLabel}.${session.meta.serverFqdn}`;
    return { ok: true, appId, url, image };
  };
}
