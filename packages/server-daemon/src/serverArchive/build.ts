/**
 * Make a server archive: every installed app as it would be copied to another
 * server (appCopy/source.ts) -- a consistent dump of each database, the files
 * folder, the app's working tree, members, owner env, the access list -- packed
 * into one tar and sealed (serverArchive/format.ts).
 *
 * No image, no operating system, no Flagship: a backup carries only what the
 * owner made. Every Flagship install can import every backup, on any CPU,
 * because the importing box rebuilds each app from its working tree with ITS
 * OWN runtime catalog (runtimes/catalog.ts), or pulls an app installed from a
 * public image by that image's name. An app that has neither can't move to
 * another server; it is left out and named (`left`), never silently packed.
 *
 * Apps are bundled one at a time and each app's scratch files are deleted as
 * soon as they are in the tar, so the scratch space needed is one app, not the
 * server. API keys are never part of it. The sealed archive is the only thing
 * left on disk.
 */
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import type { AppEnvStore } from "../serviceEnvStore.js";
import type { InstalledService } from "../servicePlatform.js";
import type { AppCopyOps } from "../appCopy/ops.js";
import { readCarriedBinaries, readServiceSource } from "../llm/serviceSource.js";
import type { CopyAccessEntry, CopySourceTree } from "../appCopy/wire.js";
import type { ArchivedApiKey } from "../appApiKeys.js";
import { ARCHIVE_FRAME_BYTES, ARCHIVE_MAGIC, sealToFile, type ArchiveHeader } from "./format.js";
import { createHash } from "node:crypto";

/** How an importing box gets an app's image without the backup carrying it. */
export type ArchiveRebuild = "source" | "pull";

/** Images the box made itself are named `flagship-*` and exist only there. */
export function pullableImage(image: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(image) && !/^flagship-/i.test(image);
}

export interface ArchivePartInfo {
  /** `files`, `source` or `db:<store>`. */
  name: string;
  /** Entry name inside the tar. */
  file: string;
  bytes: number;
  sha256: string;
}

/** One app's `meta.json` inside the archive. */
export interface ArchiveAppMeta {
  v: 1;
  serviceId: string;
  creator: string;
  slug: string;
  name: string;
  manifestJson: string;
  /** `source`: rebuild from the `source` part; `pull`: pull runtime.image. */
  rebuild: ArchiveRebuild;
  appliedMigrations: string[];
  parts: ArchivePartInfo[];
  access: CopyAccessEntry | null;
  membership: unknown;
  /** Plain: the archive as a whole is sealed. FLAGSHIP_* names are not carried. */
  env: Record<string, string>;
  accessList: string | null;
  /** The API keys clients use with this app (grant + secret hash; never the secret). */
  apiKeys: ArchivedApiKey[];
}

/** The archive's first entry, `manifest.json`. */
export interface ArchiveManifest {
  v: 1;
  archiveId: string;
  createdAt: number;
  sourceServer: string;
  apps: Array<{ serviceId: string; name: string }>;
  /** Apps on the server that couldn't be included, and why. */
  left: Array<{ serviceId: string; name: string; reason: string }>;
  /** The app the server's own address opens (its url label), or null. */
  frontPage: string | null;
  /** What an import brings back, and what it doesn't, so the apps can say so. */
  includes: string[];
  excludes: string[];
}

export const ARCHIVE_INCLUDES = [
  "apps' source, rebuilt on import",
  "app databases",
  "app files",
  "app members and access",
  "app settings and secrets",
  "app API keys",
  "the server's front page",
];
export const ARCHIVE_EXCLUDES = [
  "app images, the operating system and Flagship itself (the importing server rebuilds the apps)",
  "the server's own keys, certificate and address (the importing server has its own)",
  "the dead-man switch (owner-signed for one server: set it again there)",
  "peer backups",
  "the Git host",
];

export const NOT_PORTABLE_REASON = "its source isn't on this server and its image can't be fetched elsewhere";

export interface ArchiveBuildDeps {
  serverFqdn: string;
  apps: () => InstalledService[];
  containerName: (serviceId: string) => string;
  ops: AppCopyOps;
  envStore: AppEnvStore | null;
  access: { exportEntry(serviceId: string): CopyAccessEntry | null } | null;
  accessList: ((serviceId: string) => string | null) | null;
  sourceDir?: string | null;
  apiKeys?: { exportService(serviceId: string): ArchivedApiKey[] } | null;
  /** The front page's url label, or null. */
  frontPage?: (() => string | null) | null;
  /** Scratch folder; one app's files at a time. */
  workDir: string;
  now?: () => number;
  log?: (m: string) => void;
}

export interface ArchiveBuildResult {
  bytes: number;
  sha256: string;
  apps: Array<{ serviceId: string; name: string }>;
  left: Array<{ serviceId: string; name: string; reason: string }>;
}

/** Which apps can go in, and how each will be rebuilt on import. */
async function planApps(deps: ArchiveBuildDeps): Promise<{
  take: Array<{ app: InstalledService; rebuild: ArchiveRebuild }>;
  left: Array<{ serviceId: string; name: string; reason: string }>;
}> {
  const take: Array<{ app: InstalledService; rebuild: ArchiveRebuild }> = [];
  const left: Array<{ serviceId: string; name: string; reason: string }> = [];
  for (const app of deps.apps()) {
    const hasSource = deps.sourceDir ? (await readServiceSource(deps.sourceDir, app.serviceId)).ok : false;
    if (hasSource) take.push({ app, rebuild: "source" });
    else if (pullableImage(app.manifest.runtime.image)) take.push({ app, rebuild: "pull" });
    else left.push({ serviceId: app.serviceId, name: appName(app), reason: NOT_PORTABLE_REASON });
  }
  return { take, left };
}

function appName(app: InstalledService): string {
  const n = (app.manifest as { name?: unknown }).name;
  return typeof n === "string" && n ? n : app.slug;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src: AsyncIterable<Buffer>) {
    for await (const d of src) h.update(d);
  });
  return h.digest("hex");
}

/** Bytes under `dir`, not following links. */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = await lstat(p).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) total += await treeBytes(p);
    else if (st.isFile()) total += st.size;
  }
  return total;
}

export interface ArchiveSizeEstimate {
  /** What the sealed file will take on disk. */
  archiveBytes: number;
  /** The largest single app's scratch (its parts are staged, then packed). */
  largestAppBytes: number;
}

/**
 * Size the backup before making it, from what each part will hold: each
 * database (`pg_database_size`, more than its
 * compressed dump), the files folder (`du`), and the working tree (as base64
 * JSON). Null when the box can't size something: the caller falls back to
 * watching the disk while it works.
 */
export async function estimateServerArchive(deps: ArchiveBuildDeps): Promise<ArchiveSizeEstimate | null> {
  const ops = deps.ops;
  if (!ops.databaseBytes || !ops.filesBytes) return null;
  let archiveBytes = 64 * 1024;
  let largestAppBytes = 0;
  try {
    for (const app of deps.apps()) {
      let bytes = 0;
      for (const cred of Object.values(app.data?.postgres ?? {})) bytes += await ops.databaseBytes(cred);
      if (app.data?.files) bytes += await ops.filesBytes(app.data.files.volume);
      if (deps.sourceDir) bytes += Math.ceil((await treeBytes(join(deps.sourceDir, app.serviceId))) * 1.4);
      // tar headers and padding, frame tags: well under 1% plus a little per part.
      bytes += Math.ceil(bytes / 100) + 16 * 1024;
      archiveBytes += bytes;
      largestAppBytes = Math.max(largestAppBytes, bytes);
    }
  } catch (e) {
    deps.log?.(`[server-archive] couldn't size the backup: ${(e as Error).message}`);
    return null;
  }
  return { archiveBytes, largestAppBytes };
}

function addBuffer(pack: tar.Pack, name: string, body: Buffer): Promise<void> {
  return new Promise((resolve, reject) => pack.entry({ name, size: body.length, mode: 0o600 }, body, (e) => (e ? reject(e) : resolve())));
}

async function addFile(pack: tar.Pack, name: string, path: string, size: number): Promise<void> {
  const entry = pack.entry({ name, size, mode: 0o600 });
  await pipeline(createReadStream(path), entry);
}

export async function buildServerArchive(
  deps: ArchiveBuildDeps,
  args: { archiveId: string; key: Buffer; outPath: string; onProgress?: (done: number, total: number, appName: string) => void },
): Promise<ArchiveBuildResult> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const plan = await planApps(deps);
  const apps = plan.take.map((t) => t.app);
  const rebuildOf = new Map(plan.take.map((t) => [t.app.serviceId, t.rebuild]));
  const list = apps.map((a) => ({ serviceId: a.serviceId, name: appName(a) }));
  const header: ArchiveHeader = {
    magic: ARCHIVE_MAGIC,
    v: 1,
    archiveId: args.archiveId,
    createdAt: now(),
    sourceServer: deps.serverFqdn,
    frameBytes: ARCHIVE_FRAME_BYTES,
    apps: list,
  };
  const pack = tar.pack();

  const produce = async (): Promise<void> => {
    const manifest: ArchiveManifest = {
      v: 1,
      archiveId: args.archiveId,
      createdAt: header.createdAt,
      sourceServer: deps.serverFqdn,
      apps: list,
      left: plan.left,
      frontPage: deps.frontPage?.() ?? null,
      includes: ARCHIVE_INCLUDES,
      excludes: ARCHIVE_EXCLUDES,
    };
    await addBuffer(pack, "manifest.json", Buffer.from(JSON.stringify(manifest)));
    for (const [i, app] of apps.entries()) {
      args.onProgress?.(i, apps.length, appName(app));
      const dir = join(deps.workDir, `app-${i}`);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        const prefix = `apps/${app.serviceId}`;
        const parts: ArchivePartInfo[] = [];
        const staged: Array<{ info: ArchivePartInfo; path: string }> = [];
        const stage = async (name: string, file: string, path: string): Promise<void> => {
          const info = { name, file: `${prefix}/${file}`, bytes: (await stat(path)).size, sha256: await sha256File(path) };
          parts.push(info);
          staged.push({ info, path });
        };
        let n = 0;
        for (const [store, cred] of Object.entries(app.data?.postgres ?? {})) {
          const out = join(dir, `db-${n++}.dump`);
          await deps.ops.dumpDatabase(cred, out);
          await stage(`db:${store}`, `db-${n - 1}.dump`, out);
        }
        if (app.data?.files) {
          const out = join(dir, "files.tar");
          await deps.ops.archiveFiles(app.data.files.volume, deps.containerName(app.serviceId), out);
          await stage("files", "files.tar", out);
        }
        if (deps.sourceDir) {
          const tree = await readServiceSource(deps.sourceDir, app.serviceId);
          if (tree.ok) {
            const binaries = await readCarriedBinaries(join(deps.sourceDir, app.serviceId));
            const body: CopySourceTree = {
              files: tree.files,
              binaries: Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, v.toString("base64")])),
            };
            const out = join(dir, "source.json");
            await writeFile(out, JSON.stringify(body), { mode: 0o600 });
            await stage("source", "source.json", out);
          }
        }
        const env = deps.envStore ? ((await deps.envStore.get(app.serviceId).catch(() => null)) ?? {}) : {};
        const meta: ArchiveAppMeta = {
          v: 1,
          serviceId: app.serviceId,
          creator: app.creator,
          slug: app.slug,
          name: appName(app),
          manifestJson: JSON.stringify(app.manifest),
          rebuild: rebuildOf.get(app.serviceId) ?? "pull",
          appliedMigrations: [...(app.appliedMigrations ?? [])],
          parts,
          access: deps.access?.exportEntry(app.serviceId) ?? null,
          membership: app.membership.snapshot(),
          env: Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("FLAGSHIP_"))),
          accessList: deps.accessList?.(app.serviceId) ?? null,
          apiKeys: deps.apiKeys?.exportService(app.serviceId) ?? [],
        };
        await addBuffer(pack, `${prefix}/meta.json`, Buffer.from(JSON.stringify(meta)));
        for (const s of staged) await addFile(pack, s.info.file, s.path, s.info.bytes);
        log(`[server-archive] ${app.serviceId}: packed`);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    args.onProgress?.(apps.length, apps.length, "");
    pack.finalize();
  };

  const producing = produce().catch((e: Error) => {
    pack.destroy(e);
  });
  try {
    const sealed = await sealToFile(pack, args.key, header, args.outPath);
    await producing;
    return { ...sealed, apps: list, left: plan.left };
  } catch (e) {
    await rm(args.outPath, { force: true }).catch(() => {});
    throw e;
  }
}
