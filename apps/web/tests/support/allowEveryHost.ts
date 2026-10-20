import type { HostPolicy } from "../../src/tunnel/outboundHostPolicy.js";

/** Tests dial made-up provider names; the real default allows only the known providers. */
export const allowEveryHost: HostPolicy = { allowed: async () => true, report: async () => {} };
