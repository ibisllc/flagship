import { describe, expect, it } from "vitest";
import {
  inferenceEndpointHost,
  parseBlessedInferenceEndpoint,
} from "../src/inferenceEndpoint.js";

const good = JSON.stringify({
  baseUrl: "https://coder.runpod.example.com",
  model: "flagship-coder-v1",
});

describe("parseBlessedInferenceEndpoint", () => {
  it("parses a well-formed config", () => {
    const ep = parseBlessedInferenceEndpoint(good);
    expect(ep).toEqual({ baseUrl: "https://coder.runpod.example.com", model: "flagship-coder-v1" });
    expect(inferenceEndpointHost(ep!)).toBe("coder.runpod.example.com");
  });

  it("returns null (never throws) for unset / unparseable / shape-invalid", () => {
    expect(parseBlessedInferenceEndpoint(undefined)).toBeNull();
    expect(parseBlessedInferenceEndpoint("")).toBeNull();
    expect(parseBlessedInferenceEndpoint("{not json")).toBeNull();
    expect(parseBlessedInferenceEndpoint("[]")).toBeNull();
    expect(parseBlessedInferenceEndpoint(JSON.stringify({ baseUrl: "https://x" }))).toBeNull();
    expect(parseBlessedInferenceEndpoint(JSON.stringify({ model: "m" }))).toBeNull();
    expect(parseBlessedInferenceEndpoint(JSON.stringify({ baseUrl: "", model: "m" }))).toBeNull();
  });

  it("rejects a non-https baseUrl (the box would reject it under the strict guard anyway)", () => {
    expect(
      parseBlessedInferenceEndpoint(JSON.stringify({ baseUrl: "http://coder.example.com", model: "m" })),
    ).toBeNull();
    expect(
      parseBlessedInferenceEndpoint(JSON.stringify({ baseUrl: "not-a-url", model: "m" })),
    ).toBeNull();
  });
});
