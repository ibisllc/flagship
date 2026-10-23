/**
 * Every HTTP client the mobile apps build (SECURITY-HARDENING-PLAN.md 7.1): a client that can reach
 * a box must come from the pinning factory, so a new one cannot quietly skip the pin. Adding a raw
 * `OkHttpClient()` or `URLSession(...)` needs a line here saying why it never talks to a box.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = [
  "apps/mobile/android/app/src/main",
  "apps/mobile/android/wear/src/main",
  "apps/mobile/ios/Sources",
  "apps/mobile/ios/App/Sources",
  "apps/mobile/shared/Sources",
];

function walk(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(kt|swift)$/.test(n) ? [p] : [];
  });
}

const CONSTRUCT = /\bOkHttpClient\s*\(\s*\)|\bOkHttpClient\.Builder\s*\(\s*\)|\bURLSession\s*\(|URLSession\.shared/;

/** file (relative) -> why a raw client there never carries a box request */
const ALLOWED: Record<string, string> = {
  "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/HttpClientFactory.kt": "the one factory: pin verifier + interceptor are installed here",
  "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/SecurityNoticeCenter.kt": "anonymous GET to the control apex for signed notices",
  "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/HttpTransport.kt": "default for control-apex transports; box clients are given the factory's client",
  "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/QrRelayClient.kt": "default for the control apex's QR relay",
  "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/BuilderPairClient.kt": "default for the control apex's pairing endpoints",
  "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/LiveDevicePairingRelay.kt": "defaults for the control apex's pairing relay",
  "apps/mobile/android/app/src/main/java/com/flagshipserver/app/api/PhoneAlertClient.kt": "default for the control apex's alert inbox",
  "apps/mobile/android/app/src/main/java/com/flagshipserver/app/builder/iso/OkHttpBuilderHttp.kt": "downloads installer media from the public mirrors",
  "apps/mobile/android/app/src/main/java/com/flagshipserver/app/viewmodels/PeerRestoreSources.kt": "reads one record from the control apex",
  "apps/mobile/shared/Sources/FlagshipAPI/Client/BoxCertPinning.swift": "the pinned session factory itself",
  "apps/mobile/shared/Sources/FlagshipAPI/Client/LanDirect.swift": "LAN session built with the pinning delegate",
  "apps/mobile/shared/Sources/FlagshipAPI/Client/RelayFallback.swift": "relay session built with the pinning delegate; the other is the anonymous apex fetch",
  "apps/mobile/shared/Sources/FlagshipCore/SecurityNoticeCenter.swift": "anonymous GET to the control apex for signed notices",
  "apps/mobile/ios/Sources/FlagshipUI/ViewModels/TrustOverrideViewModel.swift": "posts to the control apex",
  "apps/mobile/ios/Sources/FlagshipUI/ViewModels/ServerArchiveViewModels.swift": "reads one record from the control apex",
};

describe("mobile HTTP clients", () => {
  const found = new Map<string, number>();
  for (const d of DIRS) {
    for (const f of walk(join(ROOT, d))) {
      const text = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      const n = text.split("\n").filter((l) => CONSTRUCT.test(l)).length;
      if (n > 0) found.set(relative(ROOT, f), n);
    }
  }

  it("builds a raw client only in the places listed above", () => {
    const unlisted = [...found.keys()].filter((f) => !(f in ALLOWED));
    expect(unlisted, `a raw HTTP client was added; route it through the pinning factory or list why it never reaches a box:\n${unlisted.join("\n")}`).toEqual([]);
  });

  it("does not keep a listing for a file that no longer builds one", () => {
    const stale = Object.keys(ALLOWED).filter((f) => !found.has(f));
    expect(stale).toEqual([]);
  });

  it("gives the clients that talk to a box no default client of their own", () => {
    const base = join(ROOT, "apps/mobile/android/app/src/main/java/com/flagshipserver/app/api");
    for (const f of ["LiveScreensClient.kt", "LiveBuildClient.kt"]) {
      const text = readFileSync(join(base, f), "utf8");
      expect(text, f).not.toMatch(/val client: OkHttpClient = /);
    }
  });

  it("installs the pin verifier, the interceptor and the known-box rule in the one factory", () => {
    const f = readFileSync(join(ROOT, "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/HttpClientFactory.kt"), "utf8");
    expect(f).toContain("CertPinHostnameVerifier(CertPinRegistry.shared::pinFor, isKnownBox");
    expect(f).toContain("CertPinInterceptor(CertPinRegistry.shared::pinFor, isKnownBox");
    const ios = readFileSync(join(ROOT, "apps/mobile/ios/App/Sources/FlagshipApp.swift"), "utf8");
    expect(ios).toContain("BoxPinPolicy.install(isKnownBox:");
  });
});
