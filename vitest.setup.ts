// Test-environment shims for Cloudflare Workers runtime globals that are
// absent under the `node` vitest environment. Routes that run in production on
// the Workers runtime may reference these; the shims let those code paths be
// exercised in unit tests without spinning up the full workerd runtime.
//
// `FixedLengthStream` is a length-bounded `TransformStream`. The production
// runtime enforces that exactly `length` bytes flow through; our routes set
// `length` from the same byte count the tests assert on, so a faithful
// passthrough is sufficient for unit tests (the test's own length assertions
// cover correctness).

class FixedLengthStreamShim {
  readable: ReadableStream;
  writable: WritableStream;
  constructor(_length: number | bigint) {
    const ts = new TransformStream();
    this.readable = ts.readable;
    this.writable = ts.writable;
  }
}

if (typeof (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream === "undefined") {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = FixedLengthStreamShim;
}
