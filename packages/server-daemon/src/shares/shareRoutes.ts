/**
 * What a share session may reach on the box (docs/share-a-server.md §6.1).
 *
 * Default deny: a route not listed here is the owner's. `need` is the level
 * the share must hold; `data` also needs the see-app-data opt-in. `action`
 * names the entry the activity log writes for a write.
 */
import type { ShareLevel } from "@flagship/protocol";

export interface ShareNeed {
  level: ShareLevel;
  data?: boolean;
  /** Activity-log id for a write (reads aren't logged). */
  action?: string;
  /** Service id the route acts on, when there is one. */
  target?: string;
}

const ID = "([^/]+)";
type Rule = { method: string; re: RegExp; need: (m: RegExpExecArray, body: Buffer | undefined) => ShareNeed | null };

const view = (action?: string) => (m: RegExpExecArray): ShareNeed => ({
  level: "view",
  ...(action ? { action } : {}),
  ...(m[1] ? { target: decode(m[1]) } : {}),
});
const manage = (action?: string) => (m: RegExpExecArray): ShareNeed => ({
  level: "manage",
  ...(action ? { action } : {}),
  ...(m[1] ? { target: decode(m[1]) } : {}),
});
const viewData = (action?: string) => (m: RegExpExecArray): ShareNeed => ({ ...view(action)(m), data: true });

const RULES: Rule[] = [
  { method: "GET", re: /^\/api\/shares\/me$/, need: view() },
  { method: "GET", re: /^\/api\/screens\/server-detail$/, need: view() },
  { method: "GET", re: /^\/api\/screens\/apps-list$/, need: view() },
  { method: "GET", re: new RegExp(`^/api/screens/app-detail/${ID}$`), need: view() },
  { method: "GET", re: new RegExp(`^/api/screens/server-metrics/${ID}$`), need: () => ({ level: "view" }) },
  { method: "GET", re: /^\/api\/screens\/release-status$/, need: view() },
  { method: "GET", re: /^\/api\/screens\/updates$/, need: view() },
  { method: "GET", re: /^\/api\/screens\/peer-backup\/status$/, need: view() },
  { method: "GET", re: /^\/api\/screens\/lan-hint$/, need: view() },

  { method: "GET", re: /^\/api\/screens\/access-requests$/, need: () => ({ level: "manage" }) },
  { method: "GET", re: new RegExp(`^/api/screens/services/${ID}/access$`), need: manage() },
  { method: "POST", re: new RegExp(`^/api/screens/services/${ID}/access$`), need: manage("app.access.edit") },
  { method: "POST", re: new RegExp(`^/api/screens/services/${ID}/access/dismiss$`), need: manage("app.access.dismiss") },
  { method: "POST", re: new RegExp(`^/api/screens/services/${ID}/access/draft/dismiss$`), need: manage("app.access.dismiss") },
  { method: "GET", re: new RegExp(`^/api/screens/services/${ID}/egress$`), need: manage() },
  { method: "POST", re: /^\/api\/screens\/vibe-code\/start$/, need: () => ({ level: "manage", action: "ai.start" }) },
  { method: "GET", re: /^\/api\/screens\/vibe-code\/name-check$/, need: () => ({ level: "manage" }) },
  { method: "GET", re: new RegExp(`^/api/screens/vibe-code/${ID}/stream$`), need: () => ({ level: "manage" }) },
  { method: "GET", re: new RegExp(`^/api/screens/vibe-code/${ID}$`), need: () => ({ level: "manage" }) },
  { method: "GET", re: new RegExp(`^/api/screens/llm/sessions/${ID}$`), need: () => ({ level: "manage" }) },
  { method: "POST", re: new RegExp(`^/api/screens/llm/sessions/${ID}/reply$`), need: () => ({ level: "manage", action: "ai.reply" }) },
  { method: "GET", re: /^\/api\/screens\/lineage-resolve$/, need: () => ({ level: "manage" }) },
  {
    method: "POST",
    re: /^\/api\/screens\/lineage-resolve$/,
    need: (_m, body) => {
      const b = parseBody(body);
      // `revoke` uninstalls the app: the owner's.
      if (b?.decision !== "accept") return null;
      return { level: "manage", action: "app.update.accept", ...(typeof b.serviceId === "string" ? { target: b.serviceId } : {}) };
    },
  },
  { method: "GET", re: new RegExp(`^/api/screens/services/${ID}/env$`), need: manage() },
  { method: "GET", re: new RegExp(`^/api/screens/browser-tabs/list/${ID}$`), need: manage() },
  { method: "GET", re: /^\/api\/screens\/events$/, need: () => ({ level: "manage" }) },

  { method: "GET", re: new RegExp(`^/api/screens/services/${ID}/db$`), need: viewData() },
  { method: "GET", re: new RegExp(`^/api/screens/services/${ID}/db/${ID}/tables/${ID}(/export\\.csv)?$`), need: viewData() },
  {
    method: "POST",
    re: new RegExp(`^/api/screens/services/${ID}/db/${ID}/query$`),
    need: (m, body) => {
      const b = parseBody(body);
      const write = b !== null && (b.grant !== undefined || b.signature !== undefined);
      return { level: write ? "manage" : "view", data: true, action: write ? "db.write" : "db.read", target: decode(m[1]!) };
    },
  },
];

/** The level a share needs for this request, or null when it's the owner's. */
export function shareRouteNeed(method: string, rawPath: string, body?: Buffer): ShareNeed | null {
  const path = rawPath.split("?")[0]!;
  const mth = method.toUpperCase();
  for (const r of RULES) {
    if (r.method !== mth) continue;
    const m = r.re.exec(path);
    if (m) return r.need(m, body);
  }
  return null;
}

export interface ShareStanding {
  level: ShareLevel;
  seeAppData: boolean;
}

/** Null when the share may make this request, else the reason it may not. */
export function shareRefusal(s: ShareStanding, need: ShareNeed | null): "owner-only" | "manage-only" | "app-data-not-shared" | null {
  if (!need) return "owner-only";
  if (need.level === "manage" && s.level !== "manage") return "manage-only";
  if (need.data && !s.seeAppData) return "app-data-not-shared";
  return null;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseBody(body: Buffer | undefined): Record<string, unknown> | null {
  if (!body || body.length === 0) return null;
  try {
    const v = JSON.parse(body.toString("utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
