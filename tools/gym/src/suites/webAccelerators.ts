/**
 * webapp gym scenarios: the server page's GPUs (apps/web/e2e/gym/gym-accelerators.spec.ts,
 * packages/server-daemon/src/gpu/http.ts). Same rules as web.ts: each `harness` is the exact title of
 * a test in that spec.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

type Row = [id: string, goal: string, title: string, handle: string, point: string, dimension?: "D1" | "D3" | "D4" | "D6"];

const ROWS: Row[] = [
  ["web-total-gpus-card", "The server page's GPUs card lists each GPU with its model, memory and state (free, in use, set aside after a fault), the app holding it with Stop, the apps waiting for one, and says when new GPU work is paused.", "gym gpus the server page lists each GPU, the app holding it and the apps waiting", "#accelerators-card", "gpus-card"],
  ["web-total-gpus-stop", "Stop asks first; Cancel sends nothing; Stop posts the allocation to /api/screens/accelerators/stop, toasts that the app no longer has the GPU, reloads, and the app that was waiting gets it.", "gym gpus Stop asks first, Cancel sends nothing, Stop frees the GPU for the app waiting", "[data-acc-stop]", "gpus-stopped", "D3"],
  ["web-total-gpus-none", "A box without a GPU (no GPU service) shows no GPUs card on its server page.", "gym gpus a box with no GPU shows no card", "#local-ai-entry", "gpus-none"],
  ["web-total-gpus-older-box", "An older box that answers 404 for the GPU screen shows no GPUs card and no error.", "gym gpus an older box without the GPU screen shows no card", "#local-ai-entry", "gpus-older-box"],
  ["web-total-gpus-approve", "Apps asking to use a GPU show their exact terms; Approve signs flagship/gpu-approval/v1 under the admin root (a sharing request names a trust domain and consent), Decline hides the ask and sends nothing, Withdraw signs flagship/gpu-approval-withdraw/v1.", "gym gpus an app's GPU request is approved with the admin root, another declined without sending, an approval withdrawn", "[data-acc-approve]", "gpu-approval-answered", "D4"],
  ["web-total-gpus-approve-read-only", "A device without the admin root sees GPU requests and approvals with the admin-only line and no buttons.", "gym gpus a non-admin device sees GPU requests read-only", "[data-acc-admin-only]", "gpu-approval-read-only", "D6"],
  ["web-total-stack-move", "Container stack: Move to the new stack signs flagship/arch-v2-switch/v1 once under the admin root and dry-runs it (the box's plan shows); Move now sends the same order; the card follows the restart to the trial.", "gym stack an admin device dry-runs the move, sends the same signed order and follows it to its trial", "#stack-move", "stack-trial", "D4"],
  ["web-total-stack-blocked", "Container stack: a plan without room shows the box's sentence and Move now stays off; nothing more is sent.", "gym stack a plan without room says why and Move now stays off", "[data-stack-blocker]", "stack-blocked", "D3"],
  ["web-total-stack-admin-only", "A device without the admin root has no Container stack card and never reads /api/stack.", "gym stack a device without the admin root has no Container stack card", "#local-ai-entry", "stack-admin-only", "D6"],
];

export const WEB_ACCELERATORS: readonly Scenario[] = ROWS.map(([id, goal, title, handle, point, dimension]) =>
  webTotal(id, goal, title, {
    steps: [
      { kind: "launch", describe: "Reach Home and open the server page with the box's GPU answers mocked." },
      { kind: "tap", describe: "Press the control and follow what it does.", handle },
    ],
    assertions: [{ describe: "The control is on screen", handle, expect: "present" }],
    screenshots: [shot(point, "The screen at its key point.")],
    dimension: dimension ?? "D1",
  }),
);
