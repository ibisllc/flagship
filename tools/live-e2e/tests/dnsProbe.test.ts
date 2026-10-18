import { describe, expect, it } from "vitest";
import { describeAnswer } from "../lib/dnsProbe.js";

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
