// Syncing an imported app with its upstream (N12, 0.3): import a Flagship-ready repo at one ref, deploy it,
// then ask for a sync with a later ref: the box answers with a three-way proposal (what upstream changed,
// conflicts, capability changes) and a NEW build holding the merge, which is not live until the owner
// deploys it; the app's page names the repo it came from, and a sync at the version it runs is "up to
// date" without opening a build. Needs a public fixture repo that is Flagship-ready at both refs (no AI): set GYM_SYNC_REPO
// (and GYM_SYNC_BASE_REF / GYM_SYNC_NEXT_REF, default v1 / v2); without it the group is skipped.
import { pair } from "../../lib/fleet.js";
import { assert, http, postJson, short } from "../../lib/harness.js";
import type { Group } from "../types.js";
import { uninstall, until } from "./util.js";

const REPO = process.env.GYM_SYNC_REPO || "";
const BASE = process.env.GYM_SYNC_BASE_REF || "v1";
const NEXT = process.env.GYM_SYNC_NEXT_REF || "v2";

export const upstreamSync: Group = {
  name: "upstream-sync",
  title: "an imported app syncs with one upstream version: a proposal and a merge build that is not live",
  needs: ["A1"],
  phase: 2,
  async run({ A, rec, box }) {
    if (!REPO) {
      rec.skip("import, deploy, sync", "GYM_SYNC_REPO is not set (a public Flagship-ready repo with two refs)");
      return;
    }
    const b = box("A1");
    const s = { "x-flagship-session": await pair(A, b) };
    let buildId = "";
    let serviceId = "";
    const live = await rec.check(`import ${REPO} at ${BASE} (Flagship-ready, no AI) and deploy it`, async () => {
      const c = await postJson(`https://${b.fqdn}/api/build/git`, { gitUrl: REPO, ref: BASE, name: "gymsync" }, s, 120_000);
      assert(c.status === 200 && c.json?.fit === true, `import ${c.status}: ${short(c.text)}`);
      buildId = c.json.buildId;
      const d = await postJson(`https://${b.fqdn}/api/build/sessions/${buildId}/deploy`, {}, s, 900_000);
      assert(d.status === 200 && d.json?.serviceId, `deploy ${d.status}: ${short(d.text)}`);
      serviceId = d.json.serviceId;
      return serviceId;
    });
    if (!live) return;
    await rec.check(`a sync with ${NEXT} returns a proposal and a build that is not live`, async () => {
      const r = await until("the sync proposal", 3 * 60_000, async () => {
        const x = await postJson(`https://${b.fqdn}/api/build/apps/${encodeURIComponent(serviceId)}/sync`, { ref: NEXT }, s, 120_000);
        // The import record is written just after the app goes live.
        if (x.status === 404) return undefined;
        return x;
      }, 10_000);
      assert(r.status === 200 && r.json?.ok === true, `sync ${r.status}: ${short(r.text)}`);
      const p = r.json.proposal;
      assert(Array.isArray(p?.takeUpstream) && Array.isArray(p?.conflicts) && Array.isArray(p?.capabilityChanges), `proposal ${short(p)}`);
      assert(r.json.upToDate === false, "the next ref reads as up to date");
      const st = await http(`https://${b.fqdn}/api/build/sessions/${r.json.buildId}`, { headers: s });
      assert(st.status === 200 && !st.json?.state?.deployedUrl && st.json?.state?.editsServiceId === serviceId, `merge build ${short(st.json?.state)}`);
      return `${p.takeUpstream.length} from upstream, ${p.conflicts.length} conflicts, ${p.capabilityChanges.length} capability changes`;
    });
    await rec.check("the app's page carries where it was imported from, so it offers the update check", async () => {
      const d = await until("the import record on the app page", 2 * 60_000, async () => {
        const x = await http(`https://${b.fqdn}/api/screens/app-detail/${encodeURIComponent(serviceId)}`, { headers: s });
        return x.json?.importedFrom?.repo ? x : undefined;
      });
      assert(String(d.json.importedFrom.repo).includes(REPO.replace(/^https?:\/\//, "").replace(/\.git$/, "")), `importedFrom ${short(d.json.importedFrom)}`);
      return short(d.json.importedFrom);
    });
    await rec.check(`a sync with ${BASE}, the version it runs, is up to date and opens no build`, async () => {
      const r = await postJson(`https://${b.fqdn}/api/build/apps/${encodeURIComponent(serviceId)}/sync`, { ref: BASE }, s, 120_000);
      assert(r.status === 200 && r.json?.upToDate === true, `sync ${r.status}: ${short(r.text)}`);
      assert(r.json.buildId === undefined, `an up-to-date check opened build ${r.json.buildId}`);
      return "up to date, no build";
    });
    await rec.check("a ref that is not a branch, tag or commit is refused", async () => {
      const r = await postJson(`https://${b.fqdn}/api/build/apps/${encodeURIComponent(serviceId)}/sync`, { ref: "../../etc" }, s);
      assert(r.status === 400, `got ${r.status}`);
      return "400";
    });
    await uninstall(A, b, serviceId.split("--")[1] ?? "gymsync");
  },
};
