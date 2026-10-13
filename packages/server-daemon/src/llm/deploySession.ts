/**
 * Deploy a VibeCodeSession's parsed manifest + source files into a
 * running app.
 *
 * Flow:
 *   1. Pull the manifest JSON + source files out of the session.
 *   2. Write the source tree to disk under <workingDir>/<serviceId>/.
 *   3. (Optional) Push the tree to the per-app Forgejo repo so the
 *      user can browse/review/revert the LLM's commits via the
 *      existing /apps/:serviceId/git/* surface. First deploy creates the
 *      repo; subsequent deploys add a commit on top.
 *   4. Run `docker build -t flagship-vibe-<serviceId>:<revision> <workingDir>`
 *      to produce a local image. The image ref replaces the manifest's
 *      runtime.image so ServicePlatform.install hands the right tag to
 *      AppRunner.
 *   5. Construct + sign an InstallServiceRequest with the host's IRK
 *      (vibe-coded apps are always self-authored on the calling pod's
 *      host — creator === username).
 *   6. Call ServicePlatform.install.
 *   7. Return the canonical URL the app will live at.
 *
 * `buildStagedChatDeploy` wraps it for the owner's Deploy: the chat's files
 * first run as a private staging copy (docs/ai-privacy-and-staging.md §2);
 * when that copy won't build or start and the session has an AI key, the
 * same staged agent loop the git and IDE builds use lets the AI fix it there.
 * Then the session is sealed (its AI key forgotten) and the tested image
 * goes live through `deploy` with no rebuild.
 */

import { join } from "node:path";
import {
  RUNTIME_BASES,
  verifyInstallService,
  type InstallServiceRequest,
} from "@flagship/protocol";
import { runDockerBuild, type CommandRunner } from "../serviceRunner.js";
import type { ServicePlatform } from "../servicePlatform.js";
import type { BoxSigner } from "../keyCustodian.js";
import type { ForgejoAppAdmin } from "../forgejoServiceAdmin.js";
import type { VibeCodeSession, VibeCodeSessionRegistry } from "./vibeCodeSession.js";
import { migrationFiles, resolveDeployTarget, type NameHolders } from "./serviceName.js";
import { writeSourceTree } from "./serviceSource.js";
import { whileDeploying, type DeployingTracker } from "../serviceActivity.js";
import { noRedaction, type ModelRedactor } from "./modelPrivacy.js";
import type { BuildJournal } from "../buildmodes/buildJournal.js";
import { BuildWorkspace, withoutBuildFiles } from "../buildmodes/buildWorkspace.js";
import { BuildToolHost } from "../buildmodes/buildToolHost.js";
import { runBuildAgent, type AgentRunner } from "../buildmodes/buildAgent.js";
import { filesDigest, stagingDataHooks, type StagingHost } from "../buildmodes/staging.js";

export interface DeploySessionDeps {
  servicePlatform: ServicePlatform;
  /** Box-identity signer (custodian slice) — signs the InstallServiceRequest
   *  as the box (the owner IRK private half is phone-held; ServicePlatform
   *  accepts the box identity as an additive host signer). Never a raw key. */
  signer: Pick<BoxSigner, "signInstallService">;
  /** Daemon username (the creator/host of vibe-coded apps). */
  hostUsername: string;
  /**
   * Where to write source trees + run docker build. Each app gets a
   * subdirectory `<workingDir>/<serviceId>/`.
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
  /**
   * Open build sessions, so a deploy never takes a name another session
   * holds (sessions from before names were kept have only the manifest's).
   */
  registry?: NameHolders;
  /**
   * Put a freshly installed service behind the box's invite-only gate. Returns
   * false when the box can't (it has no owner key pinned to let the owner
   * through), in which case the service stays open and the owner is told.
   */
  restrictToInvited?: (serviceId: string) => Promise<boolean>;
  /** Marks the service an edit replaces as deploying while it builds and goes live. */
  activity?: DeployingTracker | null;
}

export type DeployResult =
  | { ok: true; serviceId: string; url: string; image: string; inviteOnly?: boolean }
  | { ok: false; reason: string };

/**
 * What to install instead of the session's own files: the files a staged
 * run ended with, and the image already built (and tested) from them.
 */
export interface DeploySessionOverride {
  files?: Record<string, string>;
  image?: string;
}

export function buildDeploySession(deps: DeploySessionDeps) {
  const now = deps.now ?? (() => Date.now());

  return function deploy(session: VibeCodeSession, override: DeploySessionOverride = {}): Promise<DeployResult> {
    return whileDeploying(deps.activity, session.meta.editsServiceId, () => deployNow(session, override));
  };

  async function deployNow(session: VibeCodeSession, override: DeploySessionOverride): Promise<DeployResult> {
    // The model writes every file of a chat, so the box writes its build.
    const files = withoutBuildFiles(override.files ?? session.files());
    const manifestJson = files["flagship.app.json"];
    if (!manifestJson) {
      return { ok: false, reason: "session has no flagship.app.json" };
    }
    const noRuntime = chatRuntimeProblem(manifestJson);
    if (noRuntime) return { ok: false, reason: noRuntime };
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
    const target = resolveDeployTarget({
      ...(session.meta.editsServiceId ? { editsServiceId: session.meta.editsServiceId } : {}),
      name: session.meta.name ?? manifest.name,
      hostUsername: creator,
      installed: deps.servicePlatform,
      ...(deps.registry ? { registry: deps.registry } : {}),
      sessionId: session.meta.sessionId,
    });
    if (!target.ok) return { ok: false, reason: target.reason };
    const slug = target.slug;
    manifest = { ...manifest, name: slug };
    // Single-dash composite (creator is hyphen-free → unambiguous).
    // Kept inline rather than importing ServicePlatform as a value just
    // for the static; the format is pinned by servicePlatform.serviceId +
    // its test.
    const serviceId = `${creator}--${slug}`; // docs/service-addressing-double-dash.md
    const appDir = join(deps.workingDir, serviceId);

    // 1. Write the source tree. We blow away any prior working tree
    // so a re-deploy is reproducible.
    try {
      const w = await writeSourceTree(appDir, files, { keepBinaries: target.edit });
      if (!w.ok) return { ok: false, reason: `unsafe path in session files: ${w.unsafePath}` };
    } catch (e) {
      return { ok: false, reason: `failed to write source tree: ${(e as Error).message}` };
    }

    const revision = String(now());

    // 2. Push to Forgejo so the user can browse/review/revert the
    // LLM's output through the existing /apps/:serviceId/git/* surface.
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

    // 3. Build the image, unless staging already built and tested it. Tag
    // includes a per-deploy revision so re-deploys produce a fresh tag
    // (avoids stale cached images on restart).
    const image = override.image ?? `flagship-vibe-${serviceId}:${revision}`.toLowerCase();
    if (!override.image) {
      try {
        await runDockerBuild(deps.cmd, image, appDir);
      } catch (e) {
        return { ok: false, reason: `docker build failed: ${(e as Error).message}` };
      }
    }

    // 4. Update the manifest's runtime.image to our local tag. The
    // LLM may have emitted a placeholder ref it doesn't actually have
    // permission to push to.
    const patchedManifestJson = JSON.stringify(
      { ...manifest, runtime: { ...(manifest as { runtime?: object }).runtime ?? {}, image } },
    );

    // 5. Build + sign the InstallServiceRequest.
    const request: InstallServiceRequest = {
      serverId: session.meta.serverFqdn,
      creator,
      slug,
      manifestJson: patchedManifestJson,
      addOwnerToMembership: true,
      issuedAt: now(),
    };
    const signature = deps.signer.signInstallService(request);

    // 6. Install via ServicePlatform — provisions data, mints token,
    // deploys the container. Owner-set env vars (if any) are applied
    // via a separate signed set-app-env order and injected into the
    // container's process env on deploy; they are NOT part of this
    // signed install envelope.
    const migrations = migrationFiles(files);
    if (target.edit) {
      const r = await deps.servicePlatform.redeploy({ request, signature, verify: verifyInstallService, migrations });
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true, serviceId, url: `https://${target.urlLabel}.${session.meta.serverFqdn}`, image };
    }
    const installResult = await deps.servicePlatform.install({
      request,
      signature,
      verify: verifyInstallService,
      migrations,
    });
    if (!installResult.ok) {
      return { ok: false, reason: `install rejected: ${installResult.reason}` };
    }

    // 7. Compose the canonical URL. ServicePlatform exposes urlLabel via
    // its static helper; we rebuild it here to avoid coupling.
    const urlLabel = creator === deps.hostUsername ? slug : `${slug}--${creator}`;
    const url = `https://${urlLabel}.${session.meta.serverFqdn}`;
    let inviteOnly: boolean | undefined;
    if (session.meta.visibility === "just-me" && deps.restrictToInvited) {
      inviteOnly = await deps.restrictToInvited(serviceId).catch(() => false);
    }
    return { ok: true, serviceId, url, image, ...(inviteOnly !== undefined ? { inviteOnly } : {}) };
  }
}

/** Where a staged chat deploy is: on its private copy, the AI fixing it there, or going live. */
export type ChatDeployPhase = "staging" | "fixing" | "going-live";

export interface StagedChatDeployDeps {
  /** The install that goes live (`buildDeploySession`). */
  deploy: (session: VibeCodeSession, override: DeploySessionOverride) => Promise<DeployResult>;
  staging: StagingHost;
  journal?: BuildJournal | null;
  /** The session's AI (its key opened just-in-time, keyed by session id). Unset ⇒ no AI fixes. */
  agentRunner?: AgentRunner;
  hasCredential?: (sessionId: string) => boolean;
  /** Sealing: forget the session's AI key before it goes live. */
  forgetCredential?: (sessionId: string) => Promise<void>;
  redact?: ModelRedactor;
  /** Owner env var NAMES for a service (the copy gets placeholders). */
  envNames?: (serviceId: string) => Promise<string[]>;
  hostUsername: string;
  agentMaxTurns?: number;
}

function chatFixMessage(reason: string, files: string[]): string {
  const shown = files.slice(0, 400).map((p) => `  - ${p}`).join("\n") || "  (none)";
  return (
    `This app was written in a chat with its owner and is now in your build workspace. ` +
    `The box tried to run a private test copy of it, and it failed:\n\n${reason}\n\n` +
    `Fix the smallest thing that makes it build and start, without changing what the app does. ` +
    `Files present (${files.length}):\n${shown}\n\n` +
    `Read the files you need with read_file (get_contract has the platform rules), write_file the fix, ` +
    `validate, deploy, test it with check_app and get_logs, and call finish when it works.`
  );
}

/**
 * The owner's Deploy for an AI chat: stage, let the session's AI fix a copy
 * that won't build or start, seal, then put the tested image live.
 */
export function buildStagedChatDeploy(deps: StagedChatDeployDeps) {
  const redact = deps.redact ?? noRedaction;
  return async function deploy(
    session: VibeCodeSession,
    opts: { onPhase?: (phase: ChatDeployPhase) => void } = {},
  ): Promise<DeployResult> {
    const id = session.meta.sessionId;
    const ws = new BuildWorkspace(withoutBuildFiles(session.files()));
    const manifestJson = ws.manifestJson();
    if (!manifestJson) return { ok: false, reason: "session has no flagship.app.json" };
    const noRuntime = chatRuntimeProblem(manifestJson);
    if (noRuntime) return { ok: false, reason: noRuntime };
    let slug = session.meta.name ?? "";
    if (!slug) {
      try {
        const m = JSON.parse(manifestJson) as { name?: unknown };
        if (typeof m.name === "string") slug = m.name;
      } catch {
        return { ok: false, reason: "manifest is not valid JSON" };
      }
    }
    slug = (slug || "app").toLowerCase();
    const serviceId = session.meta.editsServiceId ?? `${deps.hostUsername}--${slug}`;
    const envNames = deps.envNames ? await deps.envNames(serviceId).catch(() => []) : [];
    const edits = session.meta.editsServiceId;
    const stage = () =>
      deps.staging.stage({ buildId: id, files: ws.snapshot(), slug, envNames, ...(edits ? { carryBinariesFrom: edits } : {}) });
    const matches = () => deps.staging.staged(id)?.filesDigest === filesDigest(ws.snapshot());
    const note = (kind: "build-phase" | "sealed" | "error", summary: string) =>
      deps.journal?.append(id, { mode: "scratch", kind, actor: "system", summary }).catch(() => {});

    let sealed = false;
    opts.onPhase?.("staging");
    const first = await stage();
    if (!first.ok && first.environment) {
      // The box is broken, not the app: no AI turn, and the owner is told what to do.
      await note("error", first.environment.ownerReason);
      await deps.staging.teardown(id).catch(() => {});
      return { ok: false, reason: first.environment.ownerReason };
    }
    if (!first.ok) {
      if (!deps.agentRunner || !deps.hasCredential?.(id)) {
        await deps.staging.teardown(id).catch(() => {});
        return { ok: false, reason: first.reason };
      }
      opts.onPhase?.("fixing");
      await note("build-phase", "the test copy didn't start; the AI is fixing it");
      const tools = new BuildToolHost({
        buildId: id,
        workspace: ws,
        journal: deps.journal ?? noJournal,
        serverFqdn: session.meta.serverFqdn,
        mode: "scratch",
        redact,
        envNames: async () => envNames,
        deploy: async () => {
          const r = await stage();
          return r.ok ? { ok: true } : { ok: false, reason: r.reason, ...(r.environment ? { environment: r.environment } : {}) };
        },
        checkApp: async (req) => {
          const r = await deps.staging.checkApp(id, req);
          return r.ok ? { ok: true, status: r.status, contentType: r.contentType, body: r.body, truncated: r.truncated } : r;
        },
        logs: () => deps.staging.logs(id),
        data: stagingDataHooks(deps.staging, id, () => sealed),
        finish: async () => {
          if (!deps.staging.staged(id)) return { ok: false, reason: "deploy first: finish only works after a successful deploy" };
          if (!matches()) return { ok: false, reason: "the files changed since the last deploy: deploy again, test it, then finish" };
          sealed = true;
          return { ok: true };
        },
        sealed: () => sealed,
      });
      const agentRunner = deps.agentRunner;
      const result = await runBuildAgent({
        buildId: id,
        runner: (req) => agentRunner(id, req),
        tools,
        journal: deps.journal ?? noJournal,
        repoFiles: ws.list(),
        mode: "scratch",
        initialMessage: chatFixMessage(redact(first.reason), ws.list()),
        ...(deps.agentMaxTurns != null ? { options: { maxTurns: deps.agentMaxTurns } } : {}),
      });
      if (result.stopReason === "environment" && result.environment) {
        sealed = true;
        await deps.staging.teardown(id).catch(() => {});
        return { ok: false, reason: result.environment.ownerReason };
      }
      if (!(result.finished || matches())) {
        sealed = true;
        await deps.staging.teardown(id).catch(() => {});
        return { ok: false, reason: `the app didn't start, and the AI couldn't fix it: ${first.reason}` };
      }
    }

    // Seal before anything goes live: the session's AI key is forgotten,
    // and the copy and its sample data go away.
    sealed = true;
    await deps.forgetCredential?.(id).catch(() => {});
    await note("sealed", "the AI's work is done; the box is putting it live");
    opts.onPhase?.("going-live");
    const copy = matches() ? deps.staging.staged(id) : null;
    await deps.staging.teardown(id).catch(() => {});
    const files = ws.snapshot();
    if (filesDigest(files) !== filesDigest(session.files())) session.adoptFiles(files);
    const live = await deps.deploy(session, { files, ...(copy ? { image: copy.image } : {}) });
    if (live.ok) deps.staging.forget(id);
    return live;
  };
}

const noJournal: BuildJournal = {
  append: async (buildId, e) => ({ ...e, seq: 0, ts: 0, buildId }),
  read: async () => [],
  list: async () => [],
  forget: async () => {},
};

/** Why a chat's app can't be built: it names no runtime (or its manifest doesn't parse). */
function chatRuntimeProblem(manifestJson: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson);
  } catch (e) {
    return `manifest is not valid JSON: ${(e as Error).message}`;
  }
  const base = (raw as { runtime?: { base?: unknown } } | null)?.runtime?.base;
  if (typeof base === "string" && (RUNTIME_BASES as readonly string[]).includes(base)) return null;
  return `set runtime.base in flagship.app.json to one of ${RUNTIME_BASES.join(", ")}: the box builds the app on it`;
}
