/**
 * The TARGET side of copying an app from another of the owner's servers
 * (docs/app-placement.md §5).
 *
 *   POST /api/screens/services/copy  { grant:{sourceServer, targetServer, serviceId, issuedAt}, signature }
 *        → 202 { copyId } | 400 malformed | 403 bad signature / not this box / stale | 409 already here or copying
 *   GET  /api/screens/services/copies
 *        → { copies:[{copyId, serviceId, appName, sourceServer, state, progress?, reason?, startedAt, pendingEnv?}] }
 *
 * Owner sessions only. The order is the owner's `flagship/app-copy/v1`
 * (sensitive-order authority, at most 10 minutes old, one use). The box then
 * fetches the bundle from the source (appCopy/source.ts), signing each request
 * with its identity key, checks every part's SHA-256, loads the image, writes
 * the env when it could be opened (else the names wait as `pendingEnv`), and
 * installs the app under the same service id: fresh stores, restored from the
 * dumps before the container first starts, then the start check, and its
 * working tree when it was built on the source (so it can be edited here). The source's
 * members come along; its access list becomes a draft; API keys stay behind.
 * A failure leaves nothing: the install drops the stores it made, and the
 * copy removes the image it loaded, the env it wrote and its downloads.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  egressSuggestions,
  isLanAddress,
  parseAppCopyGrant,
  parseManifest,
  parseServiceId,
  verifyAppCopyGrant,
  verifyInstallService,
  type AppCopyGrant,
  type Bytes,
  type InstallServiceRequest,
  type LanEndpoint,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import type { SensitiveAuthority } from "../egress/approvals.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { ServicePlatform } from "../servicePlatform.js";
import type { AppDataCredentials } from "../dataLayer/provisioner.js";
import type { AppEnvStore } from "../serviceEnvStore.js";
import { writeSourceTree } from "../llm/serviceSource.js";
import type { AppCopyOps } from "./ops.js";
import { makeLanFetch, type LanFetch } from "./lanFetch.js";
import { AppCopyStore, type CopyHeld, type CopyRecord } from "./store.js";
import {
  APP_COPY_CHUNK_BYTES,
  APP_COPY_EXPORT_PATH,
  APP_COPY_PARALLEL,
  COPY_ENCODINGS,
  PART_RE,
  fetchEnvelopeBytes,
  fromHex,
  openCopyEnv,
  sameAccount,
  toHex,
  type CopyAccessEntry,
  type CopyEnvKey,
  type CopyMeta,
  type CopySourceTree,
} from "./wire.js";

export const COPY_PATH = "/api/screens/services/copy";
export const COPIES_PATH = "/api/screens/services/copies";
export const COPY_GRANT_MAX_SKEW_MS = 10 * 60_000;

export function isAppCopyPath(path: string): boolean {
  return path === COPY_PATH || path === COPIES_PATH;
}

export interface AppCopyTargetOptions extends SensitiveAuthority {
  serverFqdn: string;
  platform: Pick<ServicePlatform, "byServiceId" | "install" | "whenRegistryLoaded">;
  dataProvisioner: { dropCredentials(c: AppDataCredentials): Promise<void> } | null;
  store: AppCopyStore;
  ops: AppCopyOps;
  /** The box identity key (signs each fetch, as `.com`'s directory knows it). */
  signAsBox: (msg: Bytes) => Bytes;
  /** Signs the install as the box (an additive host signer, like a build's deploy). */
  signInstall: (req: InstallServiceRequest) => Bytes;
  /** Downloads land here, one folder per copy. */
  workDir: string;
  /** Where an app's working tree goes (`<dataDir>/data/app-clones`), so it can be edited here too. */
  sourceDir?: string | null;
  /** The account-shared env key (from the CGK); null ⇒ env names wait as pendingEnv. */
  envKey: CopyEnvKey | null;
  envStore: AppEnvStore | null;
  access: { importEntry(serviceId: string, e: CopyAccessEntry): Promise<void> } | null;
  egress: { noteCopied(serviceId: string, list: string, declared: ReturnType<typeof egressSuggestions>): Promise<void> } | null;
  /** Each order starts one copy, remembered across restarts (DbWriteLedger). */
  ledger: { claim(key: string): Promise<boolean> };
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;
  /** `https://<server>` by default. */
  baseUrl?: (server: string) => string;
  /** Fetch over the source's LAN listener; null ⇒ always the relay. */
  lanFetch?: LanFetch | null;
  /** This box's own LAN addresses (to prefer a source address on the same subnet). */
  ownLanAddresses?: () => string[];
  /** Whether `bytes` of app may come onto this server (the backup policy's limit): null, or why not. */
  admitIncoming?: (bytes: number) => string | null;
  pollMs?: number;
  /** How long the source may take to make the bundle. Default 60 min. */
  prepareTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}

const J = { "content-type": "application/json" } as const;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

/** Where the progress bar stands at each step (0..1). */
const P = { meta: 0.02, fetchStart: 0.05, fetchEnd: 0.8, image: 0.85, start: 0.9 } as const;

class CopyFailed extends Error {}

/** How one copy reaches its source: the LAN endpoint while it works, else the relay. */
interface Route {
  lan: LanEndpoint | null;
  /** Data chunks that came over the LAN. */
  lanChunks: number;
}

/**
 * A local address of the source to try: one on this box's own /24 (or /64)
 * first. Never one of this box's own addresses: every box can carry the same
 * private address on an internal bridge, and dialling it reaches this box.
 */
export function pickLanEndpoint(offered: unknown, own: string[]): LanEndpoint | null {
  if (!Array.isArray(offered)) return null;
  const self = new Set(own.map((a) => a.toLowerCase()));
  const ok = offered.filter(
    (e): e is LanEndpoint =>
      typeof e?.address === "string" &&
      isLanAddress(e.address) &&
      !self.has(e.address.toLowerCase()) &&
      Number.isInteger(e.port) &&
      e.port > 0 &&
      e.port < 65536,
  );
  const prefix = (a: string) => (a.includes(":") ? a.split(":").slice(0, 4).join(":") : a.split(".").slice(0, 3).join("."));
  const mine = new Set(own.map(prefix));
  return ok.find((e) => mine.has(prefix(e.address))) ?? ok[0] ?? null;
}

export function buildAppCopyTarget(opts: AppCopyTargetOptions) {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
  const baseUrl = opts.baseUrl ?? ((s: string) => `https://${s}`);
  const pollMs = opts.pollMs ?? 2000;
  const lanFetch = opts.lanFetch === undefined ? makeLanFetch() : opts.lanFetch;
  const authority = {
    ownerIrkPub: opts.ownerIrkPub,
    ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
    username: opts.username,
    ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
  };
  const running = new Set<Promise<void>>();
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
  const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { error, ...extra });

  async function post(grant: AppCopyGrant, signature: string, part: string, offset: number, route?: Route): Promise<Response> {
    const issuedAt = now();
    const auth = opts.signAsBox(
      fetchEnvelopeBytes({
        from: opts.serverFqdn,
        to: grant.sourceServer,
        serviceId: grant.serviceId,
        grantIssuedAt: grant.issuedAt,
        grantSignature: signature,
        part,
        offset,
        issuedAt,
      }),
    );
    const url = `${baseUrl(grant.sourceServer)}${APP_COPY_EXPORT_PATH}`;
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: opts.serverFqdn, grant, signature, part, offset, issuedAt, auth: toHex(auth), accept: COPY_ENCODINGS }),
      signal: AbortSignal.timeout(5 * 60_000),
    };
    const lan = route?.lan;
    if (lan && lanFetch) {
      try {
        const res = await lanFetch(lan, url, init);
        if (res.status === 200 && part !== "meta" && part !== "done") route.lanChunks++;
        return res;
      } catch (e) {
        if (route.lan) log(`[app-copy] ${grant.serviceId}: ${grant.sourceServer} isn't answering on the local network (${(e as Error).message}); using the relay`);
        route.lan = null;
      }
    }
    return fetchImpl(url, init);
  }

  async function refusal(res: Response): Promise<string> {
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b.error === "string") return `the source server said: ${b.error}`;
    } catch {
      // not JSON
    }
    return `the source server answered ${res.status}`;
  }

  async function fetchMeta(grant: AppCopyGrant, signature: string): Promise<CopyMeta> {
    const deadline = now() + (opts.prepareTimeoutMs ?? 60 * 60_000);
    for (;;) {
      const res = await post(grant, signature, "meta", 0);
      if (res.status === 200) return validMeta((await res.json()) as unknown, grant);
      if (res.status !== 202) throw new CopyFailed(await refusal(res));
      await res.body?.cancel().catch(() => {});
      if (now() > deadline) throw new CopyFailed("the source server took too long to make the copy");
      await sleep(pollMs);
    }
  }

  function validMeta(v: unknown, grant: AppCopyGrant): CopyMeta {
    const m = v as Partial<CopyMeta> | null;
    const bad = (why: string): never => {
      throw new CopyFailed(`the source server sent a malformed copy (${why})`);
    };
    if (!m || m.v !== 1) bad("version");
    if (m!.serviceId !== grant.serviceId) bad("another app");
    const id = parseServiceId(grant.serviceId);
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
    if (!Array.isArray(m!.parts)) bad("parts");
    const seen = new Set<string>();
    for (const p of m!.parts!) {
      if (typeof p?.name !== "string" || !PART_RE.test(p.name) || ["meta", "done"].includes(p.name) || seen.has(p.name)) bad("part name");
      if (!Number.isSafeInteger(p.bytes) || p.bytes < 0) bad("part size");
      if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) bad("part hash");
      if (p.encoding !== undefined && !COPY_ENCODINGS.includes(p.encoding)) bad("part encoding");
      seen.add(p.name);
    }
    if (!seen.has("image")) bad("no image");
    if (!Array.isArray(m!.appliedMigrations) || m!.appliedMigrations!.some((x) => typeof x !== "string")) bad("migrations");
    if (!m!.env || !Array.isArray(m!.env.names) || m!.env.names.some((x) => typeof x !== "string")) bad("env");
    if (m!.accessList !== null && typeof m!.accessList !== "string") bad("access list");
    return m as CopyMeta;
  }

  /** Fetch a part into `path`, APP_COPY_PARALLEL chunks at a time, and check it whole. */
  async function download(
    grant: AppCopyGrant,
    signature: string,
    part: CopyMeta["parts"][number],
    path: string,
    onBytes: (n: number) => void,
    route: Route,
  ): Promise<void> {
    const fh = await open(path, "w", 0o600);
    try {
      const starts: number[] = [];
      for (let o = 0; o < part.bytes; o += APP_COPY_CHUNK_BYTES) starts.push(o);
      const fetchRange = async (start: number): Promise<void> => {
        const end = Math.min(start + APP_COPY_CHUNK_BYTES, part.bytes);
        for (let offset = start; offset < end; ) {
          const res = await post(grant, signature, part.name, offset, route);
          if (res.status !== 200) throw new CopyFailed(await refusal(res));
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length === 0 || offset + buf.length > end) throw new CopyFailed(`the source server sent a bad piece of ${part.name}`);
          await fh.write(buf, 0, buf.length, offset);
          offset += buf.length;
          onBytes(buf.length);
        }
      };
      let failed: unknown = null;
      const worker = async () => {
        while (failed === null && starts.length > 0) {
          try {
            await fetchRange(starts.shift()!);
          } catch (e) {
            failed ??= e;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(APP_COPY_PARALLEL, starts.length) }, worker));
      if (failed !== null) throw failed;
    } finally {
      await fh.close();
    }
    if ((await sha256File(path)) !== part.sha256) throw new CopyFailed(`${part.name} arrived damaged`);
  }

  /** A part as the box uses it: unzipped next to the download when it came gzipped. */
  async function decoded(part: CopyMeta["parts"][number], path: string): Promise<string> {
    if (part.encoding !== "gzip") return path;
    const out = `${path}.raw`;
    try {
      await pipeline(createReadStream(path), createGunzip(), createWriteStream(out, { mode: 0o600 }));
    } catch {
      throw new CopyFailed(`${part.name} arrived damaged (it doesn't unzip)`);
    } finally {
      await rm(path, { force: true });
    }
    return out;
  }

  async function holdNames(rec: CopyRecord, held: CopyHeld): Promise<void> {
    await opts.store.update(rec.copyId, { held: { ...held } });
  }

  async function run(rec: CopyRecord, grant: AppCopyGrant, signature: string): Promise<void> {
    const dir = join(opts.workDir, rec.copyId);
    const held: CopyHeld = {};
    let installed = false;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      opts.store.setProgress(rec.copyId, P.meta);
      const meta = await fetchMeta(grant, signature);
      const manifest = JSON.parse(meta.manifestJson) as { name?: unknown; runtime: { image: string }; network?: Parameters<typeof egressSuggestions>[0] };
      const appName = typeof manifest.name === "string" ? manifest.name : rec.appName;
      await opts.store.update(rec.copyId, { appName });

      const route: Route = { lan: lanFetch ? pickLanEndpoint(meta.lan, opts.ownLanAddresses?.() ?? []) : null, lanChunks: 0 };
      if (route.lan) log(`[app-copy] ${grant.serviceId}: fetching from ${grant.sourceServer} on the local network`);
      const total = meta.parts.reduce((n, p) => n + p.bytes, 0);
      const capRefusal = opts.admitIncoming?.(total) ?? null;
      if (capRefusal) throw new Error(capRefusal);
      let got = 0;
      const files = new Map<string, string>();
      opts.store.setProgress(rec.copyId, P.fetchStart);
      for (const [i, part] of meta.parts.entries()) {
        const path = join(dir, `part-${i}`);
        await download(grant, signature, part, path, (n) => {
          got += n;
          opts.store.setProgress(rec.copyId, P.fetchStart + (P.fetchEnd - P.fetchStart) * (total > 0 ? got / total : 1));
        }, route);
        files.set(part.name, await decoded(part, path));
      }
      void post(grant, signature, "done", 0, route).then(
        (r) => r.body?.cancel().catch(() => {}),
        () => {},
      );

      await opts.store.update(rec.copyId, { state: "installing" });
      opts.store.setProgress(rec.copyId, P.fetchEnd);
      if (opts.platform.byServiceId(grant.serviceId)) throw new CopyFailed("the app was installed here while it was being copied");
      const image = manifest.runtime.image;
      const existed = await opts.ops.imageExists(image);
      if (!existed) {
        held.image = image;
        await holdNames(rec, held);
      }
      await opts.ops.loadImage(files.get("image")!);
      if (!(await opts.ops.imageExists(image))) throw new CopyFailed(`the copied image didn't load as ${image}`);
      opts.store.setProgress(rec.copyId, P.image);

      let pendingEnv: string[] = [];
      if (meta.env.names.length > 0) {
        const env =
          meta.env.sealed && opts.envKey
            ? openCopyEnv(meta.env.sealed, opts.envKey, {
                sourceServer: grant.sourceServer,
                targetServer: grant.targetServer,
                serviceId: grant.serviceId,
                grantIssuedAt: grant.issuedAt,
              })
            : null;
        if (env && opts.envStore) {
          const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("FLAGSHIP_")));
          held.env = true;
          await holdNames(rec, held);
          await opts.envStore.put(grant.serviceId, clean);
        } else {
          pendingEnv = [...meta.env.names].sort();
        }
      }

      const id = parseServiceId(grant.serviceId)!;
      const request: InstallServiceRequest = {
        serverId: opts.serverFqdn,
        creator: id.creator,
        slug: id.slug,
        manifestJson: meta.manifestJson,
        addOwnerToMembership: false,
        issuedAt: now(),
      };
      const result = await opts.platform.install({
        request,
        signature: opts.signInstall(request),
        verify: verifyInstallService,
        appliedMigrations: meta.appliedMigrations,
        ...(meta.membership ? { membership: meta.membership } : {}),
        prepareData: async (data) => {
          held.postgres = Object.fromEntries(
            Object.entries(data?.postgres ?? {}).map(([k, v]) => [k, { database: v.database, role: v.role }]),
          );
          if (data?.files) held.filesVolume = data.files.volume;
          await holdNames(rec, held);
          for (const name of files.keys()) {
            if (name.startsWith("db:") && !data?.postgres?.[name.slice(3)]) throw new Error(`no database ${name.slice(3)} here`);
            if (name === "files" && !data?.files) throw new Error("no files folder here");
          }
          for (const [store, cred] of Object.entries(data?.postgres ?? {})) {
            const path = files.get(`db:${store}`);
            if (path) await opts.ops.restoreDatabase(cred, path);
          }
          const filesPath = files.get("files");
          if (filesPath && data?.files) await opts.ops.restoreFiles(data.files.volume, filesPath);
          opts.store.setProgress(rec.copyId, P.start);
        },
      });
      // The install drops what it made when it fails.
      delete held.postgres;
      delete held.filesVolume;
      if (!result.ok) throw new CopyFailed(result.reason);
      installed = true;

      if (meta.access && opts.access) {
        await opts.access.importEntry(grant.serviceId, meta.access).catch((e: Error) =>
          log(`[app-copy] ${grant.serviceId}: couldn't take the members' access: ${e.message}`),
        );
      }
      const tree = files.get("source");
      if (tree && opts.sourceDir) {
        await writeTree(join(opts.sourceDir, grant.serviceId), tree).catch((e: Error) =>
          log(`[app-copy] ${grant.serviceId}: couldn't write its working tree (it runs, but can't be edited here): ${e.message}`),
        );
      }
      if (meta.accessList && opts.egress) {
        await opts.egress.noteCopied(grant.serviceId, meta.accessList, egressSuggestions(manifest.network)).catch(() => {});
      }
      await opts.store.update(rec.copyId, {
        state: "done",
        progress: undefined,
        finishedAt: now(),
        held: undefined,
        route: route.lanChunks > 0 ? "lan" : "relay",
        ...(pendingEnv.length > 0 ? { pendingEnv } : {}),
      });
      log(`[app-copy] ${grant.serviceId}: copied from ${grant.sourceServer}`);
    } catch (e) {
      const reason = e instanceof CopyFailed ? e.message : `the copy failed: ${(e as Error).message}`;
      if (!installed) await release(grant.serviceId, held);
      await opts.store.update(rec.copyId, { state: "failed", reason, progress: undefined, finishedAt: now(), held: undefined });
      log(`[app-copy] ${grant.serviceId}: ${reason}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function writeTree(appDir: string, path: string): Promise<void> {
    const t = JSON.parse(await readFile(path, "utf8")) as Partial<CopySourceTree>;
    const strings = (v: unknown): v is Record<string, string> =>
      typeof v === "object" && v !== null && Object.values(v).every((x) => typeof x === "string");
    if (!strings(t.files) || !strings(t.binaries)) throw new Error("malformed working tree");
    const binaries = Object.fromEntries(Object.entries(t.binaries).map(([k, v]) => [k, Buffer.from(v, "base64")]));
    const w = await writeSourceTree(appDir, t.files, { binaries });
    if (!w.ok) throw new Error(`unsafe path ${w.unsafePath}`);
  }

  /** Remove what a copy that didn't finish left on this box. */
  async function release(serviceId: string, held: CopyHeld): Promise<void> {
    const id = parseServiceId(serviceId);
    if (opts.dataProvisioner && id && (held.filesVolume || Object.keys(held.postgres ?? {}).length > 0)) {
      await opts.dataProvisioner
        .dropCredentials({
          creator: id.creator,
          slug: id.slug,
          ...(held.postgres
            ? { postgres: Object.fromEntries(Object.entries(held.postgres).map(([k, v]) => [k, { ...v, url: "" }])) }
            : {}),
          ...(held.filesVolume ? { files: { volume: held.filesVolume } } : {}),
        })
        .catch((e: Error) => log(`[app-copy] ${serviceId}: couldn't drop the copy's stores: ${e.message}`));
    }
    if (held.env && opts.envStore) await opts.envStore.forget(serviceId).catch(() => {});
    if (held.image) await opts.ops.removeImage(held.image).catch(() => {});
  }

  async function postCopy(req: HttpRequest): Promise<HttpResponse> {
    let body: { grant?: unknown; signature?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8")) as typeof body;
    } catch {
      return err(400, "invalid json");
    }
    const grant = parseAppCopyGrant(body?.grant);
    if (!grant) return err(400, "malformed grant");
    if (typeof body.signature !== "string") return err(400, "signature required");
    const sig = fromHex(body.signature);
    if (!sig || sig.length !== 64) return err(400, "invalid signature hex");
    if (!parseServiceId(grant.serviceId)) return err(400, "bad service id");
    if (grant.sourceServer === grant.targetServer) return err(400, "the source and the target are the same server");
    if (grant.targetServer !== opts.serverFqdn) return err(403, "the order is for a different server");
    if (!sameAccount(grant.sourceServer, opts.serverFqdn)) return err(403, "the source isn't one of this account's servers");
    if (Math.abs(now() - grant.issuedAt) > COPY_GRANT_MAX_SKEW_MS) return err(403, "the order is stale: sign it again");
    if (!authorizeSensitiveOrder({ ...authority, order: grant, signature: sig, verify: verifyAppCopyGrant })) {
      return err(403, "invalid signature");
    }
    if (opts.platform.byServiceId(grant.serviceId)) return err(409, "the app is already on this server");
    if (opts.store.active(grant.serviceId)) return err(409, "the app is already being copied here");
    const signature = body.signature.toLowerCase();
    if (!(await opts.ledger.claim(`${grant.sourceServer}|${grant.serviceId}|${grant.issuedAt}|${signature}`))) {
      return err(409, "this signed order was already used: sign it again");
    }
    const id = parseServiceId(grant.serviceId)!;
    const rec: CopyRecord = {
      copyId: randomBytes(12).toString("hex"),
      serviceId: grant.serviceId,
      appName: id.slug,
      sourceServer: grant.sourceServer,
      state: "copying",
      progress: 0,
      startedAt: now(),
    };
    await opts.store.create(rec);
    const p = run(rec, grant, signature);
    running.add(p);
    void p.finally(() => running.delete(p));
    return json(202, { copyId: rec.copyId });
  }

  function view(r: CopyRecord) {
    return {
      copyId: r.copyId,
      serviceId: r.serviceId,
      appName: r.appName,
      sourceServer: r.sourceServer,
      state: r.state,
      ...(r.progress !== undefined ? { progress: Math.round(r.progress * 100) / 100 } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.route ? { route: r.route } : {}),
      startedAt: r.startedAt,
      ...(r.pendingEnv && r.pendingEnv.length > 0 ? { pendingEnv: r.pendingEnv } : {}),
    };
  }

  return {
    /** Runs behind the paired-session gate (screensHttp). */
    async handle(path: string, method: string, req: HttpRequest, ctx: { companion: boolean }): Promise<HttpResponse | null> {
      if (!isAppCopyPath(path)) return null;
      if (ctx.companion) {
        return err(403, "companion sessions can't copy apps: open your owner app", { code: "companion-write-not-allowed" });
      }
      if (path === COPY_PATH) return method === "POST" ? postCopy(req) : err(405, "method not allowed");
      if (method !== "GET") return err(405, "method not allowed");
      return json(200, { copies: opts.store.list().map(view) });
    },

    /** Copies underway, as rows of the apps list (greyed out, with progress). */
    inProgress(hostUsername: string) {
      return opts.store
        .list()
        .filter((r) => (r.state === "copying" || r.state === "installing") && !opts.platform.byServiceId(r.serviceId))
        .map((r) => {
          const id = parseServiceId(r.serviceId)!;
          const urlLabel = ServicePlatform.urlLabel(hostUsername, id.creator, id.slug);
          return {
            serviceId: r.serviceId,
            creator: id.creator,
            slug: id.slug,
            name: r.appName,
            urlLabel,
            url: `https://${urlLabel}.${opts.serverFqdn}`,
            status: "unknown" as const,
            installedAt: r.startedAt,
            copying: {
              state: r.state as "copying" | "installing",
              progress: Math.round((r.progress ?? 0) * 100) / 100,
            },
          };
        });
    },

    /**
     * After a restart: what the interrupted copies left behind. A copy whose
     * install had finished (the app is back in the list) is marked done.
     */
    async recover(interrupted: CopyRecord[]): Promise<void> {
      await rm(opts.workDir, { recursive: true, force: true }).catch(() => {});
      if (interrupted.length === 0) return;
      await opts.platform.whenRegistryLoaded();
      for (const r of interrupted) {
        if (opts.platform.byServiceId(r.serviceId)) {
          await opts.store.update(r.copyId, { state: "done", reason: undefined, held: undefined });
          continue;
        }
        await release(r.serviceId, r.held ?? {});
        await opts.store.update(r.copyId, { held: undefined });
        log(`[app-copy] ${r.serviceId}: ${r.reason ?? "interrupted"}; cleaned up`);
      }
    },

    /** Wait for copies underway (tests, shutdown). */
    async settle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}

export type AppCopyTarget = ReturnType<typeof buildAppCopyTarget>;

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src: AsyncIterable<Buffer>) {
    for await (const d of src) h.update(d);
  });
  return h.digest("hex");
}
