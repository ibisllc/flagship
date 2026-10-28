// Debug: uninstall and reinstall the whoami app on a kept demo box, to see the daemon's own error.
//   GYM_DEMO_IRK_KEK=… GYM_ADMIN_SECRET=… npx tsx tools/live-e2e/reinstall-probe.ts <demo-user>
import { bytesToHex } from "@noble/hashes/utils";
import { signInstallService, signUninstallService, type InstallServiceRequest, type UninstallServiceRequest } from "@flagship/protocol";
import { Account } from "./lib/fleet.js";
import { http, postJson, short, SERVICES } from "./lib/harness.js";
import { whoamiManifest } from "./groups/core.js";

const user = process.argv[2]!;
const A = new Account(user);
const fqdn = `home.${user}.${SERVICES}`;
const slug = "corewho";
const serviceId = `${user}--${slug}`;
const un: UninstallServiceRequest = { serverId: fqdn, creator: user, slug, issuedAt: Date.now() };
const d = await http(`https://${fqdn}/api/services/${encodeURIComponent(serviceId)}`, {
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ request: un, signature: bytesToHex(signUninstallService(un, A.keys.adminRoot)) }),
}, 90_000);
console.log("uninstall", d.status, short(d.text));
const req: InstallServiceRequest = { serverId: fqdn, creator: user, slug, manifestJson: whoamiManifest(slug), addOwnerToMembership: true, issuedAt: Date.now() };
const r = await postJson(`https://${fqdn}/api/services`, { request: req, signature: bytesToHex(signInstallService(req, A.keys.irk)) }, {}, 120_000);
console.log("install", r.status, short(r.text, 300));
