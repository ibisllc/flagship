import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { bytes, formatHosts, parseArgs } from "./outbound-hosts.mjs";

const answer = {
  days: 1,
  hosts: [
    { host: "api.openai.com", status: "allowed", firstSeenDay: "seed", note: "seed", streams: 40, bytesUp: 2048, bytesDown: 5 * 1024 ** 2, refused: 0 },
    { host: "files.suspicious.example", status: "allowed", firstSeenDay: "2026-10-20", note: "", streams: 900, bytesUp: 3 * 1024 ** 3, bytesDown: 100, refused: 0 },
    { host: "bad.example.org", status: "blocked", firstSeenDay: "2026-10-18", note: "complaint", streams: 0, bytesUp: 0, bytesDown: 0, refused: 12 },
  ],
};

describe("outbound-hosts", () => {
  it("reads its arguments", () => {
    expect(parseArgs([]).days).toBe(1);
    expect(parseArgs(["--days", "7", "--new"])).toMatchObject({ days: 7, newOnly: true });
    expect(parseArgs(["block", "x.example.org", "abuse", "complaint"]).action).toEqual({ status: "blocked", host: "x.example.org", note: "abuse complaint" });
    expect(parseArgs(["allow", "x.example.org"]).action?.status).toBe("allowed");
    expect(() => parseArgs(["--days", "99"])).toThrow();
    expect(() => parseArgs(["--nope"])).toThrow();
    expect(() => parseArgs(["frobnicate", "x"])).toThrow();
    expect(() => parseArgs(["block"])).toThrow();
  });

  it("prints sizes people can read", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(5 * 1024 ** 2)).toBe("5.0 MiB");
    expect(bytes(3 * 1024 ** 3)).toBe("3.0 GiB");
  });

  it("lists every host and points at new and heavy-upload ones", () => {
    const out = formatHosts(answer, {}, new Date("2026-10-20T12:00:00Z"));
    expect(out).toContain("api.openai.com");
    expect(out).toContain("bad.example.org");
    expect(out).toMatch(/files\.suspicious\.example took 3\.0 GiB UPLOADED/);
    expect(out).toMatch(/1 host\(s\) are new/);
    expect(out).toContain("npm run outbound-hosts -- block <host>");
  });

  it("filters to blocked or new hosts", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    expect(formatHosts(answer, { blockedOnly: true }, now)).not.toContain("api.openai.com");
    const fresh = formatHosts(answer, { newOnly: true }, now);
    expect(fresh).toContain("files.suspicious.example");
    expect(fresh).not.toContain("api.openai.com");
  });
});
