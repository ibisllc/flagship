import { describe, expect, it } from "vitest";
import { classifyAddress, isPublicAddress, parseIpv6Bytes, parseStrictIpv4 } from "../src/addressPolicy.js";

describe("addressPolicy (SEC N02, E01)", () => {
  it("classifies every spelling of loopback, private and metadata addresses", () => {
    const cases: Array<[string, string]> = [
      ["127.0.0.1", "loopback"], ["::1", "loopback"], ["0:0:0:0:0:0:0:1", "loopback"],
      ["0000:0000:0000:0000:0000:0000:0000:0001", "loopback"], ["::ffff:127.0.0.1", "loopback"],
      ["::ffff:7f00:1", "loopback"], ["::FFFF:7F00:1", "loopback"], ["[::1]", "loopback"],
      ["10.1.2.3", "private"], ["::ffff:a00:1", "private"], ["fd12::1", "private"], ["fec0::1", "private"],
      ["100.64.0.1", "private"], ["198.18.0.1", "private"],
      ["169.254.169.254", "metadata"], ["::ffff:a9fe:a9fe", "metadata"], ["fd00:ec2::254", "metadata"],
      ["169.254.1.1", "link-local"], ["fe80::1", "link-local"], ["febf::1", "link-local"],
      ["224.0.0.1", "multicast"], ["ff02::1", "multicast"],
      ["0.0.0.0", "reserved"], ["::", "reserved"], ["::7f00:1", "reserved"], ["64:ff9b::7f00:1", "reserved"],
      ["2001::1", "reserved"], ["2002:7f00:1::", "reserved"], ["2001:db8::1", "reserved"], ["4000::1", "reserved"],
      ["8.8.8.8", "public"], ["2606:4700:4700::1111", "public"], ["::ffff:808:808", "public"], ["2001:4860:4860::8888", "public"],
    ];
    for (const [ip, want] of cases) expect(classifyAddress(ip), ip).toBe(want);
  });

  it("refuses text that is not a plain address", () => {
    for (const ip of ["", "localhost", "1.2.3", "256.1.1.1", "010.0.0.1", "0x7f.0.0.1", "2130706433", "1.1.1.1%en0",
      "fe80::1%en0", "1::2::3", "1:2:3:4:5:6:7:8:9", "::ffff:999.1.1.1", "g::1", " 8.8.8.8x"]) {
      expect(classifyAddress(ip), JSON.stringify(ip)).toBe("invalid");
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("parses to the same bytes however the address is written", () => {
    const a = parseIpv6Bytes("::ffff:127.0.0.1")!;
    expect([...a]).toEqual([...parseIpv6Bytes("0:0:0:0:0:ffff:7f00:1")!]);
    expect(parseStrictIpv4("1.2.3.4")).toEqual([1, 2, 3, 4]);
    expect(parseStrictIpv4("01.2.3.4")).toBeNull();
  });
});
