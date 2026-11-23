import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script
import { grantLink, main, parseArgs } from "./name-grant.mjs";

describe("scripts/name-grant.mjs", () => {
  it("parses the name, --free and --hours", () => {
    expect(parseArgs(["Acme", "--free", "--hours", "12"])).toMatchObject({ name: "acme", free: true, hours: 12 });
    expect(parseArgs(["acme"])).toMatchObject({ free: false, hours: 72 });
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(["a", "b"])).toThrow();
    expect(() => parseArgs(["a", "--hours", "x"])).toThrow();
  });

  it("puts the grant in the fragment of an https app link", () => {
    expect(grantLink("https://flagshipserver.com/", { name: "acme", code: "FLAG-AAAAA", expiresAt: 5, free: true })).toBe(
      "https://flagshipserver.com/app/choose-name#n=acme&g=FLAG-AAAAA&e=5&f=1",
    );
  });

  it("calls the admin route with the secret and prints the link", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const lines: string[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, name: "acme", code: "FLAG-B", expiresAt: 0, free: false }), { status: 200 });
    };
    await main(["acme"], { FLAGSHIP_ADMIN_SECRET: "s" }, fetchFn, { log: (l: string) => lines.push(l) });
    expect(calls[0]!.url).toBe("https://flagshipserver.com/api/admin/name-grant");
    expect((calls[0]!.init.headers as Record<string, string>)["x-admin-secret"]).toBe("s");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "acme", free: false, hours: 72 });
    expect(lines.at(-1)).toBe("https://flagshipserver.com/app/choose-name#n=acme&g=FLAG-B&e=0");
    await expect(main(["acme"], {}, fetchFn, { log: () => {} })).rejects.toThrow(/FLAGSHIP_ADMIN_SECRET/);
  });
});
