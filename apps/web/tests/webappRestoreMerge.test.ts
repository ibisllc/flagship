import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module
import * as RM from "../public/webapp/lib/restoreMerge.js";
const { appRestoreUndoBytes, restoreMergePlanLine, restoreMergePlanSha256, serverRestoreMergeBytes, serverRestoreStageBytes } = RM;

const V = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/server-restore-merge/vectors.json", import.meta.url), "utf8"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("webapp restore-into-server orders", () => {
  it("builds the shared vectors' canonical bytes", () => {
    expect(text(serverRestoreStageBytes(V.stage.order))).toBe(V.stage.canonical);
    expect(restoreMergePlanSha256(V.plan.lines)).toBe(V.plan.planSha256);
    expect(text(serverRestoreMergeBytes(V.merge.order))).toBe(V.merge.canonical);
    for (const u of V.undo) expect(text(appRestoreUndoBytes(u.order))).toBe(u.canonical);
  });

  it("refuses every line the box refuses", () => {
    for (const { name, line } of V.invalidLines) expect(() => restoreMergePlanLine(line), name).toThrow();
  });
});

const FQDN = "home.demo.flagship.services";
const G = { guardCode: "tree:" + "a".repeat(64), guardSchema: "b".repeat(64), guardGen: 0 };
const APPS = [
  { archivedServiceId: "demo--notes", name: "notes", targetServiceId: "demo--notes", verdict: "same", code: "backup-older", codeByVersion: false, backup: { version: "1.2.0", hasDatabase: true, hasFiles: true }, box: { version: "1.4.0" }, alsoOn: [], addressMoves: false, allowed: ["keep", "replace", "replace-data", "copy"], disallowed: { install: "already-on-server" }, recommended: "keep", copyServiceId: "demo--notes-restored", guards: G },
  { archivedServiceId: "demo--todo", name: "todo", targetServiceId: "demo--todo", verdict: "new", code: "unknown", backup: { version: "1.0.0" }, box: null, alsoOn: [], addressMoves: false, allowed: ["install", "skip", "copy"], disallowed: { keep: "not-on-server" }, recommended: "install", copyServiceId: "demo--todo-restored", guards: null },
  { archivedServiceId: "demo--chess", name: "chess", targetServiceId: "demo--chess", verdict: "runs-elsewhere", code: "unknown", backup: { version: "2.0.0" }, box: null, alsoOn: ["home2"], addressMoves: true, allowed: ["install", "skip", "copy"], disallowed: {}, recommended: "skip", copyServiceId: "demo--chess-restored", guards: null },
  { archivedServiceId: "sam--blog", name: "blog", targetServiceId: "demo--blog", verdict: "clash", code: "diverged", backup: { version: "0.3.0" }, box: { version: "1.0.0" }, alsoOn: [], addressMoves: false, allowed: ["keep", "copy"], disallowed: { replace: "different-app" }, recommended: "copy", copyServiceId: "demo--blog-restored", guards: null },
];
const PREVIEW = { restoreId: "01".repeat(16), backup: { createdAt: 1 }, apps: APPS };

describe("webapp restore-into-server choices", () => {
  it("starts from the accepted defaults and only allows what the box allows", () => {
    let c = RM.defaultChoices(PREVIEW);
    expect(Object.fromEntries(Object.entries(c).map(([k, v]: [string, any]) => [k, v.action]))).toEqual({ "demo--notes": "keep", "demo--todo": "install", "demo--chess": "skip", "sam--blog": "copy" });
    expect(c["sam--blog"].copyName).toBe("blog-restored");
    expect(RM.choose(c, APPS[3], "replace")).toBe(c);
    c = RM.choose(c, APPS[0], "replace");
    expect(c["demo--notes"]).toMatchObject({ action: "replace", sameApp: false });
    expect(RM.groupOf(APPS[2])).toBe("new");
    expect(RM.groupOf(APPS[0])).toBe("already");
    expect(RM.groupOf(APPS[3])).toBe("different");
  });

  it("keeps Restore off for keep/skip only and for a bad copy name", () => {
    const keepAll = Object.fromEntries(APPS.map((a) => [a.archivedServiceId, { action: a.allowed.includes("keep") ? "keep" : "skip", copyName: "", sameApp: false }]));
    expect(RM.canRestore(keepAll)).toBe(false);
    const c = RM.defaultChoices(PREVIEW);
    expect(RM.canRestore(c)).toBe(true);
    expect(RM.canRestore({ ...c, "sam--blog": { ...c["sam--blog"], copyName: "Bad Name" } })).toBe(false);
  });

  it("signs exactly the plan shown, guards on replace lines only", async () => {
    const c = RM.choose(RM.defaultChoices(PREVIEW), APPS[0], "replace-data");
    const lines = RM.planLines(PREVIEW, c, FQDN);
    expect(lines.find((l: any) => l.archivedServiceId === "demo--notes")).toEqual({ archivedServiceId: "demo--notes", action: "replace-data", sameApp: false, ...G });
    expect(lines.find((l: any) => l.archivedServiceId === "sam--blog")).toEqual({ archivedServiceId: "sam--blog", action: "copy", sameApp: false, targetServiceId: "demo--blog-restored" });
    expect(lines.find((l: any) => l.archivedServiceId === "demo--chess")).toEqual({ archivedServiceId: "demo--chess", action: "skip", sameApp: false });
    const posts: any[] = [];
    const client = { fetch: async (path: string, init: any) => { posts.push({ path, body: JSON.parse(init.body) }); return {}; } };
    const signed: Uint8Array[] = [];
    const order = await RM.sendPlan({ client, serverDomain: FQDN, restoreId: PREVIEW.restoreId, archiveId: "02".repeat(16), sha256: "03".repeat(32), lines, sign: async (b: Uint8Array) => { signed.push(b); return new Uint8Array(64); }, now: () => 1000 });
    expect(order.expiresAt - order.issuedAt).toBe(RM.PLAN_TTL_MS);
    expect(order.planSha256).toBe(restoreMergePlanSha256(lines));
    expect(text(signed[0]!)).toBe(text(serverRestoreMergeBytes(order)));
    expect(posts[0].path).toBe("/api/screens/server-restore-merge/plan");
    expect(posts[0].body.lines).toEqual(lines);
  });

  it("picks the upload up where the box says it has got to", async () => {
    const blob = new Blob([new Uint8Array(10)]);
    const offsets: number[] = [];
    let first = true;
    const fetchImpl = async (url: string) => {
      const off = Number(new URL(url).searchParams.get("offset"));
      offsets.push(off);
      if (first) { first = false; return new Response(JSON.stringify({ code: "offset", received: 4 }), { status: 409 }); }
      return new Response(JSON.stringify({ received: Math.min(10, off + 4) }), { status: 200 });
    };
    await RM.sendMergeData({ client: { baseUrl: "https://" + FQDN, token: () => "t" }, blob, from: 0, fetchImpl, chunkBytes: 4 });
    expect(offsets).toEqual([0, 4, 8]);
  });

  it("a quantum-safe server's refusal points to the phone app (the webapp holds no ML-DSA key)", () => {
    const fallback = () => "fallback";
    expect(RM.restoreErrorText({ status: 403, body: { code: "needs-hybrid", error: "x" } }, fallback)).toBe(RM.RESTORE_NEEDS_PHONE);
    expect(RM.RESTORE_NEEDS_PHONE).toContain("Flagship app on an admin phone");
    expect(RM.restoreErrorText({ status: 403, body: { code: "not-admin" } }, fallback)).toBe("fallback");
  });

  it("says what each choice does in one line", () => {
    expect(RM.comparisonText(APPS[0])).toBe("The backup is older: 1.2.0 vs 1.4.0");
    expect(RM.comparisonText(APPS[2])).toBe("Runs on home2 (its data is likely newer)");
    expect(RM.notesFor(APPS[2], "install")).toContain("Its address will move to this server (it is first in your server order).");
    expect(RM.notesFor(APPS[0], "replace")).toEqual(["Jobs saved in the backup may run again.", "Files the app keeps are read as the backup left them."]);
    expect(RM.refusalText("different-app")).toBe("It is a different app with the same name.");
  });
});
