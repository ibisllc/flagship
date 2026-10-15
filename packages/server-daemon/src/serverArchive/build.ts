/**
 * Make a server archive: every installed app as it would be copied to another
 * server (appCopy/source.ts) -- image, a consistent dump of each database, the
 * files folder, the working tree of an app built here, members, owner env, the
 * access list -- packed into one tar and sealed (serverArchive/format.ts).
 *
 * Apps are bundled one at a time and each app's scratch files are deleted as
 * soon as they are in the tar, so the scratch space needed is one app, not the
 * server. API keys are never part of it. The sealed archive is the only thing
 * left on disk.
 */
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import type { AppEnvStore } from "../serviceEnvStore.js";
import type { InstalledService } from "../servicePlatform.js";
import type { AppCopyOps } from "../appCopy/ops.js";
import { readCarriedBinaries, readServiceSource } from "../llm/serviceSource.js";
import type { CopyAccessEntry, CopySourceTree } from "../appCopy/wire.js";
import { ARCHIVE_FRAME_BYTES, ARCHIVE_MAGIC, sealToFile, type ArchiveHeader } from "./format.js";
import { createHash } from "node:crypto";

export interface ArchivePartInfo {
  /** `image`, `files`, `source` or `db:<store>`. */
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
  appliedMigrations: string[];
  parts: ArchivePartInfo[];
  access: CopyAccessEntry | null;
  membership: unknown;
  /** Plain: the archive as a whole is sealed. FLAGSHIP_* names are not carried. */
  env: Record<string, string>;
  accessList: string | null;
}

/** The archive's first entry, `manifest.json`. */
export interface ArchiveManifest {
  v: 1;
  archiveId: string;
  createdAt: number;
  sourceServer: string;
  apps: Array<{ serviceId: string; name: string }>;
  /** What an import brings back, and what it doesn't, so the apps can say so. */
  includes: string[];
  excludes: string[];
}

export const ARCHIVE_INCLUDES = ["apps and their databases", "app files", "app members and access", "app settings and secrets", "app working trees"];
export const ARCHIVE_EXCLUDES = ["API keys", "the server's identity, certificate and address", "peer backups", "the Git host"];

export interface ArchiveBuildDeps {
  serverFqdn: string;
  apps: () => InstalledService[];
  containerName: (serviceId: string) => string;
  ops: AppCopyOps;
  envStore: AppEnvStore | null;
  access: { exportEntry(serviceId: string): CopyAccessEntry | null } | null;
  accessList: ((serviceId: string) => string | null) | null;
  sourceDir?: string | null;
  /** Scratch folder; one app's files at a time. */
  workDir: string;
  now?: () => number;
  log?: (m: string) => void;
}

export interface ArchiveBuildResult {
  bytes: number;
  sha256: string;
  apps: Array<{ serviceId: string; name: string }>;
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
  const apps = deps.apps();
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
        const image = join(dir, "image.tar");
        await deps.ops.saveImage(app.manifest.runtime.image, image);
        await stage("image", "image.tar", image);
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
          appliedMigrations: [...(app.appliedMigrations ?? [])],
          parts,
          access: deps.access?.exportEntry(app.serviceId) ?? null,
          membership: app.membership.snapshot(),
          env: Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("FLAGSHIP_"))),
          accessList: deps.accessList?.(app.serviceId) ?? null,
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
    return { ...sealed, apps: list };
  } catch (e) {
    await rm(args.outPath, { force: true }).catch(() => {});
    throw e;
  }
}
