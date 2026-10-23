/**
 * What a restore checks before it lets restored code or data run (SECURITY-HARDENING-PLAN.md 18.9,
 * N09). Integrity proves a backup is the one that was made, not that it is harmless, so this is
 * the part that decides what is allowed to start, what is held back for the owner, and what is
 * simply reported.
 */
import { parseServiceId } from "@flagship/protocol";
import { APP_PG_EXTENSIONS } from "../dataLayer/naming.js";

const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

/**
 * A pulled image is run exactly as it was when the backup was made. A tag can be moved to other
 * code after the fact, so the image must be named by digest, either in the manifest or in the
 * digest the backup recorded. Returns the reference to pull, or why there is none.
 */
export function pinnedImageRef(image: string, recordedDigest: string | undefined): { ok: true; ref: string } | { ok: false; reason: string } {
  if (DIGEST_RE.test(image)) return { ok: true, ref: image };
  if (typeof recordedDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(recordedDigest)) {
    const repo = image.replace(/@.*$/, "").replace(/:[^/:]+$/, "");
    return { ok: true, ref: `${repo}@${recordedDigest}` };
  }
  return { ok: false, reason: `its image ${image} is named by a tag, which could now point at different code; the backup did not record the exact image` };
}

/** Archive objects of these kinds are never restored: a restore must not widen what the database can do. */
const REFUSED_KINDS = new Set([
  "EVENT TRIGGER",
  "FOREIGN DATA WRAPPER",
  "SERVER",
  "USER MAPPING",
  "FOREIGN TABLE",
  "PUBLICATION",
  "SUBSCRIPTION",
  "PROCEDURAL LANGUAGE",
  "LANGUAGE",
  "ACCESS METHOD",
  "TRANSFORM",
  "ROLE",
  "TABLESPACE",
]);

export interface DumpAudit {
  /** Reasons the dump must not be restored. Empty when it may be. */
  refused: string[];
  /** Objects that run code inside the app's own database, said plainly to the owner. */
  executable: { functions: number; triggers: number; rules: number };
}

/**
 * Read the table of contents `pg_restore -l` prints. Lines look like
 * `123; 1255 16385 FUNCTION public touch() alice`; `;` starts a comment.
 */
export function auditDumpToc(toc: string): DumpAudit {
  const refused: string[] = [];
  const exec = { functions: 0, triggers: 0, rules: 0 };
  const allowedExt = new Set<string>(APP_PG_EXTENSIONS);
  for (const raw of toc.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const m = /^\d+;\s+\d+\s+\d+\s+(.*)$/.exec(line);
    if (!m) {
      refused.push(`an entry the audit cannot read: ${line.slice(0, 80)}`);
      continue;
    }
    const rest = m[1]!;
    const kind = [...REFUSED_KINDS, "EXTENSION", "FUNCTION", "PROCEDURE", "AGGREGATE", "TRIGGER", "RULE"].find((k) => rest === k || rest.startsWith(`${k} `));
    if (!kind) continue;
    if (REFUSED_KINDS.has(kind)) refused.push(`${kind.toLowerCase()} objects are not restored (${rest.slice(0, 80)})`);
    else if (kind === "EXTENSION") {
      const name = rest.split(/\s+/)[2] ?? "";
      if (!allowedExt.has(name)) refused.push(`extension ${name || "(unnamed)"} is not one this server provides`);
    } else if (kind === "TRIGGER") exec.triggers++;
    else if (kind === "RULE") exec.rules++;
    else exec.functions++;
  }
  return { refused, executable: exec };
}

export function describeExecutable(a: DumpAudit): string | null {
  const { functions, triggers, rules } = a.executable;
  if (functions + triggers + rules === 0) return null;
  const parts = [
    functions ? `${functions} function${functions === 1 ? "" : "s"}` : "",
    triggers ? `${triggers} trigger${triggers === 1 ? "" : "s"}` : "",
    rules ? `${rules} rule${rules === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return `its database holds ${parts.join(", ")} that run inside the app's own database`;
}

/** The owner a restore serves differs from the one the backup was made for. */
export function ownerChanged(archivedServiceId: string, hostAccount: string): boolean {
  const id = parseServiceId(archivedServiceId);
  return !id || !hostAccount || id.creator !== hostAccount;
}
