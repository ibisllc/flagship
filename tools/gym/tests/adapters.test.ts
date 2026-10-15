import { describe, it, expect } from "vitest";
import { parseXcTestCases, testsForHarness, verdictFor, isIPadScenario } from "../src/adapters/ios.js";
import { parseJUnitCases, casesForHarness } from "../src/adapters/android.js";

// Shape of `xcrun xcresulttool get test-results tests --format json` (Xcode 16+).
const xcresult = {
  testNodes: [
    {
      name: "FlagshipApp",
      nodeType: "Test Plan",
      children: [
        {
          name: "FlagshipAppUITests",
          nodeType: "UI test bundle",
          children: [
            {
              name: "GymTotalTests",
              nodeType: "Test Suite",
              children: [
                { name: "test_a()", nodeIdentifier: "GymTotalTests/test_a()", nodeType: "Test Case", result: "Passed", durationInSeconds: 1.5 },
                {
                  name: "test_b()",
                  nodeIdentifier: "GymTotalTests/test_b()",
                  nodeType: "Test Case",
                  result: "Failed",
                  durationInSeconds: 2,
                  children: [{ name: "XCTAssertTrue failed - nope", nodeType: "Failure Message" }],
                },
              ],
            },
            {
              name: "GymIPadTests",
              nodeType: "Test Suite",
              children: [
                {
                  name: "test_pad()",
                  nodeIdentifier: "GymIPadTests/test_pad()",
                  nodeType: "Test Case",
                  result: "Skipped",
                  children: [{ name: "Test skipped - iPad only", nodeType: "Skip Message" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("iOS adapter: reading the .xcresult", () => {
  const cases = parseXcTestCases(xcresult);

  it("flattens every test case with its id, result, time and messages", () => {
    expect(cases.map((c) => c.id)).toEqual(["GymTotalTests/test_a", "GymTotalTests/test_b", "GymIPadTests/test_pad"]);
    expect(cases[0]!.durationMs).toBe(1500);
    expect(cases[1]!.messages).toEqual(["XCTAssertTrue failed - nope"]);
    expect(cases[2]!.messages).toEqual(["Test skipped - iPad only"]);
  });

  it("selects by class or by class/method", () => {
    expect(testsForHarness("FlagshipAppUITests/GymTotalTests", cases)).toHaveLength(2);
    expect(testsForHarness("FlagshipAppUITests/GymTotalTests/test_a", cases)).toHaveLength(1);
  });

  it("passes only when every named test ran and none failed", () => {
    expect(verdictFor("FlagshipAppUITests/GymTotalTests/test_a", cases).passed).toBe(true);
    expect(verdictFor("FlagshipAppUITests/GymTotalTests", cases).passed).toBe(false);
  });

  it("a harness that matched nothing FAILS (never a silent pass)", () => {
    const v = verdictFor("FlagshipAppUITests/GymTotalTests/test_missing", cases);
    expect(v.passed).toBe(false);
    expect(v.skipped).toBe(false);
  });

  it("all-skipped is a skip with the skip message", () => {
    const v = verdictFor("FlagshipAppUITests/GymIPadTests", cases);
    expect(v.skipped).toBe(true);
    expect(v.reason).toBe("Test skipped - iPad only");
  });

  it("routes GymIPad harnesses to the iPad", () => {
    expect(isIPadScenario("FlagshipAppUITests/GymIPadTests/test_x")).toBe(true);
    expect(isIPadScenario("FlagshipAppUITests/GymTotalTests/test_x")).toBe(false);
  });
});

describe("Android adapter: reading the connected-test JUnit XML", () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' ?>
<testsuite name="com.flagshipserver.app.gym.GymTotalTest" tests="3" failures="1" errors="0" skipped="1" time="9.1">
  <testcase name="passes" classname="com.flagshipserver.app.gym.GymTotalTest" time="2.5" />
  <testcase name="fails" classname="com.flagshipserver.app.gym.GymTotalTest" time="1.0">
    <failure message="java.lang.AssertionError: nope &amp; more">java.lang.AssertionError: nope
	at x</failure>
  </testcase>
  <testcase name="skips" classname="com.flagshipserver.app.gym.GymTotalTest" time="0.0">
    <skipped />
  </testcase>
</testsuite>`;
  const cases = parseJUnitCases(xml);

  it("parses each testcase's result, time and failure message", () => {
    expect(cases.map((c) => [c.name, c.result])).toEqual([
      ["passes", "passed"],
      ["fails", "failed"],
      ["skips", "skipped"],
    ]);
    expect(cases[0]!.durationMs).toBe(2500);
    expect(cases[1]!.message).toBe("java.lang.AssertionError: nope & more");
  });

  it("selects by class or class#method", () => {
    expect(casesForHarness("com.flagshipserver.app.gym.GymTotalTest", cases)).toHaveLength(3);
    expect(casesForHarness("com.flagshipserver.app.gym.GymTotalTest#fails", cases)).toHaveLength(1);
    expect(casesForHarness("com.flagshipserver.app.gym.Other", cases)).toHaveLength(0);
  });
});
