// The box's vibe-code sessions (GET /api/llm/sessions): what the build
// chooser counts and the build list offers to continue. The box keeps a chat,
// finished or failed, for 30 days after its last change (restarts included);
// after that it survives only as its journal.
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
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    default: return "Stopped";
  }
}

/**
 * The row's action: carry on a chat that takes a message (the AI's question,
 * ready to deploy, failed), follow one that runs, open one that's done.
 */
export function sessionActionLabel(status) {
  switch (status) {
    case "awaiting-tool-response":
    case "ready-to-deploy":
    case "failed": return "Continue";
    case "streaming":
    case "deploying": return "Resume";
    default: return "Open";
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

/** Most recent activity first (the last change, else the start). */
export function sortSessionsNewestFirst(sessions) {
  const at = (s) => s.updatedAt || s.startedAt || 0;
  return (sessions || []).slice().sort((a, b) => at(b) - at(a));
}

function serviceSlug(serviceId) {
  if (typeof serviceId !== "string") return "";
  const i = serviceId.lastIndexOf("--");
  return i >= 0 ? serviceId.slice(i + 2) : serviceId;
}

/** A past build's title: its name, else its service's slug. */
export function buildDisplayName(build) {
  if (build?.name) return build.name;
  return serviceSlug(build?.serviceId) || "Unnamed build";
}

/** How a build was made, for the pill beside its name. */
export function buildMethodLabel(mode) {
  switch (mode) {
    case "git": return "From Git";
    case "mcp": return "From your IDE";
    default: return "AI chat";
  }
}

export function pastBuildSubtitle(build, started) {
  const n = build?.entryCount ?? 0;
  return `Started ${started} · ${n} step${n === 1 ? "" : "s"}`;
}

// Session and build ids are per box; a row tagged with the server that listed
// it (`server`, docs/app-placement.md) matches only rows from that server.
const rowKey = (id, server) => `${server ?? ""}|${id}`;

/** A live session's title: its own name, else its journal build's, else its
 *  service's slug. */
export function sessionTitle(session, builds) {
  if (session.name) return session.name;
  const build = (builds || []).find((b) => b.buildId === session.sessionId && (b.server ?? "") === (session.server ?? ""));
  if (build) return buildDisplayName(build);
  return serviceSlug(session.serviceId) || "Unnamed build";
}

/** Discarding frees the name; a deployed session's name is its app's. */
export function canDiscard(session) {
  return session?.status !== "deployed";
}

export const DISCARD_TITLE = "Discard this build?";

export function discardMessage(session) {
  const freed = session?.name ? ` Its name, "${session.name}", becomes free again.` : "";
  return `This stops the AI and deletes what it has written on your server.${freed}`;
}

/** Past builds the box no longer holds a session for. */
export function endedBuilds(builds, sessions) {
  const live = new Set((sessions || []).map((s) => rowKey(s.sessionId, s.server)));
  return (builds || []).filter((b) => !live.has(rowKey(b.buildId, b.server)) && b.open !== true);
}

/** Git imports and IDE builds the box still holds (and whose names it keeps). */
export function openBuilds(builds, sessions) {
  const live = new Set((sessions || []).map((s) => rowKey(s.sessionId, s.server)));
  return (builds || []).filter((b) => b.open === true && !live.has(rowKey(b.buildId, b.server)));
}

export function discardBuildMessage(build) {
  return `This deletes what was imported or written on your server. Its name, "${buildDisplayName(build)}", becomes free again.`;
}

/** Forget an open git or IDE build on the box, which frees its name. Throws
 *  the box's reason on failure. */
export async function discardBuild({ baseUrl, token, buildId, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || !token) throw new Error("Not paired to a server yet.");
  const r = await fetchImpl(
    `${String(baseUrl).replace(/\/+$/, "")}/api/build/sessions/${encodeURIComponent(buildId)}/discard`,
    {
      method: "POST",
      headers: { "x-flagship-session": token, "content-type": "application/json" },
      body: "{}",
    },
  );
  if (!r.ok) {
    let msg = `The build wasn't discarded (HTTP ${r.status}).`;
    try {
      const body = await r.json();
      if (body?.error) msg = body.error;
    } catch {
      // keep the status message
    }
    throw new Error(msg);
  }
}

/** Decode the wire body, keeping only well-formed entries. */
export function decodeSessions(body) {
  const raw = Array.isArray(body?.sessions) ? body.sessions : [];
  return raw
    .filter((s) => s && typeof s.sessionId === "string" && typeof s.status === "string")
    .map((s) => ({
      sessionId: s.sessionId,
      startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
      ...(typeof s.updatedAt === "number" ? { updatedAt: s.updatedAt } : {}),
      status: s.status,
      serviceId: typeof s.serviceId === "string" ? s.serviceId : null,
      url: typeof s.url === "string" ? s.url : null,
      name: typeof s.name === "string" && s.name ? s.name : null,
      visibility: typeof s.visibility === "string" ? s.visibility : null,
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

/** Stop a session and delete it on the box, which frees its name. Throws on
 *  failure so the list can say why. */
export async function discardSession({ baseUrl, token, sessionId, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || !token) throw new Error("Not paired to a server yet.");
  const r = await fetchImpl(
    `${String(baseUrl).replace(/\/+$/, "")}/api/llm/sessions/${encodeURIComponent(sessionId)}/discard`,
    {
      method: "POST",
      headers: { "x-flagship-session": token, "content-type": "application/json" },
      body: "{}",
    },
  );
  if (!r.ok) {
    let msg = `The build wasn't discarded (HTTP ${r.status}).`;
    try {
      const body = await r.json();
      if (body?.error) msg = body.error;
    } catch {
      // keep the status message
    }
    throw new Error(msg);
  }
}

/**
 * The live sessions and builds of every server this device can ask, each row
 * tagged with `server` (its FQDN), so a build started on any server shows up.
 * `servers` are `{fqdn, baseUrl, token, fetchJson}`. A server whose builds
 * list fails is left out and named in `failed` (with its error).
 */
export async function fetchBuildsOnServers(servers, { fetchImpl = globalThis.fetch } = {}) {
  const results = await Promise.all(
    (servers || []).map(async (srv) => {
      const sessionsP = fetchVibeSessions({ baseUrl: srv.baseUrl, token: srv.token, fetchImpl });
      let builds = [];
      let error = null;
      try {
        const r = await srv.fetchJson("/api/build/sessions");
        builds = Array.isArray(r?.builds) ? r.builds : [];
      } catch (e) {
        error = e;
      }
      const sessions = await sessionsP;
      return {
        fqdn: srv.fqdn,
        error,
        sessions: sessions.map((x) => ({ ...x, server: srv.fqdn })),
        builds: builds.map((b) => ({ ...b, server: srv.fqdn })),
      };
    }),
  );
  return {
    sessions: results.flatMap((r) => r.sessions),
    builds: results.flatMap((r) => r.builds),
    failed: results.filter((r) => r.error).map((r) => ({ fqdn: r.fqdn, error: r.error })),
  };
}

/**
 * The server holding `sessionId`: the `first` candidates in order (a hint,
 * then the current server), then `more()` (every server this device has a
 * session for, read only when those miss). `probe(fqdn)` resolves true when
 * that box holds the session; a throw or false moves on. Null when none does.
 */
export async function findSessionServer(sessionId, { first = [], more = async () => [], probe }) {
  if (!sessionId) return null;
  const tried = new Set();
  const tryOne = async (fqdn) => {
    const f = String(fqdn ?? "").trim().toLowerCase();
    if (!f || tried.has(f)) return null;
    tried.add(f);
    try {
      return (await probe(f)) ? f : null;
    } catch {
      return null;
    }
  };
  for (const f of first) {
    const hit = await tryOne(f);
    if (hit) return hit;
  }
  let rest = [];
  try {
    rest = (await more()) ?? [];
  } catch {
    rest = [];
  }
  for (const f of rest) {
    const hit = await tryOne(f);
    if (hit) return hit;
  }
  return null;
}
