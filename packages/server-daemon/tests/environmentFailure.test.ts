import { describe, expect, it } from "vitest";
import {
  classifyEnvironmentFailure,
  classifyProvisioningError,
  environmentFailureForAgent,
} from "../src/buildmodes/environmentFailure.js";
import { UNFENCED_REASON } from "../src/buildmodes/staging.js";
import { DataLayerUnavailableError } from "../src/dataLayer/stack.js";

const kind = (r: string) => classifyEnvironmentFailure(r)?.kind ?? null;

describe("classifyEnvironmentFailure", () => {
  it("the server's failures", () => {
    expect(kind("data provisioning failed: connect ECONNREFUSED 127.0.0.1:5432")).toBe("data-layer");
    expect(kind('data provisioning failed: unsafe S3 name "dev.owner-stg-443ac182b4bc9fe5"')).toBe("data-layer");
    expect(kind("install rejected: data provisioning failed: connect ECONNREFUSED 127.0.0.1:5432")).toBe("data-layer");
    expect(kind("the app declares data stores, but this server has no data layer")).toBe("data-layer");
    expect(kind("migration 0001_init.sql failed: Connection terminated unexpectedly")).toBe("data-layer");
    expect(kind(UNFENCED_REASON)).toBe("fence");
    expect(kind("docker build failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")).toBe("docker");
    expect(kind("container deploy failed: spawn docker ENOENT")).toBe("docker");
    expect(kind("docker build failed: write /var/lib/docker/overlay2/x: no space left on device")).toBe("disk");
    expect(kind("failed to write source tree: ENOSPC: no space left on device, write")).toBe("disk");
    expect(kind("docker build failed: toomanyrequests: You have reached your pull rate limit.")).toBe("registry");
    expect(
      kind('docker build failed: Step 1/4 : FROM node:20\nGet "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout'),
    ).toBe("registry");
  });

  it("the app's failures stay the app's", () => {
    expect(kind("migration 0001_init.sql failed: syntax error at or near \"TABL\"")).toBeNull();
    expect(kind("the app didn't start: it stopped (exit code 1).")).toBeNull();
    expect(kind("flagship.app.json is invalid: runtime.port must be a number")).toBeNull();
    expect(kind("docker build failed: npm ERR! code E404 npm ERR! 404 Not Found - GET https://registry.npmjs.org/nope")).toBeNull();
    expect(kind("docker build failed: pull access denied for nosuchimage, repository does not exist")).toBeNull();
    expect(
      kind("docker build failed: curl: (6) Could not resolve host: example.com\nThe command '/bin/sh -c curl https://example.com/x' returned a non-zero code: 6"),
    ).toBeNull();
  });

  it("says when the database is still starting rather than down", () => {
    expect(classifyEnvironmentFailure("data provisioning failed: the data layer (Postgres) is still starting")!.ownerReason).toMatch(
      /still starting/,
    );
    expect(classifyProvisioningError(new DataLayerUnavailableError("starting")).ownerReason).toMatch(/still starting/);
    expect(classifyProvisioningError(new DataLayerUnavailableError("down")).ownerReason).toMatch(/isn't running/);
    expect(classifyProvisioningError(new Error("connect ECONNREFUSED")).kind).toBe("data-layer");
  });

  it("owner reasons are plain and carry nothing of the box; the agent is told to stop", () => {
    const f = classifyEnvironmentFailure("data provisioning failed: connect ECONNREFUSED 127.0.0.1:5432")!;
    expect(f.ownerReason).toBe(
      "This server's database isn't running, so apps that store data can't start yet. The server keeps trying to start it: try again in a few minutes, and restart the server if it still fails.",
    );
    const agent = environmentFailureForAgent(f);
    expect(agent).toMatch(/Don't change or delete any files/);
    expect(agent).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });
});
