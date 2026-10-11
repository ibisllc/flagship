// The box's live vibe-code sessions (GET /api/llm/sessions): what the build
// chooser counts and the build list offers to resume. A session missing from
// this list ended with a daemon restart and survives only as its journal.
//
// MIRRORS: iOS VibeCodeSessionMeta + BuildJournalViewModel, Android
// VibeCodeSessions.kt.

const ACTIVE = new Set(["streaming", "awaiting-tool-response", "ready-to-deploy", "deploying"]);

export function isActiveSession(session) {
  return ACTIVE.has(session?.status);
}

export function countActiveSessions(sessions) {
  return (sessions || []).filter(isActiveSession).length;
}

export function sessionStatusLabel(status) {
  switch (status) {
    case "streaming": return "AI is working";
    case "awaiting-tool-response": return "Waiting for you";
    case "ready-to-deploy": return "Ready to deploy";
    case "deploying": return "Deploying";
    case "deployed": return "Deployed";
    case "cancelled": return "Cancelled";
    default: return "Stopped";
  }
}

export function sessionPillClass(status) {
  switch (status) {
    case "awaiting-tool-response":
    case "ready-to-deploy": return "warn";
    case "streaming":
    case "deploying": return "accent";
    case "deployed": return "ok";
    case "failed": return "err";
    default: return "";
  }
}

export function sortSessionsNewestFirst(sessions) {
  return (sessions || []).slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function sessionTitle(session, builds) {
  if (session.serviceId) return session.serviceId;
  const build = (builds || []).find((b) => b.buildId === session.sessionId);
  return build?.serviceId || "AI build";
}

/** Past builds the box no longer holds a session for. */
export function endedBuilds(builds, sessions) {
  const live = new Set((sessions || []).map((s) => s.sessionId));
  return (builds || []).filter((b) => !live.has(b.buildId));
}

/** Decode the wire body, keeping only well-formed entries. */
export function decodeSessions(body) {
  const raw = Array.isArray(body?.sessions) ? body.sessions : [];
  return raw
    .filter((s) => s && typeof s.sessionId === "string" && typeof s.status === "string")
    .map((s) => ({
      sessionId: s.sessionId,
      startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
      status: s.status,
      serviceId: typeof s.serviceId === "string" ? s.serviceId : null,
      url: typeof s.url === "string" ? s.url : null,
    }));
}

/**
 * Same paired-session auth as the scratch deploy trigger. Any failure reads
 * as "no open sessions" so the chooser and the build list never break on it.
 */
export async function fetchVibeSessions({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || !token) return [];
  try {
    const r = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/api/llm/sessions`, {
      headers: { "x-flagship-session": token },
    });
    if (!r.ok) return [];
    return decodeSessions(await r.json());
  } catch {
    return [];
  }
}
