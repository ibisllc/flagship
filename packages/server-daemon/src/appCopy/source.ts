/**
 * The SOURCE side of copying an app to another server (docs/app-placement.md
 * §5): `POST /api/app-copy/export` on the box's public HTTPS surface.
 *
 * Every request must come from the box the owner's order names as target:
 * signed with that box's identity key as `.com`'s server directory holds it
 * (revoked boxes resolve to nothing), a server of the same account, carrying
 * an order that verifies under this box's sensitive-order authority and names
 * THIS box as source. The first `meta` opens the export (the order is at most
 * 15 minutes old, and opens one export only) and starts making the bundle in a
 * private folder: the image (`docker save`), a consistent dump of each of the
 * app's databases and of its files folder, its working tree when it was built
 * here, its members, its owner env (sealed
 * under the account key, or just the names) and its signed access list. API
 * keys are never part of it. The app itself is untouched, apart from a pause
 * while its files folder is read. The folder is deleted when the target says
 * `done`, after 30 idle minutes, and at every start of the daemon.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createGzip } from "node:zlib";
import { ed, parseAppCopyGrant, verifyAppCopyGrant, type AppCopyGrant, type Bytes, type LanEndpoint } from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import type { SensitiveAuthority } from "../egress/approvals.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { InstalledService } from "../servicePlatform.js";
import type { AppEnvStore } from "../serviceEnvStore.js";
import { readCarriedBinaries, readServiceSource } from "../llm/serviceSource.js";
import type { AppCopyOps } from "./ops.js";
import {
  APP_COPY_CHUNK_BYTES,
  APP_COPY_EXPORT_PATH,
  PART_RE,
  fetchEnvelopeBytes,
  fromHex,
  sameAccount,
  sealCopyEnv,
  type CopyAccessEntry,
  type CopyEnvKey,
  type CopyMeta,
  type CopySourceTree,
} from "./wire.js";

export const EXPORT_GRANT_MAX_AGE_MS = 15 * 60_000;
export const EXPORT_REQUEST_MAX_SKEW_MS = 5 * 60_000;
export const EXPORT_IDLE_MS = 30 * 60_000;

export interface AppCopySourceOptions extends SensitiveAuthority {
  serverFqdn: string;
  app: (serviceId: string) => InstalledService | undefined;
  /** The container an app runs as (paused while its files folder is read). */
  containerName: (serviceId: string) => string;
  ops: AppCopyOps;
  /** A caller's directory-bound identity key (`.com`), null when unknown or revoked. */
  resolveCallerKey: (serverId: string) => Promise<Bytes | null>;
  /** Where bundles are made; emptied at start. */
  workDir: string;
  /** The account-shared env key (from the CGK); null ⇒ env goes as names only. */
  envKey: CopyEnvKey | null;
  envStore: AppEnvStore | null;
  access: { exportEntry(serviceId: string): CopyAccessEntry | null } | null;
  accessList: ((serviceId: string) => string | null) | null;
  /** Where apps built here keep their working tree (`<dataDir>/data/app-clones`); null ⇒ none sent. */
  sourceDir?: string | null;
  /** Each order opens one export, remembered across restarts (DbWriteLedger). */
  ledger: { claim(key: string): Promise<boolean> };
  /** The LAN-direct listener's addresses, offered to the target in the description. */
  lanEndpoints?: () => LanEndpoint[];
  now?: () => number;
  log?: (m: string) => void;
}

interface ExportSession {
  key: string;
  dir: string;
  target: string;
  state: "preparing" | "ready" | "failed";
  meta?: CopyMeta;
  error?: string;
  files: Map<string, string>;
  lastUsed: number;
  /** The target can open gzipped parts. */
  gzip: boolean;
}

const J = { "content-type": "application/json" } as const;

export function buildAppCopySource(opts: AppCopySourceOptions) {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const sessions = new Map<string, ExportSession>();
  const authority = {
    ownerIrkPub: opts.ownerIrkPub,
    ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
    username: opts.username,
    ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
  };
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
  const err = (status: number, error: string) => json(status, { error });

  async function sweep(): Promise<void> {
    const t = now();
    for (const s of [...sessions.values()]) {
      if (s.state !== "preparing" && s.lastUsed < t - EXPORT_IDLE_MS) await close(s);
    }
  }

  async function close(s: ExportSession): Promise<void> {
    sessions.delete(s.key);
    await rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }

  async function prepare(s: ExportSession, app: InstalledService, grant: AppCopyGrant): Promise<void> {
    await mkdir(s.dir, { recursive: true, mode: 0o700 });
    const parts: CopyMeta["parts"] = [];
    const add = async (name: string, raw: string, compressible = true) => {
      const gz = s.gzip && compressible;
      const path = gz ? await gzipFile(raw) : raw;
      parts.push({ name, bytes: (await stat(path)).size, sha256: await sha256File(path), ...(gz ? { encoding: "gzip" as const } : {}) });
      s.files.set(name, path);
    };
    const image = join(s.dir, "image.tar");
    await opts.ops.saveImage(app.manifest.runtime.image, image);
    await add("image", image);
    for (const [store, cred] of Object.entries(app.data?.postgres ?? {})) {
      const out = join(s.dir, `db-${parts.length}.dump`);
      await opts.ops.dumpDatabase(cred, out);
      await add(`db:${store}`, out, false);
    }
    if (app.data?.files) {
      const out = join(s.dir, "files.tar");
      await opts.ops.archiveFiles(app.data.files.volume, opts.containerName(app.serviceId), out);
      await add("files", out);
    }
    if (opts.sourceDir) {
      const tree = await readServiceSource(opts.sourceDir, app.serviceId);
      if (tree.ok) {
        const binaries = await readCarriedBinaries(join(opts.sourceDir, app.serviceId));
        const body: CopySourceTree = {
          files: tree.files,
          binaries: Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, v.toString("base64")])),
        };
        const out = join(s.dir, "source.json");
        await writeFile(out, JSON.stringify(body), { mode: 0o600 });
        await add("source", out);
      }
    }
    const env = opts.envStore ? ((await opts.envStore.get(app.serviceId).catch(() => null)) ?? {}) : {};
    const names = Object.keys(env).sort();
    s.meta = {
      v: 1,
      serviceId: app.serviceId,
      creator: app.creator,
      slug: app.slug,
      manifestJson: JSON.stringify(app.manifest),
      appliedMigrations: [...(app.appliedMigrations ?? [])],
      parts,
      access: opts.access?.exportEntry(app.serviceId) ?? null,
      membership: app.membership.snapshot(),
      env: {
        names,
        ...(opts.envKey && names.length > 0
          ? {
              sealed: sealCopyEnv(env, opts.envKey, {
                sourceServer: opts.serverFqdn,
                targetServer: grant.targetServer,
                serviceId: app.serviceId,
                grantIssuedAt: grant.issuedAt,
              }),
            }
          : {}),
      },
      accessList: opts.accessList?.(app.serviceId) ?? null,
    };
    const lan = opts.lanEndpoints?.() ?? [];
    if (lan.length > 0) s.meta.lan = lan;
  }

  async function chunk(s: ExportSession, part: string, offset: number): Promise<HttpResponse> {
    const path = s.files.get(part);
    const info = s.meta?.parts.find((p) => p.name === part);
    if (!path || !info) return err(404, "no such part");
    if (offset > info.bytes) return err(400, "offset is past the end of the part");
    const len = Math.min(APP_COPY_CHUNK_BYTES, info.bytes - offset);
    const buf = Buffer.alloc(len);
    const fh = await open(path, "r");
    try {
      let read = 0;
      while (read < len) {
        const r = await fh.read(buf, read, len - read, offset + read);
        if (r.bytesRead === 0) break;
        read += r.bytesRead;
      }
      if (read !== len) return err(500, "the part changed while it was read");
    } finally {
      await fh.close();
    }
    return {
      status: 200,
      headers: { "content-type": "application/octet-stream", "x-flagship-part-bytes": String(info.bytes), "cache-control": "no-store" },
      body: buf,
    };
  }

  async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path.split("?")[0] !== APP_COPY_EXPORT_PATH) return null;
    if (req.method.toUpperCase() !== "POST") return err(405, "method not allowed");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return err(400, "invalid json");
    }
    const grant = parseAppCopyGrant(body?.grant);
    const { from, part, offset, issuedAt, signature, auth, accept } = body ?? {};
    if (
      !grant ||
      typeof from !== "string" ||
      from.length === 0 ||
      typeof part !== "string" ||
      !PART_RE.test(part) ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof issuedAt !== "number" ||
      !Number.isSafeInteger(issuedAt) ||
      typeof signature !== "string" ||
      typeof auth !== "string"
    ) {
      return err(400, "malformed export request");
    }
    const ownerSig = fromHex(signature);
    const authSig = fromHex(auth);
    if (!ownerSig || ownerSig.length !== 64 || !authSig || authSig.length !== 64) return err(400, "invalid signature hex");

    const callerKey = await opts.resolveCallerKey(from);
    if (!callerKey) return err(403, "unknown caller");
    const envelope = fetchEnvelopeBytes({
      from,
      to: opts.serverFqdn,
      serviceId: grant.serviceId,
      grantIssuedAt: grant.issuedAt,
      grantSignature: signature,
      part,
      offset,
      issuedAt,
    });
    let callerOk = false;
    try {
      callerOk = ed.verify(authSig, envelope, callerKey);
    } catch {
      callerOk = false;
    }
    if (!callerOk) return err(403, "invalid caller signature");
    if (Math.abs(now() - issuedAt) > EXPORT_REQUEST_MAX_SKEW_MS) return err(403, "stale request");
    if (grant.sourceServer !== opts.serverFqdn) return err(403, "the order is for a different source server");
    if (grant.targetServer !== from) return err(403, "the caller isn't the server the order names as target");
    if (!sameAccount(from, opts.serverFqdn)) return err(403, "the caller isn't one of this account's servers");
    if (!authorizeSensitiveOrder({ ...authority, order: grant, signature: ownerSig, verify: verifyAppCopyGrant })) {
      return err(403, "invalid signature");
    }

    await sweep();
    const key = `${grant.serviceId}|${grant.targetServer}|${grant.issuedAt}|${signature.toLowerCase()}`;
    let s = sessions.get(key);
    if (part === "meta" && !s) {
      if (Math.abs(now() - grant.issuedAt) > EXPORT_GRANT_MAX_AGE_MS) return err(403, "the order is stale: sign it again");
      const app = opts.app(grant.serviceId);
      if (!app) return err(404, "that app isn't on this server");
      if (!(await opts.ledger.claim(key))) return err(409, "this signed order was already used: sign it again");
      s = {
        key,
        dir: join(opts.workDir, createHash("sha256").update(key).digest("hex").slice(0, 32)),
        target: from,
        state: "preparing",
        files: new Map(),
        lastUsed: now(),
        gzip: Array.isArray(accept) && accept.includes("gzip"),
      };
      sessions.set(key, s);
      const session = s;
      log(`[app-copy] ${grant.serviceId}: preparing a copy for ${from}`);
      void prepare(session, app, grant).then(
        () => {
          session.state = "ready";
          session.lastUsed = now();
          log(`[app-copy] ${grant.serviceId}: copy ready for ${from}`);
        },
        async (e: Error) => {
          session.state = "failed";
          session.error = e.message ?? "the copy couldn't be made";
          session.files.clear();
          session.lastUsed = now();
          await rm(session.dir, { recursive: true, force: true }).catch(() => {});
          log(`[app-copy] ${grant.serviceId}: making the copy failed: ${session.error}`);
        },
      );
    }
    if (!s) return err(404, "no export is open for this order");
    s.lastUsed = now();
    if (part === "done") {
      await close(s);
      return json(200, { ok: true });
    }
    if (s.state === "failed") return err(500, s.error ?? "the copy couldn't be made");
    if (s.state === "preparing") return json(202, { preparing: true });
    if (part === "meta") return json(200, s.meta);
    return chunk(s, part, offset);
  }

  return {
    handle,
    /** Drop any bundle a previous run left behind. */
    async init(): Promise<void> {
      await rm(opts.workDir, { recursive: true, force: true }).catch(() => {});
    },
    /** Open exports (tests). */
    openExports: () => sessions.size,
  };
}

/** `path` → `path.gz` (fast level: the link, not the CPU, is what's short), dropping `path`. */
async function gzipFile(path: string): Promise<string> {
  const out = `${path}.gz`;
  await pipeline(createReadStream(path), createGzip({ level: zlibConstants.Z_BEST_SPEED }), createWriteStream(out, { mode: 0o600 }));
  await rm(path, { force: true });
  return out;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return h.digest("hex");
}
