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
 *
 * Split in two for AI builds (docs/ai-privacy-and-staging.md §2):
 * `buildAppImage` makes the image (staging.ts builds the AI's test copy
 * with it), and `buildArtifactPipeline(...).install` puts a build live with
 * an image built earlier, so what goes live is exactly what was tested.
 */

import { join } from "node:path";
import {
  verifyInstallService,
  type InstallServiceRequest,
} from "@flagship/protocol";
import { runDockerBuild, type CommandRunner } from "../serviceRunner.js";
import type { ServicePlatform } from "../servicePlatform.js";
import type { BoxSigner } from "../keyCustodian.js";
import type { ForgejoAppAdmin } from "../forgejoServiceAdmin.js";
import type { BuildJournal, BuildMode } from "./buildJournal.js";
import { migrationFiles, resolveDeployTarget, type NameHolders } from "../llm/serviceName.js";
import { writeSourceTree } from "../llm/serviceSource.js";

export interface DeployArtifactDeps {
  servicePlatform: ServicePlatform;
  /** Box-identity signer (custodian slice) for the InstallServiceRequest. */
  signer: Pick<BoxSigner, "signInstallService">;
  hostUsername: string;
  workingDir: string;
  cmd: CommandRunner;
  /** Harness-only Forgejo push. Null in dev/test (tree stays on disk). */
  forgejoAdmin?: ForgejoAppAdmin | null;
  journal?: BuildJournal | null;
  now?: () => number;
  /** Open AI-chat sessions, so a deploy never takes a name one holds. */
  registry?: NameHolders;
}

export interface DeployArtifactArgs {
  files: Record<string, string>;
  serverFqdn: string;
  /** Journalled under this id when a journal is configured. */
  buildId?: string;
  /** The build mode, so deploy entries carry the correct mode. */
  mode?: BuildMode;
  /** The installed service this build edits; it is replaced in place. */
  editsServiceId?: string;
  /** The name the build was given; it wins over the manifest's. */
  name?: string;
  /** Non-text files (images, fonts) carried from the repo unchanged. */
  binaries?: Record<string, Buffer>;
}

export type DeployResult =
  | { ok: true; serviceId: string; url: string; image: string }
  | {
      ok: false;
      reason: string;
      /** A shared adapter failed here: the repo now needs the owner's AI. */
      needsAdapt?: true;
    };


/** Install a build with an image already built (and tested) for it. */
export interface InstallArtifactArgs extends DeployArtifactArgs {
  image: string;
}

/**
 * Write a build's files into `contextDir` and `docker build` them as
 * `image`. The one place a build's image is made, for a direct install and
 * for an AI build's staging copy alike.
 */
export async function buildAppImage(
  cmd: CommandRunner,
  a: { contextDir: string; files: Record<string, string>; binaries?: Record<string, Buffer>; keepBinaries?: boolean; image: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const w = await writeSourceTree(a.contextDir, a.files, {
      ...(a.binaries ? { binaries: a.binaries } : {}),
      ...(a.keepBinaries ? { keepBinaries: true } : {}),
    });
    if (!w.ok) return { ok: false, reason: `unsafe path in artifact files: ${w.unsafePath}` };
  } catch (e) {
    return { ok: false, reason: `failed to write source tree: ${(e as Error).message}` };
  }
  try {
    await runDockerBuild(cmd, a.image, a.contextDir);
  } catch (e) {
    return { ok: false, reason: `docker build failed: ${(e as Error).message}` };
  }
  return { ok: true };
}

/**
 * The two halves of putting a build on the box: `deploy` builds the image
 * from the files and installs it (a build no AI touched), `install` installs
 * an image built earlier (an AI build's tested staging image, so what goes
 * live is exactly what was tested, with no rebuild).
 */
export function buildArtifactPipeline(deps: DeployArtifactDeps) {
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

  async function run(args: DeployArtifactArgs, prebuilt: string | null): Promise<DeployResult> {
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
    const wanted = args.name ?? manifest.name;
    if (typeof wanted !== "string" || !wanted) {
      return { ok: false, reason: "manifest.name missing" };
    }

    const creator = deps.hostUsername;
    const target = resolveDeployTarget({
      ...(args.editsServiceId ? { editsServiceId: args.editsServiceId } : {}),
      name: wanted,
      hostUsername: creator,
      installed: deps.servicePlatform,
      ...(deps.registry ? { registry: deps.registry } : {}),
      ...(buildId ? { sessionId: buildId } : {}),
    });
    if (!target.ok) {
      await note(buildId, mode, "error", target.reason);
      return { ok: false, reason: target.reason };
    }
    const slug = target.slug;
    manifest = { ...manifest, name: slug };
    const serviceId = `${creator}--${slug}`; // docs/service-addressing-double-dash.md
    const appDir = join(deps.workingDir, serviceId);
    const revision = String(now());

    await note(buildId, mode, "build-started", prebuilt ? `installing ${slug}` : `building ${slug}`);

    // Harness-only Forgejo push (browse/review/revert via the existing
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

    // The service's working tree (what an edit later starts from), and the
    // image: built from it now, or the one already built and tested.
    let image: string;
    if (prebuilt) {
      image = prebuilt;
      try {
        const w = await writeSourceTree(appDir, files, {
          ...(args.binaries ? { binaries: args.binaries } : {}),
          keepBinaries: target.edit,
        });
        if (!w.ok) return { ok: false, reason: `unsafe path in artifact files: ${w.unsafePath}` };
      } catch (e) {
        return { ok: false, reason: `failed to write source tree: ${(e as Error).message}` };
      }
      await note(buildId, mode, "build-phase", "installing the tested image");
    } else {
      image = `flagship-vibe-${serviceId}:${revision}`.toLowerCase();
      await note(buildId, mode, "build-phase", "docker build");
      const built = await buildAppImage(deps.cmd, {
        contextDir: appDir,
        files,
        ...(args.binaries ? { binaries: args.binaries } : {}),
        keepBinaries: target.edit,
        image,
      });
      if (!built.ok) {
        if (/^docker build failed/.test(built.reason)) await note(buildId, mode, "error", built.reason);
        return { ok: false, reason: built.reason };
      }
    }

    // Patch the manifest's runtime.image to our local tag, then sign + install.
    const patchedManifestJson = JSON.stringify({
      ...manifest,
      runtime: { ...((manifest as { runtime?: object }).runtime ?? {}), image },
    });
    const request: InstallServiceRequest = {
      serverId: serverFqdn,
      creator,
      slug,
      manifestJson: patchedManifestJson,
      addOwnerToMembership: true,
      issuedAt: now(),
    };
    const signature = deps.signer.signInstallService(request);
    const migrations = migrationFiles(files);
    if (target.edit) {
      const r = await deps.servicePlatform.redeploy({ request, signature, verify: verifyInstallService, migrations });
      if (!r.ok) {
        await note(buildId, mode, "error", r.reason);
        return { ok: false, reason: r.reason };
      }
      const url = `https://${target.urlLabel}.${serverFqdn}`;
      await note(buildId, mode, "deployed", `updated at ${url}`, serviceId);
      return { ok: true, serviceId, url, image };
    }
    const installResult = await deps.servicePlatform.install({ request, signature, verify: verifyInstallService, migrations });
    if (!installResult.ok) {
      await note(buildId, mode, "error", `install rejected: ${installResult.reason}`);
      return { ok: false, reason: `install rejected: ${installResult.reason}` };
    }

    const urlLabel = creator === deps.hostUsername ? slug : `${slug}--${creator}`;
    const url = `https://${urlLabel}.${serverFqdn}`;
    await note(buildId, mode, "deployed", `live at ${url}`, serviceId);
    return { ok: true, serviceId, url, image };
  }

  return {
    deploy: (args: DeployArtifactArgs): Promise<DeployResult> => run(args, null),
    install: (args: InstallArtifactArgs): Promise<DeployResult> => run(args, args.image),
  };
}

/** Build + install a files map (a build no AI touched). */
export function buildArtifactDeployer(deps: DeployArtifactDeps) {
  return buildArtifactPipeline(deps).deploy;
}
