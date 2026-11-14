/** The restore preview's verdicts, allowed actions and defaults (docs/restore-into-server.md §1-§3). */
import { describe, expect, it } from "vitest";
import { legacyOrigin, mintOrigin, schemaGuard } from "../../src/appLineage.js";
import type { ArchiveAppMeta } from "../../src/serverArchive/build.js";
import { buildPreview, checkPlan, copyNameFor, lineFor, recommendedPlan, type BoxAppView } from "../../src/serverArchive/merge/preview.js";

const HOST = "home.harry.flagship.services";
const T = (c: string) => `tree:${c.repeat(64)}`;

function meta(serviceId: string, o: Partial<ArchiveAppMeta> = {}): ArchiveAppMeta {
  const [creator, slug] = serviceId.split("--") as [string, string];
  return {
    v: 1, serviceId, creator, slug, name: slug,
    manifestJson: JSON.stringify({ version: "1.2.0", runtime: { image: "x:1", port: 1 } }),
    rebuild: "source", appliedMigrations: ["001.sql"],
    parts: [{ name: "db:default", file: `apps/${serviceId}/db-0.dump`, bytes: 100, sha256: "0".repeat(64) }, { name: "files", file: `apps/${serviceId}/files.tar`, bytes: 50, sha256: "0".repeat(64) }],
    access: null, membership: null, env: {}, accessList: null, apiKeys: [],
    ...o,
  };
}

function boxApp(serviceId: string, o: Partial<BoxAppView> = {}): BoxAppView {
  return {
    serviceId, name: serviceId, version: "1.4.0", manifestJson: "{}", origin: mintOrigin(),
    codeHistory: [{ digest: T("a"), version: "1.2.0", at: 1 }, { digest: T("b"), version: "1.4.0", at: 2 }],
    appliedMigrations: ["001.sql", "002.sql"], dataGeneration: 0, installedAt: 1, postgresStores: ["default"], files: true, bytes: 10, busy: null,
    ...o,
  };
}

function preview(metas: ArchiveAppMeta[], box: BoxAppView[], elsewhere: Record<string, string[]> = {}) {
  const b = new Map(box.map((a) => [a.serviceId, a]));
  return buildPreview({ serverFqdn: HOST, metas, box: b, alsoOn: (id) => elsewhere[id] ?? [], taken: (id) => b.has(id) || !!elsewhere[id], addressMoves: () => true });
}

describe("the restore preview", () => {
  it("the same app (same origin), older: keep by default; every action that keeps data safe allowed", () => {
    const o = mintOrigin();
    const [p] = preview([meta("harry--notes", { lineage: { origin: o, codeHistory: [{ digest: T("a"), version: "1.2.0", at: 1 }] } })], [boxApp("harry--notes", { origin: o })]);
    expect(p).toMatchObject({ verdict: "same", code: "backup-older", schema: "backup-older", recommended: "keep", migrationsToRun: ["002.sql"] });
    expect(p!.allowed.sort()).toEqual(["copy", "keep", "replace", "replace-data"]);
    expect(p!.guards).toEqual({ guardCode: T("b"), guardSchema: schemaGuard(["001.sql", "002.sql"]), guardGen: 0 });
  });

  it("refuses replace-data when the backup's schema is newer or diverged, or its stores differ", () => {
    const o = mintOrigin();
    const newer = preview([meta("harry--notes", { appliedMigrations: ["001.sql", "002.sql", "003.sql"], lineage: { origin: o, codeHistory: [] } })], [boxApp("harry--notes", { origin: o })])[0]!;
    expect(newer.disallowed["replace-data"]).toBe("schema-newer");
    const diverged = preview([meta("harry--notes", { appliedMigrations: ["001.sql", "009.sql"], lineage: { origin: o, codeHistory: [] } })], [boxApp("harry--notes", { origin: o })])[0]!;
    expect(diverged.disallowed["replace-data"]).toBe("schema-diverged");
    const stores = preview([meta("harry--notes", { lineage: { origin: o, codeHistory: [] } })], [boxApp("harry--notes", { origin: o, files: false })])[0]!;
    expect(stores.disallowed["replace-data"]).toBe("stores-differ");
  });

  it("a different app with the same name: copy beside it by default, never replace", () => {
    const [p] = preview([meta("harry--notes", { lineage: { origin: mintOrigin(), codeHistory: [] } })], [boxApp("harry--notes")]);
    expect(p).toMatchObject({ verdict: "clash", recommended: "copy", copyServiceId: "harry--notes-restored" });
    expect(p!.disallowed).toMatchObject({ replace: "different-app", "replace-data": "different-app" });
  });

  it("legacy apps: same account is the same app; another account's may be, if the owner says so", () => {
    const same = preview([meta("harry--notes")], [boxApp("harry--notes", { origin: legacyOrigin("harry--notes") })])[0]!;
    expect(same.verdict).toBe("same");
    const other = preview([meta("sam--notes")], [boxApp("harry--notes", { origin: legacyOrigin("harry--notes") })])[0]!;
    expect(other).toMatchObject({ verdict: "clash-maybe", targetServiceId: "harry--notes" });
    expect(other.allowed).toContain("replace");
    expect(checkPlan([other], [lineFor(other, "replace")], { serverFqdn: HOST, taken: () => true })?.code).toBe("plan-same-app-not-allowed");
    expect(checkPlan([other], [lineFor(other, "replace", { sameApp: true })], { serverFqdn: HOST, taken: () => true })).toBeNull();
  });

  it("an app the account runs on another server: skip by default, and its address would move", () => {
    const [p] = preview([meta("harry--notes")], [], { "harry--notes": ["home2"] });
    expect(p).toMatchObject({ verdict: "runs-elsewhere", recommended: "skip", alsoOn: ["home2"], addressMoves: true });
    expect(p!.allowed.sort()).toEqual(["copy", "install", "skip"]);
  });

  it("an app being changed right now can't be replaced", () => {
    const o = mintOrigin();
    const [p] = preview([meta("harry--notes", { lineage: { origin: o, codeHistory: [] } })], [boxApp("harry--notes", { origin: o, busy: "editing" })]);
    expect(p!.disallowed).toMatchObject({ replace: "busy", "replace-data": "busy" });
  });

  it("names a copy that fits and is free; two copies in one plan don't take one name", () => {
    expect(copyNameFor("harry", "notes", () => false)).toBe("harry--notes-restored");
    expect(copyNameFor("harry", "notes", (id) => id === "harry--notes-restored")).toBe("harry--notes-restored-2");
    expect(copyNameFor("harry", "a".repeat(30), () => false)).toBe(`harry--${"a".repeat(21)}-restored`);
    const ps = preview([meta("harry--notes", { lineage: { origin: mintOrigin(), codeHistory: [] } }), meta("sam--notes", { lineage: { origin: mintOrigin(), codeHistory: [] } })], [boxApp("harry--notes")]);
    expect(ps.map((p) => p.copyServiceId)).toEqual(["harry--notes-restored", "harry--notes-restored-2"]);
    const plan = recommendedPlan(ps);
    expect(checkPlan(ps, plan, { serverFqdn: HOST, taken: (id) => id === "harry--notes" })).toBeNull();
    // A copy under another account, or a taken name, is refused.
    expect(checkPlan(ps, [lineFor(ps[0]!, "copy", { targetServiceId: "sam--x" }), plan[1]!], { serverFqdn: HOST, taken: () => false })?.code).toBe("plan-copy-name");
  });
});
