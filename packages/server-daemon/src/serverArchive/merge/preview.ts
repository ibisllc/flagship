/**
 * What a backup's apps are to this server, and what the owner may do with
 * each (docs/restore-into-server.md §1-§3). Pure: the service gathers the
 * facts, this decides. Nothing here is ever shown to a model.
 */
import { APP_SLUG_MAX, isAppSlug, parseServiceId, type RestoreMergeAction, type RestoreMergePlanLine } from "@flagship/protocol";
import {
  compareCode,
  compareSchema,
  compareVersions,
  isLegacyOrigin,
  legacyOrigin,
  manifestCodeDigest,
  parseLineage,
  schemaGuard,
  type CodeHistoryEntry,
  type CodeRelation,
  type SchemaRelation,
} from "../../appLineage.js";
import type { ArchiveAppMeta } from "../build.js";
import { localServiceId } from "../restore.js";

export type MergeVerdict = "new" | "runs-elsewhere" | "same" | "clash" | "clash-maybe";

/** The server's own copy of an app, as the preview needs it. */
export interface BoxAppView {
  serviceId: string;
  name: string;
  version: string;
  manifestJson: string;
  origin: string;
  codeHistory: CodeHistoryEntry[];
  appliedMigrations: string[];
  dataGeneration: number;
  installedAt: number;
  postgresStores: string[];
  files: boolean;
  /** Bytes its stores hold, when measured. */
  bytes: number | null;
  /** Something is changing it now (a deploy, an arriving copy, an open build chat or IDE session). */
  busy: "deploying" | "copying" | "editing" | null;
}

export interface PreviewInput {
  serverFqdn: string;
  metas: readonly ArchiveAppMeta[];
  box: ReadonlyMap<string, BoxAppView>;
  /** The account's other servers that run an app id (§1.1). */
  alsoOn: (serviceId: string) => readonly string[];
  /** Ids taken anywhere in the account (this server's and the others'), for a copy's new name. */
  taken: (serviceId: string) => boolean;
  /** Whether the server would move this app's address to itself if it ran it (it leads the server order). */
  addressMoves: (serviceId: string) => boolean;
}

/** A refusal of one action for one app: a stable code the apps translate. */
export type DisallowedCode =
  | "not-on-server"
  | "already-on-server"
  | "different-app"
  | "schema-newer"
  | "schema-diverged"
  | "stores-differ"
  | "no-copy-name"
  | "busy";

export interface PreviewApp {
  archivedServiceId: string;
  name: string;
  targetServiceId: string;
  verdict: MergeVerdict;
  code: CodeRelation;
  /** Code compared by semver only ("probably"), when either side has no history. */
  codeByVersion: boolean;
  schema: SchemaRelation | null;
  backup: { version: string; digest: string; bytes: number; origin: string; legacyOrigin: boolean; hasDatabase: boolean; hasFiles: boolean };
  box: { version: string; digest: string; installedAt: number; bytes: number | null; legacyOrigin: boolean } | null;
  alsoOn: string[];
  addressMoves: boolean;
  allowed: RestoreMergeAction[];
  disallowed: Partial<Record<RestoreMergeAction, DisallowedCode>>;
  recommended: RestoreMergeAction;
  /** The copy's default new id, when a copy is possible. */
  copyServiceId: string | null;
  /** What a replace or replace-data line must pin (§4.2). */
  guards: { guardCode: string; guardSchema: string; guardGen: number } | null;
  /** Migrations replace-data would run on the backup's data (X∖B). */
  migrationsToRun: string[];
}

function hostAccount(serverFqdn: string): string {
  return serverFqdn.split(".")[1] ?? "";
}

function backupVersion(meta: ArchiveAppMeta): string {
  try {
    const v = (JSON.parse(meta.manifestJson) as { version?: unknown }).version;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/** The code digest an app runs now: its newest history entry, else its manifest's. */
export function currentCodeDigest(history: readonly CodeHistoryEntry[], manifestJson: string): string {
  return history[history.length - 1]?.digest ?? manifestCodeDigest(manifestJson);
}

/** The guards a plan line pins for a server app, and that the swap re-checks. */
export function guardsOf(app: Pick<BoxAppView, "codeHistory" | "manifestJson" | "appliedMigrations" | "dataGeneration">): { guardCode: string; guardSchema: string; guardGen: number } {
  return { guardCode: currentCodeDigest(app.codeHistory, app.manifestJson), guardSchema: schemaGuard(app.appliedMigrations), guardGen: app.dataGeneration };
}

/** `<account>--<slug>-restored`, then `-restored-2`…, the first free one that is a valid app name. */
export function copyNameFor(account: string, slug: string, taken: (id: string) => boolean): string | null {
  for (let i = 1; i <= 50; i++) {
    const suffix = i === 1 ? "-restored" : `-restored-${i}`;
    const s = `${slug.slice(0, APP_SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!isAppSlug(s)) return null;
    const id = `${account}--${s}`;
    if (!taken(id)) return id;
  }
  return null;
}

function migrationsToRun(backup: readonly string[], box: readonly string[]): string[] {
  const B = new Set(backup);
  return [...new Set(box)].filter((m) => !B.has(m)).sort((a, b) => a.localeCompare(b));
}

export function buildPreview(input: PreviewInput): PreviewApp[] {
  const account = hostAccount(input.serverFqdn);
  const plannedCopies = new Set<string>();
  return input.metas.map((meta) => {
    const target = localServiceId(input.serverFqdn, meta.serviceId);
    const sameAccount = parseServiceId(meta.serviceId)?.creator === account;
    const lineage = parseLineage(meta.lineage) ?? { origin: legacyOrigin(meta.serviceId), codeHistory: [] };
    const history = lineage.codeHistory;
    const bDigest = currentCodeDigest(history, meta.manifestJson);
    const bVersion = backupVersion(meta);
    const bBytes = meta.parts.filter((p) => p.name === "files" || p.name.startsWith("db:")).reduce((n, p) => n + p.bytes, 0);
    const bDbs = meta.parts.filter((p) => p.name.startsWith("db:")).map((p) => p.name.slice(3));
    const bFiles = meta.parts.some((p) => p.name === "files");
    const box = input.box.get(target) ?? null;
    const alsoOn = [...input.alsoOn(target)];

    let verdict: MergeVerdict;
    if (!box) verdict = alsoOn.length > 0 ? "runs-elsewhere" : "new";
    else if (box.origin === lineage.origin) verdict = "same";
    else if (!isLegacyOrigin(box.origin) && !isLegacyOrigin(lineage.origin)) verdict = "clash";
    else verdict = sameAccount ? "same" : "clash-maybe";

    let code: CodeRelation = "unknown";
    let codeByVersion = false;
    let schema: SchemaRelation | null = null;
    if (box) {
      code = compareCode(history.length ? history : [{ digest: bDigest, version: bVersion, at: 0 }], box.codeHistory.length ? box.codeHistory : [{ digest: currentCodeDigest([], box.manifestJson), version: box.version, at: 0 }]);
      if ((history.length === 0 || box.codeHistory.length === 0) && code !== "same") {
        code = compareVersions(bVersion, box.version);
        codeByVersion = true;
      }
      schema = compareSchema(meta.appliedMigrations, box.appliedMigrations);
    }

    const copyServiceId = copyNameFor(account, parseServiceId(target)?.slug ?? "", (id) => input.taken(id) || plannedCopies.has(id));
    const disallowed: Partial<Record<RestoreMergeAction, DisallowedCode>> = {};
    const allowed: RestoreMergeAction[] = [];
    const allow = (a: RestoreMergeAction, refused: DisallowedCode | null) => {
      if (refused) disallowed[a] = refused;
      else allowed.push(a);
    };
    const busy = box?.busy ? ("busy" as const) : null;
    allow("install", box ? "already-on-server" : null);
    allow("skip", box ? "already-on-server" : null);
    allow("keep", box ? null : "not-on-server");
    const sameish = verdict === "same" || verdict === "clash-maybe";
    allow("replace", !box ? "not-on-server" : !sameish ? "different-app" : busy);
    let replaceData: DisallowedCode | null = !box ? "not-on-server" : verdict !== "same" ? "different-app" : busy;
    if (!replaceData && box) {
      if (schema === "backup-newer") replaceData = "schema-newer";
      else if (schema === "diverged") replaceData = "schema-diverged";
      else if (!bDbs.every((d) => box.postgresStores.includes(d)) || (bFiles && !box.files)) replaceData = "stores-differ";
    }
    allow("replace-data", replaceData);
    allow("copy", copyServiceId ? null : "no-copy-name");

    let recommended: RestoreMergeAction;
    if (verdict === "new") recommended = "install";
    else if (verdict === "runs-elsewhere") recommended = "skip";
    else if (verdict === "same") recommended = "keep";
    else recommended = copyServiceId ? "copy" : "keep";
    if (recommended === "copy" && copyServiceId) plannedCopies.add(copyServiceId);

    return {
      archivedServiceId: meta.serviceId,
      name: meta.name,
      targetServiceId: target,
      verdict,
      code,
      codeByVersion,
      schema,
      backup: { version: bVersion, digest: bDigest, bytes: bBytes, origin: lineage.origin, legacyOrigin: isLegacyOrigin(lineage.origin), hasDatabase: bDbs.length > 0, hasFiles: bFiles },
      box: box ? { version: box.version, digest: currentCodeDigest(box.codeHistory, box.manifestJson), installedAt: box.installedAt, bytes: box.bytes, legacyOrigin: isLegacyOrigin(box.origin) } : null,
      alsoOn,
      addressMoves: !box && alsoOn.length > 0 && input.addressMoves(target),
      allowed,
      disallowed,
      recommended,
      copyServiceId,
      guards: box ? guardsOf(box) : null,
      migrationsToRun: box ? migrationsToRun(meta.appliedMigrations, box.appliedMigrations) : [],
    };
  });
}

/** The plan the owner gets by changing nothing. */
export function recommendedPlan(preview: readonly PreviewApp[]): RestoreMergePlanLine[] {
  return preview.map((p) => lineFor(p, p.recommended));
}

/** A plan line for one app and one action, with the guards and copy name the preview gave it. */
export function lineFor(p: PreviewApp, action: RestoreMergeAction, opts: { targetServiceId?: string; sameApp?: boolean } = {}): RestoreMergePlanLine {
  const guarded = action === "replace" || action === "replace-data";
  return {
    archivedServiceId: p.archivedServiceId,
    action,
    sameApp: !!opts.sameApp,
    ...(action === "copy" ? { targetServiceId: opts.targetServiceId ?? p.copyServiceId ?? "" } : {}),
    ...(guarded && p.guards ? p.guards : {}),
  };
}

export type PlanRefusal =
  | { code: "plan-app-missing"; serviceId: string }
  | { code: "plan-app-unknown"; serviceId: string }
  | { code: "plan-action-not-allowed"; serviceId: string; reason: DisallowedCode | "not-offered" }
  | { code: "plan-same-app-not-allowed"; serviceId: string }
  | { code: "plan-guard-mismatch"; serviceId: string }
  | { code: "plan-copy-name"; serviceId: string }
  | { code: "plan-nothing-to-do" };

/**
 * Check a signed plan against the preview it was made from (§4.2): one line
 * per backed-up app, each action one the preview allowed, the guards the
 * preview gave, a copy's new id free and this account's, sameApp only on a
 * clash that may be the same app.
 */
export function checkPlan(preview: readonly PreviewApp[], lines: readonly RestoreMergePlanLine[], ctx: { serverFqdn: string; taken: (id: string) => boolean }): PlanRefusal | null {
  const byId = new Map(preview.map((p) => [p.archivedServiceId, p]));
  const seen = new Set<string>();
  const copies = new Set<string>();
  for (const l of lines) {
    const p = byId.get(l.archivedServiceId);
    if (!p) return { code: "plan-app-unknown", serviceId: l.archivedServiceId };
    seen.add(l.archivedServiceId);
    if (!p.allowed.includes(l.action)) return { code: "plan-action-not-allowed", serviceId: l.archivedServiceId, reason: p.disallowed[l.action] ?? "not-offered" };
    if (l.sameApp && p.verdict !== "clash-maybe") return { code: "plan-same-app-not-allowed", serviceId: l.archivedServiceId };
    if (p.verdict === "clash-maybe" && l.action === "replace" && !l.sameApp) return { code: "plan-same-app-not-allowed", serviceId: l.archivedServiceId };
    if (l.action === "replace" || l.action === "replace-data") {
      const g = p.guards;
      if (!g || g.guardCode !== l.guardCode || g.guardSchema !== l.guardSchema || g.guardGen !== l.guardGen) return { code: "plan-guard-mismatch", serviceId: l.archivedServiceId };
    }
    if (l.action === "copy") {
      const t = l.targetServiceId ?? "";
      const id = parseServiceId(t);
      if (!id || id.creator !== hostAccount(ctx.serverFqdn) || !isAppSlug(id.slug) || ctx.taken(t) || copies.has(t)) return { code: "plan-copy-name", serviceId: l.archivedServiceId };
      copies.add(t);
    }
  }
  for (const p of preview) if (!seen.has(p.archivedServiceId)) return { code: "plan-app-missing", serviceId: p.archivedServiceId };
  if (lines.every((l) => l.action === "keep" || l.action === "skip")) return { code: "plan-nothing-to-do" };
  return null;
}
