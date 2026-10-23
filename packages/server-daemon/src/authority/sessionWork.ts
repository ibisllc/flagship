/**
 * Work that runs on a paired session's authority (a build, a live stream, a browser tab) is
 * registered against that session's grant, so ending the session or its device stops the work
 * (SECURITY-HARDENING-PLAN.md 18.5, N05). A request with no session token registers nothing.
 */
import { extractPairedSessionToken, pairedSessionId } from "../pairedSessionStore.js";
import type { AuthorityHub } from "./hub.js";

export type TrackWork = (req: { path: string; headers: Record<string, string> }, label: string, cancel: (reason: string) => void) => (() => void) | null;

export function sessionGrantId(token: string, companion: boolean): string {
  return `${companion ? "companion-session" : "owner-session"}:${pairedSessionId(token).slice(0, 32)}`;
}

export function buildTrackWork(
  hub: AuthorityHub,
  isCompanion: (req: { path: string; headers: Record<string, string> }) => boolean,
): TrackWork {
  return (req, label, cancel) => {
    const raw = extractPairedSessionToken({ method: "GET", path: req.path, headers: req.headers, body: Buffer.alloc(0) });
    if (!raw) return null;
    return hub.registerWork([sessionGrantId(raw, isCompanion(req))], { label, cancel });
  };
}
