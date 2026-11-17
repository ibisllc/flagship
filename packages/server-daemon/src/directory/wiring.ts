/**
 * Starts the org box's directory connectors (docs/org-directory.md): refreshes the connector records
 * every 5 minutes, serves SCIM 2.0 at /scim/v2 (the request's bearer token picks the connector), and
 * runs each LDAP connector on its schedule (15 minutes by default). Every change goes through the
 * engine and leaves the box only as proposals sealed to the org admins.
 */
import { join } from "node:path";
import { readStateFile, writeFileDurable } from "../durableFile.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { SCIM_TOKEN_WARN_AFTER_MS, type ConnectorRuntime } from "./connector.js";
import { LdapDirectorySource, ldapConfigFrom } from "./ldap.js";
import { createScimHandler, emptyScimData, scimDataFrom, scimSnapshot, type ScimData } from "./scim.js";
import { collectSnapshot } from "./source.js";
import { createHash } from "node:crypto";

export interface DirectoryWiringDeps {
  rt: ConnectorRuntime;
  dataDir: string;
  /** An Activity line (no names, no emails: kinds and counts only). */
  note: (kind: string, text: string, ok: boolean) => void;
  log: (line: string) => void;
  now?: () => number;
}

export function startDirectoryConnectors(deps: DirectoryWiringDeps): { handler: (req: HttpRequest) => Promise<HttpResponse | null>; stop: () => void } {
  const now = deps.now ?? (() => Date.now());
  const data = new Map<string, ScimData>();
  const handlers = new Map<string, (req: HttpRequest) => Promise<HttpResponse | null>>();
  const ldapNext = new Map<string, number>();
  const warned = new Set<string>();
  const path = (id: string) => join(deps.dataDir, "org-directory", `${id}.scim.json`);
  let refused = 0;
  let refusedNotedAt = -Infinity;

  async function load(id: string): Promise<ScimData> {
    const r = await readStateFile(path(id));
    if (r.kind !== "ok") return emptyScimData();
    try {
      return scimDataFrom(JSON.parse(r.text));
    } catch {
      return emptyScimData();
    }
  }

  async function refresh(): Promise<void> {
    const active = await deps.rt.refresh();
    for (const c of active) {
      const id = c.bundle.connector.connectorId;
      if (c.bundle.connector.kind === "scim" && !handlers.has(id)) {
        data.set(id, await load(id));
        handlers.set(
          id,
          createScimHandler({
            tokenSha256: () => deps.rt.connector(id)?.setup.scimTokenSha256 ?? null,
            load: () => data.get(id) ?? emptyScimData(),
            save: async (d) => {
              data.set(id, d);
              await writeFileDurable(path(id), JSON.stringify(d));
              void deps.rt.sync(id, scimSnapshot(d)).catch((e) => deps.log(`[directory] SCIM sync: ${(e as Error).message}`));
            },
            // One Activity line per request: the method, the resource kind and the status, never a name.
            audit: (l) => deps.note("org.directory.scim", `SCIM ${l.method} ${l.resource} ${l.status} (connector ${id.slice(0, 8)})`, l.status < 400),
          }),
        );
      }
      const issued = c.setup.scimTokenIssuedAt;
      if (issued && now() - issued > SCIM_TOKEN_WARN_AFTER_MS && !warned.has(id)) {
        warned.add(id);
        deps.note("org.directory.token-old", `Directory connector ${id.slice(0, 8)}: its SCIM token is over a year old; rotate it from the admin console`, false);
      }
    }
    for (const id of [...handlers.keys()]) if (!deps.rt.connector(id)) handlers.delete(id);
  }

  async function runLdap(): Promise<void> {
    for (const c of deps.rt.connectors()) {
      const l = c.setup.ldap;
      const id = c.bundle.connector.connectorId;
      if (c.bundle.connector.kind !== "ldap" || !l) continue;
      if ((ldapNext.get(id) ?? 0) > now()) continue;
      ldapNext.set(id, now() + Math.max(5, l.intervalMinutes ?? 15) * 60_000);
      try {
        const people = await collectSnapshot(new LdapDirectorySource(id, ldapConfigFrom(l, l.flavor ?? "ad", l.attributes)));
        const posted = await deps.rt.sync(id, people);
        deps.note("org.directory.ldap", `Directory connector ${id.slice(0, 8)} read ${people.length} people and proposed ${posted.length} changes`, true);
      } catch (e) {
        deps.note("org.directory.ldap", `Directory connector ${id.slice(0, 8)} could not read its directory: ${(e as Error).message.replace(/\S+@\S+/g, "…")}`, false);
      }
    }
  }

  const tick = () => void refresh().then(runLdap).catch((e) => deps.log(`[directory] ${(e as Error).message}`));
  tick();
  const timers = [setInterval(tick, 5 * 60_000)];
  for (const t of timers) t.unref?.();

  return {
    handler: async (req) => {
      if (!req.path.startsWith("/scim/v2")) return null;
      const m = /^Bearer\s+(\S+)$/.exec(req.headers["authorization"] ?? "");
      const sha = m ? createHash("sha256").update(m[1]!).digest("hex") : "";
      for (const [id, h] of handlers) if (deps.rt.connector(id)?.setup.scimTokenSha256 === sha) return h(req);
      // At most one Activity line a minute for refused requests (anyone can send them), with how many there were.
      refused += 1;
      if (now() - refusedNotedAt >= 60_000) {
        deps.note("org.directory.scim", `SCIM request refused: no connector matched the token (401, ${refused} since the last note)`, false);
        refused = 0;
        refusedNotedAt = now();
      }
      return { status: 401, headers: { "content-type": "application/scim+json" }, body: JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401", detail: "a valid connector token is required" }) };
    },
    stop: () => timers.forEach(clearInterval),
  };
}
