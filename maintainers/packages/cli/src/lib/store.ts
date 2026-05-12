/**
 * On-disk .maintainers/ folder I/O.
 *
 * Matches §7 of the spec:
 *   .maintainers/
 *   ├── policy.json
 *   ├── keys/<email>.json
 *   ├── tracks/<track>/policy.json
 *   ├── tracks/<track>/mandates/<iso>-<summary>.json
 *   └── endorsements/<semver-tag>.json
 *
 * The reader returns parsed envelopes; the writer canonicalizes filenames and
 * refuses to overwrite. Both sides are pure-fs and have no git awareness —
 * git is the canonical-log layer above us.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Mandate,
  ReleaseEndorsement,
  RootPolicy,
  TrackPolicy,
} from "@maintainers/protocol";
import { CliError } from "./args.js";

export interface MaintainersStore {
  rootDir: string;
  rootPolicy: RootPolicy | null;
  trackPolicies: Map<string, TrackPolicy>;
  mandatesByTrack: Map<string, Mandate[]>;
  endorsements: ReleaseEndorsement[];
}

export function readStore(rootDir: string): MaintainersStore {
  const out: MaintainersStore = {
    rootDir,
    rootPolicy: null,
    trackPolicies: new Map(),
    mandatesByTrack: new Map(),
    endorsements: [],
  };

  const rootPolicyPath = path.join(rootDir, "policy.json");
  if (fs.existsSync(rootPolicyPath)) {
    out.rootPolicy = readJson(rootPolicyPath) as RootPolicy;
  }

  const tracksDir = path.join(rootDir, "tracks");
  if (fs.existsSync(tracksDir) && fs.statSync(tracksDir).isDirectory()) {
    for (const name of fs.readdirSync(tracksDir).sort()) {
      const trackDir = path.join(tracksDir, name);
      if (!fs.statSync(trackDir).isDirectory()) continue;
      const policyPath = path.join(trackDir, "policy.json");
      if (fs.existsSync(policyPath)) {
        out.trackPolicies.set(name, readJson(policyPath) as TrackPolicy);
      }
      const mandatesDir = path.join(trackDir, "mandates");
      if (fs.existsSync(mandatesDir) && fs.statSync(mandatesDir).isDirectory()) {
        const files = fs.readdirSync(mandatesDir)
          .filter((f) => f.endsWith(".json"))
          .sort();
        const arr: Mandate[] = [];
        for (const f of files) {
          const parsed = readJson(path.join(mandatesDir, f));
          if (isMandate(parsed)) arr.push(parsed);
        }
        out.mandatesByTrack.set(name, arr);
      } else {
        out.mandatesByTrack.set(name, []);
      }
    }
  }

  const endorsementsDir = path.join(rootDir, "endorsements");
  if (fs.existsSync(endorsementsDir) && fs.statSync(endorsementsDir).isDirectory()) {
    const files = fs.readdirSync(endorsementsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files) {
      const parsed = readJson(path.join(endorsementsDir, f));
      if (isReleaseEndorsement(parsed)) out.endorsements.push(parsed);
    }
    // Order by issuedAt as a stable canonical-log substitute (real adapters
    // get this from git commit order, but the on-disk view used by verify/
    // status only sees timestamps).
    out.endorsements.sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
  }

  return out;
}

export interface WrittenPath {
  absolute: string;
  relative: string;
}

export function writeMandate(rootDir: string, m: Mandate): WrittenPath {
  const dir = path.join(rootDir, "tracks", m.track, "mandates");
  fs.mkdirSync(dir, { recursive: true });
  const file = mandateFilename(m);
  const abs = path.join(dir, file);
  if (fs.existsSync(abs)) {
    throw new CliError(`refusing to overwrite existing mandate file: ${abs}`);
  }
  fs.writeFileSync(abs, JSON.stringify(m, null, 2) + "\n", "utf8");
  return { absolute: abs, relative: path.relative(rootDir, abs) };
}

export function writeEndorsement(rootDir: string, e: ReleaseEndorsement): WrittenPath {
  const dir = path.join(rootDir, "endorsements");
  fs.mkdirSync(dir, { recursive: true });
  const safeTag = e.semverTag.replace(/[^A-Za-z0-9.\-_+]/g, "_");
  const file = `${safeTag}.json`;
  const abs = path.join(dir, file);
  if (fs.existsSync(abs)) {
    throw new CliError(`refusing to overwrite existing endorsement file: ${abs}`);
  }
  fs.writeFileSync(abs, JSON.stringify(e, null, 2) + "\n", "utf8");
  return { absolute: abs, relative: path.relative(rootDir, abs) };
}

export function writeTrackPolicyIfMissing(
  rootDir: string,
  policy: TrackPolicy,
): WrittenPath | null {
  const dir = path.join(rootDir, "tracks", policy.track);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, "policy.json");
  if (fs.existsSync(abs)) return null;
  fs.writeFileSync(abs, JSON.stringify(policy, null, 2) + "\n", "utf8");
  return { absolute: abs, relative: path.relative(rootDir, abs) };
}

export function writeRootPolicyIfMissing(
  rootDir: string,
  policy: RootPolicy,
): WrittenPath | null {
  fs.mkdirSync(rootDir, { recursive: true });
  const abs = path.join(rootDir, "policy.json");
  if (fs.existsSync(abs)) return null;
  fs.writeFileSync(abs, JSON.stringify(policy, null, 2) + "\n", "utf8");
  return { absolute: abs, relative: path.relative(rootDir, abs) };
}

/**
 * Build a mandate filename: `<iso-zulu-compact>-<short-id>.json`. The compact
 * timestamp keeps directory listings sortable; the short id disambiguates
 * mandates issued in the same second.
 */
export function mandateFilename(m: Mandate): string {
  const compact = m.issuedAt.replace(/[:\-]/g, "").replace(/\..*Z$/, "Z").replace(/Z$/, "");
  const safeCompact = compact.replace(/[^0-9T]/g, "");
  const shortId = m.mandateId.slice(0, 8);
  return `${safeCompact}-${shortId}.json`;
}

function readJson(p: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    throw new CliError(`failed to read ${p}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`failed to parse JSON in ${p}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isMandate(x: unknown): x is Mandate {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  return obj.kind === "Mandate" && obj.version === 1
    && typeof obj.mandateId === "string"
    && typeof obj.track === "string"
    && typeof obj.holder === "string"
    && typeof obj.issuedAt === "string"
    && typeof obj.expiresAt === "string"
    && Array.isArray(obj.successors)
    && typeof obj.signedBy === "string"
    && Array.isArray(obj.signatures);
}

function isReleaseEndorsement(x: unknown): x is ReleaseEndorsement {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  return obj.kind === "ReleaseEndorsement" && obj.version === 1
    && typeof obj.releaseId === "string"
    && typeof obj.commitHash === "string"
    && typeof obj.intermediateMerkleRoot === "string"
    && typeof obj.issuedAt === "string"
    && Array.isArray(obj.signatures)
    && Array.isArray(obj.intermediateCommits);
}
