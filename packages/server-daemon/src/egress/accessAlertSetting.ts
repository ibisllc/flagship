/**
 * The owner's "Internet request alerts" switch (docs/ai-privacy-and-staging.md
 * §3a "Turning alerts off"). Off means the box never calls `.com`'s push
 * relay for an access request, so nothing about it reaches Flagship, Apple or
 * Google; requests are still recorded and the screens socket still fires.
 *
 *   GET  /api/screens/settings/access-alerts            → { enabled }
 *   POST /api/screens/settings/access-alerts {enabled}  → { ok, enabled }
 *
 * Owner paired session only (a companion gets 403). Unsigned on purpose: the
 * switch can only reduce what leaves the box, it never opens anything.
 * Persisted in `<dataDir>/data/access-alerts.json` as
 * `{ "accessAlerts": { "enabled": <bool> } }`; missing or unreadable = on.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileDurable } from "../durableFile.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";

export const ACCESS_ALERTS_PATH = "/api/screens/settings/access-alerts";

export class AccessAlertSetting {
  private on = true;
  private writes: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string | null) {}

  static async load(path: string | null, log: (m: string) => void = () => {}): Promise<AccessAlertSetting> {
    const s = new AccessAlertSetting(path);
    if (!path) return s;
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8")) as { accessAlerts?: { enabled?: unknown } };
      if (parsed?.accessAlerts?.enabled === false) s.on = false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`[egress] could not read the access alerts setting (${(e as Error).message}); alerts stay on`);
      }
    }
    return s;
  }

  enabled(): boolean {
    return this.on;
  }

  async set(enabled: boolean): Promise<void> {
    this.on = enabled;
    const path = this.path;
    if (!path) return;
    const body = `${JSON.stringify({ accessAlerts: { enabled } })}\n`;
    const write = this.writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileDurable(path, body);
    });
    this.writes = write.catch(() => {});
    await write;
  }
}

const J = { "content-type": "application/json" };
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });

/** The two routes; null for any other path. `denyCompanion` returns the 403 for a companion session. */
export function buildAccessAlertSettingHttp(deps: {
  setting: Pick<AccessAlertSetting, "enabled" | "set">;
  denyCompanion: (req: HttpRequest) => HttpResponse | null;
}) {
  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path !== ACCESS_ALERTS_PATH) return null;
    if (method !== "GET" && method !== "POST") return json(405, { error: "method not allowed" });
    const denied = deps.denyCompanion(req);
    if (denied) return denied;
    if (method === "GET") return json(200, { enabled: deps.setting.enabled() });
    let body: unknown;
    try {
      body = req.body.length === 0 ? null : JSON.parse(req.body.toString("utf-8"));
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") return json(400, { error: "enabled must be true or false" });
    try {
      await deps.setting.set(enabled);
    } catch (e) {
      return json(500, { error: `could not save the setting: ${(e as Error).message}` });
    }
    return json(200, { ok: true, enabled });
  };
}
