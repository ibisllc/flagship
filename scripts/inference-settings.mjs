#!/usr/bin/env node
/**
 * inference-settings — see and change what Flagship Inference offers,
 * without a deploy: which models are on, the default, multipliers, menu
 * descriptions and the promotion's allowance. Talks to
 * GET/PUT /api/admin/inference-settings (packages/control-plane/src/
 * inferenceSettings.ts); docs/runbooks/inference-settings.md.
 *
 *   npm run inference-settings                          what's in force
 *   npm run inference-settings -- history               the last 20 changes
 *   npm run inference-settings -- set high.multiplier=4 weeklyCredits=750 --note "owners ran out mid-edit"
 *   npm run inference-settings -- set low.enabled=true --dry-run --note "try Low again"
 *   npm run inference-settings -- unset weeklyCredits --note "back to the default"
 *   npm run inference-settings -- reset --note "shipped defaults"
 *
 * Keys: default=<model id>; <id>.enabled=true|false; <id>.multiplier=<n>
 * (1–20, steps of 0.5); <id>.descriptor="<text>"; starterCredits,
 * weeklyCredits, dailyCapCredits (1 credit = 1,000 weighted tokens) or the
 * same as …Tokens; inputWeight, outputWeight; endsAt=<ISO date>|none.
 * `set` and `unset` change the stored settings; a key left alone keeps its
 * value. Every change needs a --note saying why: it is kept in the history.
 * Changes reach the allowance checks within 30 s and the menus within ~90 s.
 *
 * Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default
 * https://flagshipserver.com).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PATH = "/api/admin/inference-settings";
const CREDIT_TOKENS = 1000;
const ALLOWANCE_KEYS = {
  starterTokens: ["starterTokens", 1],
  weeklyTokens: ["weeklyTokens", 1],
  dailyCapTokens: ["dailyCapTokens", 1],
  starterCredits: ["starterTokens", CREDIT_TOKENS],
  weeklyCredits: ["weeklyTokens", CREDIT_TOKENS],
  dailyCapCredits: ["dailyCapTokens", CREDIT_TOKENS],
  inputWeight: ["inputWeight", null],
  outputWeight: ["outputWeight", null],
  endsAt: ["endsAt", "date"],
};
const MODEL_FIELDS = ["enabled", "multiplier", "descriptor"];

export function parseArgs(argv) {
  const opts = { command: "show", assignments: [], note: null, dryRun: false, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--note") opts.note = argv[++i] ?? null;
    else if (a.startsWith("--note=")) opts.note = a.slice("--note=".length);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
    else rest.push(a);
  }
  if (rest.length > 0) opts.command = rest.shift();
  if (!["show", "history", "set", "unset", "reset"].includes(opts.command)) {
    throw new Error(`unknown command: ${opts.command} (show, history, set, unset, reset)`);
  }
  opts.assignments = rest;
  if (["set", "unset"].includes(opts.command) && rest.length === 0) {
    throw new Error(`${opts.command} needs at least one key`);
  }
  if (["set", "unset", "reset"].includes(opts.command) && !opts.note?.trim()) {
    throw new Error(`${opts.command} needs --note "<why>"`);
  }
  return opts;
}

function parseValue(field, raw) {
  if (field === "enabled") {
    if (raw === "true" || raw === "on") return true;
    if (raw === "false" || raw === "off") return false;
    throw new Error(`enabled takes true or false, not "${raw}"`);
  }
  if (field === "descriptor") return raw;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) throw new Error(`${field} takes a number, not "${raw}"`);
  return n;
}

/** Applies `key=value` (set) or `key` (unset) to a copy of the stored settings. */
export function applyAssignments(stored, assignments, mode, modelIds) {
  const out = structuredClone(stored ?? {});
  for (const item of assignments) {
    const eq = item.indexOf("=");
    if (mode === "set" && eq < 0) throw new Error(`set takes key=value, not "${item}"`);
    if (mode === "unset" && eq >= 0) throw new Error(`unset takes a key alone, not "${item}"`);
    const key = mode === "set" ? item.slice(0, eq) : item;
    const raw = mode === "set" ? item.slice(eq + 1) : null;

    if (key === "default" || key === "defaultModel") {
      if (mode === "unset") delete out.defaultModel;
      else {
        if (modelIds && !modelIds.includes(raw)) throw new Error(`no model "${raw}" (known: ${modelIds.join(", ")})`);
        out.defaultModel = raw;
      }
      continue;
    }

    const dot = key.indexOf(".");
    if (dot > 0) {
      const id = key.slice(0, dot);
      const field = key.slice(dot + 1);
      if (modelIds && !modelIds.includes(id)) throw new Error(`no model "${id}" (known: ${modelIds.join(", ")})`);
      if (!MODEL_FIELDS.includes(field)) throw new Error(`a model has ${MODEL_FIELDS.join(", ")}, not "${field}"`);
      out.models ??= {};
      if (mode === "unset") {
        if (out.models[id]) delete out.models[id][field];
        if (out.models[id] && Object.keys(out.models[id]).length === 0) delete out.models[id];
        if (Object.keys(out.models).length === 0) delete out.models;
      } else {
        out.models[id] = { ...out.models[id], [field]: parseValue(field, raw) };
      }
      continue;
    }

    const spec = ALLOWANCE_KEYS[key];
    if (!spec) throw new Error(`unknown key "${key}"`);
    const [field, scale] = spec;
    out.allowance ??= {};
    if (mode === "unset") {
      delete out.allowance[field];
      if (Object.keys(out.allowance).length === 0) delete out.allowance;
    } else if (scale === "date") {
      out.allowance[field] = raw === "none" ? null : raw;
    } else {
      const n = parseValue(field, raw);
      out.allowance[field] = scale === null ? n : Math.round(n * scale);
    }
  }
  return out;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const fmt = (n) => Number(n).toLocaleString("en-US");

export function formatEffective(e) {
  const lines = ["Models (the default is marked *)"];
  for (const m of e.models) {
    const mult = m.multiplier === m.computedMultiplier ? `${m.multiplier}×` : `${m.multiplier}× (prices say ${m.computedMultiplier}×)`;
    lines.push(
      `  ${m.id === e.defaultModel ? "*" : " "} ${pad(m.id, 14)} ${pad(m.enabled ? "on" : "off", 4)} ${pad(mult, 26)} ${m.tier} (${m.model})`,
    );
    lines.push(`      ${m.descriptor}`);
  }
  const a = e.allowance;
  lines.push(
    "",
    "Allowance",
    `  starter      ${fmt(a.starterCredits)} credits (${fmt(a.starterTokens)} weighted tokens, once per account)`,
    `  weekly       ${fmt(a.weeklyCredits)} credits (${fmt(a.weeklyTokens)}, every Monday, doesn't carry over)`,
    `  daily cap    ${fmt(a.dailyCapCredits)} credits (${fmt(a.dailyCapTokens)}, every account together)`,
    `  weights      input × ${a.inputWeight}, output × ${a.outputWeight}`,
    `  ends         ${a.endsAt ?? "no end date"}`,
  );
  return lines.join("\n");
}

async function call(base, secret, method, body) {
  const res = await fetch(`${base}${PATH}`, {
    method,
    headers: { "x-admin-secret": secret, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${PATH}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${method} ${PATH}: HTTP ${res.status} ${json.error ?? text.slice(0, 200)}`);
  return json;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${readHelp()}\n`);
    return;
  }
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) throw new Error("FLAGSHIP_ADMIN_SECRET is not set");
  const base = (process.env.FLAGSHIP_BASE_URL || "https://flagshipserver.com").replace(/\/$/, "");
  const now = await call(base, secret, "GET");

  if (opts.command === "show") {
    if (opts.json) return void process.stdout.write(`${JSON.stringify(now, null, 2)}\n`);
    process.stdout.write(`${formatEffective(now.effective)}\n`);
    process.stdout.write(
      now.stored
        ? `\nLast change ${now.stored.setAt}: ${now.stored.note}\n`
        : "\nNo stored settings: the shipped defaults and the env are in force.\n",
    );
    return;
  }
  if (opts.command === "history") {
    if (opts.json) return void process.stdout.write(`${JSON.stringify(now.history, null, 2)}\n`);
    if (now.history.length === 0) return void process.stdout.write("No changes yet.\n");
    for (const h of now.history) process.stdout.write(`${h.setAt}  ${h.note}\n  ${JSON.stringify(h.settings)}\n`);
    return;
  }

  const ids = now.effective.models.map((m) => m.id);
  const next =
    opts.command === "reset" ? {} : applyAssignments(now.stored?.settings ?? {}, opts.assignments, opts.command, ids);
  const r = await call(base, secret, "PUT", { settings: next, note: opts.note.trim(), preview: opts.dryRun });
  process.stdout.write(`${formatEffective(r.effective)}\n`);
  process.stdout.write(opts.dryRun ? "\nDry run: nothing was stored.\n" : `\nStored: ${opts.note.trim()}\n`);
}

function readHelp() {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  return (src.match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? "").replace(/^ \* ?/gm, "").trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(`inference-settings: ${e.message}\n`);
    process.exit(1);
  });
}
