/**
 * Scenario files (`scenarios/*.json`): one app prompt, the owner's scripted
 * answers, and the follow-up edits. Loaded and checked here so a typo in a
 * data file fails before any money is spent.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Size = "small" | "medium" | "large";

/** How the owner answers a requestEnvVar. */
export type EnvVarAnswer = "set" | "declined" | "deferred";

/** Hints that steer the mock model only; a real model never sees them. */
export interface MockHints {
  /** What the mock builds: a static site, a node app, with Postgres, with files, or Python. */
  kind: "static" | "node" | "node-pg" | "node-files" | "python";
  /** Ask the owner one question (talkToUser) before writing files. */
  ask?: boolean;
  /** Ask for an env var (requestEnvVar) before writing files. */
  envVar?: string;
  /** Make the first build fail the build check, so the fix loop runs. */
  break?: boolean;
}

export interface Scenario {
  id: string;
  size: Size;
  title: string;
  /** The Describe form's Name (becomes the slug). Optional. */
  name?: string;
  /** The Describe form's reach. */
  visibility?: "just-me" | "link";
  prompt: string;
  owner: {
    /** Replies to the model's questions (talkToUser), in order. */
    answers: string[];
    /** Said to any question after `answers` run out. */
    fallback: string;
    envVars: EnvVarAnswer;
  };
  /** Follow-up changes, each its own edit session on the deployed app. */
  edits: string[];
  mock: MockHints;
}

export const SCENARIO_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "scenarios");

const DEFAULT_FALLBACK = "Whatever you think is best. Please go ahead and build it now.";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const KINDS = new Set(["static", "node", "node-pg", "node-files", "python"]);

export function parseScenario(raw: unknown, source = "scenario"): Scenario {
  const fail = (m: string): never => {
    throw new Error(`${source}: ${m}`);
  };
  if (!raw || typeof raw !== "object") return fail("not an object");
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, what: string): string => (typeof v === "string" && v.trim() ? v : fail(`${what} must be a non-empty string`));
  const id = str(r.id, "id");
  if (!ID_RE.test(id)) fail(`id "${id}" must be lowercase letters, digits and dashes`);
  const size = r.size;
  if (size !== "small" && size !== "medium" && size !== "large") fail("size must be small, medium or large");
  const owner = (r.owner ?? {}) as Record<string, unknown>;
  const answers = owner.answers ?? [];
  if (!Array.isArray(answers) || answers.some((a) => typeof a !== "string")) fail("owner.answers must be a list of strings");
  const envVars = owner.envVars ?? "declined";
  if (envVars !== "set" && envVars !== "declined" && envVars !== "deferred") fail("owner.envVars must be set, declined or deferred");
  const edits = r.edits ?? [];
  if (!Array.isArray(edits) || edits.some((e) => typeof e !== "string" || !e.trim())) fail("edits must be a list of prompts");
  if ((edits as string[]).length > 3) fail("at most 3 edits");
  const mock = (r.mock ?? {}) as Record<string, unknown>;
  if (typeof mock.kind !== "string" || !KINDS.has(mock.kind)) fail(`mock.kind must be one of ${[...KINDS].join(", ")}`);
  const visibility = r.visibility;
  if (visibility !== undefined && visibility !== "just-me" && visibility !== "link") fail("visibility must be just-me or link");
  if (r.name !== undefined && (typeof r.name !== "string" || !/^[a-z0-9-]{1,63}$/.test(r.name))) fail("name must be a DNS label");
  return {
    id,
    size: size as Size,
    title: str(r.title, "title"),
    ...(typeof r.name === "string" ? { name: r.name } : {}),
    ...(visibility ? { visibility: visibility as "just-me" | "link" } : {}),
    prompt: str(r.prompt, "prompt"),
    owner: {
      answers: answers as string[],
      fallback: typeof owner.fallback === "string" && owner.fallback.trim() ? owner.fallback : DEFAULT_FALLBACK,
      envVars: envVars as EnvVarAnswer,
    },
    edits: edits as string[],
    mock: {
      kind: mock.kind as MockHints["kind"],
      ...(mock.ask === true ? { ask: true } : {}),
      ...(typeof mock.envVar === "string" ? { envVar: mock.envVar } : {}),
      ...(mock.break === true ? { break: true } : {}),
    },
  };
}

export function loadScenarios(dir = SCENARIO_DIR): Scenario[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const out = files.map((f) => parseScenario(JSON.parse(readFileSync(join(dir, f), "utf8")), f));
  const ids = new Set<string>();
  for (const s of out) {
    if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
    ids.add(s.id);
  }
  return out;
}

const SIZE_ORDER: Record<Size, number> = { small: 0, medium: 1, large: 2 };

/** Scenarios matching `ids` (all when empty), smallest first. */
export function selectScenarios(all: readonly Scenario[], ids: readonly string[]): Scenario[] {
  const unknown = ids.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(", ")} (known: ${all.map((s) => s.id).join(", ")})`);
  const picked = ids.length > 0 ? all.filter((s) => ids.includes(s.id)) : [...all];
  return picked.sort((a, b) => SIZE_ORDER[a.size] - SIZE_ORDER[b.size] || a.id.localeCompare(b.id));
}
