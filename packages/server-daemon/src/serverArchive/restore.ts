/**
 * Import a server archive onto this server (the clone half of "Backup/clone
 * server"). The archive is opened with the key the owner's phone derives for
 * it, unpacked into a scratch folder with every path checked, every part's
 * SHA-256 verified, and then each app is installed the way an app copy
 * installs one (appCopy/target.ts), except that no image comes with it: this
 * box rebuilds the app from its working tree with its own runtime catalog
 * (or pulls the public image an app was installed from), so a backup made on
 * any Flagship install, on any CPU, imports here. Then env written, fresh stores
 * restored from the dumps before the container first starts, members and
 * working tree brought over, the access list kept as a draft for the owner.
 *
 * The apps are installed under THIS server (its own name), so a clone made
 * under a new name works. They become the importing account's own apps: the
 * creator in their id (`<creator>--<slug>`) is rewritten to the account this
 * server belongs to, so a backup made under another account (a name that may
 * since have been freed and claimed by someone else) never installs as a
 * cross-creator app, which would record an auto-update pull from that old
 * name's canonical home. An app that is already here is skipped and said so;
 * an app that fails leaves nothing behind (stores dropped, image and env
 * removed) and the rest go on.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import {
  egressSuggestions,
  parseManifest,
  parseServiceId,
  verifyInstallService,
  type InstallServiceRequest,
  type Bytes,
} from "@flagship/protocol";
import type { AppDataCredentials } from "../dataLayer/provisioner.js";
import type { AppEnvStore } from "../serviceEnvStore.js";
import type { ServicePlatform } from "../servicePlatform.js";
import type { AppCopyOps } from "../appCopy/ops.js";
import type { CopyAccessEntry, CopySourceTree } from "../appCopy/wire.js";
import { writeSourceTree } from "../llm/serviceSource.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { openDataFile, ArchiveError } from "./format.js";
import type { ArchiveAppMeta, ArchiveManifest } from "./build.js";

const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const ENTRY_RE = /^(manifest\.json|apps\/[a-z0-9][a-z0-9-]*--[a-z0-9][a-z0-9-]*\/(meta\.json|files\.tar|source\.json|db-\d{1,3}\.dump))$/;

export type RestoreAppState = "waiting" | "restoring" | "done" | "skipped" | "failed";

export interface RestoreAppResult {
  serviceId: string;
  name: string;
  state: RestoreAppState;
  reason?: string;
  /** Names of env values that couldn't be carried (none today: the archive is sealed whole). */
  pendingEnv?: string[];
}

export interface ArchiveRestoreDeps {
  serverFqdn: string;
  platform: Pick<ServicePlatform, "byServiceId" | "install">;
  dataProvisioner: { dropCredentials(c: AppDataCredentials): Promise<void> } | null;
  ops: AppCopyOps;
  signInstall: (req: InstallServiceRequest) => Bytes;
  envStore: AppEnvStore | null;
  access: { importEntry(serviceId: string, e: CopyAccessEntry): Promise<void> } | null;
  egress: { noteCopied(serviceId: string, list: string, declared: ReturnType<typeof egressSuggestions>): Promise<void> } | null;
  sourceDir?: string | null;
  workDir: string;
  /** Build an app's image from its tree (deployArtifact.buildAppImage: the box
   *  writes the Dockerfile from the manifest's runtime, then `docker build`). */
  buildImage: (a: { contextDir: string; files: Record<string, string>; binaries: Record<string, Buffer>; image: string }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** `docker pull` a public image an app was installed from. */
  pullImage: (image: string) => Promise<void>;
  /** Take an app's API keys onto this server (grants still checked against the owner). */
  apiKeys?: { importService(serviceId: string, keys: unknown): Promise<{ imported: number; dropped: number }> } | null;
  /** The server's front page: set from the backup when this server has none. */
  frontPage?: { get(): string | null; set(label: string): Promise<void>; installed(label: string): boolean } | null;
  now?: () => number;
  log?: (m: string) => void;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src: AsyncIterable<Buffer>) {
    for await (const d of src) h.update(d);
  });
  return h.digest("hex");
}

/** Unpack the sealed data file into `dir`. Refuses any entry that isn't one of the expected files. */
async function unpack(archivePath: string, key: Buffer, archiveId: string, dir: string): Promise<void> {
  const extract = tar.extract();
  const done = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const name = header.name;
      if (header.type !== "file" || !ENTRY_RE.test(name)) {
        stream.resume();
        extract.destroy(new ArchiveError(`the archive holds something unexpected (${name.slice(0, 80)})`));
        return;
      }
      const target = join(dir, name);
      mkdir(dirname(target), { recursive: true, mode: 0o700 })
        .then(() => pipeline(stream, createWriteStream(target, { mode: 0o600 })))
        .then(() => next(), (e) => extract.destroy(e as Error));
    });
    extract.on("finish", () => resolve());
    extract.on("error", reject);
  });
  const src = openDataFile(archivePath, key, archiveId);
  src.on("error", (e) => extract.destroy(e));
  extract.on("error", () => src.destroy());
  src.pipe(extract);
  await done;
}

function validMeta(v: unknown, serviceId: string): ArchiveAppMeta {
  const m = v as Partial<ArchiveAppMeta> | null;
  const bad = (why: string): never => {
    throw new ArchiveError(`the archive is damaged (${serviceId}: ${why})`);
  };
  if (!m || m.v !== 1 || m.serviceId !== serviceId) bad("identity");
  const id = parseServiceId(serviceId);
  if (!id || m!.creator !== id.creator || m!.slug !== id.slug) bad("service id");
  if (typeof m!.manifestJson !== "string") bad("manifest");
  let manifest: unknown;
  try {
    manifest = JSON.parse(m!.manifestJson!);
  } catch {
    bad("manifest");
  }
  const parsed = parseManifest(manifest);
  if (!parsed.ok) bad(`manifest: ${parsed.errors.join("; ")}`);
  if (!IMAGE_RE.test(String((manifest as { runtime?: { image?: unknown } }).runtime?.image ?? ""))) bad("image name");
  if (m!.rebuild !== "source" && m!.rebuild !== "pull") bad("rebuild");
  if (!Array.isArray(m!.parts)) bad("parts");
  if (m!.rebuild === "source" && !m!.parts!.some((p) => p?.name === "source")) bad("no source to rebuild from");
  for (const p of m!.parts!) {
    if (typeof p?.name !== "string" || typeof p.file !== "string") bad("part");
    if (!/^(files|source|db:[A-Za-z0-9_-]{1,63})$/.test(p.name)) bad("part name");
    if (!p.file.startsWith(`apps/${serviceId}/`) || !ENTRY_RE.test(p.file)) bad("part file");
    if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) bad("part hash");
  }
  if (!Array.isArray(m!.appliedMigrations) || m!.appliedMigrations!.some((x) => typeof x !== "string")) bad("migrations");
  if (!m!.env || typeof m!.env !== "object") bad("env");
  return m as ArchiveAppMeta;
}

export interface ArchiveContents {
  manifest: ArchiveManifest;
  metas: ArchiveAppMeta[];
}

/** Unpack and check a data file; the folder is left for `installArchive`. */
export async function unpackArchive(
  deps: ArchiveRestoreDeps,
  archivePath: string,
  key: Buffer,
  archiveId: string,
  dir: string,
): Promise<ArchiveContents> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await unpack(archivePath, key, archiveId, dir);
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ArchiveManifest;
  } catch {
    throw new ArchiveError("the archive has no manifest");
  }
  if (manifest.v !== 1 || !Array.isArray(manifest.apps) || manifest.archiveId !== archiveId) throw new ArchiveError("the archive manifest is damaged");
  const metas: ArchiveAppMeta[] = [];
  for (const a of manifest.apps) {
    if (!parseServiceId(a.serviceId)) throw new ArchiveError("the archive manifest is damaged");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, "apps", a.serviceId, "meta.json"), "utf8"));
    } catch {
      throw new ArchiveError(`the archive is missing ${a.serviceId}`);
    }
    const meta = validMeta(raw, a.serviceId);
    for (const p of meta.parts) {
      const got = await sha256File(join(dir, p.file)).catch(() => null);
      if (got !== p.sha256) throw new ArchiveError(`${a.serviceId}: ${p.name} is damaged`);
    }
    metas.push(meta);
  }
  void deps;
  return { manifest, metas };
}

interface Held {
  image?: string;
  /** The working tree this import wrote (removed again if the app fails). */
  tree?: string;
  env?: boolean;
  postgres?: Record<string, { database: string; role: string }>;
  filesVolume?: string;
}

/** The account this server belongs to: `<server>.<account>.<apex>`, the same label the platform checks installs against. */
function hostAccount(serverFqdn: string): string {
  return serverFqdn.split(".")[1] ?? "";
}

/** The id an archived app takes on this server: the importing account is its creator. */
export function localServiceId(serverFqdn: string, archivedServiceId: string): string {
  const id = parseServiceId(archivedServiceId);
  const host = hostAccount(serverFqdn);
  return id && host ? `${host}--${id.slug}` : archivedServiceId;
}

async function installOne(
  deps: ArchiveRestoreDeps,
  dir: string,
  meta: ArchiveAppMeta,
  log: (m: string) => void,
): Promise<RestoreAppResult> {
  const now = deps.now ?? (() => Date.now());
  const sid = localServiceId(deps.serverFqdn, meta.serviceId);
  const result: RestoreAppResult = { serviceId: sid, name: meta.name, state: "restoring" };
  if (deps.platform.byServiceId(sid)) {
    return { ...result, state: "skipped", reason: "already on this server" };
  }
  const held: Held = {};
  let installed = false;
  const path = (part: string): string | undefined => {
    const p = meta.parts.find((x) => x.name === part);
    return p ? join(dir, p.file) : undefined;
  };
  try {
    const manifest = JSON.parse(meta.manifestJson) as { runtime: { image: string }; network?: Parameters<typeof egressSuggestions>[0] };
    let image = manifest.runtime.image;
    if (meta.rebuild === "source") {
      if (!deps.sourceDir) throw new Error("this server can't rebuild apps (no working-tree folder)");
      const tree = await readTree(path("source")!);
      image = `flagship-vibe-${sid}:${now()}`.toLowerCase();
      held.tree = join(deps.sourceDir, sid);
      held.image = image;
      const built = await deps.buildImage({ contextDir: held.tree, files: tree.files, binaries: tree.binaries, image });
      if (!built.ok) throw new Error(`rebuilding it here failed: ${built.reason}`);
    } else if (!(await deps.ops.imageExists(image))) {
      held.image = image;
      await deps.pullImage(image);
    }
    if (!(await deps.ops.imageExists(image))) throw new Error(`its image ${image} isn't here after ${meta.rebuild === "source" ? "the build" : "the pull"}`);
    const manifestJson = JSON.stringify({ ...(JSON.parse(meta.manifestJson) as object), runtime: { ...manifest.runtime, image } });

    if (Object.keys(meta.env).length > 0) {
      if (!deps.envStore) {
        result.pendingEnv = Object.keys(meta.env).sort();
      } else {
        held.env = true;
        const clean = Object.fromEntries(
          Object.entries(meta.env).filter(([k, v]) => typeof v === "string" && !k.startsWith("FLAGSHIP_")),
        );
        await deps.envStore.put(sid, clean);
      }
    }

    const id = parseServiceId(sid)!;
    const request: InstallServiceRequest = {
      serverId: deps.serverFqdn,
      creator: id.creator,
      slug: id.slug,
      manifestJson,
      addOwnerToMembership: false,
      issuedAt: now(),
    };
    const installResult = await deps.platform.install({
      request,
      signature: deps.signInstall(request),
      verify: verifyInstallService,
      appliedMigrations: meta.appliedMigrations,
      ...(meta.membership ? { membership: meta.membership as never } : {}),
      prepareData: async (data) => {
        held.postgres = Object.fromEntries(Object.entries(data?.postgres ?? {}).map(([k, v]) => [k, { database: v.database, role: v.role }]));
        if (data?.files) held.filesVolume = data.files.volume;
        for (const p of meta.parts) {
          if (p.name.startsWith("db:") && !data?.postgres?.[p.name.slice(3)]) throw new Error(`no database ${p.name.slice(3)} here`);
          if (p.name === "files" && !data?.files) throw new Error("no files folder here");
        }
        for (const [store, cred] of Object.entries(data?.postgres ?? {})) {
          const dump = path(`db:${store}`);
          if (dump) await deps.ops.restoreDatabase(cred, dump);
        }
        const files = path("files");
        if (files && data?.files) await deps.ops.restoreFiles(data.files.volume, files);
      },
    });
    delete held.postgres;
    delete held.filesVolume;
    if (!installResult.ok) throw new Error(installResult.reason);
    installed = true;

    if (meta.access && deps.access) {
      await deps.access.importEntry(sid, meta.access).catch((e: Error) => log(`[server-archive] ${sid}: couldn't take the members' access: ${e.message}`));
    }
    // A pulled app's tree, when it had one, still comes along so it can be edited here.
    const tree = path("source");
    if (tree && deps.sourceDir && meta.rebuild !== "source") {
      await writeTree(join(deps.sourceDir, sid), tree).catch((e: Error) =>
        log(`[server-archive] ${sid}: couldn't write its working tree (it runs, but can't be edited here): ${e.message}`),
      );
    }
    if (deps.apiKeys && Array.isArray(meta.apiKeys) && meta.apiKeys.length > 0) {
      const r = await deps.apiKeys.importService(sid, meta.apiKeys).catch((e: Error) => {
        log(`[server-archive] ${sid}: couldn't take its API keys: ${e.message}`);
        return null;
      });
      if (r && r.dropped > 0) log(`[server-archive] ${sid}: ${r.dropped} API key(s) no longer verify; left out`);
    }
    if (meta.accessList && deps.egress) {
      await deps.egress.noteCopied(sid, meta.accessList, egressSuggestions(manifest.network)).catch(() => {});
    }
    return { ...result, state: "done" };
  } catch (e) {
    if (!installed) await release(deps, sid, held, log);
    return { ...result, state: "failed", reason: (e as Error).message };
  }
}

async function readTree(path: string): Promise<{ files: Record<string, string>; binaries: Record<string, Buffer> }> {
  const t = JSON.parse(await readFile(path, "utf8")) as Partial<CopySourceTree>;
  const strings = (v: unknown): v is Record<string, string> => typeof v === "object" && v !== null && Object.values(v).every((x) => typeof x === "string");
  if (!strings(t.files) || !strings(t.binaries)) throw new Error("malformed working tree");
  return { files: t.files, binaries: Object.fromEntries(Object.entries(t.binaries).map(([k, v]) => [k, Buffer.from(v, "base64")])) };
}

async function writeTree(appDir: string, path: string): Promise<void> {
  const t = await readTree(path);
  const w = await writeSourceTree(appDir, t.files, { binaries: t.binaries });
  if (!w.ok) throw new Error(`unsafe path ${w.unsafePath}`);
}

async function release(deps: ArchiveRestoreDeps, serviceId: string, held: Held, log: (m: string) => void): Promise<void> {
  const id = parseServiceId(serviceId);
  if (deps.dataProvisioner && id && (held.filesVolume || Object.keys(held.postgres ?? {}).length > 0)) {
    await deps.dataProvisioner
      .dropCredentials({
        creator: id.creator,
        slug: id.slug,
        ...(held.postgres ? { postgres: Object.fromEntries(Object.entries(held.postgres).map(([k, v]) => [k, { ...v, url: "" }])) } : {}),
        ...(held.filesVolume ? { files: { volume: held.filesVolume } } : {}),
      })
      .catch((e: Error) => log(`[server-archive] ${serviceId}: couldn't drop the stores: ${e.message}`));
  }
  if (held.env && deps.envStore) await deps.envStore.forget(serviceId).catch(() => {});
  if (held.image) await deps.ops.removeImage(held.image).catch(() => {});
  if (held.tree) await rm(held.tree, { recursive: true, force: true }).catch(() => {});
}

/** Install every app of an unpacked archive; one failing app doesn't stop the rest. */
export async function installArchive(
  deps: ArchiveRestoreDeps,
  dir: string,
  contents: ArchiveContents,
  onUpdate: (results: RestoreAppResult[]) => void,
): Promise<RestoreAppResult[]> {
  const log = deps.log ?? (() => {});
  const results: RestoreAppResult[] = contents.metas.map((m) => ({ serviceId: m.serviceId, name: m.name, state: "waiting" as const }));
  onUpdate(results);
  for (const [i, meta] of contents.metas.entries()) {
    results[i] = { ...results[i]!, state: "restoring" };
    onUpdate(results);
    results[i] = await installOne(deps, dir, meta, log);
    onUpdate(results);
    log(`[server-archive] ${meta.serviceId}: ${results[i]!.state}${results[i]!.reason ? ` (${results[i]!.reason})` : ""}`);
    // Free this app's scratch as soon as it is in.
    await rm(join(dir, "apps", meta.serviceId), { recursive: true, force: true }).catch(() => {});
  }
  // The front page, when this server has none and the app came back here.
  // A label of the form `<slug>-<creator>` named a cross-creator app on the old
  // server; here the app is the importing account's own, so its label is the slug.
  const fpRaw = contents.manifest.frontPage;
  const fp = fpRaw
    ? (contents.metas.find((m) => fpRaw === `${m.slug}-${m.creator}` && m.creator !== hostAccount(deps.serverFqdn))?.slug ?? fpRaw)
    : fpRaw;
  if (fp && deps.frontPage && !deps.frontPage.get() && deps.frontPage.installed(fp)) {
    await deps.frontPage.set(fp).catch((e: Error) => log(`[server-archive] couldn't set the front page: ${e.message}`));
  }
  return results;
}

export async function listScratch(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}
