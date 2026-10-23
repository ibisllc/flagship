import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyze, formatPath, topBypasses, validateGraph } from "./crypto-graph-check.mjs";

const SCRIPT = join(__dirname, "crypto-graph-check.mjs");

const node = (id: string, kind: string, pq: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  label: id,
  algorithms: pq === "classical-only" ? ["Ed25519"] : pq === "symmetric" ? ["AES-256-GCM"] : [],
  location: "synthetic",
  pq,
  owner: "test",
  evidence: ["synthetic.ts:1"],
  ...extra,
});
const edge = (from: string, to: string, type: string, extra: Record<string, unknown> = {}) => ({
  from,
  to,
  type,
  evidence: ["synthetic.ts:2"],
  ...extra,
});

// classical signer -> authorizes -> effect A           (bypass, 1 step)
// classical sealer -> unwraps -> symmetric key -> unwraps -> data B   (bypass, 2 steps)
// pq signer -> authorizes -> effect C                   (safe)
// hybrid key, enrolled by a classical directory -> authorizes -> effect D  (bypass through a hybrid key)
// effect E needs classical maintainer AND pq owner (gate all) -> safe
// effect F needs classical maintainer AND classical owner (gate all) -> bypass with side condition
// effect G is reachable only through a compatibility-profile edge -> safe in strict
function synthetic() {
  return {
    schemaVersion: 1,
    baseCommit: "152ab3d87",
    nodes: [
      node("k.classical-signer", "key", "classical-only"),
      node("k.classical-sealer", "key", "classical-only", { algorithms: ["X25519"] }),
      node("k.sym", "key", "symmetric"),
      node("k.pq-signer", "key", "pq", { algorithms: ["ML-DSA-65"] }),
      node("k.directory", "admin-channel", "classical-only", { algorithms: ["WebPKI ECDSA"] }),
      node("k.hybrid", "key", "hybrid", { algorithms: ["Ed25519", "ML-DSA-65"] }),
      node("k.maintainer", "key", "classical-only"),
      node("k.owner-pq", "key", "pq", { algorithms: ["ML-DSA-65"] }),
      node("k.owner-classical", "key", "classical-only"),
      node("e.a", "effect", "n/a"),
      node("d.b", "data", "n/a"),
      node("e.c", "effect", "n/a"),
      node("e.d", "effect", "n/a"),
      node("e.e", "effect", "n/a", { gate: "all" }),
      node("e.f", "effect", "n/a", { gate: "all" }),
      node("e.g", "effect", "n/a"),
    ],
    edges: [
      edge("k.classical-signer", "e.a", "authorizes"),
      edge("k.classical-sealer", "k.sym", "unwraps"),
      edge("k.sym", "d.b", "unwraps"),
      edge("k.pq-signer", "e.c", "authorizes"),
      edge("k.directory", "k.hybrid", "replaces"),
      edge("k.hybrid", "e.d", "authorizes"),
      edge("k.maintainer", "e.e", "authorizes", { group: "release" }),
      edge("k.owner-pq", "e.e", "authorizes", { group: "owner" }),
      edge("k.maintainer", "e.f", "authorizes", { group: "release" }),
      edge("k.owner-classical", "e.f", "authorizes", { group: "owner" }),
      edge("k.classical-signer", "e.g", "downgrades", { profile: "compatibility" }),
    ],
    targets: ["e.a", "d.b", "e.c", "e.d", "e.e", "e.f", "e.g"].map((n) => ({
      node: n,
      claim: n.startsWith("d.") ? "confidentiality" : "authorization",
      profile: "strict",
    })),
  };
}

describe("crypto-graph-check", () => {
  it("accepts the synthetic graph", () => {
    expect(validateGraph(synthetic())).toEqual([]);
  });

  it("finds exactly the classical-only bypasses", () => {
    const r = analyze(synthetic());
    const status = Object.fromEntries(r.results.map((x: { target: string; compromised: boolean }) => [x.target, x.compromised]));
    expect(status).toEqual({ "e.a": true, "d.b": true, "e.c": false, "e.d": true, "e.e": false, "e.f": true, "e.g": false });
    const byTarget = Object.fromEntries(r.results.map((x: { target: string; paths: unknown[] }) => [x.target, x.paths.map((p) => formatPath(p))]));
    expect(byTarget["e.a"]).toEqual(["k.classical-signer -[authorizes]-> e.a"]);
    expect(byTarget["d.b"]).toEqual(["k.classical-sealer -[unwraps]-> k.sym -[unwraps]-> d.b"]);
    expect(byTarget["e.d"]).toEqual(["k.directory -[replaces]-> k.hybrid -[authorizes]-> e.d"]);
    expect(byTarget["e.f"]).toEqual([
      "k.maintainer -[authorizes]-> e.f (+ k.owner-classical)",
      "k.owner-classical -[authorizes]-> e.f (+ k.maintainer)",
    ]);
    expect(r.fallen).toContain("k.sym");
    expect(r.fallen).toContain("k.hybrid");
    expect(r.fallen).not.toContain("k.pq-signer");
  });

  it("enumerates every simple path, not just one", () => {
    const g = synthetic();
    g.nodes.push(node("k.second", "key", "classical-only"));
    g.edges.push(edge("k.second", "k.sym", "unwraps"));
    const r = analyze(g, { target: "d.b" });
    expect(r.results[0].pathCount).toBe(2);
  });

  it("ranks the shortest bypass first", () => {
    const top = topBypasses(analyze(synthetic()), 2);
    expect(top.map((t: { target: string }) => t.target)).toEqual(["e.a", "e.f"]);
  });

  it("rejects malformed graphs", () => {
    const g = synthetic() as unknown as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[]; targets: Record<string, unknown>[] };
    g.nodes[0]!.pq = "quantumish";
    g.nodes[1]!.evidence = [];
    g.edges[0]!.to = "missing";
    g.edges[1]!.type = "owns";
    g.targets[0]!.node = "k.sym";
    const errors = validateGraph(g).join("\n");
    expect(errors).toMatch(/nodes\[0\].*pq must be/);
    expect(errors).toMatch(/nodes\[1\].*evidence is empty/);
    expect(errors).toMatch(/unknown to node "missing"/);
    expect(errors).toMatch(/type must be one of/);
    expect(errors).toMatch(/must be a data or effect node/);
  });

  it("allows empty evidence only on an inferred entry", () => {
    const g = synthetic();
    (g.nodes[2] as Record<string, unknown>).evidence = [];
    (g.nodes[2] as Record<string, unknown>).inferred = true;
    expect(validateGraph(g)).toEqual([]);
  });

  it("exits 1 on bypasses, 0 when clean, 2 on schema errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "crypto-graph-"));
    const run = (g: unknown) => {
      const f = join(dir, `g${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, JSON.stringify(g));
      return spawnSync(process.execPath, [SCRIPT, f], { encoding: "utf8" });
    };
    const dirty = run(synthetic());
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toContain("FAIL e.a");
    expect(dirty.stdout).toContain("OK   e.c");

    const clean = synthetic();
    clean.targets = clean.targets.filter((t) => ["e.c", "e.e", "e.g"].includes(t.node));
    expect(run(clean).status).toBe(0);

    const broken = synthetic() as unknown as { schemaVersion: number };
    broken.schemaVersion = 2;
    expect(run(broken).status).toBe(2);
  });
});
