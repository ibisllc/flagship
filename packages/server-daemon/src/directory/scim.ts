/**
 * A barebones SCIM 2.0 server (RFC 7643/7644) for an org box (docs/org-directory.md §3), the endpoint
 * Microsoft Entra ID, Okta, Google Workspace and others push users and groups to:
 *
 *   https://<server>.<org>.<apex>/scim/v2/{Users,Groups,ServiceProviderConfig,Schemas,ResourceTypes}
 *
 * Users: GET (list, `userName eq` / `externalId eq`), POST, GET/PUT/PATCH/DELETE by id. Groups: GET
 * (list, `displayName eq`), POST, GET/PATCH/PUT/DELETE by id. PATCH takes both Entra's shape
 * (`{"op":"Replace","path":"active","value":"False"}`) and Okta's (`{"op":"replace","value":{"active":false}}`).
 * Auth is the connector's bearer token, compared by SHA-256 (the box keeps only the hash). Every
 * accepted write feeds the directory engine, which proposes; SCIM itself never admits anyone.
 *
 * Nothing here leaves the box except as a proposal sealed to the org admins, and nothing here is
 * ever shown to a model (owner rule, 2026-10-12).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { DirectoryUser } from "./source.js";

export const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const BASE = "/scim/v2";
const MAX_BODY = 256 * 1024;
const MAX_USERS = 100_000;
const MAX_GROUPS = 10_000;

export interface ScimUserRecord {
  id: string;
  externalId?: string;
  userName: string;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  emails?: Array<{ value: string; type?: string; primary?: boolean }>;
  active: boolean;
  created: number;
  lastModified: number;
}

export interface ScimGroupRecord {
  id: string;
  displayName: string;
  externalId?: string;
  members: string[];
  created: number;
  lastModified: number;
}

export interface ScimData {
  users: Record<string, ScimUserRecord>;
  groups: Record<string, ScimGroupRecord>;
}

export const emptyScimData = (): ScimData => ({ users: {}, groups: {} });

export interface ScimDeps {
  /** The connector's SHA-256 token hash (hex); null when the connector is paused or not set up. */
  tokenSha256: () => string | null;
  load: () => ScimData;
  /** Persists and feeds the engine with the people as they are now. */
  save: (data: ScimData) => Promise<void>;
  /** One line per request for the box's Activity log: method, resource kind, status. Never a name. */
  audit?: (line: { method: string; resource: string; status: number }) => void;
  /** Requests per minute (default 600). */
  ratePerMinute?: number;
  now?: () => number;
  newId?: () => string;
}

/** The people SCIM holds, as a directory snapshot (groups by display name; a person in no group has none). */
export function scimSnapshot(data: ScimData): DirectoryUser[] {
  const groupsOf = new Map<string, string[]>();
  for (const g of Object.values(data.groups)) for (const m of g.members) groupsOf.set(m, [...(groupsOf.get(m) ?? []), g.displayName]);
  return Object.values(data.users).map((u) => ({
    externalId: u.externalId || u.id,
    userName: u.userName,
    displayName: u.displayName || [u.givenName, u.familyName].filter(Boolean).join(" ") || u.userName,
    active: u.active,
    groups: [...new Set(groupsOf.get(u.id) ?? [])].sort(),
  }));
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { "content-type": "application/scim+json", "cache-control": "no-store", ...extra },
  body: body === null ? "" : JSON.stringify(body),
});
const scimError = (status: number, detail: string, scimType?: string) => json(status, { schemas: [SCIM_ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) });

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  return undefined;
}

function str(v: unknown, max = 512): string | undefined {
  return typeof v === "string" && v.length <= max ? v : undefined;
}

/** `userName eq "x"` style filters; only the attributes Entra and Okta send. */
export function parseScimFilter(filter: string, allowed: readonly string[]): { attr: string; value: string } | null {
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) return null;
  const attr = allowed.find((a) => a.toLowerCase() === m[1]!.toLowerCase());
  return attr ? { attr, value: m[2]!.replace(/\\(.)/g, "$1") } : null;
}

class RateLimit {
  private times: number[] = [];
  constructor(private readonly perMinute: number) {}
  take(now: number): boolean {
    this.times = this.times.filter((t) => now - t < 60_000);
    if (this.times.length >= this.perMinute) return false;
    this.times.push(now);
    return true;
  }
}

export function createScimHandler(deps: ScimDeps): (req: HttpRequest) => Promise<HttpResponse | null> {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => randomBytes(16).toString("hex"));
  const limit = new RateLimit(deps.ratePerMinute ?? 600);

  function authorized(req: HttpRequest): boolean {
    const want = deps.tokenSha256();
    const m = /^Bearer\s+(\S{16,512})$/.exec(req.headers["authorization"] ?? req.headers["Authorization"] ?? "");
    if (!want || !m) return false;
    const got = createHash("sha256").update(m[1]!).digest();
    const w = Buffer.from(want, "hex");
    return w.length === got.length && timingSafeEqual(w, got);
  }

  function userJson(u: ScimUserRecord, data: ScimData, host: string): Record<string, unknown> {
    const groups = Object.values(data.groups)
      .filter((g) => g.members.includes(u.id))
      .map((g) => ({ value: g.id, display: g.displayName, $ref: `https://${host}${BASE}/Groups/${g.id}` }));
    return {
      schemas: [SCIM_USER],
      id: u.id,
      ...(u.externalId ? { externalId: u.externalId } : {}),
      userName: u.userName,
      ...(u.displayName ? { displayName: u.displayName } : {}),
      ...(u.givenName || u.familyName ? { name: { ...(u.givenName ? { givenName: u.givenName } : {}), ...(u.familyName ? { familyName: u.familyName } : {}) } } : {}),
      ...(u.emails?.length ? { emails: u.emails } : {}),
      active: u.active,
      groups,
      meta: { resourceType: "User", created: new Date(u.created).toISOString(), lastModified: new Date(u.lastModified).toISOString(), location: `https://${host}${BASE}/Users/${u.id}` },
    };
  }

  function groupJson(g: ScimGroupRecord, data: ScimData, host: string, withMembers = true): Record<string, unknown> {
    return {
      schemas: [SCIM_GROUP],
      id: g.id,
      displayName: g.displayName,
      ...(g.externalId ? { externalId: g.externalId } : {}),
      ...(withMembers ? { members: g.members.filter((m) => data.users[m]).map((m) => ({ value: m, display: data.users[m]!.userName, $ref: `https://${host}${BASE}/Users/${m}` })) } : {}),
      meta: { resourceType: "Group", created: new Date(g.created).toISOString(), lastModified: new Date(g.lastModified).toISOString(), location: `https://${host}${BASE}/Groups/${g.id}` },
    };
  }

  /** Reads a User resource body into the record fields it sets (PUT and POST). */
  function userFields(b: Record<string, unknown>): Partial<ScimUserRecord> | string {
    const userName = str(b.userName, 320);
    if (!userName) return "userName is required";
    const name = (b.name ?? {}) as Record<string, unknown>;
    const emails = Array.isArray(b.emails)
      ? (b.emails as Array<Record<string, unknown>>).filter((e) => str(e?.value, 320)).slice(0, 8).map((e) => ({ value: e.value as string, ...(str(e.type, 32) ? { type: e.type as string } : {}), ...(typeof e.primary === "boolean" ? { primary: e.primary } : {}) }))
      : undefined;
    return {
      userName,
      externalId: str(b.externalId, 256),
      displayName: str(b.displayName, 256),
      givenName: str(name.givenName, 128),
      familyName: str(name.familyName, 128),
      emails,
      active: bool(b.active) ?? true,
    };
  }

  /** One PATCH operation on a user. Returns an error string for a path it doesn't support. */
  function patchUser(u: ScimUserRecord, op: string, path: string | undefined, value: unknown): string | null {
    const set = (p: string, v: unknown): string | null => {
      const key = p.toLowerCase();
      if (key === "active") {
        const b = bool(v);
        if (b === undefined) return "active must be a boolean";
        u.active = op === "remove" ? false : b;
      } else if (key === "username") u.userName = str(v, 320) ?? u.userName;
      else if (key === "displayname") u.displayName = op === "remove" ? undefined : str(v, 256);
      else if (key === "externalid") u.externalId = op === "remove" ? undefined : str(v, 256);
      else if (key === "name.givenname") u.givenName = op === "remove" ? undefined : str(v, 128);
      else if (key === "name.familyname") u.familyName = op === "remove" ? undefined : str(v, 128);
      else if (key === "name" && v && typeof v === "object") {
        const n = v as Record<string, unknown>;
        u.givenName = str(n.givenName, 128) ?? u.givenName;
        u.familyName = str(n.familyName, 128) ?? u.familyName;
      } else if (/^emails(\[.*\])?(\.value)?$/.test(key)) {
        const value = typeof v === "string" ? v : Array.isArray(v) ? str((v[0] as Record<string, unknown>)?.value, 320) : undefined;
        u.emails = op === "remove" || !value ? [] : [{ value, type: "work", primary: true }];
      } else if (key.startsWith("urn:") || key === "title" || key === "preferredlanguage" || key === "locale" || key.startsWith("addresses") || key.startsWith("phonenumbers")) {
        // Attributes this connector does not keep: accepted and ignored, as RFC 7644 §3.5.2 allows.
      } else return `unsupported path ${p}`;
      return null;
    };
    if (path) return set(path, value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const e = set(k, v);
        if (e) return e;
      }
      return null;
    }
    return "a patch without a path needs an object value";
  }

  function patchGroup(g: ScimGroupRecord, data: ScimData, op: string, path: string | undefined, value: unknown): string | null {
    const ids = (v: unknown): string[] =>
      (Array.isArray(v) ? v : [v]).map((m) => (m && typeof m === "object" ? str((m as Record<string, unknown>).value, 64) : undefined)).filter((x): x is string => !!x && !!data.users[x]);
    const filtered = path ? /^members\[value eq "([^"]+)"\]$/i.exec(path) : null;
    if (filtered) {
      if (op === "remove") g.members = g.members.filter((m) => m !== filtered[1]);
      return null;
    }
    const key = path?.toLowerCase();
    if (key === "members" || (!path && value && typeof value === "object" && "members" in (value as object))) {
      const v = key === "members" ? value : (value as Record<string, unknown>).members;
      if (op === "add") g.members = [...new Set([...g.members, ...ids(v)])];
      else if (op === "replace") g.members = [...new Set(ids(v))];
      else if (op === "remove") g.members = v === undefined ? [] : g.members.filter((m) => !ids(v).includes(m));
      return null;
    }
    if (key === "displayname" || (!path && value && typeof value === "object" && "displayName" in (value as object))) {
      const v = key === "displayname" ? value : (value as Record<string, unknown>).displayName;
      g.displayName = str(v, 256) ?? g.displayName;
      return null;
    }
    if (key === "externalid") {
      g.externalId = str(value, 256);
      return null;
    }
    return `unsupported path ${path ?? ""}`;
  }

  function list(resources: unknown[], q: URLSearchParams): HttpResponse {
    const start = Math.max(1, Number(q.get("startIndex") ?? "1") || 1);
    const count = Math.min(200, Math.max(0, Number(q.get("count") ?? "100") || 0));
    const page = resources.slice(start - 1, start - 1 + count);
    return json(200, { schemas: [SCIM_LIST], totalResults: resources.length, startIndex: start, itemsPerPage: page.length, Resources: page });
  }

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const [rawPath, query = ""] = req.path.split("?", 2) as [string, string?];
    if (rawPath !== BASE && !rawPath.startsWith(`${BASE}/`)) return null;
    const parts = rawPath.slice(BASE.length).split("/").filter(Boolean);
    const resource = parts[0] ?? "";
    const finish = (r: HttpResponse) => {
      // Content-free: a known resource kind or "other", never the path's own text (it could hold a name).
      const kind = ["Users", "Groups", "ServiceProviderConfig", "Schemas", "ResourceTypes"].includes(resource) ? resource : "other";
      deps.audit?.({ method: /^[A-Z]{3,7}$/.test(req.method) ? req.method : "OTHER", resource: kind, status: r.status });
      return r;
    };
    if (!authorized(req)) return finish(scimError(401, "a valid connector token is required"));
    if (!limit.take(now())) return finish(scimError(429, "too many requests", "tooMany"));
    if (req.body.length > MAX_BODY) return finish(scimError(413, "request too large", "tooLarge"));
    const q = new URLSearchParams(query);
    const host = (req.headers["host"] ?? "").replace(/[^a-z0-9.:-]/gi, "");
    let body: Record<string, unknown> = {};
    if (req.body.length > 0) {
      try {
        body = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
      } catch {
        return finish(scimError(400, "the body is not JSON", "invalidSyntax"));
      }
    }
    const data = deps.load();
    const t = now();
    const save = async () => deps.save(data);

    if (resource === "ServiceProviderConfig" && req.method === "GET") {
      return finish(
        json(200, {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
          patch: { supported: true },
          bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
          filter: { supported: true, maxResults: 200 },
          changePassword: { supported: false },
          sort: { supported: false },
          etag: { supported: false },
          authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "The connector token shown once when the connector was added", primary: true }],
        }),
      );
    }
    if (resource === "ResourceTypes" && req.method === "GET") {
      return finish(
        json(200, {
          schemas: [SCIM_LIST],
          totalResults: 2,
          Resources: [
            { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: SCIM_USER },
            { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: SCIM_GROUP },
          ],
        }),
      );
    }
    if (resource === "Schemas" && req.method === "GET") {
      const attr = (name: string, type = "string", extra: Record<string, unknown> = {}) => ({ name, type, multiValued: false, required: false, mutability: "readWrite", returned: "default", ...extra });
      return finish(
        json(200, {
          schemas: [SCIM_LIST],
          totalResults: 2,
          Resources: [
            { id: SCIM_USER, name: "User", attributes: [attr("userName", "string", { required: true, uniqueness: "server" }), attr("displayName"), attr("externalId"), attr("active", "boolean"), attr("emails", "complex", { multiValued: true }), attr("name", "complex")] },
            { id: SCIM_GROUP, name: "Group", attributes: [attr("displayName", "string", { required: true }), attr("members", "complex", { multiValued: true })] },
          ],
        }),
      );
    }

    if (resource === "Users") {
      const id = parts[1];
      if (!id && req.method === "GET") {
        let users = Object.values(data.users);
        const f = q.get("filter");
        if (f) {
          const parsed = parseScimFilter(f, ["userName", "externalId"]);
          if (!parsed) return finish(scimError(400, "only userName eq and externalId eq are supported", "invalidFilter"));
          users = users.filter((u) => (parsed.attr === "userName" ? u.userName.toLowerCase() === parsed.value.toLowerCase() : u.externalId === parsed.value));
        }
        return finish(list(users.map((u) => userJson(u, data, host)), q));
      }
      if (!id && req.method === "POST") {
        const f = userFields(body);
        if (typeof f === "string") return finish(scimError(400, f, "invalidValue"));
        if (Object.values(data.users).some((u) => u.userName.toLowerCase() === f.userName!.toLowerCase())) return finish(scimError(409, "userName exists", "uniqueness"));
        if (Object.keys(data.users).length >= MAX_USERS) return finish(scimError(403, "too many users"));
        const u: ScimUserRecord = { ...(f as ScimUserRecord), id: newId(), created: t, lastModified: t };
        data.users[u.id] = u;
        await save();
        return finish(json(201, userJson(u, data, host), { location: `https://${host}${BASE}/Users/${u.id}` }));
      }
      const u = id ? data.users[id] : undefined;
      if (!u) return finish(scimError(404, "no such user"));
      if (req.method === "GET") return finish(json(200, userJson(u, data, host)));
      if (req.method === "DELETE") {
        delete data.users[u.id];
        for (const g of Object.values(data.groups)) g.members = g.members.filter((m) => m !== u.id);
        await save();
        return finish(json(204, null));
      }
      if (req.method === "PUT") {
        const f = userFields(body);
        if (typeof f === "string") return finish(scimError(400, f, "invalidValue"));
        Object.assign(u, { externalId: undefined, displayName: undefined, givenName: undefined, familyName: undefined, emails: undefined }, f, { lastModified: t });
        await save();
        return finish(json(200, userJson(u, data, host)));
      }
      if (req.method === "PATCH") {
        if (!Array.isArray(body.Operations) || !(body.schemas as unknown[] | undefined)?.includes(SCIM_PATCH)) return finish(scimError(400, "a PatchOp is required", "invalidSyntax"));
        for (const o of body.Operations as Array<Record<string, unknown>>) {
          const op = String(o.op ?? "").toLowerCase();
          if (!["add", "replace", "remove"].includes(op)) return finish(scimError(400, "op must be add, replace or remove", "invalidSyntax"));
          const e = patchUser(u, op, str(o.path, 256), o.value);
          if (e) return finish(scimError(400, e, "invalidPath"));
        }
        u.lastModified = t;
        await save();
        return finish(json(200, userJson(u, data, host)));
      }
    }

    if (resource === "Groups") {
      const id = parts[1];
      if (!id && req.method === "GET") {
        let groups = Object.values(data.groups);
        const f = q.get("filter");
        if (f) {
          const parsed = parseScimFilter(f, ["displayName", "externalId"]);
          if (!parsed) return finish(scimError(400, "only displayName eq and externalId eq are supported", "invalidFilter"));
          groups = groups.filter((g) => (parsed.attr === "displayName" ? g.displayName === parsed.value : g.externalId === parsed.value));
        }
        const withMembers = !/members/.test(q.get("excludedAttributes") ?? "");
        return finish(list(groups.map((g) => groupJson(g, data, host, withMembers)), q));
      }
      if (!id && req.method === "POST") {
        const displayName = str(body.displayName, 256);
        if (!displayName) return finish(scimError(400, "displayName is required", "invalidValue"));
        if (Object.values(data.groups).some((g) => g.displayName === displayName)) return finish(scimError(409, "displayName exists", "uniqueness"));
        if (Object.keys(data.groups).length >= MAX_GROUPS) return finish(scimError(403, "too many groups"));
        const g: ScimGroupRecord = { id: newId(), displayName, externalId: str(body.externalId, 256), members: [], created: t, lastModified: t };
        patchGroup(g, data, "replace", "members", body.members ?? []);
        data.groups[g.id] = g;
        await save();
        return finish(json(201, groupJson(g, data, host), { location: `https://${host}${BASE}/Groups/${g.id}` }));
      }
      const g = id ? data.groups[id] : undefined;
      if (!g) return finish(scimError(404, "no such group"));
      if (req.method === "GET") return finish(json(200, groupJson(g, data, host, !/members/.test(q.get("excludedAttributes") ?? ""))));
      if (req.method === "DELETE") {
        delete data.groups[g.id];
        await save();
        return finish(json(204, null));
      }
      if (req.method === "PUT") {
        g.displayName = str(body.displayName, 256) ?? g.displayName;
        g.externalId = str(body.externalId, 256);
        patchGroup(g, data, "replace", "members", body.members ?? []);
        g.lastModified = t;
        await save();
        return finish(json(200, groupJson(g, data, host)));
      }
      if (req.method === "PATCH") {
        if (!Array.isArray(body.Operations)) return finish(scimError(400, "a PatchOp is required", "invalidSyntax"));
        for (const o of body.Operations as Array<Record<string, unknown>>) {
          const op = String(o.op ?? "").toLowerCase();
          if (!["add", "replace", "remove"].includes(op)) return finish(scimError(400, "op must be add, replace or remove", "invalidSyntax"));
          const e = patchGroup(g, data, op, str(o.path, 256), o.value);
          if (e) return finish(scimError(400, e, "invalidPath"));
        }
        g.lastModified = t;
        await save();
        return finish(json(204, null));
      }
    }
    return finish(scimError(404, "not a SCIM endpoint on this server"));
  };
}
