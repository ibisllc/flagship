// AI01/AI02 local AI on the CPU (docs/architecture-v2/local-ai.md).
//
// `local-ai-cpu`: on a throwaway UpCloud Debian 13 VM with Docker and the pinned gVisor, the EXACT
// container shapes the daemon builds (localAi/containers.ts, training.ts) run the pinned llama.cpp
// images for real: the test model is fetched by revision and checked against its pinned SHA-256,
// installed by privd's own script, served under gVisor as uid 10001 behind its key, answers a chat
// completion, and is fine-tuned for two epochs (the second from the first's checkpoint) on sample
// text. No Flagship account is involved; nothing here names an owner.
//
// `local-ai`: on a real box (A1, no GPU) through the owner API: the download, the model server on
// CPU, "On this server" in the model menu and a build chat on it (no provider, no relay), the app
// SDK grant signed by the owner (a stranger's refused), and a signed training order honestly
// failing on an app with no staged sample data.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils";
import { ed, signLocalAiAppGrant, signLocalAiTrainOrder } from "@flagship/protocol";
import { LOCAL_AI_INSTALL_SCRIPT } from "@flagship/privd";
import { GVISOR_RELEASE, GVISOR_SHA512, gvisorSources } from "../../../../packages/server-daemon/src/appSandbox/gvisor.js";
import { LOCAL_AI_IMAGES, localModel, modelDownloadUrl, modelFileName } from "../../../../packages/server-daemon/src/localAi/catalog.js";
import { serviceRunArgs, trainRunArgs } from "../../../../packages/server-daemon/src/localAi/containers.js";
import { datasetScript, finetuneCommand, hashCommand } from "../../../../packages/server-daemon/src/localAi/training.js";
import { pair } from "../../lib/fleet.js";
import { assert, http, postJson, short } from "../../lib/harness.js";
import { createDebianVm, destroyVm, ssh, type Vm } from "../../lib/upcloudVm.js";
import type { Group } from "../types.js";
import { uninstall, until } from "./util.js";
import { baseManifest, signedInstall } from "./runtimeShared.js";

/** One shell word. */
const q = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
const sh = (argv: string[]) => argv.map(q).join(" ");

const SAMPLE = Array.from({ length: 40 }, (_, i) => `Once upon a time a small robot counted ${i} stars and went to sleep happy.`).join("\n");

export const localAiCpu: Group = {
  name: "local-ai-cpu",
  title: "local AI: the pinned llama.cpp images serve and fine-tune on the CPU under gVisor",
  needs: [],
  phase: 1,
  async run(ctx) {
    const { rec } = ctx;
    const dir = join(ctx.dir, "local-ai-cpu");
    const model = localModel("stories-260k")!;
    const hex = randomBytes(8).toString("hex");
    let vm: Vm | null = null;
    const run = async (box: Vm, cmd: string, ms = 600_000) => {
      const r = await ssh(box, cmd, ms);
      if (r.code !== 0) throw new Error(`${short(cmd, 120)} → ${r.code}: …${(r.stderr || r.stdout).slice(-700)}`);
      return r.stdout;
    };
    try {
      await rec.check("a throwaway Debian 13 VM is up", async () => {
        vm = await createDebianVm({ dir, title: `gym-local-ai-${Date.now().toString(36)}`, log: (s) => rec.log(s) });
        return vm.ip;
      });
      const box = vm as Vm | null;
      if (!box) return;
      const ready = await rec.check(`Docker with gVisor ${GVISOR_RELEASE} as runsc`, async () => {
        await run(
          box,
          [
            "set -e",
            "export DEBIAN_FRONTEND=noninteractive",
            "apt-get update -q >/dev/null",
            "apt-get install -y -q --no-install-recommends docker.io docker-cli curl ca-certificates jq zstd >/dev/null",
            // The bundle a box installs (appSandbox/gvisor.ts): Flagship's mirror, else upstream, checked
            // against the SHA-512 this release pins.
            `for u in ${gvisorSources("x86_64", ["https://flagshipserver.com/build/iso"]).map(q).join(" ")}; do curl -fsSL "$u" -o /tmp/gvisor.tar.zstd && break; done`,
            `echo ${q(`${GVISOR_SHA512.x86_64}  /tmp/gvisor.tar.zstd`)} | sha512sum -c --status -`,
            // runsc needs its sidecars (gvisor-bin/) beside it, as the box keeps the bundle.
            "mkdir -p /usr/local/lib/flagship-gvisor && tar --zstd -xf /tmp/gvisor.tar.zstd -C /usr/local/lib/flagship-gvisor",
            `echo '{"runtimes":{"runsc":{"path":"/usr/local/lib/flagship-gvisor/runsc"}}}' > /etc/docker/daemon.json`,
            "systemctl restart docker",
            "docker network create --opt com.docker.network.bridge.name=fs-staging flagship-staging >/dev/null",
          ].join("\n"),
          1_200_000,
        );
        return (await run(box, "docker info --format '{{json .Runtimes}}' | jq -r 'keys|join(\",\")'")).trim();
      });
      if (!ready) return;
      const fetched = await rec.check("the test model is fetched by revision and matches its pinned SHA-256 and size", async () => {
        const out = await run(box, `set -e; mkdir -p /var/flagship/data/local-ai/incoming; f=/var/flagship/data/local-ai/incoming/${modelFileName(model.sha256)}; curl -fsSL ${q(modelDownloadUrl(model))} -o "$f"; sha256sum "$f" | cut -d' ' -f1; stat -c %s "$f"`);
        const [sha, size] = out.trim().split("\n");
        assert(sha === model.sha256 && Number(size) === model.sizeBytes, `got ${sha} ${size}`);
        return `${sha!.slice(0, 16)}… ${size} bytes`;
      });
      if (!fetched) return;
      await rec.check("a wrong digest is refused by the install step (nothing lands in the volume)", async () => {
        const r = await ssh(box, `docker volume create flagship-models >/dev/null; d=$(docker volume inspect -f '{{.Mountpoint}}' flagship-models); mkdir -p /var/lib/flagship-privd/local-ai; cp /var/flagship/data/local-ai/incoming/${modelFileName(model.sha256)} /var/lib/flagship-privd/local-ai/x; sh -c ${q(LOCAL_AI_INSTALL_SCRIPT)} _ ${"0".repeat(64)} /var/lib/flagship-privd/local-ai/x "$d"; echo rc=$?; ls "$d"`);
        assert(/rc=[1-9]/.test(r.stdout) && !r.stdout.includes(".gguf"), short(r.stdout));
        return "refused";
      });
      const installed = await rec.check("privd's install script puts it in the models volume, root-owned, read-only", async () => {
        const out = await run(box, `set -e; d=$(docker volume inspect -f '{{.Mountpoint}}' flagship-models); s=/var/lib/flagship-privd/local-ai/${modelFileName(model.sha256)}; cp /var/flagship/data/local-ai/incoming/${modelFileName(model.sha256)} "$s"; sh -c ${q(LOCAL_AI_INSTALL_SCRIPT)} _ ${model.sha256} "$s" "$d"; stat -c '%U %a' "$d/${modelFileName(model.sha256)}"`);
        assert(out.trim() === "root 444", out);
        return out.trim();
      });
      if (!installed) return;
      const key = randomBytes(18).toString("base64url");
      const serve = serviceRunArgs({
        name: `flagship-localai-${hex}`,
        image: LOCAL_AI_IMAGES.serverCpu,
        modelSha256: model.sha256,
        hostPort: 41234,
        contextTokens: model.serveContextTokens,
        threads: 2,
        memoryMiB: 512,
        cpus: "2",
        apiKey: key,
        gpuArgs: [],
        sandboxArgs: ["--runtime=runsc"],
        networkArgs: ["--network", "flagship-staging"],
      });
      const up = await rec.check("the model server starts in the daemon's exact shape and becomes healthy", async () => {
        await run(box, `docker pull -q ${q(LOCAL_AI_IMAGES.serverCpu)} >/dev/null`, 1_200_000);
        await run(box, `docker ${sh(serve)} >/dev/null`, 1_200_000);
        await until("healthy", 5 * 60_000, async () => ((await ssh(box, `curl -fsS -H 'authorization: Bearer ${key}' http://127.0.0.1:41234/health`)).code === 0 ? true : undefined), 3_000);
        const info = (await run(box, `docker inspect -f '{{.HostConfig.Runtime}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}}' flagship-localai-${hex}`)).trim();
        assert(info === "runsc 10001:10001 true", info);
        return info;
      });
      if (up) {
        await rec.check("it answers an OpenAI chat completion, with its measured speed", async () => {
          const body = JSON.stringify({ model: "stories-260k", messages: [{ role: "user", content: "Once upon a time" }], max_tokens: 24, cache_prompt: false });
          const out = await run(box, `curl -fsS -H 'authorization: Bearer ${key}' -H 'content-type: application/json' --data ${q(body)} http://127.0.0.1:41234/v1/chat/completions`);
          const j = JSON.parse(out) as { choices?: { message?: { content?: string } }[]; timings?: { predicted_per_second?: number } };
          assert((j.choices?.[0]?.message?.content ?? "").length > 0, short(out));
          return `${short(j.choices![0]!.message!.content, 40)} · ${Math.round(j.timings?.predicted_per_second ?? 0)} tok/s`;
        });
        await rec.check("without its key the server answers 401", async () => {
          const r = await ssh(box, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:41234/v1/models");
          assert(r.stdout.trim() === "401", r.stdout);
          return "401";
        });
        await rec.check("it is published on loopback only", async () => {
          const r = await ssh(box, `docker port flagship-localai-${hex}`);
          assert(/^8080\/tcp -> 127\.0\.0\.1:41234\s*$/.test(r.stdout.trim()), r.stdout);
          return r.stdout.trim();
        });
        await ssh(box, `docker rm -f flagship-localai-${hex} >/dev/null`);
      }
      // Fine-tuning: the same steps as training.ts, two epochs, the second from the first's checkpoint.
      const base = { hex, image: LOCAL_AI_IMAGES.trainCpu, gpuArgs: [], sandboxArgs: ["--runtime=runsc"], networkArgs: ["--network", "flagship-staging"], memoryMiB: 1024, cpus: "2" };
      const prepared = await rec.check("the sample text goes into the job's own volume (handed to uid 10001); its digest is read back", async () => {
        await run(box, `docker pull -q ${q(LOCAL_AI_IMAGES.trainCpu)} >/dev/null`, 1_800_000);
        await run(box, `set -e; docker volume create flagship-aitrain-${hex} >/dev/null; chown 10001:10001 -- "$(docker volume inspect -f '{{.Mountpoint}}' flagship-aitrain-${hex})"`);
        const args = trainRunArgs({ ...base, entrypoint: "sh", command: ["-c", datasetScript("text")], interactive: true });
        const out = await run(box, `printf %s ${q(SAMPLE)} | docker ${sh(args)}`, 1_200_000);
        const digest = /^([0-9a-f]{64})\s/m.exec(out)?.[1];
        assert(digest === createHash("sha256").update(SAMPLE).digest("hex"), short(out));
        return `${digest!.slice(0, 16)}…`;
      });
      if (!prepared) return;
      const sums: string[] = [];
      for (const epoch of [1, 2]) {
        const ok = await rec.check(`epoch ${epoch} of llama-finetune runs under gVisor and writes a checkpoint`, async () => {
          const input = epoch === 1 ? `/models/${modelFileName(model.sha256)}` : `/out/ckpt-${epoch - 1}.gguf`;
          const args = trainRunArgs({ ...base, entrypoint: "/app/llama-finetune", command: finetuneCommand({ input, epoch, ctx: 64, threads: 2, gpu: false }) });
          const r = await ssh(box, `docker ${sh(args)} 2>&1 | tail -n 5`, 1_800_000);
          assert(r.code === 0, short(r.stdout + r.stderr, 600));
          const h = await run(box, `docker ${sh(trainRunArgs({ ...base, entrypoint: "sh", command: hashCommand(epoch) }))}`);
          const sha = /^([0-9a-f]{64})\s/m.exec(h)?.[1];
          assert(sha, short(h));
          sums.push(sha);
          return `${sha.slice(0, 16)}… ${short(r.stdout.split("\n").filter(Boolean).pop() ?? "", 60)}`;
        });
        if (!ok) return;
      }
      await rec.check("the second epoch changed the weights (two different checkpoints)", async () => {
        assert(sums.length === 2 && sums[0] !== sums[1], sums.join(" "));
        return "different";
      });
    } finally {
      const box = vm as Vm | null;
      if (box) await destroyVm(box, (s) => rec.log(s));
    }
  },
};

type Json = Record<string, any>;

export const localAi: Group = {
  name: "local-ai",
  title: "local AI on a box: download, the CPU model server, On this server, app grants, training orders",
  needs: ["A1"],
  phase: 2,
  async run({ A, rec, box }) {
    const b = box("A1");
    const s = { "x-flagship-session": await pair(A, b) };
    const base = `https://${b.fqdn}/api/screens/local-ai`;
    const view = async (): Promise<Json> => {
      const r = await http(base, { headers: s });
      assert(r.status === 200, `local-ai ${r.status}: ${short(r.text)}`);
      return r.json as Json;
    };
    const post = (path: string, body: unknown, ms = 60_000) => postJson(`${base}${path}`, body, s, ms);

    const first = await rec.check("the screen says what is true here: available, no cost, this server only", async () => {
      const v = await view();
      assert(v.available === true && v.cost === "none" && v.privacy === "this-server", short(v));
      return `${v.hardware.cpus} CPUs, ${v.hardware.gpus.length} GPUs, ${v.models.length} models`;
    });
    if (!first) return;
    await rec.check("a model id that isn't in the pinned catalog is refused", async () => {
      const r = await post("/models/download", { modelId: "../../etc/passwd" });
      assert(r.status === 404, `${r.status}: ${short(r.text)}`);
      return "404";
    });
    const got = await rec.check("the owner downloads the test model: checked against its pinned digest", async () => {
      const r = await post("/models/download", { modelId: "stories-260k" });
      assert(r.status === 202 || r.json?.code === "already-installed", `${r.status}: ${short(r.text)}`);
      await until("installed", 5 * 60_000, async () => ((await view()).models.find((m: Json) => m.id === "stories-260k")?.state === "installed" ? true : undefined));
      return "installed";
    });
    if (!got) return;
    const serving = await rec.check("the model server starts on this server's CPU", async () => {
      const r = await post("/service/start", { modelId: "stories-260k" }, 10 * 60_000);
      assert(r.status === 200 && r.json?.service?.state === "running" && r.json.service.device === "cpu", `${r.status}: ${short(r.text)}`);
      const m = await until("measured", 60_000, async () => {
        const row = (await view()).models.find((x: Json) => x.id === "stories-260k");
        return row?.speed?.measured ? row : undefined;
      });
      return `${m.speed.tokensPerSecond} tok/s measured`;
    });
    if (serving) {
      await rec.check('the build menu offers it "On this server"', async () => {
        const r = await postJson(`https://${b.fqdn}/api/screens/ai/models`, { credential: { provider: "flagship-local", apiKey: "local" } }, s);
        assert(r.status === 200 && (r.json?.models ?? []).some((m: Json) => m.id === "stories-260k"), `${r.status}: ${short(r.text)}`);
        return (r.json.models as Json[]).map((m) => m.id).join(",");
      });
      await rec.check("a build chat runs on the local model: no provider, no relay, no cost consent", async () => {
        const r = await postJson(`https://${b.fqdn}/api/screens/vibe-code/start`, { prompt: "Once upon a time", name: `localai${Date.now().toString(36).slice(-5)}`, model: "stories-260k", credential: { provider: "flagship-local", apiKey: "local" } }, s, 60_000);
        assert(r.status === 200 && r.json?.sessionId && !r.json?.needsCredential, `${r.status}: ${short(r.text)}`);
        const id = r.json.sessionId as string;
        const st = await until("an answer", 3 * 60_000, async () => {
          const g = await http(`https://${b.fqdn}/api/screens/vibe-code/${encodeURIComponent(id)}`, { headers: s });
          const turns = (g.json?.transcript ?? []) as Json[];
          return turns.some((t) => t.role === "assistant" && String(t.content).length > 0) || g.json?.status === "failed" ? g.json : undefined;
        });
        assert(!/isn't available|can't run a local model|No model is downloaded/.test(String(st.failureReason ?? "")), short(st.failureReason));
        await postJson(`https://${b.fqdn}/api/screens/vibe-code/${encodeURIComponent(id)}/cancel`, {}, s).catch(() => null);
        return `status ${st.status}`;
      });
    }

    const slug = "localaiprobe";
    const sid = `${A.username}--${slug}`;
    const app = await rec.check("an app that declares localAi installs and is listed for a grant", async () => {
      const r = await signedInstall(A, b, slug, { ...baseManifest(slug), runtime: { image: "docker.io/traefik/whoami:v1.10", port: 80 }, localAi: { inference: true } });
      assert(r.status === 200, `install ${r.status}: ${short(r.text, 300)}`);
      const v = await view();
      assert(v.apps.some((a: Json) => a.serviceId === sid && a.grant === null), short(v.apps));
      return sid;
    });
    if (app) {
      const grant = (requests: number, tokens: number, max: number) => ({ serverDomain: b.fqdn, serviceId: sid, requestsPerDay: requests, tokensPerDay: tokens, maxTokensPerRequest: max, issuedAt: Date.now() });
      await rec.check("a grant signed by someone else is refused", async () => {
        const g = grant(10, 1000, 64);
        const r = await post("/apps/grant", { order: g, signature: bytesToHex(signLocalAiAppGrant(g, (m) => ed.sign(m, new Uint8Array(32).fill(7)))) });
        assert(r.status === 403, `${r.status}: ${short(r.text)}`);
        return "403";
      });
      await rec.check("the owner's signed grant applies, with its quotas", async () => {
        const g = grant(500, 200_000, 1024);
        const r = await post("/apps/grant", { order: g, signature: bytesToHex(signLocalAiAppGrant(g, (m) => ed.sign(m, A.keys.adminRoot.privateKey))) });
        assert(r.status === 200 && r.json?.grant?.requestsPerDay === 500, `${r.status}: ${short(r.text)}`);
        return "500/day";
      });
      await rec.check("the owner withdraws it", async () => {
        await new Promise((r) => setTimeout(r, 5));
        const g = grant(0, 0, 0);
        const r = await post("/apps/grant", { order: g, signature: bytesToHex(signLocalAiAppGrant(g, (m) => ed.sign(m, A.keys.adminRoot.privateKey))) });
        assert(r.status === 200 && r.json?.grant === null, `${r.status}: ${short(r.text)}`);
        return "withdrawn";
      });
      await rec.check("a signed training order for an app with no staged sample data fails with the reason", async () => {
        const o = { serverDomain: b.fqdn, serviceId: sid, jobId: randomBytes(8).toString("hex"), baseModel: "stories-260k", epochs: 1, issuedAt: Date.now() };
        const padded = await post("/train", { order: { ...o, dataset: "flagship-devfiles-someone--else" }, signature: "00".repeat(64) });
        assert(padded.status === 400, `padded order ${padded.status}`);
        const r = await post("/train", { order: o, signature: bytesToHex(signLocalAiTrainOrder(o, (m) => ed.sign(m, A.keys.adminRoot.privateKey))) });
        assert(r.status === 202, `${r.status}: ${short(r.text)}`);
        const job = await until("the job to end", 3 * 60_000, async () => {
          const j = await http(`${base}/jobs/${o.jobId}`, { headers: s });
          return ["failed", "completed", "cancelled"].includes(j.json?.job?.state) ? j.json.job : undefined;
        });
        assert(job.state === "failed" && /sample data/.test(job.reason ?? ""), short(job));
        await post("/jobs/delete", { jobId: o.jobId });
        return short(job.reason, 80);
      });
      await uninstall(A, b, slug).catch(() => {});
    }
    await post("/service/stop", {}).catch(() => null);
    await rec.check("the owner deletes the model", async () => {
      const r = await post("/models/delete", { modelId: "stories-260k" });
      // The harness sends a slow call again; if the box finished the first one, the second finds nothing to delete: gone is gone.
      assert(r.status === 200 || (r.status === 404 && /isn't on this server/.test(r.text)), `${r.status}: ${short(r.text)}`);
      return r.status === 200 ? "deleted" : "already gone";
    });
  },
};
