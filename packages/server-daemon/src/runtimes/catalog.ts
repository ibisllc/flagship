/**
 * The runtimes every app builds on (docs/app-runtimes.md §4): public upstream
 * images pinned by their multi-arch index digest, so the endorsed release
 * names exactly which bytes a box may run apps on. A box pulls one the first
 * time an app needs it; docker refuses anything that doesn't match the digest.
 */

import type { RuntimeBase } from "@flagship/protocol";

export type RuntimeId = RuntimeBase;

export interface Runtime {
  id: RuntimeId;
  /** `<repo>:<tag>@sha256:<index digest>`. */
  image: string;
  /** uid:gid the app runs as. */
  user: string;
  /** The only port the app may listen on, when the runtime fixes it. */
  fixedPort?: number;
}

export const RUNTIMES: Readonly<Record<RuntimeId, Runtime>> = {
  "node-24": {
    id: "node-24",
    image: "docker.io/library/node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66",
    user: "10001:10001",
  },
  "python-3.13": {
    id: "python-3.13",
    image: "docker.io/library/python:3.13-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f",
    user: "10001:10001",
  },
  static: {
    id: "static",
    image: "docker.io/nginxinc/nginx-unprivileged:alpine@sha256:884e0b7f42f303641b0f4e78755aea647521dca0b89ca3be7992ad78b5c07434",
    // The image's own unprivileged nginx user.
    user: "101:101",
    fixedPort: 8080,
  },
};

export function runtimeById(id: unknown): Runtime | null {
  return typeof id === "string" && Object.hasOwn(RUNTIMES, id) ? RUNTIMES[id as RuntimeId] : null;
}
