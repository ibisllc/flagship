// The TypeScript relay (apps/web `start()`) in its own process for scripts/bench/relay.ts, so its CPU and memory are
// measured apart from the load generator. Plain Node on the compiled apps/web/dist/server.js, as the Fly image runs
// it (no tsx loader in the process): run `npx tsc -b` first. The parent reads "tunnel hub:" once it listens.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../../apps/web/dist/server.js");
if (!existsSync(dist)) {
  console.error("no apps/web/dist/server.js: run `npx tsc -b` first");
  process.exit(2);
}
const { start } = await import(dist);
const n = (k) => Number(process.env[k]);
await start({ httpPort: n("PORT"), tunnelTcpPort: n("TUNNEL_TCP_PORT"), relayEchoPort: n("RELAY_ECHO_PORT"), host: "127.0.0.1" });
console.log(`tunnel hub: ts pid ${process.pid}`);
process.on("SIGTERM", () => process.exit(0));
