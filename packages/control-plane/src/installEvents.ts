import type { InstallEventStorage } from "@flagship/storage";
import { malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

export interface InstallEventsDeps {
  storage: InstallEventStorage;
  now?: () => number;
}

interface PostEventBody {
  event?: string;
  detail?: string;
}

const SERIAL_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_NAME_RE = /^[a-z][a-z0-9-]{0,63}(?::[a-z0-9-]+)?$/;

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
