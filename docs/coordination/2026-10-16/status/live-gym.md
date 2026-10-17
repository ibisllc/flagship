# live-gym: status at pause (2026-10-16)
Goal: extend the live gym (tools/live-e2e/shared-run.ts) to every feature and run it green on UpCloud, fixing what breaks.

## Landed on main
- a54100d36 box: one daemon heartbeat at a time (a restored server's /pods showed "restoring" for good)
- 2635663f2 box: sandbox bridges (fs-*) out of LAN-direct; an app copy never dials itself (copies now go over the LAN)
- 1a7c18afd box: discard an entitlement for another name (a migrated box crash-looped after take-over)
- 4b61794a1 llm-providers: retry a turn the provider refused for a moment (DeepInfra engine_overloaded failed a build)
- 52f30d6ee / 92b8bc7bd gym-only: provision with a given SWK + backup interval; teardown retries UpCloud 401s, reports the zone's size
- d0ff92c9b gym-refresh replays rerere resolutions (the gym branch conflicts with main on every iOS/webapp change)
- 1d02f580b, 3af302ccb, 15ac17597, 8e995d3d9, 8d9cb0e72, 879d6dc10 harness: new groups real-account, api-keys, remote, ai-chat, archive, activity, migrate, mcp-ide; extended share/invites/runtimes/app-copy/lifecycle; LE and DNS preflights; 4-box scheduler; sweep/teardown/probe CLIs
- cde0fdd7d AGENTS Urgent: the flagship.services DNS zone is nearly full; docs/ui-test-gym.md "Tier 2 today"
- Runs: full-2 195 checks/28 min green; green-1 (gym-results/green-1) 218 checks/41 min green (old main); full-5 216 checks, 1 red (DeepInfra busy, now handled)

## Saved, not landed
- wip/live-gym-2026-10-16 (3c25e06df): archive uses the one .flagship file (/bundle); migrate follows main's new archive-path Migrate (keys, paused backup, restore order + box-to-box pull); new `backups` group (phase 6, B1 + new B2 slot) from the backup agent's spec. Typechecks; NOT run live.

## Remaining (in order)
1. S: gym-refresh (main moved: peer-backup secrets PB_*, D1 0104), then one full run with the wip branch; fix the three updated groups (archive, migrate, backups) and the quota agent's `quota` group (first live run: loop-mounted image under gVisor). Files: tools/live-e2e/groups/{archive,migrate,backups}.ts, lib/{bundle,restore}.ts
2. S: land the wip branch once green (land-main.sh, check `npx tsc -b`).
3. M: 3 green full runs in a row (~45 min each, 4 boxes peak, ~40 DNS records, ~7 LE certs each); then update the AGENTS.md "Live gym on UpCloud" paragraph (run id, checks, duration).
4. S (optional): `mcp-ide --ai` weekly variant with `claude -p` restricted to the MCP tools.
5. M: peer-backup group (peer-backup agent's spec) once an endorsed release with the engine exists.

## Blockers / owner decisions
- DNS zone: 154/200 records, ~12 per account with a server, ~70 are leftovers (demoent1-4, demouser7347*, demo1234, harry1, ltsln0yduha, drill-1010, update-drill, openai-build, jolly-quince, harry2). Options: paid Cloudflare plan (higher cap), a zone wildcard A/AAAA + CAA on the account only (~3 per account), the gym on its own domain, reap leftovers. Today a full gym run fits with ~1 record to spare.
- Let's Encrypt: flagship.services is not on the PSL, so gym and prod share 50 new certs/week (a gym run ≈ 7). Same fix: a separate gym domain, or the PSL entry.
- My 16:13 sweep destroyed the MCP-IDE agent's box mcpideb5icco6a (it ran without the gym lock); sweeps reap all gym resources, so the lock is mandatory.
- Gym boxes can't be SSH'd (setting UPCLOUD_SSH_PUBLIC_KEY on the gym Worker was denied by the permission system).

## Gym coverage
Added: real account (admin-only add-server, RCK, read tokens, 429 sentence, new account with no server), API keys + signed DB writes, remote QR + companion, real-model chat continue + provider switch, backup + restore onto a waiting box, Migrate end to end incl. the old box's wipe, delete's wipe-now, activity log, share view/manage/.com offer/unlock/push/leave, second admin device, staging egress, lan-hint + LAN copy, MCP IDE.
Still missing (needs a device or infra): phone-approval unlock, co-manager start-up push delivery, Watch/Wear approval, first-boot update, forward update + rollback (no gym release key), Flagship Inference shim, hub gossip, STK read token, cloud recovery, USB burn → install, the apps' buttons (live UI tier).
UpCloud: 0 gym servers, 0 gym DNS (zone 154). DeepInfra spend: < $0.01 (month total unchanged at $1.65).
