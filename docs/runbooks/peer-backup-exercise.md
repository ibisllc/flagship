# Peer-backup operational tuning + 7-day multi-pod exercise (#57)

**Status:** Runbook ready; the actual 7-day exercise is operational
work to schedule before v1 alpha.

## What's built today

Per the project overview, the peer-backup primitives are all in
place: `peerLink`, `transport`, `shardStore`, `registry`,
`repairDaemon`, `matchmaker`, `BackupLoop`. The control-plane has
the matchmaker endpoint. Daemons opt in via the BackupToggle
envelope.

What's NOT been validated at scale: tuning the parameters across
multiple pods over a real time window. This runbook captures the
exercise plan.

## Goals of the 7-day exercise

After the exercise we should know, with measured numbers:

1. **Steady-state shard-storage rate** — bytes per day a typical user's
   pod adds to peer storage (varies with how much app data the user
   has + the Reed-Solomon parameters).
2. **Repair latency on peer disappearance** — how long between a peer
   going offline and the repair daemon noticing + scheduling
   replacement shards.
3. **Network usage during routine maintenance** — bytes-per-day for
   challenge-response proof-of-storage exchanges.
4. **Matchmaker pairing quality** — does the matchmaker produce
   reasonable pair distributions, or do some pods get over-loaded?

## Setup

Provision **6 test pods** across **3 geographic regions**:

| Pod | Region | Disk class | Role |
|---|---|---|---|
| pod-a | iad | 100 GB SSD | "Light user" — 5 apps, ~1 GB data |
| pod-b | iad | 100 GB SSD | "Heavy user" — 30 apps, ~50 GB data |
| pod-c | fra | 100 GB SSD | Light user |
| pod-d | fra | 100 GB SSD | Heavy user (mirror of pod-b for stress) |
| pod-e | syd | 100 GB SSD | Light user |
| pod-f | syd | 100 GB SSD | Heavy user |

All 6 pods opt in to peer-backup at hour 0.

## Per-day measurements

Each day, record from each pod's status endpoint (`GET
/api/screens/peer-backup/status`):

- Total shards stored (count, total bytes)
- Total shards held remotely on this pod's behalf (count, total bytes)
- Repair operations in the last 24h
- Challenge-response success rate
- Matchmaker re-pairing events

## Failure-injection schedule

The exercise isn't only about steady-state. Inject failures to
exercise the repair primitives:

| Day | Event |
|---|---|
| 0 | All pods opt in. |
| 1 | Verify initial pairing — every pod has at least K peers, every shard has at least N replicas per Reed-Solomon parameters. |
| 2 | Take **pod-c** offline for 6 hours, then bring back. Verify shards on pod-c re-mirror to other peers during the outage, then the repair daemon does not re-replicate after pod-c returns (we don't want unnecessary I/O). |
| 3 | Take **pod-d** offline permanently. Verify pod-d's shards re-replicate to other peers within ~24h. |
| 4 | Wipe **pod-a's** disk (simulate hardware failure). Re-provision pod-a from scratch. Initiate a recovery from peer-backup. Measure: time to first shard pulled, time to full recovery. |
| 5 | Inject a **corrupt shard** on pod-e (tamper with a stored shard's bytes). Verify the proof-of-storage challenge fails and the matchmaker reassigns. |
| 6 | Simulate a **matchmaker outage** (block .com from one pod). Verify the pod continues to honor existing pair commitments. |
| 7 | All-clear: gather metrics, write up findings. |

## Parameters to tune

Reed-Solomon parameters live in `packages/protocol/src/erasure.ts`
(or wherever the chunker is). Default K (data shards) + N
(parity shards) was chosen heuristically. The exercise tests:

- K=6, N=4 (default): tolerates 4 simultaneous peer losses; ~67% overhead.
- K=8, N=2: ~25% overhead; tolerates only 2 peer losses. Test if
  peer-loss rate is low enough.
- K=4, N=4: ~100% overhead; tolerates 4 peer losses. Test if disk
  budget allows.

Pick the K,N that matches measured peer-loss-rate × 1.5.

## Matchmaker quality metric

After day 1 + day 7, run an analysis: for each pod, count the
number of OTHER pods it stores shards for. The distribution should
be roughly uniform (each pod ~ same load). If matchmaker biases
toward early-joiners or geo-clustering, tune the matchmaker's
selection algorithm in `packages/control-plane/src/matchmaker.ts` or
wherever it lives.

## Exit criteria

The exercise produces:

1. A measured number for each of the four goals above.
2. A signed-off K,N parameter setting (recorded in
   `docs/build-tasks.md` § peer-backup as the v1-launch default).
3. Any code changes needed (a separate commit per finding).

If repair latency exceeds 48h or matchmaker distribution is &gt;3x
imbalanced, the launch is gated until both are fixed.

## Why this is a runbook not a script

A real 7-day exercise needs human attention at each failure-injection
step + judgment calls on the resulting metrics. Automating it
end-to-end is overengineering for a once-per-major-release event.
The exercise lives as a doc; results land in commits when measured.

## Once executed, the artifact

Replace this file's "Status: Runbook ready" line with a "Status:
Exercise run YYYY-MM-DD; results in commit XXXXXXX" line, and
append a "Results" section with the measured numbers and the
K,N decision.

The repeat cadence: once per major release that touches peer-backup
internals. Otherwise the parameters can ride.
