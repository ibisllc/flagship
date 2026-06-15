// The global operations sliver is a thin render of the ActiveOperationsCenter,
// so the logic that matters — what shows, in what order, where a tap goes, and
// the churn-free reconciliation — lives in lib/activeOperations.js. This is the
// webapp mirror of iOS's ActiveOperationsCenterTests; the cases line up
// one-for-one (label shapes, deploy reconciliation, build lifecycle, ordering
// across mixed operations, namespaced-id collision-freedom).
//
// We exercise the REAL shipping module (a plain ESM file with no DOM deps) via
// the same pathToFileURL + dynamic import seam the other webapp lib tests use.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MOD_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/activeOperations.js"),
).href;

async function load() {
  return import(MOD_URL);
}

async function freshCenter() {
  const { ActiveOperationsCenter } = await load();
  return new ActiveOperationsCenter();
}

function pendingPod(id: string, name: string) {
  return { podId: id, name, status: "pending" };
}
function onlinePod(id: string, name: string) {
  return { podId: id, name, status: "online" };
}

// The deploy target the center builds for a pending pod.
function deployTarget(podId: string) {
  return { view: "view-server-detail", params: { podId } };
}
// A build target — the chat view (params carry nothing the center inspects).
const VIBE_TARGET = { view: "view-vibe-code" };

describe("activeOperations — label shapes", () => {
  it("derives the canonical deploy + build sentences", async () => {
    const { operationLabel } = await load();
    expect(operationLabel({ kind: "deploy", subject: "Home" })).toBe(
      "deploying server Home",
    );
    expect(
      operationLabel({ kind: "build", subject: "blog", onServer: "Home" }),
    ).toBe("building blog on Home");
    expect(operationLabel({ kind: "build", subject: "blog", onServer: null })).toBe(
      "building blog",
    );
    expect(operationLabel({ kind: "build", subject: "blog" })).toBe(
      "building blog",
    );
  });
});

describe("activeOperations — empty", () => {
  it("has no primary and no additional", async () => {
    const c = await freshCenter();
    expect(c.primary).toBeNull();
    expect(c.additionalCount).toBe(0);
    expect(c.operations).toHaveLength(0);
  });
});

describe("activeOperations — deploy (derived from pods)", () => {
  it("a pending pod becomes a deploy op with the canonical label + target", async () => {
    const { operationLabel } = await load();
    const c = await freshCenter();
    c.syncDeployOperations([pendingPod("p1", "Home")]);
    const op = c.primary;
    expect(op).not.toBeNull();
    expect(op.kind).toBe("deploy");
    expect(operationLabel(op)).toBe("deploying server Home");
    expect(op.target).toEqual(deployTarget("p1"));
    expect(c.operations).toHaveLength(1);
    expect(c.additionalCount).toBe(0);
  });

  it("non-pending pods produce no deploy ops", async () => {
    const c = await freshCenter();
    c.syncDeployOperations([onlinePod("p1", "Home"), onlinePod("p2", "Work")]);
    expect(c.operations).toHaveLength(0);
    expect(c.primary).toBeNull();
  });

  it("a steady re-sync is idempotent and does not reorder (same ids AND seq)", async () => {
    const c = await freshCenter();
    const pods = [pendingPod("p1", "Home"), pendingPod("p2", "Work")];
    c.syncDeployOperations(pods);
    const first = c.operations;
    c.syncDeployOperations(pods);
    // Churn-free: an unchanged sync must not even reassign the array.
    expect(c.operations).toBe(first);
  });

  it("a pod leaving pending drops its deploy op", async () => {
    const c = await freshCenter();
    c.syncDeployOperations([pendingPod("p1", "Home")]);
    expect(c.operations).toHaveLength(1);
    c.syncDeployOperations([onlinePod("p1", "Home")]);
    expect(c.operations).toHaveLength(0);
  });

  it("a deploy rename updates the label but keeps the op's order", async () => {
    const { operationLabel } = await load();
    const c = await freshCenter();
    c.syncDeployOperations([pendingPod("p1", "Home"), pendingPod("p2", "Work")]);
    const seqBefore = c.operations.find((o: any) => o.id === "deploy:p2")?.seq;
    c.syncDeployOperations([
      pendingPod("p1", "Home"),
      pendingPod("p2", "Workstation"),
    ]);
    const renamed = c.operations.find((o: any) => o.id === "deploy:p2");
    expect(operationLabel(renamed)).toBe("deploying server Workstation");
    expect(renamed.seq).toBe(seqBefore);
  });
});

describe("activeOperations — build (imperative)", () => {
  it("build label with and without a server; re-upsert never duplicates", async () => {
    const { operationLabel } = await load();
    const c = await freshCenter();
    c.upsertBuild("s1", "blog", "Home", VIBE_TARGET);
    expect(operationLabel(c.primary)).toBe("building blog on Home");
    expect(c.primary.target).toEqual(VIBE_TARGET);

    c.upsertBuild("s1", "blog", null, VIBE_TARGET);
    expect(operationLabel(c.primary)).toBe("building blog");
    expect(c.operations).toHaveLength(1);
  });

  it("upsert twice keeps order and applies the new subject", async () => {
    const c = await freshCenter();
    c.upsertBuild("s1", "blog", "Home", VIBE_TARGET);
    const seqBefore = c.operations[0].seq;
    c.upsertBuild("s1", "blog renamed", "Home", VIBE_TARGET);
    expect(c.operations).toHaveLength(1);
    expect(c.operations[0].seq).toBe(seqBefore);
    expect(c.operations[0].subject).toBe("blog renamed");
  });

  it("removeBuild clears it", async () => {
    const c = await freshCenter();
    c.upsertBuild("s1", "blog", "Home", VIBE_TARGET);
    c.removeBuild("s1");
    expect(c.operations).toHaveLength(0);
    expect(c.primary).toBeNull();
  });
});

describe("activeOperations — ordering & mixing the two feeders", () => {
  it("primary is the most recently started", async () => {
    const c = await freshCenter();
    c.syncDeployOperations([pendingPod("p1", "Home")]); // seq 1
    c.upsertBuild("s1", "blog", "Home", VIBE_TARGET); // seq 2
    expect(c.primary.kind).toBe("build");
    expect(c.additionalCount).toBe(1);

    // When the build finishes the deploy is primary again.
    c.removeBuild("s1");
    expect(c.primary.kind).toBe("deploy");
    expect(c.additionalCount).toBe(0);
  });

  it("a deploy sync preserves build operations", async () => {
    const c = await freshCenter();
    c.upsertBuild("s1", "blog", "Home", VIBE_TARGET);
    c.syncDeployOperations([pendingPod("p1", "Home")]);
    expect(c.operations).toHaveLength(2);
    expect(c.operations.some((o: any) => o.kind === "build")).toBe(true);
    expect(c.operations.some((o: any) => o.kind === "deploy")).toBe(true);
  });

  it("mixed operations count + additional", async () => {
    const c = await freshCenter();
    c.syncDeployOperations([pendingPod("p1", "Home"), pendingPod("p2", "Work")]);
    c.upsertBuild("s1", "blog", "Home", VIBE_TARGET);
    expect(c.operations).toHaveLength(3);
    expect(c.additionalCount).toBe(2);
  });

  it("deploy and build ids never collide on a shared raw id", async () => {
    const c = await freshCenter();
    c.syncDeployOperations([pendingPod("x", "Home")]);
    c.upsertBuild("x", "blog", "Home", VIBE_TARGET);
    expect(c.operations).toHaveLength(2);
  });
});

describe("activeOperations — subscribe / churn", () => {
  it("notifies on real changes and stays silent on no-ops", async () => {
    const c = await freshCenter();
    let n = 0;
    const off = c.subscribe(() => {
      n += 1;
    });

    c.upsertBuild("s1", "blog", "Home", VIBE_TARGET); // +1 (add)
    c.upsertBuild("s1", "blog", "Home", VIBE_TARGET); // no-op (identical)
    expect(n).toBe(1);

    c.syncDeployOperations([pendingPod("p1", "Home")]); // +1 (add deploy)
    c.syncDeployOperations([pendingPod("p1", "Home")]); // no-op (unchanged)
    expect(n).toBe(2);

    c.removeBuild("nope"); // no-op (absent)
    expect(n).toBe(2);

    c.removeBuild("s1"); // +1 (remove)
    expect(n).toBe(3);

    off();
    c.upsertBuild("s2", "wiki", null, VIBE_TARGET); // no longer observed
    expect(n).toBe(3);
  });
});

describe("activeOperations — shared singleton", () => {
  it("exports a ready-to-use center instance", async () => {
    const { activeOperations } = await load();
    expect(activeOperations).toBeTruthy();
    expect(typeof activeOperations.syncDeployOperations).toBe("function");
    expect(typeof activeOperations.upsertBuild).toBe("function");
  });
});
