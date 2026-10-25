# NVIDIA MIG and cooperative sharing (H5, H6)

**Hardware (not procured):** an A100 or H100 class card on a Debian 13 host qualified as in
`nvidia-cuda.md`.

## H5: hardware partitions

```sh
bash gpu-real.sh qualify-mig /root/gpu-receipt 3g.20gb,3g.20gb
```

Then through flagship-gpud (`gpu.mig.apply` with a maintenance order, `gpu.claim` with
`sharing: partition`):

1. With nothing held, apply `3g.20gb,2g.10gb,1g.5gb`: the generation moves, reconcile runs, the
   three partitions appear in the inventory with their CDI names (`0:0`…).
2. Two apps claim a partition each and run the vector add concurrently: both verify.
3. A third claim for the same layout waits; a whole-device claim on the MIG card waits.
4. While a partition is held, `gpu.mig.apply` is refused.
5. Fault isolation: in one partition run a workload that triggers an Xid (out-of-bounds kernel);
   the other partition's job finishes and verifies; the faulting allocation settles as quarantined
   unless the MIG-recreate cleanup is qualified.
6. Per-partition accounting: `nvidia-smi -q -x` processes carry the GI/CI ids; flagship-gpud
   observes each partition separately (a process in partition 1 doesn't hold partition 0).
7. Residue: canary in partition 0, release, scrub (cleanup `flagship-scrub-v1`, reset
   `mig-recreate`), the next tenant's scan finds none.

## H6: cooperative sharing

Two apps of one trust domain with the owner's consent and share limits
(`share: {computePercent, memoryMib}`) on one non-MIG card:

1. Both reserve; a third whose compute shares would pass 100 % is refused; an app that requires
   secrecy, or another trust domain, is never added.
2. Run both under load: each sees `FLAGSHIP_GPU_MEMORY_BUDGET_MIB` / `FLAGSHIP_GPU_COMPUTE_PERCENT`.
3. Make one exceed its memory budget: the ticker revokes it after two samples; the other keeps
   running. Make one exceed its compute share for three windows: revoked.
4. The owner is told the budgets are admission limits enforced by revocation, not hardware
   partitions (receipt records the wording shown).

Receipts `H5-nvidia-mig`, `H6-nvidia-cooperative`, `H2-nvidia-mig-scrub`; fill
`nvidia-a100-40gb-mig-debian13` in the matrix.
