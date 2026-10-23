/**
 * Owner-only wrapper for a paired-session gate (SEC-AUTH-001).
 *
 * A companion (Remote) session is a read-only bearer token. Routes that
 * build, deploy, mint credentials, rotate identity or move backups must
 * not accept it merely because "some paired session" is present, so those
 * routes mount their gate through this wrapper. The companion's own
 * session store answers whether the token is one of theirs.
 */

import type { PairedSessionGate } from "./alertInboxHttp.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export const COMPANION_DENIED_CODE = "companion-write-not-allowed";

export function companionDenied(): HttpResponse {
  return {
    status: 403,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: COMPANION_DENIED_CODE,
      message: "Open your owner app to approve this",
    }),
  };
}

export interface CompanionProbe {
  isCompanionRequest(req: HttpRequest): boolean;
}

export function ownerOnlyGate(inner: PairedSessionGate, sessions: CompanionProbe): PairedSessionGate {
  return {
    check(req: HttpRequest): HttpResponse | null {
      const denied = inner.check(req);
      if (denied) return denied;
      return sessions.isCompanionRequest(req) ? companionDenied() : null;
    },
  };
}
