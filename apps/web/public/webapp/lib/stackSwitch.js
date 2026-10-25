// The owner's order to move one box between its container stacks (packages/server-daemon/src/
// archV2Switch.ts): `arch-v2` (Podman, and the Rust keyd, broker and core) or back to `classic`
// (Docker and the TS path). Signed with the sensitive-order key (the admin root where the box pins
// one), sent to the box, used once. Wire parity with packages/protocol/src/archV2Switch.ts; pinned by
// packages/protocol/test-vectors/arch-v2-switch/vectors.json. Also the words of the server page's card.
//
//   flagship/arch-v2-switch/v1|<serverDomain lowercase>|<target>|<nonce>|<issuedAt>
//
// MIRRORS: iOS StackSwitchOrder.swift + StackCopy, Android StackSwitchOrder.kt.

import { tr } from "./i18n.js";
import { formatBytes } from "./serverMonitoring.js";
import { formatDateTime } from "./dateFormat.js";

export const TAG_ARCH_V2_SWITCH = "flagship/arch-v2-switch/v1";
export const STACK_PATH = "/api/stack";
export const STACK_SWITCH_PATH = "/api/stack/switch";

const enc = new TextEncoder();
const toHex = (sig) => Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");

export function canonicalArchV2SwitchOrder(o) {
  const d = String(o?.serverDomain ?? "");
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) throw new Error("serverDomain");
  }
  if (o.target !== "arch-v2" && o.target !== "classic") throw new Error("unknown target stack");
  if (!/^[0-9a-f]{32}$/.test(o.nonce ?? "")) throw new Error("nonce must be 32 lowercase hex");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("bad issuedAt");
  return enc.encode([TAG_ARCH_V2_SWITCH, d.toLowerCase(), o.target, o.nonce, o.issuedAt].join("|"));
}

export function newNonce(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return toHex(rand(16));
}

/** `{order, signature, dryRun?}` for POST /api/stack/switch. */
export async function stackSwitchBody(order, sign, { dryRun = false } = {}) {
  const body = { order: { ...order }, signature: toHex(await sign(canonicalArchV2SwitchOrder(order))) };
  if (dryRun) body.dryRun = true;
  return body;
}

export const TITLE = tr("Container stack");
export const PLAN_TITLE = tr("What the move does");
export const MOVE_NOW = tr("Move now");
export const STARTED = tr("The server is restarting for the move. This card shows how it goes.");
export const INSTALLING = tr("Moving: the server restarts and its apps come back on the new stack.");

export const currentLine = (s) =>
  s?.stack === "arch-v2" ? tr("This server runs the new stack (Podman and the Rust services).") : tr("This server runs the classic stack (Docker).");
export const moveLabel = (target) => (target === "classic" ? tr("Go back to the classic stack") : tr("Move to the new stack"));

export function roomLine(plan) {
  if (!plan?.needBytes) return null;
  return tr("Needs about {0} free; this server has {1}.", formatBytes(plan.needBytes), formatBytes(plan.freeBytes ?? 0));
}

/** What the switch record says, or null. */
export function recordLine(r) {
  if (!r) return null;
  if (r.state === "installing") return INSTALLING;
  if (r.state === "trial") return tr("On trial until {0}. If it doesn't stay healthy, the server goes back by itself.", formatDateTime(r.trialUntil ?? r.startedAt));
  if (r.state === "done") return tr("Moved on {0}.", formatDateTime(r.finishedAt ?? r.startedAt));
  if (r.state === "reverted") return tr("The move was undone: {0}", r.reason ?? "");
  return null;
}
