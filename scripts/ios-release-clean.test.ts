import { describe, expect, it } from "vitest";
import { scanBinaryStrings, scanSources, scanSwift } from "./ios-release-clean.mjs";

describe("iOS Release builds ship no mocks or developer mode", () => {
  it("no Swift file compiled into a Release build names a mock, fixture, gym seam or developer mode", () => {
    const findings = scanSources();
    expect(findings.map((f: { file: string; line: number; match: string }) => `${f.file}:${f.line} ${f.match}`)).toEqual([]);
  });

  it("flags Release-visible mock and dev-mode code and ignores Debug-only code and comments", () => {
    const src = [
      "import Foundation",
      "let a = MockScreensClient(); let a2 = ShareCoInvitesMockBox.gym(bundleKey: nil)",
      "// MockScreensClient in a comment is fine",
      "let url = \"https://x\" // DemoFixtures",
      "#if DEBUG",
      "let b = MockLockPowerClient()",
      "#else",
      "let c = GymSeams.forceAdminRoot",
      "#endif",
      "#if !DEBUG",
      "let d = DeveloperSettings()",
      "#else",
      "let e = DemoFixtures.samplePods(username: \"x\")",
      "#endif",
      "#if canImport(UIKit)",
      "let f = ProcessInfo.processInfo.arguments.contains(\"-smoke-mode\")",
      "#endif",
      "/* GymLaunch.usesMocks",
      "   still a comment */ let g = dev.useLiveClient",
    ].join("\n");
    const found = scanSwift(src).map((f: { line: number; match: string }) => `${f.line}:${f.match}`);
    expect(found).toEqual(["2:MockScreensClient", "2:ShareCoInvitesMockBox", "8:GymSeams", "11:DeveloperSettings", "16:\"-smoke-", "19:useLiveClient"]);
  });

  it("flags mock and developer-mode names in a binary's strings", () => {
    const strings = [
      "flagshipserver.com",
      "_$s10FlagshipUI17MockScreensClientCMn",
      "Developer menu unlocked.",
      "-smoke-mode",
      "_$s12FlagshipCore21ShareCoInvitesMockBoxCMn",
      "DemoAccount",
    ].join("\n");
    expect(scanBinaryStrings(strings)).toEqual(["-smoke-mode", "Developer menu", "MockBox", "MockScreens"]);
  });
});
