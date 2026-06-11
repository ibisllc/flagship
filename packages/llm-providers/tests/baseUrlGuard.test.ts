import { describe, expect, it } from "vitest";
import {
  assertSafeProviderBaseUrl,
  UnsafeBaseUrlError,
} from "../src/baseUrlGuard.js";

function rejects(url: string, opts?: Parameters<typeof assertSafeProviderBaseUrl>[1]): string {
  try {
    assertSafeProviderBaseUrl(url, opts);
  } catch (e) {
    expect(e).toBeInstanceOf(UnsafeBaseUrlError);
    return (e as UnsafeBaseUrlError).reason;
  }
  throw new Error(`expected ${url} to be rejected`);
}

describe("assertSafeProviderBaseUrl", () => {
  it("accepts a public https endpoint", () => {
    const u = assertSafeProviderBaseUrl("https://api.anthropic.com/v1");
    expect(u.hostname).toBe("api.anthropic.com");
  });

  it("accepts a public https endpoint given as an IP", () => {
    expect(() => assertSafeProviderBaseUrl("https://8.8.8.8/v1")).not.toThrow();
  });

  it("rejects non-https by default", () => {
    expect(rejects("http://api.anthropic.com")).toContain("scheme");
  });

  it("rejects an unparseable url", () => {
    expect(rejects("not a url")).toBe("unparseable");
  });

  describe("loopback", () => {
    it("rejects localhost", () => {
      expect(rejects("https://localhost:8080")).toBe("loopback host");
    });
    it("rejects *.localhost", () => {
      expect(rejects("https://api.localhost")).toBe("loopback host");
    });
    it("rejects 127.0.0.0/8", () => {
      expect(rejects("https://127.0.0.1")).toBe("loopback IP");
      expect(rejects("https://127.1.2.3:5432")).toBe("loopback IP");
    });
    it("rejects ::1", () => {
      expect(rejects("https://[::1]:9090")).toBe("loopback IP");
    });
    it("rejects ipv4-mapped loopback", () => {
      expect(rejects("https://[::ffff:127.0.0.1]")).toBe("loopback IP");
    });
  });

  describe("link-local + metadata", () => {
    it("rejects 169.254.0.0/16", () => {
      expect(rejects("https://169.254.1.1")).toBe("link-local IP");
    });
    it("rejects the cloud metadata IP specifically", () => {
      expect(rejects("https://169.254.169.254/latest/meta-data")).toBe("cloud metadata IP");
    });
    it("rejects the metadata IP EVEN when private ranges are allowed", () => {
      expect(rejects("https://169.254.169.254", { allowPrivate: true })).toBe("cloud metadata IP");
    });
    it("rejects fe80::/10 link-local v6", () => {
      expect(rejects("https://[fe80::1]")).toBe("link-local IP");
    });
  });

  describe("RFC1918 / unique-local", () => {
    it("rejects 10.0.0.0/8 by default", () => {
      expect(rejects("https://10.1.2.3")).toBe("private IP");
    });
    it("rejects 192.168.0.0/16 by default", () => {
      expect(rejects("https://192.168.1.1")).toBe("private IP");
    });
    it("rejects 172.16.0.0/12 by default", () => {
      expect(rejects("https://172.16.5.5")).toBe("private IP");
      expect(rejects("https://172.31.255.255")).toBe("private IP");
    });
    it("treats 172.32.x.x as public (outside the /12)", () => {
      expect(() => assertSafeProviderBaseUrl("https://172.32.0.1")).not.toThrow();
    });
    it("rejects fc00::/7 unique-local v6 by default", () => {
      expect(rejects("https://[fd12::1]")).toBe("private IP");
    });
  });

  describe("allowPrivate override", () => {
    it("permits an RFC1918 host when allowPrivate is set", () => {
      expect(() =>
        assertSafeProviderBaseUrl("https://192.168.1.50:11434", { allowPrivate: true }),
      ).not.toThrow();
    });
    it("still blocks loopback even with allowPrivate", () => {
      expect(rejects("https://127.0.0.1", { allowPrivate: true })).toBe("loopback IP");
    });
    it("still blocks link-local even with allowPrivate", () => {
      expect(rejects("https://169.254.1.1", { allowPrivate: true })).toBe("link-local IP");
    });
  });

  describe("allowHttp override", () => {
    it("permits http for an allowed LAN host", () => {
      expect(() =>
        assertSafeProviderBaseUrl("http://192.168.1.50:11434", {
          allowHttp: true,
          allowPrivate: true,
        }),
      ).not.toThrow();
    });
    it("does not permit other schemes", () => {
      expect(rejects("file:///etc/passwd", { allowHttp: true })).toContain("scheme");
    });
  });

  describe("hostAllowlist override", () => {
    it("permits an exact allowlisted internal host", () => {
      expect(() =>
        assertSafeProviderBaseUrl("https://ollama.internal", {
          hostAllowlist: ["ollama.internal"],
        }),
      ).not.toThrow();
    });
    it("allowlist is case-insensitive", () => {
      expect(() =>
        assertSafeProviderBaseUrl("https://Ollama.Internal", {
          hostAllowlist: ["ollama.internal"],
        }),
      ).not.toThrow();
    });
    it("a non-allowlisted internal host is still blocked", () => {
      expect(
        rejects("https://192.168.1.99", { hostAllowlist: ["ollama.internal"] }),
      ).toBe("private IP");
    });
    it("the metadata IP is blocked even if allowlisted", () => {
      expect(
        rejects("https://169.254.169.254", { hostAllowlist: ["169.254.169.254"] }),
      ).toBe("cloud metadata IP");
    });
  });
});
