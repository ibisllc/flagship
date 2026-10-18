import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DnsProbe, darkDuringIssuance, describeAnswer } from "../lib/dnsProbe.js";

const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe("DNS probe answer states", () => {
  it("tells a name that exists without the type from a name that does not exist", () => {
    expect(describeAnswer(err("ENODATA"), [], "A")).toBe("NODATA");
    expect(describeAnswer(err("ENOTFOUND"), [], "A")).toBe("NXDOMAIN");
  });
  it("keeps timeouts and refusals apart from real answers", () => {
    expect(describeAnswer(err("ETIMEOUT"), [], "A")).toBe("ERROR(ETIMEOUT)");
    expect(describeAnswer(err("EREFUSED"), [], "TXT")).toBe("ERROR(EREFUSED)");
  });
  it("names an address answer by its sorted addresses, not its TTL, so a TTL tick is no change", () => {
    const a = describeAnswer(null, [{ address: "2.2.2.2", ttl: 60 }, { address: "1.1.1.1", ttl: 60 }], "A");
    const b = describeAnswer(null, [{ address: "1.1.1.1", ttl: 12 }, { address: "2.2.2.2", ttl: 12 }], "A");
    expect(a).toBe("A 1.1.1.1,2.2.2.2");
    expect(b).toBe(a);
  });
  it("counts TXT records (a box challenge has two at once)", () => {
    expect(describeAnswer(null, [["x"], ["y"]], "TXT")).toBe("TXT x2");
    expect(describeAnswer(null, [], "TXT")).toBe("NODATA");
  });
});

describe("dark stretches during issuance", () => {
  const ev = (t: number, target: string, state: string, via = "authoritative") => ({ t, at: "", target, via, state });
  it("is empty while the box and the labels under it keep answering", () => {
    const events = [ev(0, "box A", "A 1.1.1.1"), ev(1000, "random label under box A", "A 1.1.1.1"), ev(2000, "challenge TXT", "NXDOMAIN")];
    expect(darkDuringIssuance(events, 0, 10_000)).toEqual([]);
  });
  it("reports a label under the box that went NXDOMAIN, with how long", () => {
    const events = [ev(0, "random label under box A", "A 1.1.1.1", "8.8.8.8"), ev(5000, "random label under box A", "NXDOMAIN", "8.8.8.8"), ev(10_100, "random label under box A", "A 1.1.1.1", "8.8.8.8")];
    expect(darkDuringIssuance(events, 0, 20_000)).toEqual(["8.8.8.8 / random label under box A: NXDOMAIN at 5.0 s for 5.1 s"]);
  });
  it("counts a dark state that began before the window and is still there", () => {
    const events = [ev(0, "box A", "NXDOMAIN")];
    expect(darkDuringIssuance(events, 3000, 9000)).toHaveLength(1);
  });
  it("ignores darkness after issuance ended (teardown removes records one by one)", () => {
    const events = [ev(0, "box A", "A 1.1.1.1"), ev(9500, "box A", "NXDOMAIN")];
    expect(darkDuringIssuance(events, 0, 9000)).toEqual([]);
  });
  it("does not blame the challenge TXT or the account name", () => {
    const events = [ev(0, "challenge TXT", "NXDOMAIN"), ev(0, "account A", "NODATA")];
    expect(darkDuringIssuance(events, 0, 9000)).toEqual([]);
  });
});

describe("the probe under the root wildcard", () => {
  const probe = (): DnsProbe =>
    new DnsProbe({ box: "home.ga1.gym.flagship.services", account: "ga1.gym.flagship.services", apex: "gym.flagship.services" }, mkdtempSync(join(tmpdir(), "probe-")), {
      auth: ["127.0.0.1"],
      public: [],
    });
  const note = (p: DnsProbe, target: string, via: string, state: string) =>
    (p as unknown as { note(t: string, v: string, s: string): void }).note(target, via, state);

  it("counts the box name from its first answer: there is no wildcard to wait for", () => {
    const p = probe();
    expect(p.issuanceStart()).toBeNull();
    note(p, "box A", "authoritative", "A 1.1.1.1");
    expect(p.issuanceStart()).toBe(0);
  });

  it("reports a box name that was dark at the start", async () => {
    const p = probe();
    note(p, "box A", "authoritative", "NXDOMAIN");
    await new Promise((r) => setTimeout(r, 30));
    note(p, "box A", "authoritative", "A 1.1.1.1");
    await new Promise((r) => setTimeout(r, 10));
    expect(p.dark()).toHaveLength(1);
  });

  it("sees an address or CAA record that appears at the account, not the challenge TXT", () => {
    const p = probe();
    const zone = (state: string) => (p as unknown as { zoneEvent(s: string): void }).zoneEvent(state);
    zone("+ TXT _acme-challenge.home.ga1.gym.flagship.services");
    expect(p.recordsWritten()).toEqual([]);
    zone("+ A *.ga1.gym.flagship.services");
    zone("+ CAA ga1.gym.flagship.services");
    zone("- A *.ga1.gym.flagship.services");
    expect(p.recordsWritten()).toEqual(["A *.ga1.gym.flagship.services", "CAA ga1.gym.flagship.services"]);
  });
});
