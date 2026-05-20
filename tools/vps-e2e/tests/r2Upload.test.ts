import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  R2Uploader,
  makeObjectKey,
  parsePresignedUrl,
  putArgs,
  presignArgs,
  deleteArgs,
  rand6,
} from "../src/r2Upload.js";

/**
 * A trivial fake `spawn` that exposes stdout/stderr emitters + exits
 * deterministically. Lets us assert the exact argv we forward to
 * `npx wrangler r2 …` without ever shelling out for real.
 */
function fakeSpawn(scripts: Array<{
  match: (cmd: string, args: readonly string[]) => boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}>): {
  spawnFn: (cmd: string, args: readonly string[]) => unknown;
  calls: Array<{ cmd: string; args: readonly string[] }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const spawnFn = (cmd: string, args: readonly string[]): unknown => {
    calls.push({ cmd, args });
    const ee = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    const match = scripts.find((s) => s.match(cmd, args));
    setImmediate(() => {
      if (match?.stdout) {
        ee.stdout.emit("data", Buffer.from(match.stdout, "utf8"));
      }
      if (match?.stderr) {
        ee.stderr.emit("data", Buffer.from(match.stderr, "utf8"));
      }
      ee.emit("exit", match?.exitCode ?? 0);
    });
    return ee;
  };
  return { spawnFn: spawnFn as never, calls };
}

describe("makeObjectKey + rand6", () => {
  it("formats as e2e-runs/<unix-ms>-<rand>.iso", () => {
    expect(makeObjectKey(1_700_000_000_000, () => "abc123")).toBe(
      "e2e-runs/1700000000000-abc123.iso",
    );
  });
  it("rand6 returns 6 url-safe chars", () => {
    const a = rand6();
    expect(a).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe("CLI builders", () => {
  it("putArgs starts with `wrangler r2 object put`", () => {
    expect(putArgs("bkt", "k", "/tmp/x.iso")).toEqual([
      "wrangler",
      "r2",
      "object",
      "put",
      "bkt/k",
      "--file",
      "/tmp/x.iso",
      "--remote",
    ]);
  });
  it("presignArgs encodes TTL in seconds", () => {
    expect(presignArgs("bkt", "k", 3600)).toEqual([
      "wrangler",
      "r2",
      "object",
      "presign",
      "bkt/k",
      "--ttl",
      "3600",
    ]);
  });
  it("deleteArgs is the same key shape", () => {
    expect(deleteArgs("bkt", "k")).toEqual([
      "wrangler",
      "r2",
      "object",
      "delete",
      "bkt/k",
      "--remote",
    ]);
  });
});

describe("parsePresignedUrl", () => {
  it("picks the first https URL out of wrangler's chatty output", () => {
    const out =
      `signing url for bkt/key…\n` +
      `presigned URL: https://r2.cloudflarestorage.com/bkt/key?X-Amz-...=abc\n` +
      `expires in 3600s\n`;
    expect(parsePresignedUrl(out)).toMatch(
      /^https:\/\/r2\.cloudflarestorage\.com\/bkt\/key\?X-Amz-/,
    );
  });
  it("throws when no URL present", () => {
    expect(() => parsePresignedUrl("no url here")).toThrow(/no URL/);
  });
});

describe("R2Uploader", () => {
  it("upload runs put + presign and returns the parsed URL", async () => {
    const { spawnFn, calls } = fakeSpawn([
      {
        match: (_c, a) => a.includes("put"),
        stdout: "uploaded ok",
        exitCode: 0,
      },
      {
        match: (_c, a) => a.includes("presign"),
        stdout: "presigned URL: https://r2.example/bkt/k?sig=xyz",
        exitCode: 0,
      },
    ]);
    const up = new R2Uploader({
      bucket: "bkt",
      spawnFn: spawnFn as never,
      presignTtlSeconds: 60,
    });
    const r = await up.upload("/tmp/x.iso", "e2e-runs/foo.iso");
    expect(r.bucket).toBe("bkt");
    expect(r.key).toBe("e2e-runs/foo.iso");
    expect(r.presignedUrl).toBe("https://r2.example/bkt/k?sig=xyz");
    // Default `npx` binary path; forwards full `wrangler …` vector.
    expect(calls[0]?.args[0]).toBe("wrangler");
    expect(calls[1]?.args.includes("presign")).toBe(true);
    expect(calls[1]?.args.includes("60")).toBe(true);
  });

  it("upload throws when wrangler put exits non-zero", async () => {
    const { spawnFn } = fakeSpawn([
      { match: () => true, stderr: "401 unauthorized", exitCode: 1 },
    ]);
    const up = new R2Uploader({ bucket: "bkt", spawnFn: spawnFn as never });
    await expect(up.upload("/tmp/x.iso", "k")).rejects.toThrow(
      /wrangler r2 object put failed/,
    );
  });

  it("delete runs the wrangler delete CLI", async () => {
    const { spawnFn, calls } = fakeSpawn([
      { match: () => true, exitCode: 0 },
    ]);
    const up = new R2Uploader({ bucket: "bkt", spawnFn: spawnFn as never });
    await up.delete("e2e-runs/foo.iso");
    expect(calls[0]?.args.includes("delete")).toBe(true);
    expect(calls[0]?.args.includes("bkt/e2e-runs/foo.iso")).toBe(true);
  });
});
