#!/usr/bin/env node
import { PrivdServer } from "./server.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const socketPath = arg("socket");
if (!socketPath) {
  console.error("usage: flagship-privd --socket <path> [--audit <file>] [--socket-group <group>] [--profile full|retail-claim]");
  process.exit(2);
}
const audit = arg("audit");
const socketGroup = arg("socket-group");
const profile = arg("profile") ?? "full";
if (profile !== "full" && profile !== "retail-claim") {
  console.error(`flagship-privd: unknown profile ${profile}`);
  process.exit(2);
}
const server = new PrivdServer({ socketPath, profile, ...(audit ? { auditPath: audit } : {}), ...(socketGroup ? { socketGroup } : {}) });
await server.start();
console.log(`[privd] listening on ${socketPath}`);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void server.stop().then(() => process.exit(0)));
