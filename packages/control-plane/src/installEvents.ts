import type { AuthCodeStorage, InstallEventStorage } from "@flagship/storage";
import { forbidden, malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

export interface InstallEventsDeps {
  storage: InstallEventStorage;
  /** Optional — when present, POST events are gated on the serial
   *  matching a known auth-code. Strongly recommended for production
   *  to prevent unbounded posting to fabricated serials. */
  authCodes?: AuthCodeStorage;
  now?: () => number;
}

interface PostEventBody {
  event?: string;
  detail?: string;
}

const SERIAL_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_NAME_RE = /^[a-z][a-z0-9-]{0,63}(?::[a-z0-9-]+)?$/;

// Per-serial in-memory rate-limit ring (#18). 60 events / 60s per
// serial is generous for legitimate installs (which post ~20 events
// total spread over a minute) but rejects floods.
const POST_WINDOW_MS = 60_000;
const POST_LIMIT_PER_WINDOW = 60;
const recentPosts = new Map<string, number[]>();

function checkSerialRate(serial: string, now: number): boolean {
  const cutoff = now - POST_WINDOW_MS;
  const arr = recentPosts.get(serial) ?? [];
  const filtered = arr.filter((t) => t > cutoff);
  if (filtered.length >= POST_LIMIT_PER_WINDOW) {
    recentPosts.set(serial, filtered);
    return false;
  }
  filtered.push(now);
  recentPosts.set(serial, filtered);
  // Occasional GC: trim the map when it grows past 10k serials.
  if (recentPosts.size > 10_000) {
    for (const [k, v] of recentPosts) {
      if (v.length === 0 || v[v.length - 1]! < cutoff) recentPosts.delete(k);
    }
  }
  return true;
}

/** Test-only: clear the in-memory rate-limit state. */
export function __resetInstallEventRateLimit(): void {
  recentPosts.clear();
}

export async function handlePostInstallEvent(
  deps: InstallEventsDeps,
  serial: string,
  body: PostEventBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  if (!SERIAL_RE.test(serial)) return malformed("malformed serial");
  if (
    !body ||
    typeof body.event !== "string" ||
    !EVENT_NAME_RE.test(body.event)
  ) {
    return malformed("malformed event");
  }

  // #18 — narrow the attacker's posting surface from "any serial they can
  // brute-force" to "serials corresponding to a real auth-code." Auth-codes
  // are randomly issued; without one, an attacker can't post fabricated
  // serials to grow the table unbounded.
  if (deps.authCodes) {
    const code = await deps.authCodes.get(serial);
    if (!code) return forbidden("unknown serial");
  }

  if (!checkSerialRate(serial, now)) {
    return forbidden("too many events for this serial; slow down");
  }

  const detail = typeof body.detail === "string" && body.detail.length <= 4096 ? body.detail : "";
  const out = await deps.storage.put({
    serial,
    eventName: body.event,
    detail,
    postedAt: now,
  });
  if (!out.ok) return malformed(out.reason);
  return ok({ ok: true, seq: out.seq });
}

export async function handleGetInstallEvents(
  deps: InstallEventsDeps,
  serial: string,
  sinceSeq: number,
): Promise<HandlerResponseWithHeaders> {
  if (!SERIAL_RE.test(serial)) return malformed("malformed serial");
  const events = await deps.storage.list(serial, sinceSeq);
  return ok({
    serial,
    events,
    cursor: events.length > 0 ? events[events.length - 1]!.seq : sinceSeq,
  });
}
