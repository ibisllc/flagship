# OpenAI Build Week submission — orchestration plan

**Hard deadline: 2026-07-21 17:00 PT** (Devpost). Mode: full quality, accept slip risk.
Video <3 min, public YouTube, audio, MUST show Codex/GPT-5.6 usage. Judging: tech
implementation (Codex use) · design · impact · idea quality.

## Ownership
- **Orchestrator (me):** all code + deploy, mirror repo, demo account via gym, asset
  capture (simulator / Mac app / website / vibecoding), AI voiceover, video assembly draft.
- **Harry (you):** manual Xcode archive→TestFlight upload, add judges to internal test
  group, final video review + YouTube upload, Devpost form submission.

## Tracks (status)
- [x] Repo hygiene + branch cleanup + disk (DONE, pushed)
- [x] P1 restricted-device key delivery — DoD blocker (MERGED)
- [x] P3 plaintext fixture cleanup (MERGED)
- [x] VM appliance shrink (MERGED)
- [x] gym rebase (PUSHED)
- [ ] P4 retail iOS build fix (RUNNING)
- [ ] P5 native Studio appliance discovery (QUEUED behind P4 — Xcode contention)
- [ ] P2 native UI tests (BLOCKED on P4)
- [x] Open the website (SITE_PUBLIC=1 kill-switch, deployed) — flagshipserver.com LIVE, coming-soon gone
- [ ] Mirror repo harrywinner2/flagship — squash to ONE commit (no history/dates)
- [ ] Point "link to code" → harrywinner2/flagship
- [ ] Demo account via GYM → live Hetzner box serving webapp
- [ ] Video: script → assets → voiceover → assemble
- [ ] TestFlight (Harry manual) + internal test group
- [ ] Devpost submission (Harry)

## Video beats (3 min)
1. Problem: your data lives on someone else's cloud.
2. Flagship: your own server, phone is the trust root, TLS terminates on YOUR box.
3. Phone (simulator) usage clips.
4. Mac Studio app: burn/host a phone-gated encrypted VM.
5. Website served live from the Hetzner box (green padlock).
6. Vibecoding a service on the box + final product.
7. Codex/GPT-5.6 usage montage (judging requirement).
8. Call: "patent pending — don't fork, contribute; revenue-share on contributions."
   Point to harrywinner2/flagship + web-app demo + TestFlight.

## Notes / secrets
- OpenRouter key provided in-session (LLM/chat only, NOT OpenAI TTS). ROTATE after today.
- Voiceover: OpenRouter for script; TTS via best reachable path, fallback macOS `say`.
- Demo served via GYM (uses .gym-secrets.env: GYM_ADMIN_SECRET, GYM_HCLOUD_TOKEN, ...).

## Progress log (append-only)
- Site OPEN (SITE_PUBLIC=1) — flagshipserver.com serving real marketing pages.
- All hand-off engineering merged to main; P4 retail-iOS "blocker" was a build-invocation bug (doc fix merged).
- gym redeployed from main; gym D1 migrated to 0083 (approved cutover) + ledger stamped.
- gym Fly tunnel hub (flagship-services-gym) had ZERO machines — DEPLOYED it (2 machines up, health 200). Root cause of boxes never serving.
- Demo account `openai-build` (name "OpenAI Build Week") provisioned; box IP 167.233.218.51.
- BUG FOUND: daemon hangs after "loaded entitlement bundle", never connects tunnel (deterministic across restarts). Delegated fix to worker w/ live SSH.
- Video: script done (8 scenes, judges+public cuts); neural TTS voiceover (OpenAI gpt-4o-mini-tts, 142s); title/privacy/close cards; landing + webapp captures; 4 segments assembled; Ken Burns pipeline proven.

### 2026-07-21 (resume session) — box LIVE, vibecode PROVEN, video ASSEMBLED, mirror DONE
- **Daemon "hang" ROOT-CAUSED + FIXED (live).** It was not a hang — the daemon looped on the gym hub rejecting HELLO: `rootEntitlement signature failed verification`. Cause: gym account `openai-build` is ADMIN-PINNED but the box self-minted its RootEntitlement with the IRK; the hub verifies admin-pinned accounts against the admin root only. Fix (live): re-minted an admin-root-signed entitlement (admin key = `deriveDemoAdminRoot(GYM_DEMO_IRK_KEK, "openai-build")`) + added `adminRootPubHex` to the box `/etc/flagship/config.json`, restarted daemon. **Box now serves HTTP 200 with a valid Let's Encrypt cert** (home.openai-build.gym.flagship.services). Durable code fix (demo provisioner should admin-sign + set adminRootPubHex) is a follow-up — see agent memory `project_daemon_entitlement_fix`.
- **Vibecode-helloworld gate PASSES** (`tools/live-e2e/run.ts` reuse=openai-build): BYOK model ran ON the box + authored hello-world → ready-to-deploy; container deployed + **served HTTP 200 at its subdomain**. 25/28 checks; the 3 fails are expected admin-pinned artifacts (Slice-D assertion, front-page, dead-man), not the vibecode/deploy path.
- **Video ASSEMBLED — both cuts done, then RE-CUT longer (Harry directive) to stress Scene 7.** Final: `/private/tmp/buildweek/flagship-judges.mp4` (**2:54**, under the 3-min cap; all 8 scenes) and `flagship-public.mp4` (2:05, Scene 7 trimmed). Fresh neural VO (vo3, voice=sage) rewritten to use the full time on judge-favored content: multi-platform (iPhone/Mac primary, others following), security model, patent-pending, contribute-for-equity. **Scene 7 is now the 49s centerpiece, split across two cards** — 7a: the fictitious-data / dev-vs-prod innovation (real: `feat/dev-prod-dataspace` synthesizer + promotion gate); 7b: explicit Codex/GPT-5.6 usage (the 25% "Technological Implementation" criterion + Stage-One requirement). Loudness-normalized to ~-16 LUFS. Scene 3 = live iOS sim; 4 = Flagship Studio; 5 = live demo box; 6 = real vibe-code run. Build scripts: `vo-script.json` + `gen-tts.mjs` (TTS), segments in `fin/`, then concat + music mix.
- **Competition rules confirmed** (openai.devpost.com/rules): video <3 min, public YouTube, must have audio covering what you built + how you used Codex AND GPT-5.6. Judging = 4 equally-weighted criteria (~25% each): Technological Implementation (how thoroughly you use Codex), Design (coherent product), Potential Impact, Quality of Idea. Also required in the Devpost form: text description, repo URL + README on how you collaborated with Codex, and a **/feedback Codex Session ID** for the main build thread.
- **Mirror repo DONE.** `github.com/harrywinner2/flagship` = single squashed commit `77ebc356`, public, no history. (Hazard hit + resolved: that name had been redirecting to the private ibisllc/flagship; a delegated force-push briefly moved the company main — restored to 2cd65e5f with Harry's approval; the mirror then pushed to the now-distinct new repo.)
- Note flagged to Harry: Scene 7's "AI authors against fictitious data" claim is aspirational — the fictitious-data harness is NOT implemented; only the credential-hiding seam (model never sees real credential VALUES) is real + tested. VO already recorded to the stronger claim; Harry's call whether to keep or soften.

**REMAINING (Harry-manual):** (7) TestFlight archive+upload; (8) Devpost submit (repo link harrywinner2/flagship + demo creds openai-build + YouTube URL). Also review/upload the video cut to YouTube.
