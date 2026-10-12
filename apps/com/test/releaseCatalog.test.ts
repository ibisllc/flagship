import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogFor, handleReleases, loadEndorsements, type EndorsementSummary } from "../src/releaseCatalog.js";

const DIR = join(__dirname, "../../../.maintainers/endorsements");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const raw = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf-8")) as Record<string, unknown>;
const full = (short: string) => {
  const f = FILES.find((n) => n.endsWith(`-${short}.json`));
  if (!f) throw new Error(`no endorsement for ${short}`);
  return String(raw(f).commitHash);
};

function githubStub() {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    if (url.includes("/contents/")) {
      return Response.json(FILES.map((name) => ({ name, download_url: `https://raw.example/${name}` })));
    }
    const name = url.split("/").pop()!;
    return Response.json(raw(name));
  };
  return { fetch, calls };
}

async function endorsements(): Promise<EndorsementSummary[]> {
  return loadEndorsements(githubStub().fetch);
}

describe("release catalog for boxes that can't list their own", () => {
  it("offers every later release to a box on an older one, newest first", async () => {
    const c = catalogFor(await endorsements(), full("9873b83e"), 1);
    expect(c.latest?.commit).toBe(full("aca0b079"));
    const byTag = Object.fromEntries(c.releases.map((r) => [r.commit.slice(0, 8), r.relation]));
    expect(byTag["9873b83e"]).toBe("current");
    expect(byTag["67cfd8da"]).toBe("newer");
    expect(byTag["734afafa"]).toBe("older");
    expect(c.source).toBe("flagship");
  });

  it("places a box on a commit between releases", async () => {
    // 7ac1b50a is on main between releases (the first appliances ran it).
    const between = (await endorsements()).flatMap((e) => e.intermediateCommits).find((x) => x.startsWith("7ac1b50a"));
    expect(between).toBeDefined();
    const c = catalogFor(await endorsements(), between!, 1);
    expect(c.latest?.commit).toBe(full("aca0b079"));
    expect(c.releases.some((r) => r.relation === "current")).toBe(false);
  });

  it("offers nothing to a box on a commit off main's history", async () => {
    const c = catalogFor(await endorsements(), "f".repeat(40), 1);
    expect(c.latest).toBeNull();
    expect(c.releases.every((r) => r.relation === "unrelated")).toBe(true);
  });

  it("serves the shape a box's /api/screens/updates has, and lists GitHub once per cache window", async () => {
    const gh = githubStub();
    const store = new Map<string, Response>();
    const cache = {
      match: async (k: string) => store.get(k)?.clone(),
      put: async (k: string, r: Response) => void store.set(k, r),
    } as unknown as Cache;
    const url = (q: string) => new URL(`https://flagshipserver.com/api/releases${q}`);
    const r1 = await handleReleases(url(`?current=${full("67cfd8da")}`), { fetch: gh.fetch, cache, now: () => 5 });
    expect(r1.status).toBe(200);
    const body = (await r1.json()) as { latest: { commit: string }; checkedAt: number; currentCommit: string };
    expect(body.latest.commit).toBe(full("aca0b079"));
    expect(body.checkedAt).toBe(5);
    const listed = gh.calls.filter((u) => u.includes("/contents/")).length;
    await handleReleases(url(`?current=${full("9873b83e")}`), { fetch: gh.fetch, cache });
    expect(gh.calls.filter((u) => u.includes("/contents/")).length).toBe(listed);
    expect((await handleReleases(url("?current=nope"), { fetch: gh.fetch, cache })).status).toBe(400);
  });
});
