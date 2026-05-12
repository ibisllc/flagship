/**
 * Minimal ambient declarations for the Cloudflare Workers runtime
 * surfaces we use. We deliberately avoid pulling in the full
 * `@cloudflare/workers-types` package — the Worker uses only a tiny
 * slice of the runtime API, and a hand-rolled subset keeps the build
 * dependency-free.
 */

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
