/**
 * The apps list says who may open each app, so a co-manager's page can say a
 * members-only app still needs an invite (docs/share-a-server.md §5.7). The
 * co-manager stays an ordinary visitor on the app itself.
 */
import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/runtime.js";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";

const BOX = "home.harry.flagship.services";
const app = (slug: string) => ({
  serviceId: `harry-${slug}`,
  creator: "harry",
  slug,
  urlLabel: slug,
  installedAt: 1,
  manifest: { name: slug, version: "1.0.0" },
  membership: { members: { list: () => [] } },
});
const APPS = [app("chess"), app("photos"), app("notes")];

function screens(accessMode?: (id: string) => "open" | "members-only" | null) {
  return buildScreensHttp({
    gate: { check: (_r: HttpRequest): HttpResponse | null => null },
    serverFqdn: BOX,
    username: "harry",
    daemonVersion: "t",
    startedAt: 0,
    servicePlatform: { list: () => APPS, byServiceId: (id: string) => APPS.find((a) => a.serviceId === id) } as never,
    ...(accessMode ? { accessMode } : {}),
  });
}

const get = async (h: ReturnType<typeof screens>, path: string) => {
  const r = await h({ method: "GET", path, headers: {}, body: Buffer.alloc(0) });
  return JSON.parse(String(r!.body)) as Record<string, any>;
};

describe("apps list access mode", () => {
  it("names each app's mode, and leaves it out while the box can't tell", async () => {
    const h = screens((id) => (id === "harry-chess" ? "open" : id === "harry-photos" ? "members-only" : null));
    const list = await get(h, "/api/screens/apps-list");
    const byId = Object.fromEntries((list.apps as Array<Record<string, unknown>>).map((a) => [a.serviceId, a.accessMode]));
    expect(byId).toEqual({ "harry-chess": "open", "harry-photos": "members-only", "harry-notes": undefined });
    const detail = await get(h, "/api/screens/app-detail/harry-photos");
    expect(detail.app.accessMode).toBe("members-only");
  });

  it("is absent on a box wired without it", async () => {
    const list = await get(screens(), "/api/screens/apps-list");
    expect((list.apps as Array<Record<string, unknown>>).every((a) => !("accessMode" in a))).toBe(true);
  });
});
