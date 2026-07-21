# Flagship — Build Week submission video script (target 2:55)

Format per scene: **[TIME] VISUAL — CAPTURE SOURCE** / *VO:* voiceover line.
Voiceover generated via TTS; visuals captured via simctl (phone), screencapture
(Mac app), Playwright/Chrome (website), and screen-record (vibecoding/Codex).

Two cuts will exist:
- **JUDGES cut** — includes Scene 7 (Codex/GPT-5.6 usage), required by the rules.
- **PUBLIC cut** — Scene 7 trimmed, everything else identical (for open-beta announce).

---

### Scene 1 — Hook / problem (0:00–0:18)
**VISUAL:** Title card "Flagship" (teal #14B8A6, the rounded-square-with-circle mark)
over a subtle generated background. Quick montage of familiar cloud logos dimming out.
**CAPTURE:** generated title card + background.
*VO:* "Everything you call 'yours' in the cloud actually lives on someone else's
computer. Your photos, your notes, your side-projects — readable by whoever runs
the server. Flagship changes the ownership."

### Scene 2 — What Flagship is (0:18–0:40)
**VISUAL:** The live landing page scrolling — "A personal cloud you actually own,"
"Your stuff, on your hardware, with a real green padlock."
**CAPTURE:** Playwright scroll-capture of https://flagshipserver.com
*VO:* "Flagship is a personal cloud that runs on hardware you own, at home. Your
phone is the trust root. TLS terminates on your box — so the network in the middle,
including us, literally cannot read your content."

### Scene 3 — Pair & boot, from the phone (0:40–1:05)
**VISUAL:** iOS app in the simulator: pairing (QR/short-code cover), device keychain
screen (Secure Enclave), server coming up, the green-padlock server detail.
**CAPTURE:** simctl recordVideo of the FlagshipApp iOS build, scripted walkthrough.
*VO:* "Setup is a USB stick, a QR scan, and about ten minutes. The mobile app is
the keychain — the only key lives in your Secure Enclave. Disk encrypts on first
boot, and your phone signs the unlock. No key ever touches our servers."

### Scene 4 — The Mac Studio app hosts a VM (1:05–1:35)
**VISUAL:** Flagship Studio (Mac): destination chooser (Burn to USB / Host on this
Mac), the hosted-server sidebar, a phone-gated encrypted VM appliance booting.
**CAPTURE:** screencapture of /Applications/Flagship Studio.app.
*VO:* "No spare hardware? Flagship Studio turns your own Mac into the host. It runs
your server as a phone-gated, encrypted Linux virtual machine — a prebuilt
appliance that boots sealed and only unlocks when your phone says so. Windows and
Linux hosts too, all from one shared core."

### Scene 5 — Live website served from YOUR box (1:35–2:00)
**VISUAL:** A browser hitting the demo server's live URL
(<server>.openaijudges.gym.flagship.services) — real content, real green padlock,
cert inspector showing a cert only the box's key holds.
**CAPTURE:** Playwright capture of the live demo server URL + cert panel.
*VO:* "Here's a real server, live, right now — served straight from the box, with a
Let's Encrypt certificate signed by a key only that hardware holds. This exact
account is what the judges will log into."

### Scene 6 — Vibe-code a service (2:00–2:25)
**VISUAL:** The webapp "Build" flow: type a plain-English request → an LLM emits a
manifest + Dockerfile + source → the service deploys → the finished product loads.
**CAPTURE:** screen-record of the vibecoding flow against the demo box.
*VO:* "Adding a service is a sentence. Describe what you want; the model writes the
manifest, the Dockerfile, and the code, and it deploys privately on your box.
This is your cloud, building itself."

### Scene 7 — How we built it (JUDGES cut only) (2:25–2:40)
**VISUAL:** Split montage: Codex / GPT-5.6 driving multi-file changes; the test
suite going green (7,241 tests); a workflow of parallel agents landing commits.
**CAPTURE:** screen-record of an agent session + `vitest` green run.
*VO:* "Flagship was built agent-first. Codex and GPT-5.6 drove the hardest parts —
the cross-client sealed-key cryptography, the VM appliance pipeline, thousands of
passing tests — with a human holding the architecture and the keys."

### Scene 8 — Call to action / close (2:40–2:55)
**VISUAL:** Close card: repo (github.com/harrywinner2/flagship), web-app demo,
TestFlight, **hello@flagshipserver.com**, and the equity-for-contribution line.
**CAPTURE:** generated close card.
*VO:* "Flagship is patent-pending — so please don't copy it. Instead, bring your
ideas: we accept contributions for equity. Reach me at hello@flagshipserver.com.
Own your cloud — let's build it together."

## Honest caveats to voice (judges asked for candor — weave in, don't hide)
- Primary dev/test environment is **iPhone + Mac**; Android / Windows / Linux
  builds exist but are less battle-tested (say so in Scene 4 or 8).
- Self-hosted **VMs work but can be rough** — it's one week of build. Show a VM
  working in Studio; acknowledge it's early. (Harry deleted local VMs; I'll
  create/show one fresh, or show the Studio VM capability + honest note.)
- Lead with the INNOVATION (Scene 7: AI authors against fictitious data; the real
  credential doesn't exist during authoring) — that's the differentiator.
- Patent-pending + contributions-for-equity + hello@flagshipserver.com must appear
  on-screen AND in VO.

---

## Asset checklist
- [ ] Title + close cards (generated background + text overlay)
- [ ] Landing-page scroll capture (Playwright)
- [ ] iOS simulator walkthrough recording (simctl) — NEEDS the iOS build (P4/P2)
- [ ] Mac Studio capture (screencapture)
- [ ] Live demo-server URL + cert capture (Playwright) — NEEDS demo box live
- [ ] Vibecoding flow capture — NEEDS demo box + webapp build flow
- [ ] Codex/agent + green-tests capture
- [ ] Voiceover WAVs per scene (TTS)
- [ ] Background music (royalty-free / generated; rules forbid copyrighted audio)
- [ ] ffmpeg assembly → 1080p mp4 → (Harry) YouTube upload
