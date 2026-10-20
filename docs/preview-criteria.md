# What "Experimental" means (and what Preview needs)

Owner decision, 2026-10-20: a surface that has not passed the hardware list below ships labelled
**Experimental**, in the app, on the page that offers it and in its window title. **Preview**, the
tier above it, is for a surface that has passed all six. The label never means the first run is
untested in CI or that a published artifact is known not to start.

## A surface may be called Preview (and drop "Experimental") only if all of these have passed on real hardware

1. **Install** from the published artifact (installer, store build or image), not a developer build.
2. **Pair** with a phone (and a second device, for phones).
3. **First boot** of a fresh machine to a working, reachable server, including the update it fetches.
4. **Restart** (stop and start, then a second boot) comes back by itself or with the phone's approval.
5. **Stop** and **update** (including a failed-health rollback) leave the data intact.
6. **Recover**: the phone can approve a boot unlock, and a lost phone's path is documented.

May still be incomplete in a Preview: importing a backup, accessibility polish, many hardware
models, localisation, secondary screens.

## Today

| Surface | Status | Missing before it can be called Preview |
|---|---|---|
| Windows Studio + hosted VM | Experimental | first boot of the republished appliance after the UART and resize fixes; UAC cancel and "Restart as administrator"; stop/start and second boot |
| Linux Studio | Experimental | a real desktop run of 1 to 6 |
| Mac Studio | shipping | n/a |
| Wear OS | Experimental (label it so in the Play listing) | a hardware run of pairing and an approval |
| Flagship Inference | built, shim and `.com` secrets in place (2026-10-20) | an end-to-end build on a fresh account (receipt `flagship-inference-live`) |
| Peer backup | off | a cross-account restore with churn, missing peers and a relay interruption |
| Notice lock | off in the phones; the webapp lock lets the boot-unlock writes through | a locked phone approving a real boot |

The receipts for these are tracked by `npm run release-manifest` (`docs/runbooks/release-readiness.md`).
