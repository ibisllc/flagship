// org-read: the org read token live (docs/account-read-token.md "Org routes"; `.com` bdea6fef1, box 73df9f8cd). A
// throwaway org on the gym's `.com`, a stand-in org box registered under its own STK that reads the org through the
// daemon's own OrgReadToken (authority, seats, keys), a box token kept off the audit log, and the box refused once it
// has revoked itself. No UpCloud box: it is all `.com` (lib/orgReadFlow.ts; offline twin tests/orgRead.test.ts).
import { CONTROL, SERVICES } from "../lib/harness.js";
import { orgReadFlow } from "../lib/orgReadFlow.js";
import type { Group } from "./types.js";

export const orgRead: Group = {
  name: "org-read",
  title: "org read token: an org box mints box:<domain> with its STK, reads authority, seats and keys with it, never the audit log, and is refused once revoked",
  needs: [],
  phase: 1,
  async run({ rec }) {
    const flow = orgReadFlow({ control: `https://${CONTROL}`, servicesApex: SERVICES, log: (m) => rec.log(m) });
    if (!(await rec.check("a fresh org on .com (four admins, genesis approved by all)", () => flow.createOrg()))) return;
    if (!(await rec.check("an org admin approves a server code; the box registers with it under its STK", () => flow.registerBox()))) return;
    await rec.check("the box reads authority, seats and keys through the daemon's OrgReadToken, each GET with its STK-minted token", () => flow.boxReads());
    await rec.check("the box's token never reads the audit log; an org admin's seat token does", () => flow.auditScope());
    await rec.check("after the box revokes itself it gets no new token, and a token it holds no longer reads what needs one", () => flow.revokedBoxRefused());
  },
};
