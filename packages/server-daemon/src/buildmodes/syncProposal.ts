/**
 * Explicit sync with an imported app's upstream (SECURITY-HARDENING-PLAN.md 18.12). The owner picks ONE
 * verified candidate (a specific upstream commit, cloned into isolated staging); this compares three
 * trees, the base the app was imported at, what the owner runs now and the candidate, and says what a
 * merge would do before anything is built:
 *
 *   - files only upstream changed take the candidate's version;
 *   - files only the owner changed keep theirs;
 *   - files both changed differently are conflicts: nothing is merged for them and the owner (or an AI
 *     repair they consented to) resolves them in staging;
 *   - the manifest's capability sections are compared on their own, so a new host, data store or
 *     permission is shown as such and never rides in with a code change.
 *
 * It only reads. The proposal never touches the live app: building, testing and promoting are separate steps
 * with their own approvals, and a failed or abandoned sync leaves the live app and its data as they were.
 */

export type FileTree = Record<string, string>;

export interface CapabilityChange {
  section: string;
  added: string[];
  removed: string[];
}

export interface SyncProposal {
  /** Paths upstream changed since the base (added, changed or removed). */
  upstreamChanged: string[];
  /** Paths the owner changed since the base. */
  localChanged: string[];
  /** Only upstream changed them: the merge takes the candidate's version. */
  takeUpstream: string[];
  /** Both changed them, differently: nothing is merged, a person or a consented repair decides. */
  conflicts: string[];
  /** Added or changed by the candidate that the owner also touched identically: no action. */
  alreadyApplied: string[];
  /** The result for every path that is not a conflict (a removed file is absent). */
  merged: FileTree;
  /** Capability sections that differ between what runs now and the candidate's manifest. */
  capabilityChanges: CapabilityChange[];
  /** True when nothing needs a decision: no conflict and no new capability. */
  clean: boolean;
}

const MANIFEST = "flagship.app.json";

/** Manifest sections that grant something. Each is a list of strings or an object whose keys are the entries. */
const CAPABILITY_SECTIONS: Array<[section: string, pick: (m: Record<string, unknown>) => string[]]> = [
  ["network.egress", (m) => entries((m.network as Record<string, unknown> | undefined)?.egress)],
  ["network.subdomain", (m) => entries((m.network as Record<string, unknown> | undefined)?.subdomain)],
  ["data.stores", (m) => entries((m.data as Record<string, unknown> | undefined)?.stores)],
  ["browser.domains", (m) => entries((m.browser as Record<string, unknown> | undefined)?.domains)],
  ["access", (m) => entries((m.access as Record<string, unknown> | undefined)?.public_routes).map((r) => `public route ${r}`)],
  ["runtime", (m) => entries((m.runtime as Record<string, unknown> | undefined)?.base).map((r) => `base ${r}`)],
  ["distribution", (m) => entries((m.distribution as Record<string, unknown> | undefined)?.public).map((r) => `public ${r}`)],
];

function entries(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(sortKeys(x)))).sort();
  if (typeof v === "object") return Object.keys(v as object).sort().map((k) => `${k}=${JSON.stringify(sortKeys((v as Record<string, unknown>)[k]))}`);
  return [String(v)];
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

function parseManifest(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const m = JSON.parse(text) as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function capabilityChanges(current: string | undefined, candidate: string | undefined): CapabilityChange[] {
  const a = parseManifest(current);
  const b = parseManifest(candidate);
  const out: CapabilityChange[] = [];
  for (const [section, pick] of CAPABILITY_SECTIONS) {
    const before = new Set(pick(a));
    const after = new Set(pick(b));
    const added = [...after].filter((x) => !before.has(x));
    const removed = [...before].filter((x) => !after.has(x));
    if (added.length || removed.length) out.push({ section, added, removed });
  }
  return out;
}

function changedPaths(from: FileTree, to: FileTree): Set<string> {
  const out = new Set<string>();
  for (const p of new Set([...Object.keys(from), ...Object.keys(to)])) if (from[p] !== to[p]) out.add(p);
  return out;
}

export function proposeSync(input: { base: FileTree; local: FileTree; upstream: FileTree }): SyncProposal {
  const { base, local, upstream } = input;
  const up = changedPaths(base, upstream);
  const own = changedPaths(base, local);
  const takeUpstream: string[] = [];
  const conflicts: string[] = [];
  const alreadyApplied: string[] = [];
  const merged: FileTree = { ...local };
  for (const p of [...up].sort()) {
    if (!own.has(p)) {
      takeUpstream.push(p);
      if (upstream[p] === undefined) delete merged[p];
      else merged[p] = upstream[p]!;
    } else if (local[p] === upstream[p]) {
      alreadyApplied.push(p);
    } else {
      conflicts.push(p);
    }
  }
  // The manifest is the owner's: the candidate's version only informs the capability comparison, and a
  // conflict there is a conflict like any other.
  const caps = capabilityChanges(merged[MANIFEST] ?? local[MANIFEST], upstream[MANIFEST]);
  const manifestTaken = takeUpstream.includes(MANIFEST);
  const capabilityChangesOut = manifestTaken || conflicts.includes(MANIFEST) ? capabilityChanges(local[MANIFEST], upstream[MANIFEST]) : caps;
  return {
    upstreamChanged: [...up].sort(),
    localChanged: [...own].sort(),
    takeUpstream,
    conflicts,
    alreadyApplied,
    merged,
    capabilityChanges: capabilityChangesOut,
    clean: conflicts.length === 0 && capabilityChangesOut.every((c) => c.added.length === 0),
  };
}
