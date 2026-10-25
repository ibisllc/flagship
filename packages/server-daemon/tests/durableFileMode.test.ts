import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileDurable } from "../src/durableFile.js";

describe("writeFileDurable modes", () => {
  let dir = "";
  let saved = 0;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "durable-mode-"));
    saved = process.umask(0o077);
  });
  afterEach(async () => {
    process.umask(saved);
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the exact mode asked for under the daemon's 0077 umask", async () => {
    const launcher = join(dir, "flagship-rust-exec");
    await writeFileDurable(launcher, "#!/bin/bash\n", 0o755);
    expect((await stat(launcher)).mode & 0o777).toBe(0o755);
    const unit = join(dir, "flagship-core.service");
    await writeFileDurable(unit, "[Unit]\n", 0o644);
    expect((await stat(unit)).mode & 0o777).toBe(0o644);
    const secret = join(dir, "state.json");
    await writeFileDurable(secret, "{}");
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
  });
});
