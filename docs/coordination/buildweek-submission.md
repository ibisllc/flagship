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
- BLOCKED on daemon fix: vibecode-helloworld test, judges login, video Scenes 5 (live site) & 6 (vibecode).
- Studio GUI capture (Scene 4) needs macOS accessibility grant or a Harry screen-record.
