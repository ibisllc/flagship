import { describe, expect, it } from "vitest";
import { ed, offlineControlCanonicalBytes, rescueSessionCanonicalBytes } from "@flagship/protocol";
import {
  CUT_TABLE,
  appStateIn,
  applyCutCommand,
  bundleOffsets,
  controlOrderFor,
  cutDelta,
  cutScript,
  parseCutCounters,
  parseSshClient,
  rescueHeaders,
  sessionOrderFor,
} from "../lib/sovereignty.js";

const LISTED = `table inet ${CUT_TABLE} {
	chain out {
		type filter hook output priority -50; policy accept;
		oifname "lo" counter packets 120 bytes 9000 accept comment "lo"
		ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } counter packets 40 bytes 5000 accept comment "private"
		ip6 daddr { ::1, fe80::/10, ff00::/8, fc00::/7 } counter packets 2 bytes 160 accept comment "private6"
		ip daddr 203.0.113.9 tcp sport 22 counter packets 77 bytes 12000 accept comment "runner-ssh"
		meta nfproto ipv4 counter packets 31 bytes 2400 drop comment "drop4"
		meta nfproto ipv6 counter packets 3 bytes 240 drop comment "drop6"
	}
}`;

describe("the egress cut", () => {
  it("allows only loopback, private ranges and the runner's SSH replies, and drops the rest in both hooks", () => {
    const s = cutScript({ runnerV4: "203.0.113.9" });
    expect(s).toContain(`table inet ${CUT_TABLE}`);
    expect(s).toContain("hook output");
    expect(s).toContain("hook forward");
    expect(s).toContain('ip daddr 203.0.113.9 tcp sport 22 counter accept comment "runner-ssh"');
    expect(s).not.toMatch(/ct state/);
    expect(s.match(/counter drop/g)?.length).toBe(4);
  });

  it("refuses an address that is not IPv4 (nothing reaches the box's shell unchecked)", () => {
    expect(() => cutScript({ runnerV4: "1.2.3.4; reboot" })).toThrow();
    expect(() => cutScript({ runnerV4: "300.1.1.1" })).toThrow();
    expect(() => cutScript({ runnerV4: "10.0.0.1", sshPort: 0 })).toThrow();
  });

  it("ships the script base64-encoded, so no rule text is interpreted by the remote shell", () => {
    const cmd = applyCutCommand(cutScript({ runnerV4: "203.0.113.9" }));
    expect(cmd).not.toContain("runner-ssh");
    expect(cmd).toContain("base64 -d | nft -f -");
  });

  it("parses the counters per rule and the delta between two readings", () => {
    const after = parseCutCounters(LISTED);
    expect(after["runner-ssh"]).toEqual({ packets: 77, bytes: 12000 });
    expect(after.drop4?.packets).toBe(31);
    const before = parseCutCounters(LISTED.replace("packets 31", "packets 1").replace("packets 77", "packets 70"));
    expect(cutDelta(before, after)).toEqual({ dropped: 30, runnerSsh: 7, missing: [] });
    expect(cutDelta({}, {}).missing).toEqual(["drop4", "drop6", "runner-ssh"]);
  });

  it("reads the runner's address from $SSH_CLIENT", () => {
    expect(parseSshClient("198.51.100.4 52113 22\n")).toBe("198.51.100.4");
    expect(parseSshClient("")).toBeNull();
    expect(parseSshClient("::1 1 22")).toBeNull();
  });
});

describe("the phone side of a rescue session", () => {
  const hello = { serverDomain: "home.ab.gym.flagship.services", clientNonce: "a".repeat(32), boxNonce: "b".repeat(32), certSha256: "c".repeat(64), issuedAt: 1 };

  it("answers the hello with the same nonces and certificate, and can name another certificate for the negative check", () => {
    const o = sessionOrderFor(hello, 5);
    expect(o).toEqual({ ...hello, issuedAt: 5 });
    expect(() => rescueSessionCanonicalBytes(o)).not.toThrow();
    expect(sessionOrderFor(hello, 5, "d".repeat(64)).certSha256).toBe("d".repeat(64));
  });

  it("builds offline-control orders the protocol accepts (fresh nonce each, lowercase domain)", () => {
    const a = controlOrderFor({ serverDomain: "Home.AB.gym.flagship.services", sessionNonce: "b".repeat(32), action: "app-stop", target: "ab--pyapp", now: 9 });
    const b = controlOrderFor({ serverDomain: "home.ab.gym.flagship.services", sessionNonce: "b".repeat(32), action: "app-stop", target: "ab--pyapp", now: 9 });
    expect(a.serverDomain).toBe("home.ab.gym.flagship.services");
    expect(a.nonce).not.toBe(b.nonce);
    expect(() => offlineControlCanonicalBytes(a)).not.toThrow();
    const sk = ed.utils.randomPrivateKey();
    const sig = ed.sign(offlineControlCanonicalBytes(a), sk);
    expect(ed.verify(sig, offlineControlCanonicalBytes(a), ed.getPublicKey(sk))).toBe(true);
    const restart = controlOrderFor({ serverDomain: hello.serverDomain, sessionNonce: "b".repeat(32), action: "server-restart", target: hello.serverDomain, now: 9 });
    expect(() => offlineControlCanonicalBytes(restart)).not.toThrow();
  });

  it("reads an app's state from /api/rescue/server", () => {
    const server = { apps: [{ serviceId: "ab--pyapp", name: "pyapp", state: "running" }] };
    expect(appStateIn(server, "ab--pyapp")).toBe("running");
    expect(appStateIn(server, "ab--other")).toBe("missing");
    expect(appStateIn(null, "x")).toBe("missing");
  });

  it("sends the token only in the rescue header and only when it is well formed", () => {
    expect(rescueHeaders("f".repeat(64))).toEqual({ "x-flagship-rescue": "f".repeat(64) });
    expect(() => rescueHeaders("nope")).toThrow();
  });

  it("splits a bundle into 4 MiB parts and resumes from what it has", () => {
    const M = 4 * 1024 * 1024;
    expect(bundleOffsets(0)).toEqual([]);
    expect(bundleOffsets(M)).toEqual([0]);
    expect(bundleOffsets(M + 1)).toEqual([0, M]);
    expect(bundleOffsets(2 * M + 5, M)).toEqual([M, 2 * M]);
    expect(() => bundleOffsets(10, 11)).toThrow();
  });
});
