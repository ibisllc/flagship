/**
 * The browser grants the owner gave beyond an app's manifest, kept on disk so a standing ("until you
 * remove it") grant survives a daemon restart. Only standing grants are kept: a one-visit or
 * this-session grant ends with the browser context it was for, which a restart closes anyway.
 *
 * Each entry records the app's manifest `browser.domains` when the grant was given, so the boot-time
 * re-registration of the same manifest keeps it while a changed manifest still ends it (bootstrap.ts).
 *
 * Fail closed: a damaged or unexpected file is set aside (`<file>.corrupt-<ms>`, noted in Activity) and
 * the box loads no owner grants at all, never a wider set; apps ask again. Expired grants are dropped
 * on load.
 */
import { keepCorruptAside, readStateFile, writeFileDurable } from "../durableFile.js";
import type { BrowserCapability, BrowserGrant, LocalNetworkGrant } from "./policy/grants.js";

const CAPS: BrowserCapability[] = ["navigate", "read-dom", "screenshot", "input", "download"];

export interface StoredBrowserGrant {
  grant: BrowserGrant;
  /** The app's manifest `browser.domains` (sorted) when the grant was given; null when it had none. */
  manifestDomains: string[] | null;
}

interface FileShape {
  v: 1;
  grants: StoredBrowserGrant[];
}

const isStr = (x: unknown): x is string => typeof x === "string";
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
const isTime = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

function isLocalNetwork(x: unknown): x is LocalNetworkGrant {
  if (x === null) return true;
  if (!x || typeof x !== "object") return false;
  const o = x as { kind?: unknown; hosts?: unknown };
  if (o.kind === "whole-lan") return Object.keys(o).length === 1;
  return o.kind === "exact" && isStrArr(o.hosts) && o.hosts.length > 0 && o.hosts.length <= 16 && Object.keys(o).length === 2;
}

function isGrant(x: unknown): x is BrowserGrant {
  if (!x || typeof x !== "object") return false;
  const g = x as Record<string, unknown>;
  return (
    isStr(g.id) && /^bg-[0-9a-f-]{36}$/.test(g.id) &&
    isStr(g.serviceId) && g.serviceId.length > 0 && g.serviceId.length <= 200 &&
    Array.isArray(g.capabilities) && g.capabilities.length > 0 && g.capabilities.every((c) => CAPS.includes(c as BrowserCapability)) &&
    isStrArr(g.origins) &&
    isStrArr(g.urlPrefixes) &&
    Array.isArray(g.schemes) && g.schemes.length > 0 && g.schemes.every((c) => c === "http" || c === "https") &&
    Array.isArray(g.ports) && g.ports.every((p) => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536) &&
    isLocalNetwork(g.localNetwork) &&
    g.duration === "service" &&
    isStr(g.explanation) &&
    g.sessionId === null &&
    isTime(g.issuedAt) &&
    (g.expiresAt === null || isTime(g.expiresAt)) &&
    g.revokedAt === null &&
    g.spentAt === null
  );
}

function parse(text: string): StoredBrowserGrant[] {
  const doc = JSON.parse(text) as Partial<FileShape>;
  if (!doc || typeof doc !== "object" || doc.v !== 1 || !Array.isArray(doc.grants)) throw new Error("not a browser grants file");
  return doc.grants.map((e, i) => {
    if (!e || typeof e !== "object" || !isGrant(e.grant) || !(e.manifestDomains === null || isStrArr(e.manifestDomains))) {
      throw new Error(`entry ${i} is not a browser grant`);
    }
    return { grant: e.grant, manifestDomains: e.manifestDomains === null ? null : [...e.manifestDomains].sort() };
  });
}

export class BrowserGrantStore {
  constructor(private readonly path: string, private readonly now: () => number = () => Date.now()) {}

  /** The standing grants the owner gave, minus expired ones; none at all when the file is damaged. */
  async load(): Promise<StoredBrowserGrant[]> {
    const read = await readStateFile(this.path);
    if (read.kind === "missing") return [];
    try {
      if (read.kind === "unreadable") throw read.error;
      const t = this.now();
      return parse(read.text).filter((e) => e.grant.expiresAt === null || e.grant.expiresAt > t);
    } catch (e) {
      await keepCorruptAside(this.path, e, "Browser access you gave apps beyond their manifests was forgotten; each app has to ask again.");
      return [];
    }
  }

  /** Replace the file with exactly these grants (standing ones only). */
  async save(entries: StoredBrowserGrant[]): Promise<void> {
    const doc: FileShape = { v: 1, grants: entries.filter((e) => e.grant.duration === "service") };
    await writeFileDurable(this.path, `${JSON.stringify(doc, null, 2)}\n`);
  }
}
