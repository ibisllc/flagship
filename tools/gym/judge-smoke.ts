#!/usr/bin/env -S npx tsx
/**
 * Judge smoke — proves the gym's advisory AI judge actually runs against the
 * configured BYOK provider (here: OpenAI, GYM_AI_PROVIDER=openai), reviewing a
 * REAL captured screenshot and returning advisory findings. This is the
 * "judge the gym" path end-to-end at the seam level, with no sims/AVDs.
 *
 *   GYM_AI_API_KEY=… GYM_AI_PROVIDER=openai GYM_AI_MODEL=gpt-4o-mini \
 *     npx tsx tools/gym/judge-smoke.ts [screenshot.png]
 *
 * Exit 0 = the judge ran and returned ≥1 finding; 1 = no key / no finding / err.
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { byokConfigFromEnv, resolveAiHooks } from "./src/ai/byokSeam.js";

async function main(): Promise<void> {
  const cfg = byokConfigFromEnv(process.env);
  if (!cfg) {
    console.log("✗ no GYM_AI_API_KEY — judge disabled (set the key to enable)");
    process.exit(1);
  }
  console.log(`judge config: provider=${cfg.provider} model=${cfg.model ?? "(default)"} base=${cfg.baseUrl ?? "(default)"}`);

  // Pick a real screenshot: the arg, else the newest one under gym-results/.
  let shot = process.argv[2];
  if (!shot) {
    try {
      shot = execSync(`ls -t gym-results/**/screenshots/*.png gym-results/*/screenshots/*.png 2>/dev/null | head -1`, {
        shell: "/bin/zsh",
        encoding: "utf8",
      }).trim();
    } catch {
      /* fall through */
    }
  }
  if (!shot || !existsSync(shot)) {
    console.log(`✗ no screenshot to judge (looked for ${shot || "gym-results/**/screenshots/*.png"})`);
    process.exit(1);
  }
  console.log(`screenshot: ${shot}`);

  const hooks = resolveAiHooks(process.env);
  console.log(`judge impl: ${hooks.judge.name}`);
  const t = Date.now();
  const findings = await hooks.judge.judge({
    scenarioId: "judge-smoke",
    point: "home-ready",
    screenshotPath: shot,
    goal: "The app's home screen has loaded and shows the expected primary content (server list / empty state), with no error banner or broken layout.",
  });
  const ms = Date.now() - t;

  console.log(`\n=== judge returned ${findings.length} finding(s) in ${ms}ms ===`);
  for (const f of findings) {
    console.log(`  [${f.role}/${f.severity}] ${f.message}`);
  }
  // The judge is ADVISORY and error-swallowing (an AI outage returns [] so it
  // never reddens a deterministic run). A real model call against a real
  // screenshot should return ≥1 finding; 0 means the call failed silently.
  if (findings.length === 0) {
    console.log("\n✗ judge returned 0 findings — the model call likely failed silently (check key/provider/model).");
    process.exit(1);
  }
  console.log(`\n✓ gym judge ran against ${cfg.provider}/${cfg.model ?? "default"} and produced advisory findings.`);
  process.exit(0);
}

main().catch((e) => {
  console.log("judge-smoke crashed: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
