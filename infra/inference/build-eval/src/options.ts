/** Command-line options. */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogIds } from "./prices.js";

export interface Options {
  models: string[];
  scenarios: string[];
  repeat: number;
  concurrency: number;
  maxUsd: number;
  mock: boolean;
  stage: "auto" | "static" | "docker";
  out: string;
  saveApps: boolean;
  agentMaxTurns?: number;
  /** Leave each model's thinking at its own default (a comparison only; production turns it off). */
  modelThinking: boolean;
  plan: boolean;
  help: boolean;
}

export const RESULTS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "results");

export const USAGE = `Usage: npm run eval -w @flagship/build-eval -- [options]

Runs scripted app builds through the box's own build loop and measures what
they cost on Flagship Inference.

  --models a,b         catalog ids (default: all: ${catalogIds().join(", ")})
  --scenarios a,b      scenario ids (default: all, smallest first)
  --repeat N           runs per model and scenario (default 1)
  --concurrency N      runs at once (default 1)
  --max-usd X          spending limit in USD (default 5)
  --mock               a scripted model: no network, no key, no cost
  --stage S            build check: auto (docker when it runs here), static, docker
  --out DIR            results folder (default results/<timestamp>)
  --no-save-apps       don't keep the apps the model wrote
  --agent-max-turns N  the fix loop's turn cap (default: the box's, 24)
  --model-thinking     leave each model's thinking at its own default instead of
                       the shim's "off" (to compare; production never thinks)
  --plan              list the runs and their estimated cost, then stop
  --help`;

function positiveInt(v: string | undefined, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a whole number of at least 1`);
  return n;
}

export function parseOptions(argv: readonly string[], now: Date = new Date()): Options {
  const o: Options = {
    models: catalogIds(),
    scenarios: [],
    repeat: 1,
    concurrency: 1,
    maxUsd: 5,
    mock: false,
    stage: "auto",
    out: join(RESULTS_DIR, now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z")),
    saveApps: true,
    modelThinking: false,
    plan: false,
    help: false,
  };
  const list = (v: string | undefined, flag: string) => {
    const items = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) throw new Error(`${flag} needs a comma-separated list`);
    return items;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "--models":
        o.models = list(value(), flag);
        break;
      case "--scenarios":
        o.scenarios = list(value(), flag);
        break;
      case "--repeat":
        o.repeat = positiveInt(value(), flag);
        break;
      case "--concurrency":
        o.concurrency = positiveInt(value(), flag);
        break;
      case "--max-usd": {
        const n = Number(value());
        if (!(n > 0) || !Number.isFinite(n)) throw new Error("--max-usd must be a positive number");
        o.maxUsd = n;
        break;
      }
      case "--mock":
        o.mock = true;
        break;
      case "--stage": {
        const s = value();
        if (s !== "auto" && s !== "static" && s !== "docker") throw new Error("--stage must be auto, static or docker");
        o.stage = s;
        break;
      }
      case "--out":
        o.out = value() ?? o.out;
        break;
      case "--no-save-apps":
        o.saveApps = false;
        break;
      case "--agent-max-turns":
        o.agentMaxTurns = positiveInt(value(), flag);
        break;
      case "--model-thinking":
        o.modelThinking = true;
        break;
      case "--plan":
        o.plan = true;
        break;
      case "--help":
      case "-h":
        o.help = true;
        break;
      default:
        throw new Error(`unknown option ${a}\n\n${USAGE}`);
    }
  }
  const known = new Set(catalogIds());
  const bad = o.models.filter((m) => !known.has(m));
  if (bad.length > 0) throw new Error(`unknown model(s) ${bad.join(", ")} (known: ${[...known].join(", ")})`);
  return o;
}
