/**
 * webapp gym scenarios: Local AI on the server page (apps/web/e2e/gym/gym-localai.spec.ts,
 * docs/architecture-v2/local-ai.md). Same rules as web.ts: each `harness` is the exact title of a
 * test in that spec. Sensitive orders are answered as an admin-pinned box does (gymKit `sensitive`).
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

type Row = [id: string, goal: string, title: string, handle: string, point: string, dimension?: "D1" | "D3" | "D4" | "D6"];

const ROWS: Row[] = [
  ["web-total-localai-models-queue", "Local AI lists the catalog's models with size, memory and expected (or measured) speed; Download shows its progress until the model is on this server; the job queue shows which app holds the GPU, each job's place in line, and that it is free and stays on the server.", "gym localai models show size, speed and a download's progress until installed; the queue shows the GPU holder and position", "[data-la-download]", "localai-downloading"],
  ["web-total-localai-fine-tune", "Start fine-tuning signs flagship/local-ai-train/v1 (a fresh job id, the app with staged sample data, an installed trainable base, the epochs) under the admin root; the job shows its GPU and epoch, and Checkpoints lists each epoch's size, digest and loss.", "gym localai fine-tuning signs the train order under the admin root and shows its checkpoints", "#la-train-start", "localai-checkpoints", "D4"],
  ["web-total-localai-app-grant", "An app that declares localAi is allowed with daily quotas (signed flagship/local-ai-app-grant/v1) and shows today's use; Withdraw asks first and signs all-zero quotas.", "gym localai an app is allowed with quotas and withdrawn, each order signed", "[data-la-grant]", "localai-app-allowed", "D4"],
  ["web-total-localai-read-only", "A device without the admin root sees Local AI read-only with the admin-only line: no Download, no fine-tuning, no app grants; nothing is sent.", "gym localai a non-admin device sees Local AI read-only", "[data-la-admin-only]", "localai-read-only", "D6"],
  ["web-total-localai-menu-unavailable", "The build menu's On this server group lists the box's models with the privacy line and no credit line; when the box can't run the model it shows the box's own sentence and nothing switches to another provider.", "gym localai the build menu's On this server group shows the box's sentence and switches nothing", "[data-mm-local-error]", "localai-menu-unavailable", "D3"],
];

export const WEB_LOCAL_AI: readonly Scenario[] = ROWS.map(([id, goal, title, handle, point, dimension]) =>
  webTotal(id, goal, title, {
    steps: [
      { kind: "launch", describe: "Reach Home and open Local AI with the box's answers mocked." },
      { kind: "tap", describe: "Press the control and follow what it does.", handle },
    ],
    assertions: [{ describe: "The control is on screen", handle, expect: "present" }],
    screenshots: [shot(point, "The screen at its key point.")],
    dimension: dimension ?? "D1",
  }),
);
