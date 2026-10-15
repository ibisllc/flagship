import { describe, expect, it } from "vitest";
import { MAX_OWNER_ANSWERS, ownerAnswer } from "../src/ownerScript.js";
import { loadScenarios, parseScenario, selectScenarios } from "../src/scenarios.js";
import { parseOptions } from "../src/options.js";

describe("scenario files", () => {
  const all = loadScenarios();

  it("has about ten apps, small to large, each with 1-3 edits", () => {
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(new Set(all.map((s) => s.size))).toEqual(new Set(["small", "medium", "large"]));
    for (const s of all) {
      expect(s.edits.length, s.id).toBeGreaterThanOrEqual(1);
      expect(s.edits.length, s.id).toBeLessThanOrEqual(3);
    }
    expect(all.some((s) => s.owner.envVars === "set")).toBe(true);
    expect(all.some((s) => s.mock.kind === "python")).toBe(true);
  });

  it("picks scenarios smallest first and refuses unknown ids", () => {
    const picked = selectScenarios(all, []);
    const order = { small: 0, medium: 1, large: 2 } as const;
    for (let i = 1; i < picked.length; i++) expect(order[picked[i - 1]!.size]).toBeLessThanOrEqual(order[picked[i]!.size]);
    expect(selectScenarios(all, ["todo-list"]).map((s) => s.id)).toEqual(["todo-list"]);
    expect(() => selectScenarios(all, ["nope"])).toThrow(/unknown scenario/);
  });

  it("rejects malformed data", () => {
    const ok = { id: "x", size: "small", title: "t", prompt: "p", edits: ["e"], mock: { kind: "node" } };
    expect(parseScenario(ok).owner.fallback).toMatch(/go ahead/);
    expect(() => parseScenario({ ...ok, size: "huge" })).toThrow(/size/);
    expect(() => parseScenario({ ...ok, edits: ["a", "b", "c", "d"] })).toThrow(/at most 3/);
    expect(() => parseScenario({ ...ok, mock: { kind: "rust" } })).toThrow(/mock.kind/);
    expect(() => parseScenario({ ...ok, owner: { envVars: "maybe" } })).toThrow(/envVars/);
  });
});

describe("scripted owner answers", () => {
  const sc = parseScenario({
    id: "x",
    size: "small",
    title: "t",
    prompt: "p",
    edits: ["e"],
    owner: { answers: ["first", "second"], fallback: "go on", envVars: "set" },
    mock: { kind: "node" },
  });
  const talk = (id: string) => ({ kind: "talkToUser" as const, toolUseId: id, input: { message: "?" } });

  it("answers questions in order, then with the fallback", () => {
    expect(ownerAnswer(sc, talk("a"), 0)).toEqual({ kind: "reply", toolUseId: "a", text: "first" });
    expect(ownerAnswer(sc, talk("b"), 1)).toEqual({ kind: "reply", toolUseId: "b", text: "second" });
    expect(ownerAnswer(sc, talk("c"), 2)).toEqual({ kind: "reply", toolUseId: "c", text: "go on" });
  });

  it("answers an env-var request with the scenario's policy and never a value", () => {
    const a = ownerAnswer(sc, { kind: "requestEnvVar", toolUseId: "e", input: { name: "API_KEY", why: "x" } }, 0);
    expect(a).toEqual({ kind: "env", toolUseId: "e", name: "API_KEY", status: "set" });
    expect(Object.keys(a)).not.toContain("value");
    const declined = parseScenario({ ...sc, owner: { envVars: "declined" } });
    expect(ownerAnswer(declined, { kind: "requestEnvVar", toolUseId: "e", input: { name: "K" } }, 0)).toMatchObject({ status: "declined" });
  });

  it("caps how many answers a step gets", () => {
    expect(MAX_OWNER_ANSWERS).toBeGreaterThanOrEqual(3);
  });
});

describe("options", () => {
  it("parses the documented flags", () => {
    const o = parseOptions(["--models", "low,high", "--scenarios=todo-list", "--repeat", "3", "--concurrency", "2", "--max-usd", "1.5", "--mock", "--stage", "static"]);
    expect(o).toMatchObject({ models: ["low", "high"], scenarios: ["todo-list"], repeat: 3, concurrency: 2, maxUsd: 1.5, mock: true, stage: "static" });
    expect(parseOptions([]).maxUsd).toBe(5);
    expect(parseOptions([]).concurrency).toBe(1);
  });

  it("refuses unknown models, flags and bad numbers", () => {
    expect(() => parseOptions(["--models", "gpt"])).toThrow(/unknown model/);
    expect(() => parseOptions(["--frobnicate"])).toThrow(/unknown option/);
    expect(() => parseOptions(["--max-usd", "-1"])).toThrow(/positive/);
    expect(() => parseOptions(["--repeat", "0"])).toThrow(/at least 1/);
  });
});
