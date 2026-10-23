#!/usr/bin/env node
// Classical-only bypass checker for the cryptographic dependency graph
// (docs/architecture-v2/IMPLEMENTATION-PLAN.md §6.6).
//
// Adversary: breaks every classical public-key primitive. Every node whose `pq` is
// `classical-only` is therefore attacker-controlled from the start; control then spreads
// along edges (`A -[type]-> B` reads "whoever controls A can <type> B"). A node with
// `gate: "all"` falls only when every one of its in-edge groups has a fallen source
// (edges without a `group` are their own group). Edges marked `profile: "compatibility"`
// exist only for owners who opted out and are ignored when judging strict targets.
//
// Usage: node scripts/crypto-graph-check.mjs [graph.json] [--json] [--schema-only]
//          [--check-evidence] [--max-paths N] [--target ID] [--top N]
// Exit: 0 no bypass, 1 bypasses found, 2 schema or usage error.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NODE_KINDS = new Set([
  "key", "verifier", "executable", "transport", "storage-envelope", "admin-channel",
  "external-service", "firmware", "artifact", "data", "effect",
]);
export const PQ_STATUS = new Set(["classical-only", "hybrid", "pq", "symmetric", "n/a"]);
export const EDGE_TYPES = new Set(["replaces", "authorizes", "recovers", "unwraps", "executes", "downgrades"]);
export const PROFILES = new Set(["strict", "compatibility"]);
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const EVIDENCE = /^[^\s:]+(?:\/[^\s:]+)*:\d+(?:-\d+)?$/;

/** Validate the graph's shape. Returns a list of error strings (empty = valid). */
export function validateGraph(g, opts = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!g || typeof g !== "object" || Array.isArray(g)) return ["graph must be a JSON object"];
  if (g.schemaVersion !== 1) err("schemaVersion must be 1");
  if (typeof g.baseCommit !== "string" || !/^[0-9a-f]{7,40}$/.test(g.baseCommit)) err("baseCommit must be a git commit hash");
  for (const k of ["nodes", "edges", "targets"]) if (!Array.isArray(g[k])) err(`${k} must be an array`);
  if (errors.length) return errors;

  const ids = new Map();
  g.nodes.forEach((n, i) => {
    const at = `nodes[${i}]${n && typeof n.id === "string" ? ` (${n.id})` : ""}`;
    if (!n || typeof n !== "object") return err(`${at}: must be an object`);
    if (typeof n.id !== "string" || !ID.test(n.id)) err(`${at}: id must match ${ID}`);
    else if (ids.has(n.id)) err(`${at}: duplicate id`);
    else ids.set(n.id, n);
    if (!NODE_KINDS.has(n.kind)) err(`${at}: kind must be one of ${[...NODE_KINDS].join(", ")}`);
    if (typeof n.label !== "string" || !n.label) err(`${at}: label is required`);
    if (!Array.isArray(n.algorithms) || n.algorithms.some((a) => typeof a !== "string")) err(`${at}: algorithms must be a list of strings`);
    if (typeof n.location !== "string" || !n.location) err(`${at}: location is required`);
    if (!PQ_STATUS.has(n.pq)) err(`${at}: pq must be one of ${[...PQ_STATUS].join(", ")}`);
    if (typeof n.owner !== "string" || !n.owner) err(`${at}: owner is required (a placeholder role is fine)`);
    if (n.gate !== undefined && n.gate !== "any" && n.gate !== "all") err(`${at}: gate must be "any" or "all"`);
    if (n.inferred !== undefined && typeof n.inferred !== "boolean") err(`${at}: inferred must be boolean`);
    checkEvidence(n, at, err);
    if (n.pq === "classical-only" && Array.isArray(n.algorithms) && n.algorithms.length === 0) err(`${at}: a classical-only node must name its algorithm(s)`);
  });
  g.edges.forEach((e, i) => {
    const at = `edges[${i}]${e && e.from ? ` (${e.from} -> ${e.to})` : ""}`;
    if (!e || typeof e !== "object") return err(`${at}: must be an object`);
    if (!ids.has(e.from)) err(`${at}: unknown from node ${JSON.stringify(e.from)}`);
    if (!ids.has(e.to)) err(`${at}: unknown to node ${JSON.stringify(e.to)}`);
    if (e.from === e.to) err(`${at}: self edge`);
    if (!EDGE_TYPES.has(e.type)) err(`${at}: type must be one of ${[...EDGE_TYPES].join(", ")}`);
    if (e.profile !== undefined && !PROFILES.has(e.profile)) err(`${at}: profile must be strict or compatibility`);
    if (e.group !== undefined && (typeof e.group !== "string" || !e.group)) err(`${at}: group must be a non-empty string`);
    if (e.inferred !== undefined && typeof e.inferred !== "boolean") err(`${at}: inferred must be boolean`);
    checkEvidence(e, at, err);
  });
  const seenTargets = new Set();
  g.targets.forEach((t, i) => {
    const at = `targets[${i}]`;
    if (!t || typeof t !== "object") return err(`${at}: must be an object`);
    const n = ids.get(t.node);
    if (!n) err(`${at}: unknown node ${JSON.stringify(t.node)}`);
    else if (n.kind !== "data" && n.kind !== "effect") err(`${at}: target ${t.node} must be a data or effect node`);
    if (seenTargets.has(t.node)) err(`${at}: duplicate target ${t.node}`);
    seenTargets.add(t.node);
    if (t.claim !== "confidentiality" && t.claim !== "authorization") err(`${at}: claim must be confidentiality or authorization`);
    if (t.profile !== "strict") err(`${at}: profile must be "strict"`);
  });
  if (opts.repoRoot) {
    const lines = new Map();
    const cite = (c, at) => {
      const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(c);
      if (!m) return;
      const p = resolve(opts.repoRoot, m[1]);
      if (!existsSync(p)) return err(`${at}: evidence file not found: ${m[1]}`);
      if (!lines.has(p)) lines.set(p, readFileSync(p, "utf8").split("\n").length);
      const last = Number(m[3] ?? m[2]);
      if (last > lines.get(p) || Number(m[2]) < 1) err(`${at}: evidence line out of range: ${c}`);
    };
    g.nodes.forEach((n, i) => (n.evidence ?? []).forEach((c) => cite(c, `nodes[${i}] (${n.id})`)));
    g.edges.forEach((e, i) => (e.evidence ?? []).forEach((c) => cite(c, `edges[${i}] (${e.from} -> ${e.to})`)));
  }
  return errors;
}

function checkEvidence(x, at, err) {
  if (!Array.isArray(x.evidence)) return err(`${at}: evidence must be a list of path:line strings`);
  if (x.evidence.length === 0 && x.inferred !== true) err(`${at}: evidence is empty; cite path:line or mark inferred: true`);
  for (const c of x.evidence) if (typeof c !== "string" || !EVIDENCE.test(c)) err(`${at}: evidence ${JSON.stringify(c)} is not path:line`);
}

/**
 * Fixpoint of attacker control under the classical-break adversary, then every simple path
 * from a classical-only root to each strict target through fallen nodes.
 */
export function analyze(g, opts = {}) {
  const maxPaths = opts.maxPaths ?? 200;
  const maxCount = opts.maxCount ?? 100_000;
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const inEdges = new Map(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) {
    if (e.profile === "compatibility") continue;
    inEdges.get(e.to).push(e);
  }
  const groupsOf = (id) => {
    const groups = new Map();
    inEdges.get(id).forEach((e, i) => {
      const k = e.group ?? `#${i}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    });
    return groups;
  };

  const fallen = new Set(g.nodes.filter((n) => n.pq === "classical-only").map((n) => n.id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of g.nodes) {
      if (fallen.has(n.id)) continue;
      const ins = inEdges.get(n.id);
      if (ins.length === 0) continue;
      let falls;
      if (n.gate === "all") falls = [...groupsOf(n.id).values()].every((es) => es.some((e) => fallen.has(e.from)));
      else falls = ins.some((e) => fallen.has(e.from));
      if (falls) {
        fallen.add(n.id);
        changed = true;
      }
    }
  }

  const results = [];
  for (const t of g.targets) {
    if (opts.target && t.node !== opts.target) continue;
    const paths = [];
    let total = 0;
    let truncated = false;
    if (fallen.has(t.node)) {
      // Walk backwards over fallen nodes. At a gate:"all" node the path enters through one
      // edge; the other groups' fallen sources are recorded as side conditions.
      const walk = (id, suffix, onPath) => {
        if (total >= maxCount) {
          truncated = true;
          return;
        }
        const n = nodes.get(id);
        if (n.pq === "classical-only") {
          total += 1;
          if (paths.length < maxPaths) paths.push(suffix);
          return;
        }
        const groups = groupsOf(id);
        for (const [gk, es] of groups) {
          for (const e of es) {
            if (!fallen.has(e.from) || onPath.has(e.from)) continue;
            const also = n.gate === "all"
              ? [...groups].filter(([k]) => k !== gk).map(([, others]) => others.find((o) => fallen.has(o.from)).from)
              : [];
            const step = { from: e.from, to: id, type: e.type, ...(also.length ? { alsoRequires: also } : {}) };
            onPath.add(e.from);
            walk(e.from, [step, ...suffix], onPath);
            onPath.delete(e.from);
          }
        }
      };
      walk(t.node, [], new Set([t.node]));
      paths.sort((a, b) => a.length - b.length || pathKey(a).localeCompare(pathKey(b)));
    }
    results.push({ target: t.node, claim: t.claim, compromised: fallen.has(t.node), pathCount: total, truncated, paths });
  }
  return { fallen: [...fallen].sort(), results };
}

const pathKey = (p) => p.map((s) => `${s.from}>${s.to}`).join("|");

export function formatPath(p) {
  if (p.length === 0) return "(target is itself classical-only)";
  const parts = [p[0].from];
  for (const s of p) parts.push(`-[${s.type}]-> ${s.to}${s.alsoRequires ? ` (+ ${s.alsoRequires.join(", ")})` : ""}`);
  return parts.join(" ");
}

/** The shortest bypass of each compromised target, shortest first. */
export function topBypasses(analysis, n = 10) {
  return analysis.results
    .filter((r) => r.compromised && r.paths.length)
    .map((r) => ({ target: r.target, claim: r.claim, path: r.paths[0], pathCount: r.pathCount }))
    .sort((a, b) => a.path.length - b.path.length || a.target.localeCompare(b.target))
    .slice(0, n);
}

function parseArgs(argv) {
  const o = { file: null, json: false, schemaOnly: false, checkEvidence: false, maxPaths: 200, target: null, top: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--schema-only") o.schemaOnly = true;
    else if (a === "--check-evidence") o.checkEvidence = true;
    else if (a === "--max-paths") o.maxPaths = Number(argv[++i]);
    else if (a === "--target") o.target = argv[++i];
    else if (a === "--top") o.top = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (o.file) throw new Error("only one graph file");
    else o.file = a;
  }
  if (!Number.isInteger(o.maxPaths) || o.maxPaths < 1) throw new Error("--max-paths needs a positive integer");
  if (!Number.isInteger(o.top) || o.top < 1) throw new Error("--top needs a positive integer");
  return o;
}

export function main(argv, out = console.log) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    out(`usage error: ${e.message}`);
    return 2;
  }
  const file = resolve(o.file ?? `${repoRoot}/docs/architecture-v2/crypto-graph.json`);
  let g;
  try {
    g = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    out(`cannot read ${file}: ${e.message}`);
    return 2;
  }
  const errors = validateGraph(g, o.checkEvidence ? { repoRoot } : {});
  if (errors.length) {
    out(`schema: ${errors.length} error(s) in ${file}`);
    for (const m of errors) out(`  - ${m}`);
    return 2;
  }
  if (o.schemaOnly) {
    out(`schema: ok (${g.nodes.length} nodes, ${g.edges.length} edges, ${g.targets.length} targets)`);
    return 0;
  }
  if (o.target && !g.targets.some((t) => t.node === o.target)) {
    out(`usage error: ${o.target} is not a declared target`);
    return 2;
  }
  const a = analyze(g, { maxPaths: o.maxPaths, target: o.target });
  const bad = a.results.filter((r) => r.compromised);
  if (o.json) {
    out(JSON.stringify({ baseCommit: g.baseCommit, fallen: a.fallen, results: a.results, top: topBypasses(a, o.top) }, null, 2));
    return bad.length ? 1 : 0;
  }
  out(`graph ${file} at ${g.baseCommit}: ${g.nodes.length} nodes, ${g.edges.length} edges, ${g.targets.length} strict targets`);
  out(`adversary breaks every classical public-key primitive: ${a.fallen.length} node(s) fall`);
  for (const r of a.results) {
    if (!r.compromised) {
      out(`\nOK   ${r.target} (${r.claim}): no classical-only path`);
      continue;
    }
    out(`\nFAIL ${r.target} (${r.claim}): ${r.pathCount}${r.truncated ? "+" : ""} path(s)${r.pathCount > r.paths.length ? `, first ${r.paths.length} shown` : ""}`);
    for (const p of r.paths) out(`  ${formatPath(p)}`);
  }
  const top = topBypasses(a, o.top);
  if (top.length) {
    out(`\nTop ${top.length} bypass(es), shortest path per target:`);
    top.forEach((b, i) => out(`  ${i + 1}. ${b.target}: ${formatPath(b.path)}`));
  }
  out(`\n${bad.length} of ${a.results.length} strict target(s) reachable without breaking any PQ or symmetric primitive.`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
