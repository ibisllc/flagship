/**
 * Build journal — an append-only, human-readable record of how a
 * service came to exist, written by EVERY build mode (scratch / git /
 * mcp). One journal per build session; once a build deploys, its
 * entries carry the resulting `serviceId` so the owner can later open
 * "how was this built?" from the service detail screen.
 *
 * The journal is the single observability surface across the otherwise
 * very different modes:
 *   - scratch  — the AI chat turns + tool calls + file writes
 *   - git      — clone, the fitness verdict, adapt steps (if any), writes
 *   - mcp      — every call an external IDE/agent made over the MCP pipe
 *
 * VALUE-FREE by contract. The journal lives on the user's own box and is
 * never sent to flagship.services, but it is shown back to the owner and
 * (for mcp) reflects input from an external agent, so it must never
 * capture a secret VALUE. `summary`/`detail` are redacted on append as
 * defense-in-depth (mirrors `looksLikePastedSecret`), and callers are
 * expected to log NAMES not values — exactly the rule `serviceEnvStore`
 * already enforces for env vars.
 *
 * On-disk form mirrors the file-per-entity, mode-0600 precedent set by
 * `serviceEnvStore`/`appAuthToken`: one append-only `<buildId>.jsonl`
 * file per build under the journal dir, one JSON entry per line.
 */

import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export type BuildMode = "scratch" | "git" | "mcp";

/** Who/what produced the entry. */
export type BuildActor = "owner" | "ai" | "ide" | "system";

export type BuildJournalKind =
  | "session-started"
  | "user-message"
  | "assistant-message"
  | "attachment-added"
  | "tool-call"
  | "question"
  | "answer"
  | "env-requested"
  | "env-decision"
  | "git-clone"
  | "fitness-check"
  | "adapt-step"
  | "file-written"
  | "mcp-connected"
  | "mcp-call"
  | "build-started"
  | "build-phase"
  | "deployed"
  | "error"
  | "cancelled";

/** A persisted journal line. `seq` is 1-based + monotonic per build. */
export interface BuildJournalEntry {
  seq: number;
  ts: number;
  buildId: string;
  mode: BuildMode;
  kind: BuildJournalKind;
  actor: BuildActor;
  /** One-line, human-readable. Redacted of secret-shaped tokens. */
  summary: string;
  /** Optional longer context (filename, repo URL, error text). Redacted. */
  detail?: string;
  /** Set once the build is bound to an installed service. */
  serviceId?: string;
}

/** The caller-supplied fields; `seq`/`ts`/`buildId` are assigned by the store. */
export interface BuildJournalAppend {
  mode: BuildMode;
  kind: BuildJournalKind;
  actor: BuildActor;
  summary: string;
  detail?: string;
  serviceId?: string;
}

/** Compact per-build header for the "your builds" list. */
export interface BuildJournalSummary {
  buildId: string;
  mode: BuildMode;
  serviceId?: string;
  startedAt: number;
  lastAt: number;
  entryCount: number;
  lastKind: BuildJournalKind;
}

export interface BuildJournal {
  /** Append one entry; returns the fully-assigned entry. */
  append(buildId: string, entry: BuildJournalAppend): Promise<BuildJournalEntry>;
  /** All entries for a build, in seq order. Empty array if unknown. */
  read(buildId: string): Promise<BuildJournalEntry[]>;
  /** Per-build summaries, newest-first by `lastAt`. */
  list(): Promise<BuildJournalSummary[]>;
  /** Drop a build's journal (e.g. cancelled never-deployed build). Idempotent. */
  forget(buildId: string): Promise<void>;
}

// ----- secret redaction (defense-in-depth) -------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Stripe / many
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bghp_[A-Za-z0-9]{30,}\b/g, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, // JWT
];

/** Replace secret-shaped tokens with a placeholder. Pure; exported for tests. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "«redacted»");
  return out;
}

function sanitize(entry: BuildJournalAppend): BuildJournalAppend {
  return {
    ...entry,
    summary: redactSecrets(entry.summary),
    detail: entry.detail == null ? undefined : redactSecrets(entry.detail),
  };
}

function summarize(entries: BuildJournalEntry[]): BuildJournalSummary | null {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (!first || !last) return null;
  // serviceId is learned late (on deploy); surface the last non-empty one.
  let serviceId: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.serviceId) {
      serviceId = entries[i]!.serviceId;
      break;
    }
  }
  return {
    buildId: first.buildId,
    mode: first.mode,
    serviceId,
    startedAt: first.ts,
    lastAt: last.ts,
    entryCount: entries.length,
    lastKind: last.kind,
  };
}

// ----- in-memory (tests / ephemeral) -------------------------------------

export class InMemoryBuildJournal implements BuildJournal {
  private byBuild = new Map<string, BuildJournalEntry[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async append(buildId: string, entry: BuildJournalAppend): Promise<BuildJournalEntry> {
    const list = this.byBuild.get(buildId) ?? [];
    const clean = sanitize(entry);
    const full: BuildJournalEntry = {
      seq: list.length + 1,
      ts: this.now(),
      buildId,
      mode: clean.mode,
      kind: clean.kind,
      actor: clean.actor,
      summary: clean.summary,
      ...(clean.detail != null ? { detail: clean.detail } : {}),
      ...(clean.serviceId != null ? { serviceId: clean.serviceId } : {}),
    };
    list.push(full);
    this.byBuild.set(buildId, list);
    return full;
  }

  async read(buildId: string): Promise<BuildJournalEntry[]> {
    return [...(this.byBuild.get(buildId) ?? [])];
  }

  async list(): Promise<BuildJournalSummary[]> {
    const out: BuildJournalSummary[] = [];
    for (const entries of this.byBuild.values()) {
      const s = summarize(entries);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  async forget(buildId: string): Promise<void> {
    this.byBuild.delete(buildId);
  }
}

// ----- file-backed (production) ------------------------------------------

/**
 * Append-only JSONL, one file per build. Not sealed: a journal is the
 * user's own dev history on their own (LUKS-encrypted) box, is shown
 * back to them verbatim, and carries no secret values by contract. The
 * seq counter is cached in-memory and lazily seeded from the file's
 * line count on first touch after a restart.
 */
export class FileBuildJournal implements BuildJournal {
  private seqCache = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private file(buildId: string): string {
    return join(this.dir, `${encodeURIComponent(buildId)}.jsonl`);
  }

  private async currentSeq(buildId: string): Promise<number> {
    const cached = this.seqCache.get(buildId);
    if (cached != null) return cached;
    const existing = await this.read(buildId);
    const seq = existing.length;
    this.seqCache.set(buildId, seq);
    return seq;
  }

  async append(buildId: string, entry: BuildJournalAppend): Promise<BuildJournalEntry> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
    const seq = (await this.currentSeq(buildId)) + 1;
    const clean = sanitize(entry);
    const full: BuildJournalEntry = {
      seq,
      ts: this.now(),
      buildId,
      mode: clean.mode,
      kind: clean.kind,
      actor: clean.actor,
      summary: clean.summary,
      ...(clean.detail != null ? { detail: clean.detail } : {}),
      ...(clean.serviceId != null ? { serviceId: clean.serviceId } : {}),
    };
    await appendFile(this.file(buildId), JSON.stringify(full) + "\n", { mode: 0o600 });
    this.seqCache.set(buildId, seq);
    return full;
  }

  async read(buildId: string): Promise<BuildJournalEntry[]> {
    const path = this.file(buildId);
    if (!existsSync(path)) return [];
    const text = await readFile(path, "utf8");
    const out: BuildJournalEntry[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as BuildJournalEntry);
      } catch {
        // Skip a torn final line rather than fail the whole read.
      }
    }
    return out;
  }

  async list(): Promise<BuildJournalSummary[]> {
    if (!existsSync(this.dir)) return [];
    const out: BuildJournalSummary[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const buildId = decodeURIComponent(f.slice(0, -".jsonl".length));
      const s = summarize(await this.read(buildId));
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  async forget(buildId: string): Promise<void> {
    this.seqCache.delete(buildId);
    await rm(this.file(buildId), { force: true });
  }
}
