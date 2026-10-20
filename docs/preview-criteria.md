# What "Preview" means

A surface is labelled **Preview** when its core workflow works and is tested, while polish, breadth
of hardware or secondary features are incomplete. It never means the first run is untested or a
published artifact is known not to start.

## A surface may be called Preview only if all of these have passed on real hardware

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
| Windows Studio + hosted VM | Preview | first boot of the republished appliance after the UART and resize fixes; UAC cancel and "Restart as administrator"; stop/start and second boot |
| Linux Studio | Preview | a real desktop run of 1 to 6 |
| Mac Studio | shipping | n/a |
| Wear OS | Preview | a hardware run of pairing and an approval |
| Flagship Inference | off | its public host and an end-to-end call |
| Peer backup | off | a cross-account restore with churn, missing peers and a relay interruption |
| Notice lock | off in release | a locked phone approving a real boot |

The receipts for these are tracked by `npm run release-manifest` (`docs/runbooks/release-readiness.md`).
