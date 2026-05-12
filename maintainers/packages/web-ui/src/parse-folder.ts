/**
 * Parse a `.maintainers/` folder (as a flat path→bytes map) into a
 * structured object the UI can navigate without re-parsing JSON on
 * every render.
 *
 * This module is intentionally tolerant: it surfaces parse errors per
 * file rather than throwing, so a single malformed envelope doesn't
 * blank the whole UI. The verifier (in @maintainers/protocol) is the
 * authority on what's accepted; this layer just unpacks bytes into
 * typed shapes.
 */

import type {
  KeyFile,
  KeyRedirect,
  Mandate,
  ReleaseEndorsement,
  RootPolicy,
  TrackPolicy,
} from "@maintainers/protocol";

export interface RawFolder {
  /** Map of relative path under `.maintainers/` → file bytes. */
  files: Map<string, Uint8Array>;
}

export interface ParsedTrack {
  name: string;
  policy: TrackPolicy | null;
  mandates: Mandate[];
  /** Files we tried to parse as mandates but couldn't. */
  malformedMandates: ParseError[];
}

export interface ParsedKey {
  email: string;
  keyfile: KeyFile | null;
  redirect: KeyRedirect | null;
  /** Path it came from. */
  path: string;
}

export interface ParsedFolder {
  rootPolicy: RootPolicy | null;
  tracks: ParsedTrack[];
  keys: ParsedKey[];
  endorsements: ReleaseEndorsement[];
  malformedEndorsements: ParseError[];
  /** Files that didn't match any known location. */
  unknownFiles: string[];
}

export interface ParseError {
  path: string;
  reason: string;
}

const DECODER = new TextDecoder("utf-8");

export function parseMaintainersFolder(raw: RawFolder): ParsedFolder {
  let rootPolicy: RootPolicy | null = null;
  const trackMap = new Map<string, { policy: TrackPolicy | null; mandates: Mandate[]; malformed: ParseError[] }>();
  const keyMap = new Map<string, ParsedKey>();
  const endorsements: ReleaseEndorsement[] = [];
  const malformedEndorsements: ParseError[] = [];
  const unknownFiles: string[] = [];

  for (const [path, bytes] of raw.files) {
    if (path === "policy.json") {
      const v = safeJson(bytes);
      if (v && isRootPolicy(v)) rootPolicy = v;
      else unknownFiles.push(path);
      continue;
    }
    if (path === "README.md") continue;
    if (path.startsWith("keys/")) {
      const rest = path.slice("keys/".length);
      if (!rest.endsWith(".json")) {
        unknownFiles.push(path);
        continue;
      }
      const email = rest.slice(0, -".json".length);
      const v = safeJson(bytes);
      if (v && (v as { kind?: string }).kind === "KeyFile") {
        keyMap.set(email, { email, keyfile: v as KeyFile, redirect: null, path });
      } else if (v && (v as { kind?: string }).kind === "KeyRedirect") {
        keyMap.set(email, { email, keyfile: null, redirect: v as KeyRedirect, path });
      } else {
        unknownFiles.push(path);
      }
      continue;
    }
    if (path.startsWith("tracks/")) {
      const trackPath = path.slice("tracks/".length);
      const slashIdx = trackPath.indexOf("/");
      if (slashIdx === -1) {
        unknownFiles.push(path);
        continue;
      }
      const trackName = trackPath.slice(0, slashIdx);
      const rest = trackPath.slice(slashIdx + 1);
      const entry = ensureTrack(trackMap, trackName);
      if (rest === "policy.json") {
        const v = safeJson(bytes);
        if (v && isTrackPolicy(v)) entry.policy = v;
        else entry.malformed.push({ path, reason: "policy.json malformed" });
        continue;
      }
      if (rest.startsWith("mandates/") && rest.endsWith(".json")) {
        const v = safeJson(bytes);
        if (v && (v as { kind?: string }).kind === "Mandate") {
          entry.mandates.push(v as Mandate);
        } else {
          entry.malformed.push({ path, reason: "not a Mandate envelope" });
        }
        continue;
      }
      unknownFiles.push(path);
      continue;
    }
    if (path.startsWith("endorsements/") && path.endsWith(".json")) {
      const v = safeJson(bytes);
      if (v && (v as { kind?: string }).kind === "ReleaseEndorsement") {
        endorsements.push(v as ReleaseEndorsement);
      } else {
        malformedEndorsements.push({ path, reason: "not a ReleaseEndorsement envelope" });
      }
      continue;
    }
    unknownFiles.push(path);
  }

  // Sort tracks alphabetically; mandates within a track by issuedAt;
  // endorsements globally by issuedAt.
  const tracks: ParsedTrack[] = [...trackMap.entries()]
    .map(([name, e]) => ({
      name,
      policy: e.policy,
      mandates: [...e.mandates].sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt)),
      malformedMandates: e.malformed,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  endorsements.sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));

  return {
    rootPolicy,
    tracks,
    keys: [...keyMap.values()],
    endorsements,
    malformedEndorsements,
    unknownFiles,
  };

  function safeJson(b: Uint8Array): unknown {
    try {
      return JSON.parse(DECODER.decode(b));
    } catch {
      return null;
    }
  }
}

function ensureTrack(
  map: Map<string, { policy: TrackPolicy | null; mandates: Mandate[]; malformed: ParseError[] }>,
  name: string,
): { policy: TrackPolicy | null; mandates: Mandate[]; malformed: ParseError[] } {
  let entry = map.get(name);
  if (!entry) {
    entry = { policy: null, mandates: [], malformed: [] };
    map.set(name, entry);
  }
  return entry;
}

function isRootPolicy(v: unknown): v is RootPolicy {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o["schemaVersion"] === 1 && typeof o["project"] === "object" && Array.isArray(o["tracks"]);
}

function isTrackPolicy(v: unknown): v is TrackPolicy {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["track"] === "string" &&
    typeof o["defaultMandateDuration"] === "string" &&
    typeof o["approvalRule"] === "object"
  );
}

/**
 * Look up a display name + email for a pubkey from the parsed keys list.
 * Returns null when the pubkey isn't in the roster — UI should show the
 * pubkey shorthand as a fallback.
 */
export function lookupHolder(
  folder: ParsedFolder,
  pubkey: string,
): { displayName: string; email: string } | null {
  for (const k of folder.keys) {
    if (k.keyfile && k.keyfile.pubkey === pubkey) {
      return { displayName: k.keyfile.displayName, email: k.keyfile.currentEmail };
    }
  }
  return null;
}
