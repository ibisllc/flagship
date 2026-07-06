import { describe, expect, it } from "vitest";
import {
  assertResolvedHostSafe,
  assertSafeProviderBaseUrl,
  assertSafeResolvedUrl,
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

  describe("exclusiveHost pin (promo credentials)", () => {
    const pin = { hostAllowlist: ["coder.runpod.example.com"], exclusiveHost: "coder.runpod.example.com" };
    it("permits exactly the pinned host", () => {
      expect(() =>
        assertSafeProviderBaseUrl("https://coder.runpod.example.com/v1/chat/completions", pin),
      ).not.toThrow();
    });
    it("the pin is case-insensitive", () => {
      expect(() =>
        assertSafeProviderBaseUrl("https://Coder.RunPod.Example.com", pin),
      ).not.toThrow();
    });
    it("rejects ANY other host — even a public one (redirect-to-attacker defense)", () => {
      expect(rejects("https://attacker.example.com", pin)).toBe("host not pinned");
      expect(rejects("https://api.openai.com", pin)).toBe("host not pinned");
    });
    it("still rejects http even for the pinned host (no allowHttp)", () => {
      expect(rejects("http://coder.runpod.example.com", pin)).toContain("scheme");
    });
  });
});

describe("assertSafeResolvedUrl — DNS-record bypass", () => {
  async function rejectsResolved(
    url: string,
    resolve: (h: string) => Promise<string[]>,
    opts?: Parameters<typeof assertSafeResolvedUrl>[1],
  ): Promise<string> {
    try {
      await assertSafeResolvedUrl(url, opts, resolve);
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafeBaseUrlError);
      return (e as UnsafeBaseUrlError).reason;
    }
    throw new Error(`expected ${url} to be rejected`);
  }

  it("rejects a public hostname that RESOLVES to loopback", async () => {
    // The string guard passes (localtest.me looks public); the resolving
    // guard must catch the 127.0.0.1 A record.
    expect(() => assertSafeProviderBaseUrl("https://localtest.me/v1")).not.toThrow();
    expect(await rejectsResolved("https://localtest.me/v1", async () => ["127.0.0.1"])).toBe(
      "loopback IP",
    );
  });

  it("rejects a public hostname that RESOLVES to the cloud metadata IP", async () => {
    expect(
      await rejectsResolved("https://evil.example.com", async () => ["169.254.169.254"]),
    ).toBe("resolves to cloud metadata IP");
  });

  it("rejects metadata-on-resolve EVEN with allowPrivate", async () => {
    expect(
      await rejectsResolved("https://evil.example.com", async () => ["169.254.169.254"], {
        allowPrivate: true,
      }),
    ).toBe("resolves to cloud metadata IP");
  });

  it("rejects a public hostname that RESOLVES to an RFC1918 address", async () => {
    expect(await rejectsResolved("https://sneaky.example.com", async () => ["10.0.0.5"])).toBe(
      "private IP",
    );
  });

  it("rejects when a name resolves to a MIX of public + internal (any internal fails)", async () => {
    expect(
      await rejectsResolved("https://mix.example.com", async () => ["8.8.8.8", "127.0.0.1"]),
    ).toBe("loopback IP");
  });

  it("rejects when the name does not resolve", async () => {
    expect(await rejectsResolved("https://nope.example.com", async () => [])).toBe(
      "host did not resolve",
    );
  });

  it("rejects when the resolver throws", async () => {
    expect(
      await rejectsResolved("https://nope.example.com", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBe("DNS resolution failed");
  });

  it("accepts a public hostname that resolves to a public address", async () => {
    const u = await assertSafeResolvedUrl("https://api.anthropic.com", {}, async () => ["1.2.3.4"]);
    expect(u.hostname).toBe("api.anthropic.com");
  });

  it("permits a resolved-internal address when allowPrivate is set", async () => {
    const u = await assertSafeResolvedUrl(
      "https://ollama.lan:11434",
      { allowPrivate: true },
      async () => ["192.168.1.50"],
    );
    expect(u.hostname).toBe("ollama.lan");
  });

  it("skips resolution for an allowlisted host (resolver never called)", async () => {
    let called = false;
    const u = await assertSafeResolvedUrl(
      "https://ollama.internal",
      { hostAllowlist: ["ollama.internal"] },
      async () => {
        called = true;
        return ["127.0.0.1"];
      },
    );
    expect(u.hostname).toBe("ollama.internal");
    expect(called).toBe(false);
  });

  it("skips resolution for a literal IP host (already classified)", async () => {
    let called = false;
    await assertSafeResolvedUrl("https://8.8.8.8", {}, async () => {
      called = true;
      return ["8.8.8.8"];
    });
    expect(called).toBe(false);
  });
});

describe("assertResolvedHostSafe — bare host (git-clone path)", () => {
  async function rejectsHost(
    host: string,
    resolve: (h: string) => Promise<string[]>,
    opts?: Parameters<typeof assertResolvedHostSafe>[2],
  ): Promise<string> {
    try {
      await assertResolvedHostSafe(host, `https://${host}/x`, opts, resolve);
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafeBaseUrlError);
      return (e as UnsafeBaseUrlError).reason;
    }
    throw new Error(`expected host ${host} to be rejected`);
  }

  it("rejects a literal loopback IP host", async () => {
    expect(await rejectsHost("127.0.0.1", async () => ["127.0.0.1"])).toBe("loopback IP");
  });

  it("rejects the literal metadata IP host", async () => {
    expect(await rejectsHost("169.254.169.254", async () => [])).toBe("cloud metadata IP");
  });

  it("rejects localhost", async () => {
    expect(await rejectsHost("localhost", async () => [])).toBe("loopback host");
  });

  it("rejects a public name that resolves internal", async () => {
    expect(await rejectsHost("git.example.com", async () => ["127.0.0.1"])).toBe("loopback IP");
  });

  it("accepts a public name that resolves public", async () => {
    const h = await assertResolvedHostSafe("github.com", "https://github.com/x", {}, async () => [
      "140.82.112.3",
    ]);
    expect(h).toBe("github.com");
  });

  it("permits an allowlisted internal host without resolving", async () => {
    let called = false;
    const h = await assertResolvedHostSafe(
      "forgejo.lan",
      "https://forgejo.lan/x",
      { hostAllowlist: ["forgejo.lan"] },
      async () => {
        called = true;
        return ["127.0.0.1"];
      },
    );
    expect(h).toBe("forgejo.lan");
    expect(called).toBe(false);
  });

  it("permits a resolved RFC1918 host when allowPrivate is set", async () => {
    const h = await assertResolvedHostSafe(
      "forgejo.lan",
      "https://forgejo.lan/x",
      { allowPrivate: true },
      async () => ["192.168.1.20"],
    );
    expect(h).toBe("forgejo.lan");
  });
});
