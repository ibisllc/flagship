// The server page is one DOM view reused for every server. A slow answer from
// the server opened before must not paint its detail under the server now
// open (seen as "leticia" showing home3's FQDN, app count and version).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers = new Map<string, () => Promise<unknown>>();

vi.mock("../public/webapp/lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  boxClient: vi.fn((fqdn: string) => ({
    fqdn,
    baseUrl: `https://${fqdn}`,
    token: () => "tok",
    hasSession: () => true,
    fetch: (path: string) => (path === "/api/screens/server-detail" ? answers.get(fqdn)!() : new Promise(() => {})),
  })),
}));
vi.mock("../public/webapp/lib/toast.js", () => ({ toast: vi.fn() }));

import { enterServerDetail } from "../public/webapp/views/server-detail.js";

const HOME3 = "home3.plucky-avocet.flagship.services";
const LETICIA = "leticia.plucky-avocet.flagship.services";

class El {
  innerHTML = "";
  textContent = "";
  classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

let ids: Record<string, El>;

beforeEach(() => {
  ids = { "server-detail-content": new El(), "server-detail-title": new El(), "view-server-detail": new El() };
  vi.stubGlobal("document", {
    getElementById: (id: string) => ids[id] ?? null,
    querySelectorAll: () => [],
    dispatchEvent: () => true,
    body: new El(),
  });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

afterEach(() => {
  answers.clear();
  vi.unstubAllGlobals();
});

describe("server detail", () => {
  it("a late answer from the previous server doesn't replace the open one", async () => {
    let answerHome3!: (v: unknown) => void;
    answers.set(HOME3, () => new Promise((r) => { answerHome3 = r; }));
    answers.set(LETICIA, () => Promise.reject(new Error("not answering")));

    const first = enterServerDetail(HOME3);
    await enterServerDetail(LETICIA);
    expect(ids["server-detail-title"]!.textContent).toBe("leticia");
    expect(ids["server-detail-content"]!.innerHTML).toContain(LETICIA);

    answerHome3({ serverFqdn: HOME3, username: "u", daemonVersion: "1", currentCommit: "a".repeat(40), serviceCount: 7, pairedSessionCount: 1 });
    await first;

    expect(ids["server-detail-title"]!.textContent).toBe("leticia");
    expect(ids["server-detail-content"]!.innerHTML).toContain(LETICIA);
    expect(ids["server-detail-content"]!.innerHTML).not.toContain(HOME3);
  });
});
